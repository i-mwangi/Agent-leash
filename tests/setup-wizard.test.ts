import { describe, expect, it } from 'vitest';
import { KeyList, PrivateKey } from '@hiero-ledger/sdk';
import { proto } from '@hiero-ledger/proto';
import { Wallet } from 'ethers';
import { agreementHash, signAgreement, verifyRecordedAgreement, walletAgreementPayload, type Agreement } from '../packages/shared/src/agreement';
import { expectedTopicKeys, topicMatches, type Progress as RuntimeProgress } from '../packages/agent/src/wizard';
import { createSetupApp, SETUP_HEADER } from '../packages/agent/src/service';
import { checkWalletTransaction, guardianBalance, mirrorTransactionId, requiredTinybars, verifyAgreementMessage, walletRejected } from '../packages/nextjs/app/setup-actions';
import { createApp } from '../packages/server/src/app';
import { tokenAmount } from '../packages/nextjs/app/live-data';

const guardianWallet=new Wallet('0x'+'1'.padStart(64,'0'));
const agreement:Agreement={version:1,scope:'client-enforced',agentAccount:'0.0.123',guardianAccount:'0.0.124',policyContract:'0x0000000000000000000000000000000000000125',spendAsset:'0.0.1183558',maxPerTx:'1000000',maxPerDay:'5000000'};

describe('wallet-approved agreement records',()=>{
  it('accepts wallet approval only when the guardian published the HCS message',()=>{
    const payload=walletAgreementPayload(agreement);
    expect(payload).toEqual({agreement,hash:agreementHash(agreement),approval:'guardian-hcs-transaction'});
    expect(verifyRecordedAgreement(payload,guardianWallet.address,true)).toEqual(payload);
    expect(()=>verifyRecordedAgreement(payload,guardianWallet.address,false)).toThrow('PUBLISHER_MISMATCH');
    expect(()=>verifyRecordedAgreement({...payload,agreement:{...agreement,maxPerTx:'1000001'}},guardianWallet.address,true)).toThrow('HASH_MISMATCH');
    expect(()=>verifyRecordedAgreement({...payload,approval:'other'},guardianWallet.address,true)).toThrow();
  });
  it('still verifies the CLI signature format unchanged',async()=>{
    const signed=await signAgreement(agreement,guardianWallet);
    expect(verifyRecordedAgreement(signed,guardianWallet.address,true)).toEqual(signed);
    expect(()=>verifyRecordedAgreement(signed,new Wallet('0x'+'2'.padStart(64,'0')).address,true)).toThrow('GUARDIAN_MISMATCH');
  });
});

describe('guardian-created HCS topic',()=>{
  const [operator,guardian,agent,other]=[1,2,3,4].map(()=>PrivateKey.generateECDSA().publicKey);
  const expected=expectedTopicKeys({operatorPublicKey:operator.toStringRaw(),guardianPublicKey:guardian.toStringRaw(),agentPublicKey:agent.toStringRaw()});
  const encoded=(list:KeyList)=>({_type:'ProtobufEncoded',key:Buffer.from(proto.Key.encode(list._toProtobufKey()).finish()).toString('hex')});
  const topic=(overrides:Record<string,unknown>={})=>({memo:'Accountable Agent v1',deleted:false,admin_key:{_type:'ECDSA_SECP256K1',key:guardian.toStringRaw()},submit_key:encoded(new KeyList([operator,guardian,agent],1)),...overrides});
  it('matches only the exact admin key, memo and 1-of-3 submit key list',()=>{
    expect(topicMatches(topic(),expected)).toBe(true);
    expect(topicMatches(topic({submit_key:encoded(new KeyList([agent,operator,guardian],1))}),expected)).toBe(true);
    expect(topicMatches(topic({admin_key:{_type:'ECDSA_SECP256K1',key:other.toStringRaw()}}),expected)).toBe(false);
    expect(topicMatches(topic({submit_key:encoded(new KeyList([operator,guardian,agent],2))}),expected)).toBe(false);
    expect(topicMatches(topic({submit_key:encoded(new KeyList([operator,guardian,other],1))}),expected)).toBe(false);
    expect(topicMatches(topic({memo:'other'}),expected)).toBe(false);
    expect(topicMatches(topic({deleted:true}),expected)).toBe(false);
    expect(topicMatches(topic({admin_key:null}),expected)).toBe(false);
  });
});

