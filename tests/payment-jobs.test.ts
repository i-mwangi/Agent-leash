import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/shared/src/store';
import { AppError } from '../packages/shared/src/model';
import { addPaymentJob, cancelPaymentJob, listPaymentJobs, parseJob, runDuePaymentJobs } from '../packages/agent/src/payJobs';
import type { ServiceRequest } from '../packages/agent/src/pay';

const NOW=Date.parse('2026-10-01T12:00:00Z');
const URL='http://127.0.0.1:3011/paid/inference';
// Each call opens and closes its own connection, as the runtime does.
const database=()=>{const path=join(mkdtempSync(join(tmpdir(),'jobs-')),'agent.sqlite');return ()=>new Store(path);};

describe('scheduled x402 payment input',()=>{
  it('needs a reachable URL, a price limit, a time 30 seconds to 30 days ahead, and a complete repeat',()=>{
    expect(parseJob({url:URL,maxAmount:'20000',runAt:'2026-10-01T12:05:00Z'},NOW)).toMatchObject({runAt:NOW+300_000,times:1});
    expect(parseJob({url:URL,maxAmount:'20000',runAt:'2026-10-01T12:05:00Z',everySeconds:3600,times:3},NOW).times).toBe(3);
    const bad:[Record<string,unknown>,string][]=[
      [{url:'http://example.com',maxAmount:'1',runAt:'2026-10-01T12:05:00Z'},'INVALID_SERVICE_URL'],
      [{url:URL,maxAmount:'0',runAt:'2026-10-01T12:05:00Z'},'INVALID_AMOUNT'],
      [{url:URL,maxAmount:'1',runAt:'2026-10-01T12:00:10Z'},'SCHEDULE_TOO_SOON'],
      [{url:URL,maxAmount:'1',runAt:'2026-11-15T12:00:00Z'},'SCHEDULE_TOO_LATE'],
      [{url:URL,maxAmount:'1',runAt:'2026-10-01T12:05:00Z',everySeconds:3600},'INVALID_REPEAT'],
      [{url:URL,maxAmount:'1',runAt:'2026-10-01T12:05:00Z',times:3},'INVALID_REPEAT'],
      [{url:URL,maxAmount:'1',runAt:'2026-10-01T12:05:00Z',everySeconds:60,times:3},'INVALID_PAYMENT_JOB'],
    ];
    for(const [input,code] of bad) expect(()=>parseJob(input,NOW)).toThrow(code);
  });
});

describe('running scheduled x402 payments',()=>{
  it('pays each due run through the payer, keeps the answer and stops after the last run',async()=>{
    const open=database();
    const job=addPaymentJob({url:URL,prompt:'Hi',maxAmount:'20000',sellerAgentId:'125',runAt:'2026-10-01T12:05:00Z',everySeconds:3600,times:2},open(),NOW);
    const requests:ServiceRequest[]=[];
    const pay=async(request:ServiceRequest)=>{requests.push(request);return {paid:true,transactionId:`0.0.7162784@179086${requests.length}.000000001`,status:200,body:{answer:`Answer ${requests.length}`}};};
    expect(await runDuePaymentJobs(pay,open(),()=>NOW+60_000)).toEqual([]); // not due yet
    expect(await runDuePaymentJobs(pay,open(),()=>NOW+300_000)).toEqual([job.id]);
    expect(requests[0]).toEqual({url:URL,body:{prompt:'Hi'},maxAmount:20000n,sellerAgentId:125n});
    expect(listPaymentJobs(open())[0]).toMatchObject({status:'scheduled',runs:1,remaining:1,next_run:NOW+300_000+3_600_000,last_status:'PAID'});
    await runDuePaymentJobs(pay,open(),()=>NOW+300_000+3_600_000);
    expect(listPaymentJobs(open())[0]).toMatchObject({status:'done',runs:2,remaining:0,last_status:'PAID',last_transaction:'0.0.7162784@1790862.000000001',last_body:JSON.stringify({answer:'Answer 2'})});
  });
  it('never pays late: slots passed while the runtime was stopped are skipped as missed',async()=>{
    const open=database();
    addPaymentJob({url:URL,maxAmount:'1000',runAt:'2026-10-01T12:05:00Z',everySeconds:3600,times:5},open(),NOW);
    let paid=0;
    // Stopped for three and a half hours: the 12:05, 13:05, 14:05 and 15:05 slots have passed.
    await runDuePaymentJobs(async()=>{paid++;return {paid:true};},open(),()=>NOW+300_000+3.5*3_600_000);
    expect(paid).toBe(0);
    expect(listPaymentJobs(open())[0]).toMatchObject({status:'scheduled',runs:4,remaining:1,last_status:'MISSED',next_run:NOW+300_000+4*3_600_000});
  });
  it('records a refusal, retries when the agent is busy, and lets a job be cancelled',async()=>{
    const open=database();
    const job=addPaymentJob({url:URL,maxAmount:'1000',runAt:'2026-10-01T12:05:00Z',everySeconds:3600,times:3},open(),NOW);
    await runDuePaymentJobs(async()=>{throw new AppError('OPERATION_IN_PROGRESS',409);},open(),()=>NOW+300_000);
    expect(listPaymentJobs(open())[0]).toMatchObject({runs:0,remaining:3,last_status:null});
    await runDuePaymentJobs(async()=>{throw new AppError('PAUSED');},open(),()=>NOW+310_000);
    expect(listPaymentJobs(open())[0]).toMatchObject({runs:1,remaining:2,last_status:'PAUSED',status:'scheduled'});
    expect(cancelPaymentJob(job.id,open())).toEqual({id:job.id,status:'cancelled'});
    expect(()=>cancelPaymentJob(job.id,open())).toThrow('PAYMENT_JOB_NOT_SCHEDULED');
    expect(await runDuePaymentJobs(async()=>({paid:true}),open(),()=>NOW+10*3_600_000)).toEqual([]);
  });
});

describe('funding the agent after setup',()=>{
  it('keeps top-ups in range and leaves the setup account its 2 HBAR reserve',async()=>{
    const { checkTopUp, MAX_HBAR_TOP_UP, MAX_SAUCE_BUY_TINYBARS } = await import('../packages/agent/src/funding');
    expect(()=>checkTopUp(300_000_000n,1_476_000_000n,MAX_HBAR_TOP_UP)).not.toThrow();
    expect(()=>checkTopUp(0n,1_476_000_000n,MAX_HBAR_TOP_UP)).toThrow('FUND_AMOUNT_OUT_OF_RANGE');
    expect(()=>checkTopUp(2_100_000_000n,9_000_000_000n,MAX_HBAR_TOP_UP)).toThrow('FUND_AMOUNT_OUT_OF_RANGE');
    expect(()=>checkTopUp(200_000_000n,MAX_SAUCE_BUY_TINYBARS*3n,MAX_SAUCE_BUY_TINYBARS)).toThrow('FUND_AMOUNT_OUT_OF_RANGE');
    expect(()=>checkTopUp(300_000_000n,450_000_000n,MAX_HBAR_TOP_UP)).toThrow('SETUP_ACCOUNT_HBAR_LOW');
  });
  it('allows the swap token and USDC in one setup transaction',async()=>{
    const { policyTokens } = await import('../packages/agent/src/setup');
    expect(policyTokens('0.0.1183558')).toEqual(['0.0.1183558','0.0.429274']);
    expect(policyTokens('0.0.429274')).toEqual(['0.0.429274']);
  });
});
