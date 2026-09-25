# Accountable Agent

A Scaffold-HBAR template for an agent wallet with guardian revocation, client-enforced spending policy, ERC-8004 identity, HCS profile, x402 standing, and a SaucerSwap V1 adapter. The supplied client checks policy immediately before signing. A native 1-of-2 Hedera key **does not enforce caps or pause** against an agent that bypasses this client.

## Scaffold and run

```sh
npm create scaffold-hbar@latest --template i-mwangi/Agent-leash
cd Agent-leash
npm install
npm run check
npm run dev
```

Use Node 22.13+ (Node 24 recommended). The dashboard at `http://localhost:3000` is an explicitly synthetic local demo. The API runs at `http://127.0.0.1:3001`.

The published `i-mwangi/Agent-leash#main` template was fetched with `create-scaffold-hbar@0.4.0`; `npm ci` and `npm run check` passed in that fresh scaffold.

For a **new testnet deployment**, copy `.env.operator.example` to `.env.operator`, set a funded `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` locally, then run:

```sh
npm run agent -- init
npm run agent -- setup
npm run agent -- register
npm run agent -- status
npm run agent -- quote 1000
npm run agent -- spend 1000
npm run agent -- pause
npm run agent -- unpause
npm run agent -- revoke
```

The CLI creates separate ignored `.env.agent`, `.env.guardian`, and `.env.server` files. Never commit keys or load spend keys in the server. Amounts are raw smallest units: testnet USDC `0.0.429274` has six decimals, so `1000` is 0.001 USDC. Setup is resumable; a successful transaction whose local result was interrupted requires manual reconciliation rather than a duplicate write.

The spend command serializes requests, reserves the raw amount durably before submission, checks mirror-backed account/HCS/registry/policy/balance sources immediately before signing, and confirms the token debit before publishing a fill. Uncertain submissions stay reserved. Guardian `revoke` updates the account to a guardian-only key. It cannot undo prior spending.

## Real testnet evidence

These are **testnet writes** from one local deployment on 25 September 2026, separate from the demo and local contract execution.

| Item | Evidence |
| --- | --- |
| Guardian account `0.0.10715881` | [creation](https://hashscan.io/testnet/transaction/0.0.5792828%401790349018.352739409) |
| 1-of-2 agent account `0.0.10715883` | [creation](https://hashscan.io/testnet/transaction/0.0.5792828%401790349024.163447892) |
| HCS topic `0.0.10715890` | [creation](https://hashscan.io/testnet/transaction/0.0.5792828%401790349046.149672625), [UAID message](https://hashscan.io/testnet/transaction/0.0.5792828%401790349056.243185055) |
| Policy contract `0.0.10715941` | [deployment](https://hashscan.io/testnet/transaction/0.0.5792828%401790349205.179484212), [allowlist](https://hashscan.io/testnet/transaction/0.0.10715881%401790349210.300763930) |
| ERC-8004 agent `121` | [registration](https://hashscan.io/testnet/transaction/0.0.5792828%401790349275.514184066), [card update](https://hashscan.io/testnet/transaction/0.0.5792828%401790349280.300460069) |
| Token associations | [USDC](https://hashscan.io/testnet/transaction/0.0.10715883%401790349220.774920691), [WHBAR](https://hashscan.io/testnet/transaction/0.0.10715883%401790349224.140844625) |

`npm run agent -- status` reads and cross-checks the mirror account key, HCS publishers/events, registry owner/card, and guardian policy. These public IDs are examples, not fresh-scaffold defaults.

## Current integration limits

The API implements x402 v2 payment requirements, Blocky402 verification/settlement, independent mirror transfer confirmation, replay protection, and signed EIP-712 standing. **No paid standing response has been verified end to end**: the example account currently has zero testnet USDC. Missing identity or settlement sources fail closed.
The testnet API did return an unpaid `402 Payment Required` challenge with the expected Hedera USDC asset; that is challenge evidence, not payment evidence.

The SaucerSwap V1 router `0.0.19264` exists on testnet, but `getAmountsOut` for the configured USDC → WHBAR route currently reverts. `quote` and `spend` stop with `DEX_QUOTE_REVERTED`; **no swap has executed**. A working pool/route and funded agent are prerequisites for live fill evidence. A forked-mainnet route has not been executed. The current adapter is a read-only integration limit under the bounty brief, not trade evidence.

The card's default standing endpoint is `localhost:3001`, for local development only. Set a reachable URL before registration for a public paid endpoint. The UI is synthetic and must not be presented as live standing.

## Validation

`npm run check` runs lint, TypeScript, 32 deterministic unit/integration tests, one local Solidity execution test, and production builds. Tests do not require funded accounts. Live evidence above was checked separately with testnet receipts and mirror reads.

| Package | Role |
| --- | --- |
| `packages/agent` | CLI, key-isolated setup, policy guard, swap adapter, guardian actions |
| `packages/shared` | Mirror/HCS readers, identity validation, UAID, SQLite state |
| `packages/server` | Hono API, x402 settlement, signed standing |
| `packages/contracts` | Guardian-owned policy configuration |
| `packages/nextjs` | Local interactive demo |

Sources: [bounty brief](https://hedera.com/blog/scaffold-hbar-template-bounty/), [Scaffold-HBAR CLI](https://github.com/hedera-dev/create-scaffold-hbar), [Hedera SDK deployment guide](https://hedera.com/blog/how-to-deploy-smart-contracts-on-hedera-part-1-a-simple-getter-and-setter-contract/), [SaucerSwap contracts](https://docs.saucerswap.finance/developers/contracts.md), [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), [Blocky402 API](https://blocky402.com/docs/api-reference/).

MIT licensed.
