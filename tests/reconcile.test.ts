import { describe, expect, it } from 'vitest';
import { verifyPauseRecovery } from '../packages/agent/src/reconcile';
import { AppError, evmAddress, type ConsensusEvent } from '../packages/shared/src/model';
import type { MirrorTransaction } from '../packages/shared/src/mirror';

const guardianId='0.0.10715881';
const policyContractId='0.0.10715941';
const txId=`${guardianId}@1790473656.056565005`;
const mirrorId=`${guardianId}-1790473656-056565005`;
function proof() {
  const tx:MirrorTransaction={transaction_id:mirrorId,name:'CONTRACTCALL',result:'SUCCESS',entity_id:policyContractId,nonce:0,consensus_timestamp:'1790473657.000000000',token_transfers:[]};
  return {txId,guardianId,policyContractId,tx,result:{contract_id:policyContractId,from:evmAddress(guardianId),function_parameters:'0x8456cb59',result:'SUCCESS'},events:[] as ConsensusEvent[],paused:true};
}
function code(action:()=>unknown) {
  try {action();return '';} catch(error) {return error instanceof AppError?error.code:'UNEXPECTED_ERROR';}
}
describe('pause HCS reconciliation',()=>{
  it('accepts a verified guardian pause call',()=>expect(verifyPauseRecovery(proof())).toBe(mirrorId));
  it('rejects a call from another payer',()=>{
    const p=proof();p.tx.transaction_id='0.0.1-1790473656-056565005';
    expect(code(()=>verifyPauseRecovery(p))).toBe('PAUSE_TRANSACTION_MISMATCH');
  });
  it('rejects another contract or function',()=>{
    const p=proof();p.result.function_parameters='0x3f4ba83a';
    expect(code(()=>verifyPauseRecovery(p))).toBe('PAUSE_CALL_MISMATCH');
    p.result.function_parameters='0x8456cb59';p.tx.entity_id='0.0.9';
    expect(code(()=>verifyPauseRecovery(p))).toBe('PAUSE_TRANSACTION_MISMATCH');
  });
  it('rejects a stale pause and duplicate HCS record',()=>{
    const p=proof();p.paused=false;
    expect(code(()=>verifyPauseRecovery(p))).toBe('POLICY_NOT_PAUSED');
    p.paused=true;p.events=[{v:1,type:'paused',ts:'2026-09-27T00:00:00.000Z',agentAccount:'0.0.10715883',payload:{transactionId:txId},publisher:guardianId,sequence:1,consensusTimestamp:'1790473700.000000000'}];
    expect(code(()=>verifyPauseRecovery(p))).toBe('PAUSE_EVENT_ALREADY_RECORDED');
  });
});
