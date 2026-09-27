import { describe, expect, it } from 'vitest';
import { compileVaultTerms, vaultTermsHash } from '../packages/shared/src/vaultTerms';

const recipient = '0x0000000000000000000000000000000000001234';
const context = {network:'hedera:testnet' as const,agentAccount:'0.0.123',guardianAccount:'0.0.456'};
describe('constrained operating terms', () => {
  it('compiles precise HBAR limits and produces a stable hash', () => {
    const terms = compileVaultTerms(`No more than 0.25 HBAR per transaction and 1.5 HBAR per UTC day; only to ${recipient}.`);
    expect(terms.maxPerTxTinybars).toBe('25000000');
    expect(terms.maxPerUtcDayTinybars).toBe('150000000');
    expect(terms.allowedRecipients).toEqual([recipient]);
    expect(vaultTermsHash(terms,context)).toMatch(/^0x[\da-f]{64}$/);
    expect(vaultTermsHash(terms,context)).toBe(vaultTermsHash({...terms},context));
    expect(vaultTermsHash(terms,context)).not.toBe(vaultTermsHash(terms,{...context,agentAccount:'0.0.124'}));
  });
  it('fails closed on ambiguous, impossible or excessive terms', () => {
    expect(() => compileVaultTerms(`Spend about 1 HBAR per day to ${recipient}.`)).toThrow('UNSUPPORTED_OPERATING_TERMS');
    expect(() => compileVaultTerms(`No more than 2 HBAR per transaction and 1 HBAR per UTC day; only to ${recipient}.`)).toThrow('DAY_CAP_BELOW_TX_CAP');
    expect(() => compileVaultTerms(`No more than 0.000000001 HBAR per transaction and 1 HBAR per UTC day; only to ${recipient}.`)).toThrow('UNSUPPORTED_OPERATING_TERMS');
  });
});
