import { describe, expect, it, vi } from 'vitest';
import { AccountId, PrivateKey, TransactionId, TransferTransaction } from '@hiero-ledger/sdk';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { Mirror, mirrorTxId } from '../packages/shared/src/mirror';
import { Store } from '../packages/shared/src/store';
import { Payments, type Facilitator } from '../packages/server/src/x402';
import { APICallError } from 'ai';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { complete, inferenceConfig } from '../packages/shared/src/inference';
import { clearInferenceSettings, readInferenceSettings, saveInferenceSettings, testInferenceSettings } from '../packages/agent/src/inferenceSettings';
import { createApp } from '../packages/server/src/app';
import { chooseRequirement, serviceUrl, settledOrExpired } from '../packages/agent/src/pay';
import { dailySpend } from '../packages/shared/src/sources';
import { recentFills, recentIncome, recentPayments } from '../packages/shared/src/fills';
import type { LiveServices } from '../packages/server/src/live';

const USDC='0.0.429274';
const requirement=(overrides:Record<string,unknown>={})=>({scheme:'exact',network:'hedera:testnet' as const,asset:USDC,amount:'10000',payTo:'0.0.6',maxTimeoutSeconds:120,extra:{feePayer:'0.0.5'},...overrides});

describe('paid inference configuration',()=>{
  it('supports the AI Gateway and direct providers, and reads older base-URL settings as OpenAI-compatible',()=>{
    expect(inferenceConfig({})).toBeNull();
    expect(inferenceConfig({INFERENCE_PROVIDER:'gateway',INFERENCE_API_KEY:'vck_12345678',INFERENCE_MODEL:'moonshotai/kimi-k3'})).toEqual({provider:'gateway',apiKey:'vck_12345678',model:'moonshotai/kimi-k3',price:'10000'});
    expect(inferenceConfig({INFERENCE_BASE_URL:'https://api.example.com/v1/',INFERENCE_API_KEY:'k-12345678',INFERENCE_MODEL:'model-1'})).toMatchObject({provider:'openai-compatible',baseUrl:'https://api.example.com/v1'});
    expect(()=>inferenceConfig({INFERENCE_PROVIDER:'other',INFERENCE_API_KEY:'k-12345678',INFERENCE_MODEL:'m'})).toThrow('INFERENCE_PROVIDER_INVALID');
    expect(()=>inferenceConfig({INFERENCE_PROVIDER:'openai-compatible',INFERENCE_BASE_URL:'http://x.org',INFERENCE_API_KEY:'k-12345678',INFERENCE_MODEL:'m'})).toThrow('INFERENCE_BASE_URL_INVALID');
    expect(()=>inferenceConfig({INFERENCE_PROVIDER:'openai',INFERENCE_API_KEY:'k-12345678',INFERENCE_MODEL:'m',INFERENCE_PRICE:'0'})).toThrow('INFERENCE_PRICE_INVALID');
  });
  it('reports only the status of a provider error, never its message',async()=>{
    const config={provider:'gateway' as const,apiKey:'vck_12345678',model:'moonshotai/kimi-k3',price:'10000'};
    expect(await complete(config,'Hi',async options=>{expect(options.prompt).toBe('Hi');expect(options.maxOutputTokens).toBe(512);return {text:'Hello',usage:{inputTokens:3,outputTokens:1}};}))
      .toEqual({provider:'gateway',model:'moonshotai/kimi-k3',answer:'Hello',usage:{inputTokens:3,outputTokens:1}});
    const failing=async()=>{throw new APICallError({message:'invalid key vck_12345678',url:'https://x',requestBodyValues:{},statusCode:401});};
    await expect(complete(config,'Hi',failing)).rejects.toThrow(/^INFERENCE_UPSTREAM_401$/);
    await expect(complete(config,'Hi',async()=>{throw new Error('socket');})).rejects.toThrow(/^INFERENCE_UPSTREAM_UNAVAILABLE$/);
  });
});