describe('local setup runtime',()=>{
  const progress:RuntimeProgress={stage:'connect',operatorPublicKey:'02'+'1'.repeat(64),agentPublicKey:'03'+'2'.repeat(64),fundingTinybars:'4500000000'};
  it('rejects requests without the setup header or from another origin',async()=>{
    const {app}=createSetupApp(async()=>progress,async()=>undefined);
    expect((await app.request('/setup/state')).status).toBe(403);
    expect((await app.request('/setup/state',{headers:{[SETUP_HEADER]:'1',origin:'https://example.com'}})).status).toBe(403);
    expect((await app.request('/setup/advance',{method:'POST',headers:{origin:'http://localhost:3000'}})).status).toBe(403);
    expect((await app.request('/setup/state',{headers:{[SETUP_HEADER]:'1',origin:'http://localhost:3000'}})).status).toBe(200);
  });
  it('runs one setup pass at a time and reports its result',async()=>{
    let calls=0;let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const {app}=createSetupApp(async()=>{calls++;await gate;return {...progress,stage:'fund'};},async()=>undefined);
    const headers={[SETUP_HEADER]:'1'};
    expect((await (await app.request('/setup/advance',{method:'POST',headers})).json()).running).toBe(true);
    await app.request('/setup/advance',{method:'POST',headers});
    expect(calls).toBe(1);
    expect((await app.request('/setup/guardian',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({accountId:'0.0.5'})})).status).toBe(409);
    release();await new Promise(resolve=>setTimeout(resolve,0));
    const state=await (await app.request('/setup/state',{headers})).json();
    expect(state).toMatchObject({running:false,lastError:null,progress:{stage:'fund'}});
    expect((await app.request('/setup/guardian',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status).toBe(400);
  });
});

describe('wallet transaction reconciliation',()=>{
  const id='0.0.7@1790000000.000000001';
  const mirror=(status:number,body?:unknown)=>async()=>new Response(body?JSON.stringify(body):'{}',{status});
  it('reports success, failure, expiry and unknown without resubmitting',async()=>{
    expect(mirrorTransactionId(id)).toBe('0.0.7-1790000000-000000001');
    const row=(result:string)=>({transactions:[{transaction_id:'0.0.7-1790000000-000000001',nonce:0,result}]});
    expect(await checkWalletTransaction(id,0,1000,mirror(200,row('SUCCESS')))).toBe('success');
    expect(await checkWalletTransaction(id,0,1000,mirror(200,row('INSUFFICIENT_PAYER_BALANCE')))).toBe('failed');
    expect(await checkWalletTransaction(id,0,1000,mirror(404))).toBe('unknown');
    expect(await checkWalletTransaction(id,0,300_000,mirror(404))).toBe('expired');
    expect(await checkWalletTransaction(id,0,300_000,mirror(503))).toBe('unknown');
  });
});

describe('guardian funding check',()=>{
  it('requires the setup funding plus a fee margin before asking the wallet',async()=>{
    expect(requiredTinybars('fund','4500000000')).toBe(4_600_000_000n);
    expect(requiredTinybars('topic','4500000000')).toBe(100_000_000n);
    const account=(balance:number)=>async()=>new Response(JSON.stringify({balance:{balance}}),{status:200});
    expect(await guardianBalance('0.0.7',account(910_081_884))).toBe(910_081_884n);
    expect(await guardianBalance('0.0.7',async()=>new Response('{}',{status:503}))).toBeNull();
    expect(await guardianBalance('0.0.7',async()=>{throw new Error('offline');})).toBeNull();
  });
  it('treats only explicit wallet rejections as never submitted',()=>{
    expect(walletRejected({code:5000,message:'User rejected.'})).toBe(true);
    expect(walletRejected(new Error('Request declined by user'))).toBe(true);
    expect(walletRejected({})).toBe(false);
    expect(walletRejected(new Error('Request expired'))).toBe(false);
  });
});

describe('browser agreement check',()=>{
  const payload=walletAgreementPayload(agreement);
  const message=JSON.stringify({v:1,type:'agreement',ts:'2026-09-30T00:00:00.000Z',agentAccount:agreement.agentAccount,payload});
  const progress={guardianId:agreement.guardianAccount,deployment:{agentAccount:agreement.agentAccount}};
  it('accepts only a message carrying exactly the displayed, hashed terms',()=>{
    const shown={message,hash:payload.hash,terms:{...agreement}};
    expect(()=>verifyAgreementMessage(shown,progress)).not.toThrow();
    expect(()=>verifyAgreementMessage({...shown,terms:{...agreement,maxPerTx:'2000000'}},progress)).toThrow('hash');
    expect(()=>verifyAgreementMessage(shown,{...progress,guardianId:'0.0.999'})).toThrow('agent and guardian');
    const tampered=JSON.stringify({...JSON.parse(message),payload:{...payload,agreement:{...agreement,maxPerDay:'9'}}});
    expect(()=>verifyAgreementMessage({...shown,message:tampered},progress)).toThrow('message');
  });
});

describe('dashboard token amounts',()=>{
  it('formats raw units with the mirror-reported decimals',()=>{
    expect(tokenAmount('1000000',6)).toBe('1');
    expect(tokenAmount('53945214',6)).toBe('53.945214');
    expect(tokenAmount('5000000',6)).toBe('5');
    expect(tokenAmount('0',6)).toBe('0');
    expect(tokenAmount('1234567890000',6)).toBe('1,234,567.89');
    expect(tokenAmount('42',0)).toBe('42');
  });
});

describe('API auto mode',()=>{
  it('serves demo until the mode getter reports testnet',async()=>{
    let mode='demo';
    const app=createApp(()=>mode,()=>null);
    expect((await (await app.request('/health')).json()).mode).toBe('demo');
    expect((await app.request('/standing/0.0.1')).status).toBe(503);
    mode='testnet';
    expect((await (await app.request('/health')).json()).mode).toBe('testnet');
  });
});
