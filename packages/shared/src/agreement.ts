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
/**
 * Approval by a wallet guardian: the guardian's key signs the HCS transaction that carries these
 * exact terms. Valid only when the verifier has confirmed the guardian account paid for the message.
 */
export const WALLET_APPROVAL = 'guardian-hcs-transaction';
export const walletApprovedAgreementSchema = z.object({
  agreement: agreementSchema,
  hash: z.string().regex(/^0x[\da-fA-F]{64}$/),
  approval: z.literal(WALLET_APPROVAL),
}).strict();
export type WalletApprovedAgreement = z.infer<typeof walletApprovedAgreementSchema>;
export type RecordedAgreement = SignedAgreement | WalletApprovedAgreement;

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
/** Wallet message for an HCS agreement record; the guardian publishes it unchanged. */
export function walletAgreementPayload(input: Agreement): WalletApprovedAgreement {
  const agreement=agreementSchema.parse(input);
  return {agreement,hash:agreementHash(agreement),approval:WALLET_APPROVAL};
}
/**
 * Verify an HCS agreement record. A wallet-approved record carries no separate signature, so the
 * caller must pass whether the mirror shows the guardian account as the message's payer.
 */
export function verifyRecordedAgreement(input: unknown, guardianAddress: string, publishedByGuardian: boolean): RecordedAgreement {
  const wallet=walletApprovedAgreementSchema.safeParse(input);
  if(!wallet.success) return verifyAgreement(input,guardianAddress);
  if(!publishedByGuardian) throw new Error('AGREEMENT_PUBLISHER_MISMATCH');
  if(wallet.data.hash!==agreementHash(wallet.data.agreement)) throw new Error('AGREEMENT_HASH_MISMATCH');
  return wallet.data;
}
