import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { z } from 'zod';

const TINYBARS_PER_HBAR = 100_000_000n;
const termsSchema = z.object({
  version: z.literal(1),
  asset: z.literal('HBAR'),
  maxPerTxTinybars: z.string().regex(/^[1-9]\d*$/),
  maxPerUtcDayTinybars: z.string().regex(/^[1-9]\d*$/),
  allowedRecipients: z.array(z.string()).min(1).max(20),
}).strict();
export type VaultTerms = z.infer<typeof termsSchema>;

function tinybars(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) throw new Error('INVALID_HBAR_AMOUNT');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * TINYBARS_PER_HBAR + BigInt((fraction + '00000000').slice(0, 8));
  if (result === 0n || result > (1n << 256n) - 1n) throw new Error('INVALID_HBAR_AMOUNT');
  return result;
}

/** Deliberately narrow grammar: ambiguous free text must never become an authorization. */
export function compileVaultTerms(input: string): VaultTerms {
  const match = /^No more than (\d+(?:\.\d{1,8})?) HBAR per transaction and (\d+(?:\.\d{1,8})?) HBAR per UTC day; only to (0x[\da-fA-F]{40}(?:, 0x[\da-fA-F]{40})*)\.$/.exec(input.trim());
  if (!match) throw new Error('UNSUPPORTED_OPERATING_TERMS');
  const perTx = tinybars(match[1]), perDay = tinybars(match[2]);
  if (perDay < perTx) throw new Error('DAY_CAP_BELOW_TX_CAP');
  const recipients = match[3].split(', ').map(getAddress);
  if (recipients.some(address => address === '0x0000000000000000000000000000000000000000')) throw new Error('ZERO_RECIPIENT');
  if (new Set(recipients.map(address => address.toLowerCase())).size !== recipients.length) throw new Error('DUPLICATE_RECIPIENT');
  return termsSchema.parse({version: 1, asset: 'HBAR', maxPerTxTinybars: perTx.toString(), maxPerUtcDayTinybars: perDay.toString(), allowedRecipients: recipients});
}

export interface VaultContext { network: 'hedera:testnet'; agentAccount: string; guardianAccount: string }
export function vaultTermsHash(input: VaultTerms, context: VaultContext): string {
  const terms = termsSchema.parse(input);
  const owner=z.object({network:z.literal('hedera:testnet'),agentAccount:z.string().regex(/^0\.0\.\d+$/),guardianAccount:z.string().regex(/^0\.0\.\d+$/)}).strict().parse(context);
  return keccak256(toUtf8Bytes(JSON.stringify({context:owner,terms:{version: terms.version, asset: terms.asset, maxPerTxTinybars: terms.maxPerTxTinybars, maxPerUtcDayTinybars: terms.maxPerUtcDayTinybars, allowedRecipients: terms.allowedRecipients.map(getAddress)}})));
}
