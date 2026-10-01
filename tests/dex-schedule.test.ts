import { describe, expect, it } from 'vitest';
import { Mirror } from '../packages/shared/src/mirror';
import { Store } from '../packages/shared/src/store';
import { ROUTER_ABI } from '../packages/shared/src/sources';
import { MAINNET, compareVenues, decimalUnits, sellIntoBids } from '../packages/shared/src/venues';
import { cancelReason, scheduleState, scheduleTime, scheduledMinimum } from '../packages/agent/src/schedule';
import { createSetupApp, SETUP_HEADER, type AgentTasks } from '../packages/agent/src/service';
import { toUnits } from '../packages/nextjs/app/live-data';
import type { PolicySnapshot } from '../packages/agent/src/policyClient';

const NOW=Date.parse('2026-10-01T12:00:00Z');
const snapshot=(overrides:Partial<PolicySnapshot>={}):PolicySnapshot=>({policyExists:true,paused:false,agentKeyActive:true,hcsReady:true,identityRegistered:true,allowedTokens:['0.0.20'],maxPerTx:1_000_000n,maxPerDay:5_000_000n,spentToday:0n,pendingToday:0n,balance:9_000_000n,...overrides});

describe('scheduled swap rules',()=>{
  it('accepts execution times between two minutes and seven days ahead',()=>{
    expect(scheduleTime('2026-10-01T12:10:00Z',NOW).toISOString()).toBe('2026-10-01T12:10:00.000Z');
    expect(()=>scheduleTime('2026-10-01T12:01:00Z',NOW)).toThrow('SCHEDULE_TOO_SOON');
    expect(()=>scheduleTime('2026-10-09T12:00:00Z',NOW)).toThrow('SCHEDULE_TOO_LATE');
    expect(()=>scheduleTime('tomorrow',NOW)).toThrow('INVALID_SCHEDULE_TIME');
  });
  it('accepts at most 3% less output than quoted',()=>{
    expect(scheduledMinimum(1_000_000n)).toBe(970_000n);
  });
  it('cancels a pending swap the current policy would refuse, but not for a spent daily budget',()=>{
    expect(cancelReason(snapshot(),'0.0.20',500_000n)).toBeNull();
    expect(cancelReason(snapshot({paused:true}),'0.0.20',500_000n)).toBe('PAUSED');
    expect(cancelReason(snapshot({maxPerTx:100n}),'0.0.20',500_000n)).toBe('OVER_TX_CAP');
    expect(cancelReason(snapshot({allowedTokens:[]}),'0.0.20',500_000n)).toBe('ASSET_NOT_ALLOWED');
    expect(cancelReason(snapshot({agentKeyActive:false}),'0.0.20',500_000n)).toBe('AGENT_KEY_INACTIVE');
    // The schedule's own reservation is already in the daily total, so the daily cap is checked once, at creation.
    expect(cancelReason(snapshot({spentToday:5_000_000n}),'0.0.20',500_000n)).toBeNull();
  });
  it('classifies a schedule from the mirror alone',()=>{
    const base={schedule_id:'0.0.9',deleted:false,executed_timestamp:null,expiration_time:'1790856000.000000000'};
    expect(scheduleState(base,1790856000_000)).toBe('pending');
    expect(scheduleState({...base,executed_timestamp:'1790856000.1'},NOW)).toBe('executed');
    expect(scheduleState({...base,deleted:true},NOW)).toBe('deleted');
    expect(scheduleState(base,1790856061_000)).toBe('expired');
  });
  it('keeps the router allowance covering every pending scheduled amount',()=>{
    const store=new Store(':memory:');
    const row={tx_id:'0.0.10@1.000000001',asset:'0.0.20',minimum:'1',execute_at:'2026-10-01T12:10:00.000Z'};
    store.addSchedule({...row,schedule_id:'0.0.31',amount:'500000'});
    store.addSchedule({...row,schedule_id:'0.0.32',amount:'250000'});
    expect(store.scheduledOutstanding('0.0.20')).toBe(750_000n);
    store.finishSchedule('0.0.31','executed');
    store.finishSchedule('0.0.31','cancelled');
    expect(store.schedules().find(s=>s.schedule_id==='0.0.31')?.status).toBe('executed');
    expect(store.scheduledOutstanding('0.0.20')).toBe(250_000n);
    store.close();
  });
});

