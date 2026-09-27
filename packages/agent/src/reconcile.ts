import { resolve } from 'node:path';
import { AppError, evmAddress, type ConsensusEvent } from '../../shared/src/model';
import { Mirror, mirrorTxId, type MirrorTransaction } from '../../shared/src/mirror';
import { readDeployment, DATA } from '../../shared/src/files';
import { Store } from '../../shared/src/store';
import { POLICY_ABI } from '../../shared/src/sources';
import { publish } from './setup';
import { roleKey } from './runtime';

interface PauseProof {
  txId: string;
  guardianId: string;
  policyContractId: string;
  tx: MirrorTransaction;
  result: {contract_id:string;from:string;function_parameters:string;result:string};
  events: ConsensusEvent[];
  paused: boolean;
}

/** Validate public evidence before writing a missing guardian HCS event. */
export function verifyPauseRecovery(proof:PauseProof) {
  const id=mirrorTxId(proof.txId);
  if(proof.tx.transaction_id!==id || !id.startsWith(`${proof.guardianId}-`) || proof.tx.name!=='CONTRACTCALL' || proof.tx.result!=='SUCCESS' || (proof.tx.nonce??0)!==0 || proof.tx.entity_id!==proof.policyContractId) throw new AppError('PAUSE_TRANSACTION_MISMATCH',422);
  if(proof.result.contract_id!==proof.policyContractId || proof.result.from.toLowerCase()!==evmAddress(proof.guardianId).toLowerCase() || proof.result.function_parameters.toLowerCase()!==POLICY_ABI.encodeFunctionData('pause').toLowerCase() || proof.result.result!=='SUCCESS') throw new AppError('PAUSE_CALL_MISMATCH',422);
  if(!proof.paused) throw new AppError('POLICY_NOT_PAUSED',409);
  if(proof.events.some(event=>{
    if(event.type!=='paused' || event.publisher!==proof.guardianId || typeof event.payload.transactionId!=='string') return false;
    try {return mirrorTxId(event.payload.transactionId)===id;} catch {return false;}
  })) throw new AppError('PAUSE_EVENT_ALREADY_RECORDED',409);
  return id;
}

/** Publish only the missing HCS record; never repeat the contract call. */
export async function reconcilePause(txId:string) {
  const d=readDeployment();
  if(!d?.agentAccount || !d.guardianId || !d.policyContractId || !d.policyAddress || !d.hcsTopic || d.network!=='testnet') throw new AppError('SETUP_REQUIRED');
  const mirror=new Mirror();
  const store=new Store(resolve(DATA,'guardian.sqlite'));
  try{return await store.exclusive('guardian-action',async()=>{
    const tx=await mirror.transaction(txId);
    const [result,events,state]=await Promise.all([
      mirror.json<{contract_id:string;from:string;function_parameters:string;result:string}>(`/api/v1/contracts/results/${tx.transaction_id}`),
      mirror.events(d.hcsTopic!),
      mirror.call(d.policyAddress!,POLICY_ABI,'paused'),
    ]);
    const id=verifyPauseRecovery({txId,guardianId:d.guardianId!,policyContractId:d.policyContractId!,tx,result,events,paused:state[0]===true});
    const key=roleKey('guardian');
    if(key.publicKey.toStringRaw()!==d.guardianPublicKey) throw new AppError('GUARDIAN_KEY_MISMATCH');
    const canonical=id.replace(/^(0\.0\.\d+)-(\d+)-(\d{9})$/,'$1@$2.$3');
    const recorded=await publish(d,'paused',{address:d.policyAddress,transactionId:canonical},'guardian',`reconcile-pause-${id}`,store);
    for(let attempt=0;attempt<8;attempt++) {
      const latest=await mirror.events(d.hcsTopic!);
      if(latest.some(event=>event.type==='paused' && event.publisher===d.guardianId && event.payload.transactionId===canonical)) return {contractTransactionId:canonical,hcsTransactionId:recorded.txId,verified:true};
      if(attempt<7) await new Promise(resolve=>setTimeout(resolve,1500));
    }
    throw new AppError(`HCS_EVENT_MIRROR_PENDING:${recorded.txId}`);
  });}finally{store.close();}
}
