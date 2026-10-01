import { describe, expect, it } from 'vitest';
import { Interface } from 'ethers';
import { Mirror } from '../packages/shared/src/mirror';
import { IDENTITY_ABI } from '../packages/shared/src/sources';
import { REPUTATION_ABI, formatFixed, parseCardUri, readReputation, resolveAgent } from '../packages/shared/src/resolve';
import { feedbackInput } from '../packages/agent/src/feedback';
import { standingBase } from '../packages/agent/src/setup';
import { recentFills } from '../packages/shared/src/fills';
import { createApp } from '../packages/server/src/app';

const dataUri=(card:object)=>'data:application/json;base64,'+Buffer.from(JSON.stringify(card)).toString('base64');
const OWNER='0x00000000000000000000000000000000000a0001';
const REVIEWER='0x00000000000000000000000000000000000b0002';

/** A mirror that answers registry eth_calls from fixtures and account reads by address. */
function fakeMirror(calls:Record<string,(args:unknown[])=>unknown[]|'revert'>,accounts:Record<string,string>={}) {
  const abis:Interface[]=[IDENTITY_ABI,REPUTATION_ABI];
  return new Mirror(async (url,init)=>{
    const path=new URL(String(url)).pathname;
    if(path==='/api/v1/contracts/call') {
      const {data}=JSON.parse(String(init?.body)) as {data:string};
      for(const abi of abis) {
        const fn=abi.getFunction(data.slice(0,10));
        if(!fn || !calls[fn.name]) continue;
        const result=calls[fn.name](Array.from(abi.decodeFunctionData(fn,data)));
        if(result==='revert') return new Response('CONTRACT_REVERT_EXECUTED',{status:400});
        return Response.json({result:abi.encodeFunctionResult(fn,result)});
      }
      return new Response('unexpected call',{status:500});
    }
    const account=accounts[path.split('/').at(-1)!.toLowerCase()];
    return account?Response.json({account,evm_address:path.split('/').at(-1),deleted:false,key:{_type:'ECDSA_SECP256K1',key:'02'+'1'.repeat(64)}}):new Response('{}',{status:404});
  });
}

describe('agent card parsing',()=>{
  it('decodes only self-contained data URIs and never fetches a URL',()=>{
    expect(parseCardUri(dataUri({name:'A'}))).toEqual({kind:'data',card:{name:'A'}});
    expect(parseCardUri('https://example.com/card.json')).toEqual({kind:'external',uri:'https://example.com/card.json'});
    expect(()=>parseCardUri('data:application/json;base64,'+'A'.repeat(40000))).toThrow('CARD_TOO_LARGE');
    expect(()=>parseCardUri('data:application/json;base64,bm90IGpzb24=')).toThrow('CARD_INVALID');
  });
  it('formats signed fixed-point review values',()=>{
    expect(formatFixed(90n,0)).toBe('90');
    expect(formatFixed(8750n,2)).toBe('87.5');
    expect(formatFixed(-25n,1)).toBe('-2.5');
  });
});

describe('agent lookup',()=>{
  it('reports a missing agent as not found',async()=>{
    const mirror=fakeMirror({ownerOf:()=> 'revert',tokenURI:()=> 'revert',getClients:()=>[[]]});
    await expect(resolveAgent(7n,mirror)).rejects.toThrow('AGENT_NOT_FOUND');
  });
  it('does not verify or fetch an externally hosted card',async()=>{
    const mirror=fakeMirror({ownerOf:()=>[OWNER],tokenURI:()=>['https://example.com/agent.json'],getClients:()=>[[]]},{[OWNER]:'0.0.655361'});
    const result=await resolveAgent(7n,mirror);
    expect(result).toMatchObject({status:'external-card',owner:{account:'0.0.655361'},reputation:{count:0}});
  });
  it('separates cards that do not describe a guardian-controlled agent',async()=>{
    const mirror=fakeMirror({ownerOf:()=>[OWNER],tokenURI:()=>[dataUri({name:'Plain agent'})],getClients:()=>[[]]},{[OWNER]:'0.0.655361'});
    expect(await resolveAgent(7n,mirror)).toMatchObject({status:'not-accountable',name:'Plain agent'});
  });
  it('fails closed when a well-formed card cannot be confirmed on Hedera',async()=>{
    const card={name:'Atlas',hederaAccount:'0.0.10',guardian:'0.0.11',hcsTopic:'0.0.12',uaid:'uaid:aid:x',policy:'0x000000000000000000000000000000000000000c'};
    const mirror=fakeMirror({ownerOf:()=>[OWNER],tokenURI:()=>[dataUri(card)],getClients:()=>[[]]});
    const result=await resolveAgent(7n,mirror);
    expect(result.status).toBe('unverified');
    expect(result).toMatchObject({account:'0.0.10',guardian:'0.0.11',reason:'REGISTRY_OWNER_UNKNOWN'});
  });
  it('lists each review with its reviewer',async()=>{
    const mirror=fakeMirror({
      getClients:()=>[[REVIEWER]],
      getSummary:()=>[1n,90n,0],
      readAllFeedback:()=>[[REVIEWER],[1n],[90n],[0],['identity-check'],['verified'],[false]],
    },{[REVIEWER]:'0.0.720898'});
    expect(await readReputation(7n,mirror)).toEqual({count:1,average:'90',reviews:[{reviewer:'0x00000000000000000000000000000000000B0002',reviewerAccount:'0.0.720898',value:'90',tag1:'identity-check',tag2:'verified'}]});
  });
});