describe('scheduled transactions on the mirror',()=>{
  it('reads the scheduled execution, not the ScheduleCreate that shares its ID',async()=>{
    const requested:string[]=[];
    const mirror=new Mirror(async url=>{
      requested.push(String(url));
      return Response.json({transactions:[
        {transaction_id:'0.0.10-1-000000001',name:'SCHEDULECREATE',result:'SUCCESS',scheduled:false,nonce:0,consensus_timestamp:'1.1',token_transfers:[]},
        {transaction_id:'0.0.10-1-000000001',name:'CONTRACTCALL',result:'SUCCESS',scheduled:true,nonce:0,consensus_timestamp:'2.1',entity_id:'0.0.19264',token_transfers:[{account:'0.0.10',token_id:'0.0.20',amount:-5}]},
        {transaction_id:'0.0.10-1-000000001',name:'CRYPTOTRANSFER',result:'SUCCESS',scheduled:false,nonce:1,consensus_timestamp:'2.2',token_transfers:[{account:'0.0.10',token_id:'0.0.30',amount:9}]},
      ]});
    });
    expect((await mirror.transaction('0.0.10@1.000000001')).name).toBe('SCHEDULECREATE');
    expect((await mirror.transaction('0.0.10@1.000000001',true)).name).toBe('CONTRACTCALL');
    expect(requested.at(-1)).toContain('?scheduled=true');
    const {parent,transfers}=await mirror.contractTransfers('0.0.10@1.000000001',true);
    expect(parent.entity_id).toBe('0.0.19264');
    expect(transfers.map(t=>t.amount)).toEqual([-5,9]);
    // That filter would drop the child transfers, so transfers are read from the unfiltered rows.
    expect(requested.at(-1)).not.toContain('scheduled');
  });
});

describe('venue comparison',()=>{
  it('parses exchange decimals without rounding',()=>{
    expect(decimalUnits('0.103290',6)).toBe(103_290n);
    expect(decimalUnits('435.00000000',8)).toBe(43_500_000_000n);
    for(const bad of ['0.1032901','-1','1e5','']) expect(()=>decimalUnits(bad,6)).toThrow('VENUE_INVALID_NUMBER');
  });
  it('sells into bids best price first and reports what the book cannot fill',()=>{
    const bids:[string,string][]=[['0.104000','50'],['0.100000','100']];
    expect(sellIntoBids(bids,100n*100_000_000n)).toEqual({filled:100n*100_000_000n,usdc:10_200_000n});
    expect(sellIntoBids(bids,500n*100_000_000n)).toEqual({filled:150n*100_000_000n,usdc:15_200_000n});
    expect(()=>sellIntoBids([['0.1','1'],['0.2','1']],200_000_000n)).toThrow('VENUE_BOOK_UNSORTED');
  });
  it('quotes both venues and reports a failing one instead of estimating it',async()=>{
    const mirror=new Mirror(async(url,init)=>{
      const path=new URL(String(url)).pathname;
      if(path.endsWith(MAINNET.whbar)) return Response.json({token_id:MAINNET.whbar,symbol:'WHBAR',decimals:'8',deleted:false});
      if(path.endsWith(MAINNET.usdc)) return Response.json({token_id:MAINNET.usdc,symbol:'USDC',decimals:'6',deleted:false});
      const {data}=JSON.parse(String(init?.body)) as {data:string};
      const [amount]=ROUTER_ABI.decodeFunctionData('getAmountsOut',data);
      return Response.json({result:ROUTER_ABI.encodeFunctionResult('getAmountsOut',[[amount,10_406_786n]])});
    },'https://mainnet-public.mirrornode.hedera.com');
    const result=await compareVenues(100n*100_000_000n,{mirror,fetcher:async()=>new Response('down',{status:503})});
    expect(result).toMatchObject({readOnly:true,transactionSubmitted:false,network:'hedera:mainnet'});
    expect(result.venues[0]).toMatchObject({ok:true,quote:{venue:'SaucerSwap V1',usdcOut:'10406786'}});
    expect(result.venues[1]).toEqual({ok:false,error:'LAMBDAPLEX_UNAVAILABLE'});
    await expect(compareVenues(0n,{mirror})).rejects.toThrow('INVALID_AMOUNT');
  });
});

