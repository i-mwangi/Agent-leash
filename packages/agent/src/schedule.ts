import { AccountId, ContractExecuteTransaction, KeyList, PublicKey, ScheduleCreateTransaction, ScheduleDeleteTransaction, Timestamp } from '@hiero-ledger/sdk';
import { Interface, getBytes } from 'ethers';
import { resolve } from 'node:path';
import { DATA, readDeployment } from '../../shared/src/files';
import { AppError, entityId, evmAddress, type Deployment } from '../../shared/src/model';
import { Mirror, exactUnits, mirrorTxId } from '../../shared/src/mirror';
import { Store, type ScheduleRow } from '../../shared/src/store';
import { policySnapshot, quote, ROUTER_ABI } from '../../shared/src/sources';
import { GAS, requireHbar } from '../../shared/src/fees';
import { checkPolicy, guardedSign, type PolicySnapshot } from './policyClient';
import { clientFor, nativeOperation, roleKey } from './runtime';
import { publish } from './setup';

const TOKEN_ABI=new Interface(['function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)']);
/** Earliest and latest execution times. Hedera allows up to 62 days; a week keeps quotes meaningful. */
export const SCHEDULE_MIN_DELAY_MS=2*60_000;
export const SCHEDULE_MAX_DELAY_MS=7*24*60*60_000;
/** A scheduled swap executes later than its quote, so it accepts more price movement than an immediate one. */
export const SCHEDULE_SLIPPAGE_BPS=300n;

export function scheduleTime(value:string,now=Date.now()) {
  const at=new Date(value);
  if(Number.isNaN(at.getTime())) throw new AppError('INVALID_SCHEDULE_TIME',400);
  if(at.getTime()<now+SCHEDULE_MIN_DELAY_MS) throw new AppError('SCHEDULE_TOO_SOON',400);
  if(at.getTime()>now+SCHEDULE_MAX_DELAY_MS) throw new AppError('SCHEDULE_TOO_LATE',400);
  return at;
}
export const scheduledMinimum=(amountOut:bigint)=>amountOut*(10_000n-SCHEDULE_SLIPPAGE_BPS)/10_000n;

/**
 * A scheduled swap is signed now and executed by Hedera later, with no policy check at execution.
 * While the runtime is running it cancels any pending swap that the current policy would refuse.
 */
export function cancelReason(state:PolicySnapshot,asset:string,amount:bigint):string|null {
  if(!state.policyExists) return 'NO_POLICY';
  if(!state.agentKeyActive) return 'AGENT_KEY_INACTIVE';
  if(state.paused) return 'PAUSED';
  if(!state.allowedTokens.includes(asset)) return 'ASSET_NOT_ALLOWED';
  if(amount>state.maxPerTx) return 'OVER_TX_CAP';
  return null;
}

export interface MirrorSchedule { schedule_id:string; deleted:boolean; executed_timestamp:string|null; expiration_time:string|null }
/** Classify a schedule from the mirror alone; a pending one past its expiry never executed. */
export function scheduleState(schedule:MirrorSchedule,now=Date.now()):'pending'|'executed'|'deleted'|'expired' {
  if(schedule.executed_timestamp) return 'executed';
  if(schedule.deleted) return 'deleted';
  if(schedule.expiration_time && Number(schedule.expiration_time.split('.')[0])*1000+60_000<now) return 'expired';
  return 'pending';
}

function ready() {
  const d=readDeployment();
  if(!d?.agentAccount || !d.policyAddress || !d.erc8004AgentId || !d.hcsTopic) throw new AppError('SETUP_REQUIRED');
  const key=roleKey('agent');
  if(key.publicKey.toStringRaw()!==d.agentPublicKey) throw new AppError('AGENT_KEY_MISMATCH');
  return {d,key};
}
const openStore=()=>new Store(resolve(DATA,'agent.sqlite'));