describe('feedback input',()=>{
  it('accepts integer scores 0-100 and short lowercase tags only',()=>{
    expect(feedbackInput('125','90','identity-check')).toEqual({agentId:125n,score:90n,tag:'identity-check'});
    expect(feedbackInput('1','0').tag).toBe('interaction');
    for(const [id,score,tag] of [['0','50'],['12a','50'],['5','101'],['5','-1'],['5','9.5'],['5','50','Bad Tag']]) expect(()=>feedbackInput(id,score,tag)).toThrow();
  });
});

describe('recent swaps',()=>{
  it('lists only the agent\'s own fill records, newest first, with the received amount read from the mirror',async()=>{
    const d={agentAccount:'0.0.10',spendAsset:'0.0.20',outputAsset:'0.0.30'};
    const event=(sequence:number,publisher:string,payload:Record<string,unknown>)=>({v:1 as const,type:'fill' as const,ts:'2026-10-01T00:00:00.000Z',agentAccount:'0.0.10',payload,consensusTimestamp:`17908${sequence}.000000001`,sequence,publisher});
    const mirror={
      token:async(id:string)=>({token_id:id,symbol:id==='0.0.20'?'SAUCE':'WHBAR',decimals:id==='0.0.20'?'6':'8',deleted:false}),
      contractTransfers:async()=>({parent:{},transfers:[{account:'0.0.10',token_id:'0.0.30',amount:905763},{account:'0.0.10',token_id:'0.0.20',amount:-500000}]}),
    } as unknown as Mirror;
    const result=await recentFills(d,[
      event(5,'0.0.10',{status:'success',transactionId:'0.0.10@1.000000001',amount:'500000'}),
      event(6,'0.0.99',{status:'success',transactionId:'0.0.99@1.000000001',amount:'1'}),
      event(7,'0.0.10',{status:'failed',transactionId:'0.0.10@2.000000001',amount:'250000',reason:'INSUFFICIENT_GAS'}),
    ],mirror);
    expect(result.spendToken).toEqual({id:'0.0.20',symbol:'SAUCE',decimals:6});
    expect(result.fills.map(f=>[f.sequence,f.status,f.received,f.reason])).toEqual([[7,'failed',null,'INSUFFICIENT_GAS'],[5,'success','905763',null]]);
  });
});

describe('standing URL',()=>{
  it('accepts https or loopback http and normalizes the base',()=>{
    expect(standingBase('https://agent.example.org/')).toBe('https://agent.example.org');
    expect(standingBase(' https://example.org/agents/atlas// ')).toBe('https://example.org/agents/atlas');
    expect(standingBase('http://localhost:3001')).toBe('http://localhost:3001');
    for(const bad of ['http://agent.example.org','ftp://x.org','not a url','https://x.org/?a=1','https://x.org/#f','https://u:p@x.org']) expect(()=>standingBase(bad)).toThrow();
  });
});

describe('lookup route',()=>{
  it('rejects malformed agent IDs before any network read',async()=>{
    const app=createApp('demo',()=>null);
    for(const id of ['0','abc','-1','1e3']) expect((await app.request(`/agents/${id}`)).status).toBe(400);
  });
});
