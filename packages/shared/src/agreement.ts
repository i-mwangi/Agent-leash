import { Wallet, getAddress, getBytes, keccak256, toUtf8Bytes, verifyMessage } from 'ethers';
import { z } from 'zod';
import { address, entityId, uint } from './model';

/** A guardian-approved technical policy record, not a legal-ownership certificate. */
export const agreementSchema = z.object({
  version: z.number().int().positive().max(0xffffffff),
  scope: z.literal('client-enforced'),
  agentAccount: entityId,
  guardianAccount: entityId,
  policyContract: address,
  spendAsset: entityId,
  maxPerTx: uint,
  maxPerDay: uint,
}).strict();
export type Agreement = z.infer<typeof agreementSchema>;
export const signedAgreementSchema = z.object({
  agreement: agreementSchema,
  hash: z.string().regex(/^0x[\da-fA-F]{64}$/),
  signature: z.string().regex(/^0x[\da-fA-F]{130}$/),
}).strict();
export type SignedAgreement = z.infer<typeof signedAgreementSchema>;

export function canonicalAgreement(input: Agreement) {
  const a = agreementSchema.parse(input);
  return JSON.stringify({version:a.version,scope:a.scope,agentAccount:a.agentAccount,guardianAccount:a.guardianAccount,policyContract:getAddress(a.policyContract),spendAsset:a.spendAsset,maxPerTx:a.maxPerTx,maxPerDay:a.maxPerDay});
}
export function agreementHash(input: Agreement) { return keccak256(toUtf8Bytes(canonicalAgreement(input))); }
export async function signAgreement(input: Agreement, guardian: Wallet): Promise<SignedAgreement> {
  const agreement=agreementSchema.parse(input);
  const hash=agreementHash(agreement);
  return {agreement,hash,signature:await guardian.signMessage(getBytes(hash))};
}
export function verifyAgreement(input: unknown, guardianAddress: string): SignedAgreement {
  const signed=signedAgreementSchema.parse(input);
  if(signed.hash!==agreementHash(signed.agreement)) throw new Error('AGREEMENT_HASH_MISMATCH');
  if(getAddress(verifyMessage(getBytes(signed.hash),signed.signature))!==getAddress(guardianAddress)) throw new Error('AGREEMENT_GUARDIAN_MISMATCH');
  return signed;
}
