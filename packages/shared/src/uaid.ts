import { createHash } from 'node:crypto';
import { z } from 'zod';
const fields = z.object({ registry: z.string().trim().min(1), name: z.string().trim().min(1), version: z.string().trim().min(1), protocol: z.string().trim().min(1), nativeId: z.string().trim().min(1), skills: z.array(z.number().int().nonnegative()) });
export type AgentData = z.infer<typeof fields>;
/** HCS-14 canonical order and normalization, pinned against HOL SDK commit in fixture. */
export function canonicalAgent(input: AgentData) {
  const value = fields.parse(input);
  const protocol = value.protocol.toLowerCase();
  if (protocol === 'hcs-10' && !/^hedera:(mainnet|testnet|previewnet|devnet):\d+\.\d+\.\d+$/.test(value.nativeId)) throw new Error('INVALID_HCS10_NATIVE_ID');
  if (/[;=]/.test(value.registry + value.nativeId)) throw new Error('INVALID_UAID_ROUTING');
  return JSON.stringify({ skills: [...value.skills].sort((a,b) => a-b), name: value.name, nativeId: value.nativeId, protocol, registry: value.registry.toLowerCase(), version: value.version });
}
export function base58(bytes: Uint8Array) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let result = '';
  while (n > 0n) { result = alphabet[Number(n % 58n)] + result; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; result = '1' + result; }
  return result;
}
export function createUaid(input: AgentData) {
  const canonical = canonicalAgent(input);
  const normalized = JSON.parse(canonical) as AgentData;
  return `uaid:aid:${base58(createHash('sha384').update(canonical).digest())};uid=0;registry=${normalized.registry};nativeId=${normalized.nativeId}`;
}
export function agentData(name: string, account: string): AgentData {
  return { registry: 'accountable-agent', name, version: '1.0.0', protocol: 'hcs-10', nativeId: `hedera:testnet:${account}`, skills: [0,17] };
}
