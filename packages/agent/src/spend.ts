import { ContractExecuteTransaction } from '@hiero-ledger/sdk';
import { Interface, getBytes } from 'ethers';
import { resolve } from 'node:path';
import { DATA, readDeployment } from '../../shared/src/files';
import { AppError, evmAddress } from '../../shared/src/model';
import { Mirror, exactUnits, mirrorTxId } from '../../shared/src/mirror';
import { Store } from '../../shared/src/store';
import { policySnapshot, quote, ROUTER_ABI } from '../../shared/src/sources';
import { checkPolicy, guardedSign } from './policyClient';
import { clientFor, nativeOperation, roleKey } from './runtime';
import { publish } from './setup';

const TOKEN_ABI=new Interface(['function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)']);

/** The agent key stays in this CLI. The policy read is adjacent to each signature. */
export async function spend(amount:bigint) {
  const d=readDeployment();
  if(!d?.agentAccount || !d.policyAddress || !d.erc8004AgentId || !d.hcsTopic) throw new AppError('SETUP_REQUIRED');
  const key=roleKey('agent');
  if(key.publicKey.toStringRaw()!==d.agentPublicKey) throw new AppError('AGENT_KEY_MISMATCH');
  const mirror=new Mirror(),store=new Store(resolve(DATA,'agent.sqlite'));
  const client=clientFor(d.agentAccount,key);
  try{return await store.exclusive('agent-spend',async()=>{
    const token=await mirror.token(d.spendAsset);
    if(token.deleted || !/^\d+$/.test(token.decimals) || Number(token.decimals)>18) throw new AppError('SPEND_ASSET_INVALID');
    const router=evmAddress(d.routerId),account=evmAddress(d.agentAccount!);
    const read=()=>policySnapshot(d,mirror,confirmed=>store.outstanding(d.spendAsset,confirmed));
    const initial=checkPolicy(await read(),d.spendAsset,amount);
    if(!initial.ok) throw new AppError(initial.reason);
    // Quote first. A missing testnet pool is a read-only integration, never a synthetic fill.
    const estimate=await quote(d,mirror,amount);
    const allowance=BigInt((await mirror.call(evmAddress(d.spendAsset),TOKEN_ABI,'allowance',[account,router]))[0]);
    if(allowance<amount) {
      await guardedSign(read,d.spendAsset,amount,()=>nativeOperation(`approve-${d.spendAsset}-${amount}`,new ContractExecuteTransaction()
        .setContractId(d.spendAsset).setGas(1_000_000)
        .setFunctionParameters(getBytes(TOKEN_ABI.encodeFunctionData('approve',[router,amount]))),client,store));
      const fresh=BigInt((await mirror.call(evmAddress(d.spendAsset),TOKEN_ABI,'allowance',[account,router]))[0]);
      if(fresh<amount) throw new AppError('ALLOWANCE_UNCONFIRMED');
    }
    const minimum=BigInt(estimate.amountOut)*99n/100n;
    const deadline=BigInt(Math.floor(Date.now()/1000)+120);
    const path=[d.spendAsset,d.outputAsset].map(evmAddress);
    const tx=new ContractExecuteTransaction().setContractId(d.routerId).setGas(1_500_000)
      .setFunctionParameters(getBytes(ROUTER_ABI.encodeFunctionData('swapExactTokensForTokens',[amount,minimum,path,account,deadline])));
    // Pending amount survives a crash and counts against all future daily checks.
    const reservation=`swap-${Date.now()}`;
    return guardedSign(read,d.spendAsset,amount,async()=>{
      let result;
      try {result=await nativeOperation(reservation,tx,client,store,[],false,id=>store.reserve(mirrorTxId(id),d.spendAsset,amount,new Date().toISOString().slice(0,10)));}
      catch(error){
        const pending=store.operation(reservation);
        if(pending){
          const failed=await mirror.transaction(pending.tx_id).catch(()=>null);
          if(failed && failed.result!=='SUCCESS') {
            store.updateSpend(mirrorTxId(pending.tx_id),'failed',true);
            await publish(d,'fill',{status:'failed',transactionId:pending.tx_id,amount:amount.toString(),asset:d.spendAsset,reason:failed.result},'agent',reservation+'-failed-hcs',store);
          }
        }
        throw error;
      }
      const {parent,transfers}=await mirror.contractTransfers(result.txId);
      const debit=transfers.filter(t=>t.account===d.agentAccount && t.token_id===d.spendAsset).reduce((n,t)=>n+exactUnits(t.amount),0n);
      const output=transfers.filter(t=>t.account===d.agentAccount && t.token_id===d.outputAsset).reduce((n,t)=>n+exactUnits(t.amount),0n);
      if(parent.entity_id!==d.routerId || debit!==-amount || output<minimum) throw new AppError('SWAP_UNCONFIRMED');
      await publish(d,'fill',{status:'success',transactionId:result.txId,amount:amount.toString(),asset:d.spendAsset},'agent',reservation+'-hcs',store);
      store.updateSpend(mirrorTxId(result.txId),'success',true);
      return {transactionId:result.txId,mirrorTransactionId:mirrorTxId(result.txId),quotedOutput:estimate.amountOut};
    });
  });}finally{client.close();store.close();}
}