/** Sign a SaucerSwap swap now that Hedera executes at `executeAt`, after the same policy check as `spend`. */
export async function scheduleSwap(amount:bigint,executeAtInput:string) {
  const executeAt=scheduleTime(executeAtInput);
  const {d,key}=ready();
  const mirror=new Mirror(),store=openStore(),client=clientFor(d.agentAccount!,key);
  try{return await store.exclusive('agent-spend',async()=>{
    const token=await mirror.token(d.spendAsset);
    if(token.deleted || !/^\d+$/.test(token.decimals) || Number(token.decimals)>18) throw new AppError('SPEND_ASSET_INVALID');
    const router=evmAddress(d.routerId),account=evmAddress(d.agentAccount!);
    const read=()=>policySnapshot(d,mirror,confirmed=>store.outstanding(d.spendAsset,confirmed));
    const initial=checkPolicy(await read(),d.spendAsset,amount);
    if(!initial.ok) throw new AppError(initial.reason);
    const estimate=await quote(d,mirror,amount);
    // The router must still be allowed to move every pending scheduled amount when each one executes.
    const needed=store.scheduledOutstanding(d.spendAsset)+amount;
    const allowance=BigInt((await mirror.call(evmAddress(d.spendAsset),TOKEN_ABI,'allowance',[account,router]))[0]);
    // Fees come from the agent's own HBAR; refuse before signing anything it could not finish.
    await requireHbar(mirror,d.agentAccount!,{approve:allowance<needed,schedule:true});
    if(allowance<needed) {
      await guardedSign(read,d.spendAsset,amount,()=>nativeOperation(`approve-${d.spendAsset}-${needed}-${Date.now()}`,new ContractExecuteTransaction()
        .setContractId(d.spendAsset).setGas(Number(GAS.approve))
        .setFunctionParameters(getBytes(TOKEN_ABI.encodeFunctionData('approve',[router,needed]))),client,store));
      const fresh=BigInt((await mirror.call(evmAddress(d.spendAsset),TOKEN_ABI,'allowance',[account,router]))[0]);
      if(fresh<needed) throw new AppError('ALLOWANCE_UNCONFIRMED');
    }
    const minimum=scheduledMinimum(BigInt(estimate.amountOut));
    const deadline=BigInt(Math.floor(executeAt.getTime()/1000)+600);
    const swap=new ContractExecuteTransaction().setContractId(d.routerId).setGas(Number(GAS.swap))
      .setFunctionParameters(getBytes(ROUTER_ABI.encodeFunctionData('swapExactTokensForTokens',[amount,minimum,[d.spendAsset,d.outputAsset].map(evmAddress),account,deadline])));
    // Either the guardian or the agent can delete the schedule before it executes.
    const admin=new KeyList([PublicKey.fromStringECDSA(d.guardianPublicKey),key.publicKey],1);
    const tx=new ScheduleCreateTransaction().setScheduledTransaction(swap).setPayerAccountId(AccountId.fromString(d.agentAccount!))
      .setWaitForExpiry(true).setExpirationTime(Timestamp.fromDate(executeAt)).setAdminKey(admin)
      .setScheduleMemo(`Accountable Agent swap #${d.erc8004AgentId}`);
    const name=`schedule-swap-${Date.now()}`;
    return guardedSign(read,d.spendAsset,amount,async()=>{
      // The reservation counts against the daily limit from now until the outcome is recorded.
      const result=await nativeOperation(name,tx,client,store,[],false,id=>store.reserve(mirrorTxId(id),d.spendAsset,amount,executeAt.toISOString().slice(0,10)));
      if(!result.scheduleId) throw new AppError('SCHEDULE_UNCONFIRMED');
      store.addSchedule({schedule_id:result.scheduleId,tx_id:result.txId,asset:d.spendAsset,amount:amount.toString(),minimum:minimum.toString(),execute_at:executeAt.toISOString()});
      await publish(d,'fill',{status:'scheduled',scheduleId:result.scheduleId,transactionId:result.txId,amount:amount.toString(),asset:d.spendAsset,executeAt:executeAt.toISOString()},'agent',`${name}-hcs`,store);
      return {scheduleId:result.scheduleId,transactionId:result.txId,executeAt:executeAt.toISOString(),quotedOutput:estimate.amountOut,minimumOutput:minimum.toString()};
    });
  });}finally{client.close();store.close();}
}

