import { getAddress, getBytes, verifyMessage } from 'ethers';
import { vaultTermsHash, type VaultContext, type VaultTerms } from './vaultTerms';

export function verifyVaultApproval(record:{context:VaultContext;terms:VaultTerms;hash:string;signature:string}, context:VaultContext, guardian:string) {
  if(record.context.network!==context.network || record.context.agentAccount!==context.agentAccount || record.context.guardianAccount!==context.guardianAccount) throw new Error('VAULT_CONTEXT_MISMATCH');
  if(vaultTermsHash(record.terms,context)!==record.hash) throw new Error('VAULT_TERMS_HASH_MISMATCH');
  if(getAddress(verifyMessage(getBytes(record.hash),record.signature))!==getAddress(guardian)) throw new Error('VAULT_SIGNATURE_INVALID');
}

export function verifyVaultRules(terms:VaultTerms, hash:string, chain:{hash:string;maxPerTx:bigint;maxPerDay:bigint;recipients:string[]}) {
  if(chain.hash.toLowerCase()!==hash.toLowerCase() || chain.maxPerTx!==BigInt(terms.maxPerTxTinybars) || chain.maxPerDay!==BigInt(terms.maxPerUtcDayTinybars)) throw new Error('VAULT_POLICY_MISMATCH');
  const expected=terms.allowedRecipients.map(getAddress).sort();
  const actual=chain.recipients.map(getAddress).sort();
  if(actual.length!==expected.length || actual.some((address,index)=>address!==expected[index])) throw new Error('VAULT_RECIPIENTS_MISMATCH');
}
