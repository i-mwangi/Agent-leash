import { describe,it,expect,vi } from 'vitest';
import { Wallet,getBytes } from 'ethers';
import { Mirror } from '../packages/shared/src/mirror';
import { compileVaultTerms,vaultTermsHash } from '../packages/shared/src/vaultTerms';
import { verifyVaultApproval,verifyVaultRules } from '../packages/shared/src/vaultVerification';
import { createLiveReader,type ReadState } from '../packages/nextjs/app/live-data';

describe('HCS publisher boundaries',()=>{
  const authority={identityPublishers:['0.0.1','0.0.2'],agentAccount:'0.0.3'};
  const event=(type:string)=>({v:1,type,ts:'2026-01-01T00:00:00.000Z',agentAccount:'0.0.3',payload:{}});
  const row=(payer:string,value:unknown,sequence:number)=>({message:Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64'),payer_account_id:payer,sequence_number:sequence,consensus_timestamp:`100.${sequence}`});
  it('preserves trusted records across pages containing malformed and forged agent messages',async()=>{
    const pages=[{messages:[row('0.0.1',event('created'),1),row('0.0.3','not-json',2),row('0.0.3',event('policy'),3)],links:{next:'/api/v1/topics/0.0.4/messages?next=1'}},{messages:[row('0.0.3',{...event('fill'),agentAccount:'0.0.999'},4),row('0.0.2',event('rotated'),5),row('0.0.3',event('fill'),6)],links:{next:null}}];
    const fetcher=vi.fn(async()=>new Response(JSON.stringify(pages.shift())));
    const result=await new Mirror(fetcher as typeof fetch).events('0.0.4',authority);
    expect(result.map(e=>[e.type,e.publisher])).toEqual([['created','0.0.1'],['rotated','0.0.2'],['fill','0.0.3']]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('still fails closed for malformed authoritative records or unavailable mirror pages',async()=>{
    const mirror=new Mirror(async()=>new Response(JSON.stringify({messages:[row('0.0.2','broken',1)],links:{next:null}})));
    await expect(mirror.events('0.0.4',authority)).rejects.toThrow('HCS_INVALID_MESSAGE');
    await expect(new Mirror(async()=>new Response('',{status:503})).events('0.0.4',authority)).rejects.toThrow('MIRROR_UNAVAILABLE');
  });
});

describe('vault agreement verification',()=>{
  const context={network:'hedera:testnet' as const,agentAccount:'0.0.3',guardianAccount:'0.0.2'};
  const recipient='0x0000000000000000000000000000000000001234';
  const other='0x0000000000000000000000000000000000005678';
  const terms=compileVaultTerms(`No more than 1 HBAR per transaction and 5 HBAR per UTC day; only to ${recipient}.`);
  const hash=vaultTermsHash(terms,context);
  const chain={hash,maxPerTx:100_000_000n,maxPerDay:500_000_000n,recipients:[recipient]};
  it('rejects added and removed on-chain recipients even when caps and hash match',()=>{
    expect(()=>verifyVaultRules(terms,hash,chain)).not.toThrow();
    expect(()=>verifyVaultRules(terms,hash,{...chain,recipients:[recipient,other]})).toThrow('VAULT_RECIPIENTS_MISMATCH');
    expect(()=>verifyVaultRules(terms,hash,{...chain,recipients:[]})).toThrow('VAULT_RECIPIENTS_MISMATCH');
  });
  it('rejects tampered local terms, signature and deployment context',async()=>{
    const guardian=new Wallet('0x'+'1'.padStart(64,'0'));
    const record={context,terms,hash,signature:await guardian.signMessage(getBytes(hash))};
    expect(()=>verifyVaultApproval(record,context,guardian.address)).not.toThrow();
    expect(()=>verifyVaultApproval({...record,terms:{...terms,allowedRecipients:[other]}},context,guardian.address)).toThrow('VAULT_TERMS_HASH_MISMATCH');
    expect(()=>verifyVaultApproval(record,{...context,agentAccount:'0.0.9'},guardian.address)).toThrow('VAULT_CONTEXT_MISMATCH');
    expect(()=>verifyVaultApproval(record,context,other)).toThrow('VAULT_SIGNATURE_INVALID');
  });
});

describe('live dashboard refresh',()=>{
  const response=(path:string)=>new Response(JSON.stringify(path.endsWith('/agent/status')?{keyState:{agentKeyActive:true},paused:false}:path.endsWith('/policy/snapshot')?{snapshot:{balance:'50',spentToday:'1',maxPerTx:'10',maxPerDay:'100'}}:{liveAdaptersReady:true,milestones:[]}));
  it('clears previous readings on HTTP failures and network errors',async()=>{
    const states:ReadState[]=[];
    let mode='ok';
    const reader=createLiveReader(state=>states.push(state),(async(path)=>{
      if(mode==='network') throw new Error('offline');
      return mode==='http'?new Response('',{status:503}):response(String(path));
    }) as typeof fetch);
    await reader.refresh();expect(states.at(-1)?.value?.snapshot.balance).toBe('50');
    for(const failure of ['http','network']) {
      mode=failure;const refresh=reader.refresh();
      expect(states.at(-1)).toEqual({value:null,loading:true,error:null});
      await refresh;expect(states.at(-1)).toMatchObject({value:null,loading:false,error:expect.any(String)});
    }
    reader.dispose();
  });
  it('ignores a stale success arriving after a newer refresh fails',async()=>{
    const states:ReadState[]=[];let release!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;});
    let slow=true;
    const reader=createLiveReader(state=>states.push(state),(async(path)=>{
      if(slow) {await wait;return response(String(path));}
      return new Response('',{status:503});
    }) as typeof fetch);
    const old=reader.refresh();slow=false;await reader.refresh();release();await old;
    expect(states.at(-1)).toMatchObject({value:null,error:expect.any(String)});
    reader.dispose();
  });
});