/** Delete a pending schedule with the agent key, which is one of its two admin keys. */
export async function cancelSchedule(scheduleId:string,reason='CANCELLED_BY_AGENT') {
  entityId.parse(scheduleId);
  const {d,key}=ready();
  const store=openStore(),client=clientFor(d.agentAccount!,key);
  try{return await store.exclusive('agent-spend',async()=>{
    const row=store.schedules().find(s=>s.schedule_id===scheduleId);
    if(!row) throw new AppError('SCHEDULE_NOT_FOUND',404);
    if(row.status!=='pending') throw new AppError('SCHEDULE_NOT_PENDING',409);
    await nativeOperation(`schedule-delete-${scheduleId}`,new ScheduleDeleteTransaction().setScheduleId(scheduleId),client,store);
    await settle(d,row,{schedule_id:scheduleId,deleted:true,executed_timestamp:null,expiration_time:null},new Mirror(),store,reason);
    return {scheduleId,status:'cancelled',reason};
  });}finally{client.close();store.close();}
}

/** Record a schedule's final outcome on HCS once, from what the mirror shows. */
async function settle(d:Deployment,row:ScheduleRow,schedule:MirrorSchedule,mirror:Mirror,store:Store,reason?:string) {
  const state=scheduleState(schedule);
  if(state==='pending') return;
  const base={scheduleId:row.schedule_id,transactionId:row.tx_id,amount:row.amount,asset:row.asset,scheduled:true};
  const release=(status:'failed'|'cancelled'|'expired',why:string)=>async()=>{
    store.updateSpend(mirrorTxId(row.tx_id),'failed',true);
    await publish(d,'fill',{...base,status:status==='cancelled'?'cancelled':'failed',reason:why},'agent',`schedule-${row.schedule_id}-${status}-hcs`,store);
    store.finishSchedule(row.schedule_id,status,why);
  };
  if(state==='deleted') return release('cancelled',reason??'CANCELLED')();
  if(state==='expired') return release('expired','SCHEDULE_EXPIRED')();
  const tx=await mirror.transaction(row.tx_id,true);
  if(tx.result!=='SUCCESS') return release('failed',tx.result)();
  const {parent,transfers}=await mirror.contractTransfers(row.tx_id,true);
  const debit=transfers.filter(t=>t.account===d.agentAccount && t.token_id===row.asset).reduce((n,t)=>n+exactUnits(t.amount),0n);
  const output=transfers.filter(t=>t.account===d.agentAccount && t.token_id===d.outputAsset).reduce((n,t)=>n+exactUnits(t.amount),0n);
  if(parent.entity_id!==d.routerId || debit!==-BigInt(row.amount) || output<BigInt(row.minimum)) throw new AppError('SWAP_UNCONFIRMED');
  await publish(d,'fill',{...base,status:'success'},'agent',`schedule-${row.schedule_id}-success-hcs`,store);
  store.updateSpend(mirrorTxId(row.tx_id),'success',true);
  store.finishSchedule(row.schedule_id,'executed');
}

/**
 * Run by the agent runtime: record executed, deleted or expired schedules, and cancel pending ones
 * the current policy refuses. Hedera itself refuses them after the agent key is revoked.
 */
export async function reconcileSchedules(mirror=new Mirror()) {
  const d=readDeployment();
  if(!d?.agentAccount || !d.hcsTopic) return [];
  const store=openStore();
  try{
    const pending=store.schedules().filter(s=>s.status==='pending');
    if(!pending.length) return [];
    return await store.exclusive('agent-spend',async()=>{
      let snapshot:PolicySnapshot|null=null;
      const changed:string[]=[];
      for(const row of pending) {
        const schedule=await mirror.json<MirrorSchedule>(`/api/v1/schedules/${row.schedule_id}`);
        if(scheduleState(schedule)!=='pending') { await settle(d,row,schedule,mirror,store); changed.push(row.schedule_id); continue; }
        snapshot??=await policySnapshot(d,mirror,confirmed=>store.outstanding(d.spendAsset,confirmed));
        const reason=cancelReason(snapshot,row.asset,BigInt(row.amount));
        // A revoked agent key can no longer pay for the delete, and Hedera already rejects the swap's signature.
        if(reason && reason!=='AGENT_KEY_INACTIVE') {
          const key=roleKey('agent'),client=clientFor(d.agentAccount!,key);
          try{await nativeOperation(`schedule-delete-${row.schedule_id}`,new ScheduleDeleteTransaction().setScheduleId(row.schedule_id),client,store);}
          finally{client.close();}
          await settle(d,row,{...schedule,deleted:true},mirror,store,reason);
          changed.push(row.schedule_id);
        }
      }
      return changed;
    });
  }finally{store.close();}
}

export function listSchedules() {
  const store=openStore();
  try{return store.schedules().slice(0,20);}finally{store.close();}
}
