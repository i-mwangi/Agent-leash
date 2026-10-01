import { ContractExecuteTransaction, ContractId } from '@hiero-ledger/sdk';
import { ZeroHash, getBytes } from 'ethers';
import { resolve } from 'node:path';
import { DATA, readDeployment } from '../../shared/src/files';
import { AppError } from '../../shared/src/model';
import { Mirror } from '../../shared/src/mirror';
import { Store } from '../../shared/src/store';
import { accountKeyState } from '../../shared/src/keys';
import { REPUTATION_ABI, REPUTATION_REGISTRY, resolveAgent } from '../../shared/src/resolve';
import { clientFor, nativeOperation, roleKey } from './runtime';

/** Validate before any network call: an integer score 0–100 and a short lowercase tag. */
export function feedbackInput(agentId:string,score:string,tag='interaction') {
  if(!/^[1-9]\d{0,30}$/.test(agentId)) throw new AppError('INVALID_AGENT_ID',400);
  if(!/^(100|[1-9]?\d)$/.test(score)) throw new AppError('SCORE_MUST_BE_0_TO_100',400);
  if(!/^[a-z0-9_-]{1,32}$/.test(tag)) throw new AppError('INVALID_TAG',400);
  return {agentId:BigInt(agentId),score:BigInt(score),tag};
}

/**
 * This agent rates another agent in the ERC-8004 reputation registry, signing with its own key.
 * tag2 records whether the target passed full verification when the feedback was given.
 */
export async function giveFeedback(agentIdText:string,scoreText:string,tagText?:string) {
  const {agentId,score,tag}=feedbackInput(agentIdText,scoreText,tagText);
  const d=readDeployment();
  if(!d?.agentAccount || !d.erc8004AgentId) throw new AppError('SETUP_REQUIRED');
  if(agentId.toString()===d.erc8004AgentId) throw new AppError('SELF_FEEDBACK_REFUSED',400);
  const key=roleKey('agent');
  if(key.publicKey.toStringRaw()!==d.agentPublicKey) throw new AppError('AGENT_KEY_MISMATCH');
  const mirror=new Mirror();
  const [account,target]=await Promise.all([mirror.account(d.agentAccount),resolveAgent(agentId,mirror)]);
  if(!accountKeyState(account.key,d.agentPublicKey,d.guardianPublicKey).agentKeyActive) throw new AppError('AGENT_KEY_INACTIVE');
  const verdict=target.status==='verified'?'verified':'unverified';
  const endpoint='standing' in target && target.standing?target.standing:'';
  const data=REPUTATION_ABI.encodeFunctionData('giveFeedback',[agentId,score,0,tag,verdict,endpoint,'',ZeroHash]);
  const store=new Store(resolve(DATA,'agent.sqlite'));
  const client=clientFor(d.agentAccount,key);
  try {
    const result=await nativeOperation(`feedback-${agentId}-${Date.now()}`,new ContractExecuteTransaction().setContractId(ContractId.fromEvmAddress(0,0,REPUTATION_REGISTRY)).setGas(400_000).setFunctionParameters(getBytes(data)),client,store);
    return {transactionId:result.txId,agentId:agentId.toString(),score:score.toString(),tag,targetStatus:target.status,hashscan:`https://hashscan.io/testnet/transaction/${encodeURIComponent(result.txId)}`};
  } finally {client.close();store.close();}
}