describe('provider settings from the dashboard',()=>{
  const ORIGINAL=['APP_MODE=auto','ATTESTATION_PRIVATE_KEY=0xabc',''].join(String.fromCharCode(10));
  const root=()=>{const dir=mkdtempSync(join(tmpdir(),'inference-'));writeFileSync(join(dir,'.env.server'),ORIGINAL);return dir;};
  it('stores the key in .env.server, keeps other lines and never returns the key',()=>{
    const dir=root();
    const saved=saveInferenceSettings({provider:'gateway',apiKey:'vck_secret_123',model:'moonshotai/kimi-k3',price:'20000'},dir);
    expect(JSON.stringify(saved)).not.toContain('vck_secret_123');
    expect(saved).toMatchObject({configured:true,keySet:true,provider:'gateway',model:'moonshotai/kimi-k3',price:'20000'});
    const text=readFileSync(join(dir,'.env.server'),'utf8');
    expect(text).toContain('ATTESTATION_PRIVATE_KEY=0xabc');
    expect(text).toContain('INFERENCE_API_KEY=vck_secret_123');
    // Same provider: the saved key is kept when the field is left empty.
    expect(saveInferenceSettings({provider:'gateway',model:'anthropic/claude-haiku-4.5',price:'20000'},dir).model).toBe('anthropic/claude-haiku-4.5');
    // A different provider never inherits the key.
    expect(()=>saveInferenceSettings({provider:'openai',model:'gpt-4o-mini',price:'20000'},dir)).toThrow('INFERENCE_API_KEY_REQUIRED');
    expect(()=>saveInferenceSettings({provider:'gateway',apiKey:'has space here',model:'m',price:'1'},dir)).toThrow('INFERENCE_SETTINGS_INVALID');
    expect(()=>saveInferenceSettings({provider:'gateway',apiKey:'vck_secret_123'+String.fromCharCode(10)+'AGENT_PRIVATE_KEY=x',model:'m',price:'1'},dir)).toThrow('INFERENCE_SETTINGS_INVALID');
    const cleared=clearInferenceSettings(dir);
    expect(cleared).toMatchObject({configured:false,keySet:false});
    expect(readFileSync(join(dir,'.env.server'),'utf8')).toBe(ORIGINAL);
    expect(readInferenceSettings(dir).providers.map(p=>p.id)).toEqual(['gateway','openai','anthropic','google','openai-compatible']);
  });
  it('tests the saved settings with one short request',async()=>{
    const dir=root();
    await expect(testInferenceSettings(dir)).rejects.toThrow('INFERENCE_NOT_CONFIGURED');
    saveInferenceSettings({provider:'anthropic',apiKey:'sk-ant-12345678',model:'claude-haiku-4-5',price:'10000'},dir);
    const result=await testInferenceSettings(dir,async config=>({provider:config.provider,model:config.model,answer:'Ready.',usage:{inputTokens:1,outputTokens:1}}));
    expect(result).toEqual({ok:true,provider:'Anthropic',model:'claude-haiku-4-5',answer:'Ready.',usage:{inputTokens:1,outputTokens:1}});
  });
});

