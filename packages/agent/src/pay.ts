import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createClientHederaSigner, inspectHederaTransaction } from '@x402/hedera';
import { resolve } from 'node:path';
import { DATA, readDeployment } from '../../shared/src/files';
import { AppError, NETWORK, USDC, entityId } from '../../shared/src/model';
import { Mirror, mirrorTxId, verifyTransfer } from '../../shared/src/mirror';
import { resolveAgent } from '../../shared/src/resolve';
import { policySnapshot } from '../../shared/src/sources';
import { Store } from '../../shared/src/store';
import { guardedSign } from './policyClient';
import { roleKey, writeEvidence } from './runtime';
import { publish } from './setup';

/**
 * The agent pays for an HTTP service that charges over x402: an LLM endpoint, a data API, or any
 * other resource that accepts USDC on Hedera testnet. Every payment passes the same policy check as
 * a swap, is signed with the agent key, confirmed on the mirror and recorded on the agent's HCS topic.
 */
export interface ServiceRequest { url:string; method?:'GET'|'POST'; body?:unknown; maxAmount?:bigint; sellerAgentId?:bigint }
const MAX_BODY_CHARS=8000;

/** https anywhere, or http only to this machine (for a local seller during development). */
export function serviceUrl(value:string) {
  let url:URL;
  try{url=new URL(value.trim());}catch{throw new AppError('INVALID_SERVICE_URL',400);}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(!(url.protocol==='https:' || (url.protocol==='http:' && local)) || url.username || url.password) throw new AppError('INVALID_SERVICE_URL',400);
  return url;
}

/** The single payment option this agent may use: exact USDC on Hedera testnet, within an optional limit. */
export function chooseRequirement(required:Pick<PaymentRequired,'x402Version'|'accepts'>,maxAmount?:bigint):PaymentRequirements {
  if(required.x402Version!==2) throw new AppError('UNSUPPORTED_X402_VERSION',422);
  const options=required.accepts.filter(a=>a.scheme==='exact' && a.network===NETWORK && a.asset===USDC && /^[1-9]\d{0,17}$/.test(a.amount)
    && entityId.safeParse(a.payTo).success && entityId.safeParse(a.extra?.feePayer).success);
  if(!options.length) throw new AppError('NO_HEDERA_USDC_OPTION',422);
  const cheapest=options.reduce((a,b)=>BigInt(b.amount)<BigInt(a.amount)?b:a);
  if(maxAmount!==undefined && BigInt(cheapest.amount)>maxAmount) throw new AppError('PRICE_ABOVE_LIMIT',422);
  return cheapest;
}

function requestInit(request:ServiceRequest):RequestInit {
  const method=request.method??(request.body===undefined?'GET':'POST');
  return {method,headers:request.body===undefined?{}:{'Content-Type':'application/json'},body:request.body===undefined?undefined:JSON.stringify(request.body),signal:AbortSignal.timeout(90_000),redirect:'error'};
}
async function readBody(response:Response) {
  const text=(await response.text().catch(()=>'')).slice(0,MAX_BODY_CHARS);
  try{return JSON.parse(text) as unknown;}catch{return text;}
}

/** Ask the service its price without paying. */
export async function priceOf(request:ServiceRequest,fetcher:typeof fetch=fetch) {
  const url=serviceUrl(request.url);
  const response=await fetcher(url,requestInit(request)).catch(()=>{throw new AppError('SERVICE_UNREACHABLE');});
  if(response.status!==402) return {paymentRequired:false as const,status:response.status};
  const required=new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(name=>response.headers.get(name),await response.json().catch(()=>undefined));
  const requirement=chooseRequirement(required,request.maxAmount);
  return {paymentRequired:true as const,description:required.resource?.description??null,amount:requirement.amount,asset:requirement.asset,payTo:requirement.payTo,network:requirement.network};
}

/**
 * A signed payment the seller never submitted can only execute inside Hedera's 180-second validity
 * window. Wait it out; if the mirror still has nothing, no money moved and the reservation can go.
 */
const VALIDITY_MS=180_000,MIRROR_LAG_MS=20_000;
export async function settledOrExpired(txId:string,mirror:Mirror,now=()=>Date.now(),sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))) {
  const start=Number(/@(\d+)\./.exec(txId)?.[1]??NaN)*1000;
  if(!Number.isFinite(start)) throw new AppError('INVALID_TRANSACTION_ID');
  const deadline=start+VALIDITY_MS+MIRROR_LAG_MS;
  for(;;) {
    const found=await mirror.transaction(txId).catch(()=>null);
    if(found) return found;
    if(now()>=deadline) return null;
    await sleep(Math.min(10_000,Math.max(1_000,deadline-now())));
  }
}

