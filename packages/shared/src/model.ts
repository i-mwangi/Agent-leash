import { z } from 'zod';
export const entityId = z.string().regex(/^0\.0\.[1-9]\d*$/);
export const uint = z.string().regex(/^(0|[1-9]\d{0,29})$/);
export const address = z.string().regex(/^0x[\da-fA-F]{40}$/);
export const publicKey = z.string().regex(/^(02|03)[\da-fA-F]{64}$/);
export const deploymentSchema = z.object({
  version: z.literal(1), network: z.literal('testnet'), name: z.string().min(1).max(80),
  operatorId: entityId, operatorPublicKey: publicKey,
  guardianId: entityId.optional(), guardianPublicKey: publicKey,
  agentAccount: entityId.optional(), agentPublicKey: publicKey,
  attestationPublicKey: publicKey, attestationAddress: address,
  hcsTopic: entityId.optional(), policyContractId: entityId.optional(), policyAddress: address.optional(),
  erc8004AgentId: uint.optional(), uaid: z.string().optional(),
  registry: address.default('0x8004A818BFB912233c491871b3d84c89A494BD9e'),
  standingBaseUrl: z.string().url().default('http://localhost:3001'),
  routerId: entityId.default('0.0.19264'),
  spendAsset: entityId.default('0.0.429274'), outputAsset: entityId.default('0.0.15058'),
});
export type Deployment = z.infer<typeof deploymentSchema>;
export const eventSchema = z.object({
  v: z.literal(1), type: z.enum(['created','uaid','registered','policy','paused','unpaused','rotated','fill']),
  ts: z.string().datetime(), agentAccount: entityId, payload: z.record(z.unknown()),
});
export type ProfileEvent = z.infer<typeof eventSchema>;
export interface ConsensusEvent extends ProfileEvent { consensusTimestamp: string; sequence: number; publisher: string }
export class AppError extends Error {
  constructor(public code: string, public status: 400 | 402 | 404 | 409 | 422 | 503 = 503) { super(code); }
}
export const NETWORK = 'hedera:testnet' as const;
export const MIRROR = 'https://testnet.mirrornode.hedera.com';
export const FACILITATOR = 'https://api.testnet.blocky402.com';
export const USDC = '0.0.429274';
export const PRICE = '1000'; // six decimals: 0.001 USDC
export function evmAddress(id: string) { entityId.parse(id); return '0x' + BigInt(id.split('.')[2]).toString(16).padStart(40, '0'); }
export function jsonSafe(value: unknown) { return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)); }