describe('selling over x402',()=>{
  it('keeps the inference route an unpaid 503 until a provider is configured',async()=>{
    const app=createApp('demo',()=>null);
    const response=await app.request('/paid/inference',{method:'POST',body:JSON.stringify({prompt:'Hi'})});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:'INFERENCE_NOT_CONFIGURED',paymentRequired:false});
  });
  it('quotes its price in a 402 challenge and rejects a bad prompt before any payment',async()=>{
    const payments={requirements:vi.fn(async(amount:string)=>requirement({amount})),challenge:new Payments(new Mirror(),new Store(':memory:'),'0.0.6').challenge} as unknown as Payments;
    const live={deployment:{agentAccount:'0.0.6',standingBaseUrl:'http://localhost:3001',erc8004AgentId:'125'},payments,inference:()=>({provider:'gateway',apiKey:'k-12345678',model:'m',price:'20000'})} as unknown as LiveServices;
    const app=createApp('testnet',()=>live);
    expect((await app.request('/paid/inference',{method:'POST',body:JSON.stringify({prompt:''})})).status).toBe(400);
    const response=await app.request('/paid/inference',{method:'POST',body:JSON.stringify({prompt:'Hi'})});
    expect(response.status).toBe(402);
    expect(response.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
    expect(await response.json()).toMatchObject({x402Version:2,resource:{url:'http://localhost:3001/paid/inference',description:'One LLM completion (m)'},accepts:[{amount:'20000',payTo:'0.0.6'}]});
  });
  it('runs the paid work before settlement, so a failed request is never charged',async()=>{
    const store=new Store(':memory:'),mirror=new Mirror();
    const tx=new TransferTransaction().addTokenTransfer(USDC,'0.0.7',-10000).addTokenTransfer(USDC,'0.0.6',10000).setTransactionId(TransactionId.generate('0.0.5')).setNodeAccountIds([AccountId.fromString('0.0.3')]).freeze();
    await tx.sign(PrivateKey.fromStringECDSA('1'.padStart(64,'0')));
    const id=tx.transactionId!.toString();
    vi.spyOn(mirror,'waitTransaction').mockResolvedValue({transaction_id:mirrorTxId(id),result:'SUCCESS',consensus_timestamp:'1.0',token_transfers:[{token_id:USDC,account:'0.0.6',amount:10000},{token_id:USDC,account:'0.0.7',amount:-10000}]});
    const facilitator:Facilitator={getSupported:vi.fn(),verify:vi.fn(async()=>({isValid:true,payer:'0.0.7'})),settle:vi.fn(async()=>({success:true,transaction:id,network:'hedera:testnet' as const,payer:'0.0.7'}))};
    const payments=new Payments(mirror,store,'0.0.6',facilitator);
    const header=encodePaymentSignatureHeader({x402Version:2,accepted:requirement(),payload:{transaction:Buffer.from(tx.toBytes()).toString('base64')}});
    await expect(payments.accept(header,requirement(),'inference',async()=>{throw new Error('INFERENCE_UPSTREAM_500');},{prepareFirst:true})).rejects.toThrow('INFERENCE_UPSTREAM_500');
    expect(facilitator.settle).not.toHaveBeenCalled();
    const answered=await payments.accept(header,requirement(),'inference',async()=>({answer:'Hello'}),{prepareFirst:true});
    expect(answered.body).toEqual({answer:'Hello'});
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    // The standing price is unchanged and a payment for a different amount is refused.
    await expect(payments.accept(header,requirement({amount:'1000'}),'inference',async()=>({}))).rejects.toThrow('PAYMENT_REQUIREMENTS_MISMATCH');
    store.close();
  });
});

