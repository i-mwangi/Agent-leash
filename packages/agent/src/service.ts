// Local agent runtime for browser setup. It holds the generated setup and agent keys; the standing
// API never does. It listens on loopback only and the dashboard reaches it through the Next.js proxy.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { AppError } from '../../shared/src/model';
import { advance, chooseGuardian, type Progress } from './wizard';

export const SETUP_HEADER='x-accountable-setup';
const ALLOWED_ORIGINS=new Set(['http://localhost:3000','http://127.0.0.1:3000']);

export function createSetupApp(run:()=>Promise<Progress>=()=>advance(),select:(id:string)=>Promise<unknown>=id=>chooseGuardian(id)) {
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
  return {app,start};
}

if(process.argv[1]?.replace(/\\/g,'/').endsWith('/agent/src/service.ts')) {
  const {app,start}=createSetupApp();
  serve({fetch:app.fetch,port:3002,hostname:'127.0.0.1'});
  start();
  console.log('Accountable Agent setup runtime: http://127.0.0.1:3002 (local only)');
}
