import { getAddress, keccak256, toUtf8Bytes } from 'ethers';

/** Mirrors the local runtime's progress report (packages/agent/src/wizard.ts). */
export interface Progress {
  stage:'connect'|'fund'|'topic'|'allow'|'agreement'|'done'|'cli';
  guardianId?:string;
  operatorId?:string;
  operatorPublicKey:string;
  agentPublicKey:string;
  fundingTinybars:string;
  deployment?:{agentAccount?:string;guardianId?:string;hcsTopic?:string;policyContractId?:string;policyAddress?:string;erc8004AgentId?:string;uaid?:string;spendAsset?:string};
  topic?:{memo:string;adminKey:string;submitKeys:string[];threshold:number};
  allow?:{policyContractId:string;spendAsset:string};
  agreement?:{message:string;hash:string;terms:Record<string,unknown>};
}
export interface SetupState {running:boolean;step:string;lastError:string|null;progress:Progress|null}

const MIRROR='https://testnet.mirrornode.hedera.com/api/v1';
/** Hedera rejects a transaction after its 180-second validity window; allow for mirror delay. */
const EXPIRY_MS=240_000;

export function mirrorTransactionId(value:string) {
  const match=/^(0\.0\.\d+)@(\d+)\.(\d{1,9})$/.exec(value);
  if(!match) throw new Error('Invalid transaction ID');
  return `${match[1]}-${match[2]}-${match[3].padEnd(9,'0')}`;
}

/** Outcome of a wallet-submitted transaction, read from the mirror; never resubmits. */
export async function checkWalletTransaction(transactionId:string,submittedAt:number,now=Date.now(),fetcher:typeof fetch=fetch):Promise<'success'|'failed'|'expired'|'unknown'> {
  const id=mirrorTransactionId(transactionId);
  const response=await fetcher(`${MIRROR}/transactions/${id}`,{cache:'no-store'});
  if(response.status===404) return now-submittedAt>EXPIRY_MS?'expired':'unknown';
  if(!response.ok) return 'unknown';
  const rows=(await response.json() as {transactions:{transaction_id:string;nonce:number;result:string}[]}).transactions;
  const parent=rows.find(row=>row.transaction_id===id && row.nonce===0 && row.result!=='DUPLICATE_TRANSACTION');
  if(!parent) return now-submittedAt>EXPIRY_MS?'expired':'unknown';
  return parent.result==='SUCCESS'?'success':'failed';
}

/**
 * Re-derive the agreement hash in the browser and check the HCS message carries exactly the
 * displayed terms for this agent and guardian before the guardian publishes it.
 */
export function verifyAgreementMessage(agreement:NonNullable<Progress['agreement']>,progress:Pick<Progress,'guardianId'|'deployment'>) {
  const t=agreement.terms;
  const canonical=JSON.stringify({version:t.version,scope:t.scope,agentAccount:t.agentAccount,guardianAccount:t.guardianAccount,policyContract:getAddress(String(t.policyContract)),spendAsset:t.spendAsset,maxPerTx:t.maxPerTx,maxPerDay:t.maxPerDay});
  if(keccak256(toUtf8Bytes(canonical))!==agreement.hash) throw new Error('Agreement hash does not match the displayed terms');
  if(t.scope!=='client-enforced' || t.agentAccount!==progress.deployment?.agentAccount || t.guardianAccount!==progress.guardianId) throw new Error('Agreement terms do not match this agent and guardian');
  const message=JSON.parse(agreement.message) as {type?:string;agentAccount?:string;payload?:{agreement?:unknown;hash?:string;approval?:string}};
  if(message.type!=='agreement' || message.agentAccount!==t.agentAccount || message.payload?.hash!==agreement.hash || message.payload.approval!=='guardian-hcs-transaction' || JSON.stringify(message.payload.agreement)!==JSON.stringify(t)) throw new Error('Agreement message does not match the displayed terms');
}
