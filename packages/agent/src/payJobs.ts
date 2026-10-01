import { resolve } from 'node:path';
import { z } from 'zod';
import { DATA } from '../../shared/src/files';
import { AppError, uint } from '../../shared/src/model';
import { Store } from '../../shared/src/store';
import { payService, serviceUrl, type ServiceRequest } from './pay';

/**
 * Scheduled x402 payments. x402 is an HTTP exchange (request, price, signed payment, answer), so it
 * cannot be pre-signed into a Hedera schedule: the local agent runtime runs each payment when it is
 * due, through `payService`, so the guardian's policy is checked at that moment, right before signing.
 * Jobs run only while the runtime is running; a run more than GRACE late is skipped as missed.
 */
export const MIN_LEAD_MS=30_000;
export const MAX_LEAD_MS=30*24*60*60_000;
export const MIN_INTERVAL_S=300;
export const MAX_RUNS=100;
export const GRACE_MS=15*60_000;
const BODY_CHARS=4000;

export const jobInput=z.object({
  url:z.string().max(500),
  prompt:z.string().trim().min(1).max(4000).optional(),
  maxAmount:uint,
  sellerAgentId:uint.optional(),
  runAt:z.string(),
  everySeconds:z.number().int().min(MIN_INTERVAL_S).max(30*24*60*60).optional(),
  times:z.number().int().min(1).max(MAX_RUNS).optional(),
}).strict();
export type JobInput=z.infer<typeof jobInput>;

export interface PaymentJob {
  id:number; url:string; prompt:string|null; max_amount:string; seller_agent_id:string|null;
  next_run:number; every_seconds:number|null; remaining:number; runs:number; status:'scheduled'|'done'|'cancelled';
  last_status:string|null; last_transaction:string|null; last_body:string|null; last_run:number|null; created:number;
}

function ensure(store:Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS payment_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT NOT NULL,prompt TEXT,max_amount TEXT NOT NULL,seller_agent_id TEXT,
    next_run INTEGER NOT NULL,every_seconds INTEGER,remaining INTEGER NOT NULL,runs INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,
    last_status TEXT,last_transaction TEXT,last_body TEXT,last_run INTEGER,created INTEGER NOT NULL)`);
  return store;
}
const open=()=>ensure(new Store(resolve(DATA,'agent.sqlite')));

/** Validate a new job; a repeat needs both an interval and a run count. */
export function parseJob(input:unknown,now=Date.now()) {
  const parsed=jobInput.safeParse(input);
  if(!parsed.success) throw new AppError('INVALID_PAYMENT_JOB',400);
  const job=parsed.data;
  serviceUrl(job.url);
  if(BigInt(job.maxAmount)<=0n) throw new AppError('INVALID_AMOUNT',400);
  const at=new Date(job.runAt).getTime();
  if(!Number.isFinite(at)) throw new AppError('INVALID_SCHEDULE_TIME',400);
  if(at<now+MIN_LEAD_MS) throw new AppError('SCHEDULE_TOO_SOON',400);
  if(at>now+MAX_LEAD_MS) throw new AppError('SCHEDULE_TOO_LATE',400);
  if((job.everySeconds!==undefined && job.times===undefined) || (job.everySeconds===undefined && (job.times??1)>1)) throw new AppError('INVALID_REPEAT',400);
  return {...job,runAt:at,times:job.everySeconds?job.times??1:1};
}

export function addPaymentJob(input:unknown,store=open(),now=Date.now()) {
  const job=parseJob(input,now);
  ensure(store);
  try {
    const result=store.db.prepare("INSERT INTO payment_jobs(url,prompt,max_amount,seller_agent_id,next_run,every_seconds,remaining,status,created) VALUES(?,?,?,?,?,?,?,'scheduled',?)")
      .run(job.url,job.prompt??null,job.maxAmount,job.sellerAgentId??null,job.runAt,job.everySeconds??null,job.times,now);
    return store.db.prepare('SELECT * FROM payment_jobs WHERE id=?').get(Number(result.lastInsertRowid)) as unknown as PaymentJob;
  } finally { store.close(); }
}

export function listPaymentJobs(store=open()) {
  ensure(store);
  try { return store.db.prepare('SELECT * FROM payment_jobs ORDER BY (status=\'scheduled\') DESC, next_run DESC LIMIT 20').all() as unknown as PaymentJob[]; }
  finally { store.close(); }
}

export function cancelPaymentJob(id:number,store=open()) {
  ensure(store);
  try {
    const changed=store.db.prepare("UPDATE payment_jobs SET status='cancelled' WHERE id=? AND status='scheduled'").run(id);
    if(!changed.changes) throw new AppError('PAYMENT_JOB_NOT_SCHEDULED',409);
    return {id,status:'cancelled'};
  } finally { store.close(); }
}

const request=(job:PaymentJob):ServiceRequest=>({url:job.url,body:job.prompt?{prompt:job.prompt}:undefined,maxAmount:BigInt(job.max_amount),sellerAgentId:job.seller_agent_id?BigInt(job.seller_agent_id):undefined});

/**
 * Run every due job once. A run more than GRACE late (the runtime was stopped) is recorded as missed
 * and never paid late. A busy agent leaves the job due for the next check rather than failing it.
 */
export async function runDuePaymentJobs(pay:(request:ServiceRequest)=>Promise<unknown>=payService,store=open(),now=()=>Date.now()) {
  const ran:number[]=[];
  ensure(store);
  try {
    const due=store.db.prepare("SELECT * FROM payment_jobs WHERE status='scheduled' AND next_run<=? ORDER BY next_run").all(now()) as unknown as PaymentJob[];
    for(const job of due) {
      let status:string,transaction:string|null=null,body:string|null=null,skipped=1;
      if(now()-job.next_run>GRACE_MS) {
        status='MISSED';
        // Skip every slot that passed while the runtime was stopped; none is paid late.
        if(job.every_seconds) skipped=Math.min(job.remaining,Math.ceil((now()-job.next_run)/(job.every_seconds*1000)));
      }
      else {
        try {
          const result=await pay(request(job)) as {paid?:boolean;transactionId?:string;status?:number|null;body?:unknown};
          status=result.paid?'PAID':`NOT_PAID_HTTP_${result.status??'none'}`;
          transaction=result.transactionId??null;
          body=result.body===undefined||result.body===null?null:(typeof result.body==='string'?result.body:JSON.stringify(result.body)).slice(0,BODY_CHARS);
        } catch(error) {
          const code=error instanceof AppError?error.code:error instanceof Error?error.message:'PAYMENT_FAILED';
          if(code==='OPERATION_IN_PROGRESS') continue; // another agent task holds the lock; try again next check
          status=code;
        }
      }
      const remaining=job.remaining-skipped;
      const next=job.every_seconds?job.next_run+skipped*job.every_seconds*1000:job.next_run;
      store.db.prepare('UPDATE payment_jobs SET runs=runs+?,remaining=?,next_run=?,status=?,last_status=?,last_transaction=COALESCE(?,last_transaction),last_body=COALESCE(?,last_body),last_run=? WHERE id=? AND status=\'scheduled\'')
        .run(skipped,remaining,next,remaining>0?'scheduled':'done',status,transaction,body,now(),job.id);
      ran.push(job.id);
    }
    return ran;
  } finally { store.close(); }
}