/** Verify the seller is the ERC-8004 agent the caller named, and that it is paid at its own account. */
async function checkSeller(agentId:bigint,payTo:string,mirror:Mirror) {
  const seller=await resolveAgent(agentId,mirror);
  if(seller.status!=='verified' || seller.account!==payTo) throw new AppError('SELLER_NOT_VERIFIED',422);
}

export async function payService(request:ServiceRequest,fetcher:typeof fetch=fetch) {
  const url=serviceUrl(request.url);
  const d=readDeployment();
  if(!d?.agentAccount || !d.policyAddress || !d.erc8004AgentId || !d.hcsTopic) throw new AppError('SETUP_REQUIRED');
  const key=roleKey('agent');
  if(key.publicKey.toStringRaw()!==d.agentPublicKey) throw new AppError('AGENT_KEY_MISMATCH');
  const init=requestInit(request);
  const first=await fetcher(url,init).catch(()=>{throw new AppError('SERVICE_UNREACHABLE');});
  if(first.status!==402) return {paid:false,status:first.status,body:await readBody(first)};

  const http=new x402HTTPClient(new x402Client().register(NETWORK,new ExactHederaScheme(createClientHederaSigner(d.agentAccount,key,{network:NETWORK}))));
  const required=http.getPaymentRequiredResponse(name=>first.headers.get(name),await first.json().catch(()=>undefined));
  const requirement=chooseRequirement(required,request.maxAmount);
  const amount=BigInt(requirement.amount),payTo=requirement.payTo;
  if(payTo===d.agentAccount) throw new AppError('PAYMENT_SELF_TRANSFER',422);
  const mirror=new Mirror();
  if(request.sellerAgentId!==undefined) await checkSeller(request.sellerAgentId,payTo,mirror);

  const store=new Store(resolve(DATA,'agent.sqlite'));
  try{return await store.exclusive('agent-spend',async()=>{
    const read=()=>policySnapshot(d,mirror,confirmed=>store.outstanding(USDC,confirmed),USDC);
    return guardedSign(read,USDC,amount,async()=>{
      const payload=await http.createPaymentPayload({...required,accepts:[requirement]});
      // Check what was actually signed: one USDC debit from the agent, the exact amount to the seller.
      const bytes=payload.payload?.transaction;
      if(typeof bytes!=='string') throw new AppError('PAYMENT_PAYLOAD_INVALID');
      const signed=inspectHederaTransaction(bytes);
      const usdc=signed.tokenTransfers[USDC]??[];
      const net=(account:string)=>usdc.filter(t=>t.accountId===account).reduce((n,t)=>n+BigInt(t.amount),0n);
      if(signed.hasNonTransferOperations || usdc.length!==2 || net(d.agentAccount!)!==-amount || net(payTo)!==amount) throw new AppError('PAYMENT_PAYLOAD_INVALID');
      const txId=signed.transactionId;
      // Reserved before sending: an unconfirmed payment keeps counting against the daily limit.
      store.reserve(mirrorTxId(txId),USDC,amount,new Date().toISOString().slice(0,10));
      const response=await fetcher(url,{...init,headers:{...(init.headers as Record<string,string>),...http.encodePaymentSignatureHeader(payload)}}).catch(()=>null);
      // The mirror decides whether money moved, whatever the service answered.
      const settled=await mirror.waitTransaction(txId,15).catch(()=>null)??await settledOrExpired(txId,mirror);
      if(!settled) {store.updateSpend(mirrorTxId(txId),'failed',true);throw new AppError(`PAYMENT_NOT_SETTLED:${response?.status??'no response'}`);}
      if(settled.result!=='SUCCESS') {store.updateSpend(mirrorTxId(txId),'failed',true);throw new AppError(`PAYMENT_FAILED:${settled.result}`);}
      verifyTransfer(settled,{txId,asset:USDC,payer:d.agentAccount!,payTo,amount});
      const resource=`${url.origin}${url.pathname}`.slice(0,200);
      await publish(d,'fill',{kind:'x402',status:'success',transactionId:txId,amount:amount.toString(),asset:USDC,payTo,resource},'agent',`x402-${mirrorTxId(txId)}-hcs`,store);
      store.updateSpend(mirrorTxId(txId),'success',true);
      writeEvidence('x402-agent-payment',txId);
      return {paid:true,transactionId:txId,amount:amount.toString(),asset:USDC,payTo,status:response?.status??null,body:response?await readBody(response):null};
    });
  });}finally{store.close();}
}
