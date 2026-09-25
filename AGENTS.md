# Accountable Agent development

- Read README.md and the implementation spec before changing behavior. Report demo, local contract execution, fork execution, and real testnet evidence separately.
- Keep the supplied agent's policy check immediately before signing. Fail closed when required sources are unavailable.
- Policy is client-enforced. Never claim that the 1-of-2 native account enforces caps or pause against a bypassing agent.
- Use bigint for all smallest-unit amounts. Verify token decimals before formatting human amounts.
- Keep agent and guardian spend keys out of the server. Never log keys, seed phrases, signed payment payloads or environment contents.
- Testnet only for live writes. Do not fabricate addresses, transaction receipts, UAID vectors, signatures, registry identities or successful protocol integrations.
- The current testnet registry candidate is `0x8004A818BFB912233c491871b3d84c89A494BD9e`; USDC candidate is `0.0.429274`. Verify both before wiring them. The Blocky402 endpoint and SaucerSwap router are not yet verified.
- Paid standing requires authoritative identity sources and independent mirror settlement confirmation. Until implemented, return unpaid 503. Do not substitute a mock 402 response for a working x402 integration.
- Raw-digest Hedera signing and offline standing verification are pending; implement from verified SDK documentation and pinned test vectors.
- Run `npm run check` after implementation changes. Keep local tests deterministic and independent of funded accounts.
- Public template installation and real testnet evidence must be verified before marking the submission ready.
