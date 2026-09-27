# Accountable Agent development

- Read README.md and the relevant package source before changing behavior. The local planning guide is intentionally excluded from the public template; README.md is the public setup and evidence source. Report demo, local contract execution, fork execution, and real testnet evidence separately.
- Keep the supplied agent's policy check immediately before signing. Fail closed when required sources are unavailable.
- Policy is client-enforced. Never claim that the 1-of-2 native account enforces caps or pause against a bypassing agent.
- Use bigint for all smallest-unit amounts. Verify token decimals before formatting human amounts.
- Keep agent and guardian spend keys out of the server. Never log keys, seed phrases, signed payment payloads or environment contents.
- Testnet only for live writes. Do not fabricate addresses, transaction receipts, UAID vectors, signatures, registry identities or successful protocol integrations.
- The testnet registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`, USDC `0.0.429274`, Blocky402 payment flow, and SaucerSwap SAUCE/WHBAR route have live evidence linked in README.md. Recheck deployed contracts, token decimals, and pool liquidity before new live writes.
- Paid standing requires authoritative identity sources and independent mirror settlement confirmation. Keep the unconfigured route at unpaid 503; never substitute a mock 402 response for a working x402 integration.
- Preserve the pinned raw-digest Hedera signing and offline EIP-712 standing verification tests when changing transaction or report formats.
- Run `npm run check` after implementation changes. Keep local tests deterministic and independent of funded accounts.
- Public template installation and real testnet evidence must be verified before marking the submission ready.
