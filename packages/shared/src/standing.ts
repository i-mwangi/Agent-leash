import { Wallet, verifyTypedData, getAddress, ZeroHash } from 'ethers';
import { z } from 'zod';
import { address, entityId, uint } from './model';
import { vaultReportSchema, VAULT_STANDING_FIELDS, type VaultReport } from './vaultReport';
// Domain is separate from the twelve message fields. The policy address binds the report to its deployment.
export const STANDING_TYPES = { Standing: [
  {name:'publicId',type:'string'}, {name:'hederaAccount',type:'string'},
  {name:'erc8004AgentId',type:'uint256'}, {name:'uaid',type:'string'},
  {name:'paused',type:'bool'}, {name:'agentKeyActive',type:'bool'},
  {name:'maxPerTx',type:'uint256'}, {name:'maxPerDay',type:'uint256'},
  {name:'hcsTopic',type:'string'}, {name:'hashscanAccount',type:'string'},
  {name:'issuedAt',type:'uint64'}, {name:'expiresAt',type:'uint64'},
] };
export const STANDING_V2_TYPES = { Standing: [...STANDING_TYPES.Standing,
  {name:'agreementHash',type:'bytes32'}, {name:'agreementVersion',type:'uint32'},
] };
export const STANDING_V3_TYPES={Standing:[...STANDING_V2_TYPES.Standing,{name:'vault',type:'Vault'}],Vault:VAULT_STANDING_FIELDS};
export const standingMessageSchema = z.object({ publicId:z.string(), hederaAccount:entityId, erc8004AgentId:uint, uaid:z.string().startsWith('uaid:aid:'), paused:z.boolean(), agentKeyActive:z.boolean(), maxPerTx:uint, maxPerDay:uint, hcsTopic:entityId, hashscanAccount:z.string().url(), issuedAt:z.number().int().nonnegative(), expiresAt:z.number().int().positive() }).strict();
export type StandingMessage = z.infer<typeof standingMessageSchema>;
export const standingV2MessageSchema=standingMessageSchema.extend({agreementHash:z.string().regex(/^0x[\da-fA-F]{64}$/),agreementVersion:z.number().int().positive().max(0xffffffff)});
export type StandingV2Message=z.infer<typeof standingV2MessageSchema>;
export const standingV3MessageSchema=standingMessageSchema.extend({agreementHash:z.string().regex(/^0x[\da-fA-F]{64}$/),agreementVersion:z.number().int().nonnegative().max(0xffffffff),vault:vaultReportSchema});
export type StandingV3Message=z.infer<typeof standingV3MessageSchema>;
const standingLinksSchema=z.object({account:z.string().url(),topic:z.string().url(),policy:z.string().url()}).strict();
const signedStandingV1Schema = z.object({
  domain: z.object({name:z.literal('AccountableAgentStanding'),version:z.literal('1'),chainId:z.literal(296),verifyingContract:address}).strict(),
  message:standingMessageSchema, signature:z.string().regex(/^0x[\da-fA-F]{130}$/), signer:address, links:standingLinksSchema,
}).strict();
const signedStandingV2Schema = z.object({
  domain: z.object({name:z.literal('AccountableAgentStanding'),version:z.literal('2'),chainId:z.literal(296),verifyingContract:address}).strict(),
  message:standingV2MessageSchema, signature:z.string().regex(/^0x[\da-fA-F]{130}$/), signer:address, links:standingLinksSchema,
}).strict();
const signedStandingV3Schema=signedStandingV2Schema.extend({domain:signedStandingV2Schema.shape.domain.extend({version:z.literal('3')}),message:standingV3MessageSchema,links:standingLinksSchema.extend({vault:z.string().url()})});
export const signedStandingSchema=z.union([signedStandingV1Schema,signedStandingV2Schema,signedStandingV3Schema]);
export type SignedStanding = z.infer<typeof signedStandingSchema>;
export function standingDomain(policy: string,version:'1'|'2'|'3'='1') { return {name:'AccountableAgentStanding' as const,version,chainId:296 as const,verifyingContract:getAddress(policy)}; }
export function standingLinks(message:StandingMessage|StandingV3Message,policy:string) {
  return {account:`https://hashscan.io/testnet/account/${message.hederaAccount}`,topic:`https://hashscan.io/testnet/topic/${message.hcsTopic}`,policy:`https://hashscan.io/testnet/contract/${getAddress(policy)}`,...('vault' in message?{vault:`https://hashscan.io/testnet/contract/${message.vault.contractId}`}:{})};
}
export async function signStanding(message: StandingMessage|StandingV2Message|StandingV3Message, policy: string, wallet: Wallet): Promise<SignedStanding> {
  const v3='vault' in message;
  const v2='agreementHash' in message;
  if(v3) standingV3MessageSchema.parse(message); else if(v2) standingV2MessageSchema.parse(message); else standingMessageSchema.parse(message);
  const domain = standingDomain(policy,v3?'3':v2?'2':'1');
  const signature=await wallet.signTypedData(domain,v3?STANDING_V3_TYPES:v2?STANDING_V2_TYPES:STANDING_TYPES,message);
  return { domain, message, signer:wallet.address, signature, links:standingLinks(message,policy) } as SignedStanding;
}
export function verifyStanding(input: unknown, expectedSigner: string, expectedPolicy: string, expectedAccount: string, now = Math.floor(Date.now()/1000), expectedAgreement?:{hash:string;version:number}, expectedVault?:Pick<VaultReport,'contractAddress'|'termsHash'>|null) {
  const report = signedStandingSchema.parse(input);
  if (getAddress(report.domain.verifyingContract) !== getAddress(expectedPolicy) || report.message.hederaAccount !== expectedAccount) throw new Error('STANDING_SUBJECT_MISMATCH');
  const links=standingLinks(report.message,expectedPolicy);
  if(report.message.hashscanAccount!==links.account || Object.entries(links).some(([name,url])=>(report.links as Record<string,string>)[name]!==url)) throw new Error('STANDING_LINK_MISMATCH');
  if (report.message.issuedAt > now + 30 || report.message.expiresAt <= now || report.message.expiresAt <= report.message.issuedAt || report.message.expiresAt - report.message.issuedAt > 300) throw new Error('STANDING_EXPIRED_OR_INVALID_TIME');
  if(expectedAgreement && (report.domain.version==='1' || !('agreementHash' in report.message) || report.message.agreementHash!==expectedAgreement.hash || report.message.agreementVersion!==expectedAgreement.version)) throw new Error('STANDING_AGREEMENT_MISMATCH');
  if(report.domain.version==='3' && 'vault' in report.message) {
    if((report.message.agreementVersion===0)!==(report.message.agreementHash===ZeroHash)) throw new Error('STANDING_AGREEMENT_MISMATCH');
    if(report.message.vault.utcDay!==Math.floor(report.message.issuedAt/86400).toString()) throw new Error('STANDING_VAULT_DAY_MISMATCH');
  }
  if(expectedVault!==undefined && (expectedVault===null ? 'vault' in report.message : !('vault' in report.message) || getAddress(report.message.vault.contractAddress)!==getAddress(expectedVault.contractAddress) || report.message.vault.termsHash!==expectedVault.termsHash)) throw new Error('STANDING_VAULT_MISMATCH');
  const recovered = verifyTypedData(report.domain, report.domain.version==='3'?STANDING_V3_TYPES:report.domain.version==='2'?STANDING_V2_TYPES:STANDING_TYPES, report.message, report.signature);
  if (getAddress(expectedSigner) !== recovered || getAddress(report.signer) !== recovered) throw new Error('STANDING_SIGNER_MISMATCH');
  return report.message;
}
