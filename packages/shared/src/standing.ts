import { Wallet, verifyTypedData, getAddress } from 'ethers';
import { z } from 'zod';
import { address, entityId, uint } from './model';
// Domain is separate from the twelve message fields. The policy address binds the report to its deployment.
export const STANDING_TYPES = { Standing: [
  {name:'publicId',type:'string'}, {name:'hederaAccount',type:'string'},
  {name:'erc8004AgentId',type:'uint256'}, {name:'uaid',type:'string'},
  {name:'paused',type:'bool'}, {name:'agentKeyActive',type:'bool'},
  {name:'maxPerTx',type:'uint256'}, {name:'maxPerDay',type:'uint256'},
  {name:'hcsTopic',type:'string'}, {name:'hashscanAccount',type:'string'},
  {name:'issuedAt',type:'uint64'}, {name:'expiresAt',type:'uint64'},
] };
export const standingMessageSchema = z.object({ publicId:z.string(), hederaAccount:entityId, erc8004AgentId:uint, uaid:z.string().startsWith('uaid:aid:'), paused:z.boolean(), agentKeyActive:z.boolean(), maxPerTx:uint, maxPerDay:uint, hcsTopic:entityId, hashscanAccount:z.string().url(), issuedAt:z.number().int().nonnegative(), expiresAt:z.number().int().positive() }).strict();
export type StandingMessage = z.infer<typeof standingMessageSchema>;
export const signedStandingSchema = z.object({
  domain: z.object({name:z.literal('AccountableAgentStanding'),version:z.literal('1'),chainId:z.literal(296),verifyingContract:address}).strict(),
  message:standingMessageSchema, signature:z.string().regex(/^0x[\da-fA-F]{130}$/), signer:address,
}).strict();
export type SignedStanding = z.infer<typeof signedStandingSchema>;
export function standingDomain(policy: string) { return {name:'AccountableAgentStanding' as const,version:'1' as const,chainId:296 as const,verifyingContract:getAddress(policy)}; }
export async function signStanding(message: StandingMessage, policy: string, wallet: Wallet): Promise<SignedStanding> {
  standingMessageSchema.parse(message);
  const domain = standingDomain(policy);
  return { domain, message, signer:wallet.address, signature:await wallet.signTypedData(domain, STANDING_TYPES, message) };
}
export function verifyStanding(input: unknown, expectedSigner: string, expectedPolicy: string, expectedAccount: string, now = Math.floor(Date.now()/1000)) {
  const report = signedStandingSchema.parse(input);
  if (getAddress(report.domain.verifyingContract) !== getAddress(expectedPolicy) || report.message.hederaAccount !== expectedAccount) throw new Error('STANDING_SUBJECT_MISMATCH');
  if (report.message.issuedAt > now + 30 || report.message.expiresAt <= now || report.message.expiresAt <= report.message.issuedAt || report.message.expiresAt - report.message.issuedAt > 300) throw new Error('STANDING_EXPIRED_OR_INVALID_TIME');
  const recovered = verifyTypedData(report.domain, STANDING_TYPES, report.message, report.signature);
  if (getAddress(expectedSigner) !== recovered || getAddress(report.signer) !== recovered) throw new Error('STANDING_SIGNER_MISMATCH');
  return report.message;
}
