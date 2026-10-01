// Local agent runtime for browser setup. It holds the generated setup and agent keys; the standing
// API never does. It listens on loopback only and the dashboard reaches it through the Next.js proxy.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { AppError, entityId, uint } from '../../shared/src/model';
import { advance, chooseGuardian, type Progress } from './wizard';
import { spend } from './spend';
import { cancelSchedule, listSchedules, reconcileSchedules, scheduleSwap } from './schedule';

/** Agent work the dashboard can request. Each one runs the same policy-checked code as the CLI. */
export interface AgentTasks {
  swap:(amount:bigint)=>Promise<unknown>;
  schedule:(amount:bigint,executeAt:string)=>Promise<unknown>;
  cancel:(scheduleId:string)=>Promise<unknown>;
  schedules:()=>unknown[];
}
const agentTasks:AgentTasks={swap:spend,schedule:scheduleSwap,cancel:id=>cancelSchedule(id,'CANCELLED_FROM_DASHBOARD'),schedules:listSchedules};
const amountOf=(value:unknown)=>{
  const parsed=uint.safeParse(value);
  if(!parsed.success || BigInt(parsed.data)<=0n) throw new AppError('INVALID_AMOUNT',400);
  return BigInt(parsed.data);
};

export const SETUP_HEADER='x-accountable-setup';
const ALLOWED_ORIGINS=new Set(['http://localhost:3000','http://127.0.0.1:3000']);

export function createSetupApp(run:()=>Promise<Progress>=()=>advance(),select:(id:string)=>Promise<unknown>=id=>chooseGuardian(id),tasks:AgentTasks=agentTasks) {
  let running:Promise<void>|null=null;
  let progress:Progress|null=null;
  let lastError:string|null=null;
  let step='';
  const start=()=>{
    if(running) return;
    step='Checking setup progress on Hedera testnet';
    running=(async()=>{
      try{progress=await run();lastError=null;}
      catch(error){lastError=error instanceof AppError?error.code:error instanceof Error?error.message:'SETUP_FAILED';}
      finally{running=null;step='';}
    })();
  };
  const state=()=>({running:!!running,step,lastError,progress});
  const app=new Hono();
  // A custom header forces a CORS preflight, which this server never approves, so other web
  // pages cannot drive setup spending; a present Origin must be the local dashboard.
  app.use('*',async(c,next)=>{
    const origin=c.req.header('origin');
    if(c.req.header(SETUP_HEADER)!=='1' || (origin && !ALLOWED_ORIGINS.has(origin))) return c.json({error:'SETUP_REQUEST_REJECTED'},403);
    c.header('Cache-Control','no-store');
    await next();
  });
  app.onError((error,c)=>c.json({error:error instanceof AppError?error.code:'SETUP_FAILED'},error instanceof AppError?error.status:500));
  app.get('/setup/state',c=>c.json(state()));
  app.post('/setup/advance',c=>{start();return c.json(state());});
  app.post('/setup/guardian',async c=>{
    const body=await c.req.json().catch(()=>null) as {accountId?:unknown}|null;
    if(typeof body?.accountId!=='string') throw new AppError('INVALID_REQUEST',400);
    if(running) throw new AppError('SETUP_BUSY',409);
    await select(body.accountId);
    start();
    return c.json(state());
  });
  // One agent task at a time; the dashboard polls for the outcome because a swap takes several seconds.
  let task:{kind:string;running:boolean;result:unknown;error:string|null;startedAt:string}|null=null;
  const begin=(kind:string,work:()=>Promise<unknown>)=>{
    if(task?.running) throw new AppError('AGENT_BUSY',409);
    const current={kind,running:true,result:null as unknown,error:null as string|null,startedAt:new Date().toISOString()};
    task=current;
    void work().then(result=>{current.result=result;},error=>{current.error=error instanceof AppError?error.code:error instanceof Error?error.message:'TASK_FAILED';}).finally(()=>{current.running=false;});
    return current;
  };
  const agentState=()=>({task,schedules:tasks.schedules()});
  app.get('/setup/agent',c=>c.json(agentState()));
  app.post('/setup/agent/swap',async c=>{
    const body=await c.req.json().catch(()=>null) as {amount?:unknown}|null;
    const amount=amountOf(body?.amount);
    begin('swap',()=>tasks.swap(amount));
    return c.json(agentState());
  });
  app.post('/setup/agent/schedule',async c=>{
    const body=await c.req.json().catch(()=>null) as {amount?:unknown;executeAt?:unknown}|null;
    const amount=amountOf(body?.amount);
    if(typeof body?.executeAt!=='string') throw new AppError('INVALID_SCHEDULE_TIME',400);
    const executeAt=body.executeAt;
    begin('schedule',()=>tasks.schedule(amount,executeAt));
    return c.json(agentState());
  });
  app.post('/setup/agent/schedules/:id/cancel',c=>{
    const id=entityId.safeParse(c.req.param('id'));
    if(!id.success) throw new AppError('INVALID_REQUEST',400);
    begin('cancel',()=>tasks.cancel(id.data));
    return c.json(agentState());
  });
  return {app,start,busy:()=>!!task?.running};
}

if(process.argv[1]?.replace(/\\/g,'/').endsWith('/agent/src/service.ts')) {
  const {app,start,busy}=createSetupApp();
  serve({fetch:app.fetch,port:3002,hostname:'127.0.0.1'});
  start();
  // Record scheduled swap outcomes and cancel pending ones the current policy refuses.
  let lastError='';
  setInterval(()=>{
    if(busy()) return;
    reconcileSchedules().then(()=>{lastError='';}).catch(error=>{
      const code=error instanceof AppError?error.code:'SCHEDULE_RECONCILE_FAILED';
      if(code!==lastError && code!=='OPERATION_IN_PROGRESS') console.error(`Accountable Agent runtime: scheduled swaps not reconciled (${code})`);
      lastError=code;
    });
  },20_000).unref();
  console.log('Accountable Agent setup runtime: http://127.0.0.1:3002 (local only)');
}