describe('paying over x402',()=>{
  it('accepts https, or http only to this machine',()=>{
    expect(serviceUrl('https://api.example.com/paid').hostname).toBe('api.example.com');
    expect(serviceUrl('http://127.0.0.1:3001/paid/inference').port).toBe('3001');
    for(const bad of ['http://example.com/x','ftp://x.org','https://u:p@x.org','not a url']) expect(()=>serviceUrl(bad)).toThrow('INVALID_SERVICE_URL');
  });
  it('pays only exact USDC on Hedera testnet, the cheapest option, within the limit',()=>{
    const accepts=[requirement({network:'eip155:8453',asset:'0xabc',amount:'1'}),requirement({amount:'30000'}),requirement({amount:'20000'}),requirement({asset:'0.0.1183558',amount:'5'})];
    expect(chooseRequirement({x402Version:2,accepts} as never).amount).toBe('20000');
    expect(()=>chooseRequirement({x402Version:2,accepts} as never,10000n)).toThrow('PRICE_ABOVE_LIMIT');
    expect(()=>chooseRequirement({x402Version:2,accepts:[accepts[0]]} as never)).toThrow('NO_HEDERA_USDC_OPTION');
    expect(()=>chooseRequirement({x402Version:2,accepts:[requirement({extra:{}})]} as never)).toThrow('NO_HEDERA_USDC_OPTION');
    expect(()=>chooseRequirement({x402Version:1,accepts} as never)).toThrow('UNSUPPORTED_X402_VERSION');
  });
  it('releases a payment the seller never submitted only after its validity window',async()=>{
    let clock=1_790_000_000_000;
    const mirror={transaction:vi.fn(async()=>{throw new Error('MIRROR_NOT_FOUND');})} as unknown as Mirror;
    const result=await settledOrExpired('0.0.10@1790000000.000000001',mirror,()=>clock,async ms=>{clock+=ms;});
    expect(result).toBeNull();
    expect(clock).toBeGreaterThanOrEqual(1_790_000_200_000);
    const found={transaction_id:'0.0.10-1790000000-000000001',result:'SUCCESS'};
    const later={transaction:vi.fn(async()=>found)} as unknown as Mirror;
    expect(await settledOrExpired('0.0.10@1790000000.000000001',later,()=>clock,async()=>undefined)).toBe(found);
  });
  it('counts a payment against the daily limit from its plain transfer, and lists it apart from swaps',async()=>{
    const now=Date.parse('2026-10-01T12:00:00Z');
    const event={v:1 as const,type:'fill' as const,ts:'2026-10-01T12:00:00.000Z',agentAccount:'0.0.10',payload:{kind:'x402',status:'success',transactionId:'0.0.10@1790856000.000000001',amount:'10000',asset:USDC,payTo:'0.0.6',resource:'http://127.0.0.1:3001/paid/inference'},consensusTimestamp:'1790856001.000000001',sequence:20,publisher:'0.0.10'};
    const mirror={
      transaction:async()=>({transaction_id:'0.0.10-1790856000-000000001',result:'SUCCESS',consensus_timestamp:'1790856000.5',token_transfers:[{token_id:USDC,account:'0.0.10',amount:-10000},{token_id:USDC,account:'0.0.6',amount:10000}]}),
      contractTransfers:async()=>{throw new Error('not a contract call');},
      token:async(id:string)=>({token_id:id,symbol:'T',decimals:'6',deleted:false}),
    } as unknown as Mirror;
    expect((await dailySpend([event],'0.0.10',USDC,mirror,now)).total).toBe(10000n);
    expect((await recentFills({agentAccount:'0.0.10',spendAsset:'0.0.20',outputAsset:'0.0.30'},[event],mirror)).fills).toEqual([]);
    expect(recentPayments({agentAccount:'0.0.10'},[event])).toEqual([{transactionId:'0.0.10@1790856000.000000001',amount:'10000',asset:USDC,payTo:'0.0.6',resource:'http://127.0.0.1:3001/paid/inference',recordedAt:'1790856001.000000001',sequence:20}]);
  });
  it('reads USDC received by the seller from the mirror',async()=>{
    const mirror=new Mirror(async()=>Response.json({transactions:[
      {transaction_id:'0.0.5-1-000000001',result:'SUCCESS',consensus_timestamp:'2.0',token_transfers:[{token_id:USDC,account:'0.0.7',amount:-10000},{token_id:USDC,account:'0.0.6',amount:10000}]},
      {transaction_id:'0.0.6-1-000000002',result:'SUCCESS',consensus_timestamp:'1.0',token_transfers:[{token_id:USDC,account:'0.0.6',amount:-5},{token_id:USDC,account:'0.0.9',amount:5}]},
    ]}));
    expect(await recentIncome('0.0.6',mirror)).toEqual([{transactionId:'0.0.5-1-000000001',amount:'10000',payer:'0.0.7',consensusTimestamp:'2.0'}]);
  });
});