describe('dashboard amounts',()=>{
  it('converts human amounts with the token decimals and refuses rounding',()=>{
    expect(toUnits('0.5',6)).toBe(500_000n);
    expect(toUnits('12',8)).toBe(1_200_000_000n);
    for(const bad of ['0','0.0000001','abc','-1','1,000']) expect(toUnits(bad,6)).toBeNull();
  });
});

describe('agent tasks from the dashboard',()=>{
  const headers={[SETUP_HEADER]:'1','Content-Type':'application/json'};
  const idle=async()=>({stage:'done' as const,operatorPublicKey:'',agentPublicKey:'',fundingTinybars:'0'});
  it('runs one policy-checked task at a time and validates input first',async()=>{
    let release!:()=>void;
    const calls:string[]=[];
    const tasks:AgentTasks={
      swap:async amount=>{calls.push(`swap:${amount}`);await new Promise<void>(resolve=>{release=resolve;});return {transactionId:'0.0.10@1.000000001'};},
      schedule:async(amount,at)=>{calls.push(`schedule:${amount}:${at}`);throw new Error('SCHEDULE_TOO_SOON');},
      cancel:async id=>{calls.push(`cancel:${id}`);return {};},
      schedules:()=>[],
      pay:async()=>({}),
      price:async()=>({}),
    };
    const {app}=createSetupApp(idle,async()=>undefined,tasks);
    expect((await app.request('/setup/agent/swap',{method:'POST',body:JSON.stringify({amount:'5'})})).status).toBe(403);
    for(const amount of ['0','-1','1.5',5,null]) expect((await app.request('/setup/agent/swap',{method:'POST',headers,body:JSON.stringify({amount})})).status).toBe(400);
    expect((await (await app.request('/setup/agent/swap',{method:'POST',headers,body:JSON.stringify({amount:'500000'})})).json()).task).toMatchObject({kind:'swap',running:true});
    expect((await app.request('/setup/agent/schedule',{method:'POST',headers,body:JSON.stringify({amount:'1',executeAt:'2026-10-02T00:00:00Z'})})).status).toBe(409);
    release();await new Promise(resolve=>setTimeout(resolve,0));
    expect((await (await app.request('/setup/agent',{headers})).json()).task).toMatchObject({kind:'swap',running:false,error:null,result:{transactionId:'0.0.10@1.000000001'}});
    await app.request('/setup/agent/schedule',{method:'POST',headers,body:JSON.stringify({amount:'1',executeAt:'2026-10-02T00:00:00Z'})});
    await new Promise(resolve=>setTimeout(resolve,0));
    expect((await (await app.request('/setup/agent',{headers})).json()).task).toMatchObject({kind:'schedule',running:false,error:'SCHEDULE_TOO_SOON'});
    expect((await app.request('/setup/agent/schedules/not-an-id/cancel',{method:'POST',headers})).status).toBe(400);
    expect(calls).toEqual(['swap:500000','schedule:1:2026-10-02T00:00:00Z']);
  });
});

describe('agent fee reserve',()=>{
  it('covers the full gas limits Hedera reserves, plus schedule creation when scheduling',async()=>{
    const { hbarNeeded, gasPrice } = await import('../packages/shared/src/fees');
    expect(hbarNeeded(81n,{approve:false,schedule:false})).toBe(300_000n*81n+10_000_000n);
    expect(hbarNeeded(81n,{approve:true,schedule:true})).toBe(1_000_000n*81n+300_000n*81n+120_000_000n+10_000_000n);
    // The failing testnet schedule had 0.31 HBAR left; a new schedule now needs about 1.6 HBAR up front.
    expect(hbarNeeded(81n,{approve:false,schedule:true})>31_000_000n).toBe(true);
    const mirror=new Mirror(async()=>Response.json({fees:[{gas:81,transaction_type:'ContractCall'}]}));
    expect(await gasPrice(mirror)).toBe(81n);
    await expect(gasPrice(new Mirror(async()=>Response.json({fees:[]})))).rejects.toThrow('GAS_PRICE_UNAVAILABLE');
  });
});
