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
npm run agent -- pay-standing
npm run agent -- quote 1000
npm run agent -- quote-fallback 1000000
npm run agent -- spend 1000
npm run agent -- pause
npm run agent -- unpause
npm run agent -- revoke
npm run agent -- pay-standing
```

The CLI creates separate ignored `.env.agent`, `.env.guardian`, and `.env.server` files. Never commit keys or load spend keys in the server. Amounts are raw smallest units: testnet USDC `0.0.429274` has six decimals, so `1000` is 0.001 USDC. Setup is resumable; a successful transaction whose local result was interrupted requires manual reconciliation rather than a duplicate write.

To reattach an existing deployment after re-scaffolding, copy the four ignored role environment files locally and keep the old public `.accountable/deployment.json` outside the new project. Run `npm run agent -- adopt /path/to/old/deployment.json` **instead of `init`**. The command verifies all four public keys, the account, HCS, registry, and policy against the mirror before saving local state; it creates no Hedera account. Do not put the private environment files in GitHub.

Start the testnet API in a separate terminal before `pay-standing`: PowerShell: `$env:APP_MODE='testnet'; npm run dev -w @accountable/server`; Bash: `APP_MODE=testnet npm run dev -w @accountable/server`. Startup verifies the account, HCS, registry, policy, facilitator support, and payment token association; it fails before serving if a required source is unavailable. The operator account must hold testnet USDC and the agent account must be associated with it.

The spend command serializes requests, reserves the raw amount durably before submission, checks mirror-backed account/HCS/registry/policy/balance sources immediately before signing, and confirms the router call and token amounts before publishing a fill. Uncertain submissions stay reserved; a mirror-confirmed failed swap is recorded to HCS and released. Guardian `revoke` updates the account to a guardian-only key. It cannot undo prior spending. **Run revoke last:** the agent key cannot authorize further spends afterward.

`npm run agent -- mcp` starts a local stdio MCP server with `link_account`, `check_policy`, and `record_outcome`. Run it in the repository directory with the isolated agent environment present. `link_account` verifies the account and stores a local ignored binding; `check_policy` is advisory; `record_outcome` checks mirror evidence before writing an HCS fill. The dashboard exposes live read-only identity, policy and fallback quote data in testnet mode. Demo switches and sample metrics remain labelled simulations.

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
| x402 paid standing | [0.001 USDC settlement](https://hashscan.io/testnet/transaction/0.0.7162784%401790350541.346608081), operator `0.0.5792828` → agent `0.0.10715883` |
| Guardian pause/unpause | [pause](https://hashscan.io/testnet/transaction/0.0.10715881%401790351849.434983179), [unpause](https://hashscan.io/testnet/transaction/0.0.10715881%401790351875.376849531) |
| Guardian revocation | [key update](https://hashscan.io/testnet/transaction/0.0.10715881%401790351896.589395734), [HCS rotated event](https://hashscan.io/testnet/transaction/0.0.10715881%401790351899.146336845) |
| Standing after revocation | [second USDC settlement](https://hashscan.io/testnet/transaction/0.0.7162784%401790351936.882024325); verified EIP-712 report returned `agentKeyActive: false` |

`npm run agent -- status` reads and cross-checks the mirror account key, HCS publishers/events, registry owner/card, and guardian policy. These public IDs are examples, not fresh-scaffold defaults.

A **second deployment from a freshly downloaded public scaffold** also completed the allowed fallback flow on testnet: [agent account `0.0.10719538`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368400.901918984), [HCS topic `0.0.10719539`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368403.419699553), [policy `0.0.10719558`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368452.706297608), [ERC-8004 agent `122`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368490.311414726), [paid standing](https://hashscan.io/testnet/transaction/0.0.7162784%401790368535.441608179), [guardian revocation](https://hashscan.io/testnet/transaction/0.0.10719536%401790368579.022184355), and [paid standing after revocation](https://hashscan.io/testnet/transaction/0.0.7162784%401790368604.066112463). The second verified report returned `agentKeyActive: false`. A live SAUCE → WHBAR read-only quote succeeded between payment and revocation. The configured USDC swap failed before signing because no pool exists; after revocation it failed with `AGENT_KEY_INACTIVE`. This fresh-scaffold run used the published template at commit `7f7c412` before the subsequent API startup preflight change.

## Current integration limits

The API implements x402 v2 payment requirements, Blocky402 verification/settlement, independent mirror transfer confirmation, replay protection, and signed EIP-712 standing. With the local testnet server running (`APP_MODE=testnet`), `pay-standing` paid 0.001 USDC, checked the mirror debit/credit, and verified the signed report against the pinned attestation address and policy. The report expires after two minutes. Missing identity or settlement sources fail closed.

The SaucerSwap V1 router `0.0.19264` exists on testnet, but there is no V1 or V2 USDC → WHBAR pool at the configured addresses. `getAmountsOut` reverts. Before revocation, `spend` stops with `DEX_QUOTE_REVERTED`; after revocation it stops earlier with `AGENT_KEY_INACTIVE`. **No swap has executed.** A reproducible **read-only** fallback is `npm run agent -- quote-fallback 1000000`: on 25 September 2026 the testnet V1 pair `0xfE7CC3cEb7b1128bfC3889184E2d5561BF74bfb3` quoted 1 SAUCE (six decimals) to 0.01809179 WHBAR (eight decimals). It checks token decimals and pool existence, calls the live router, and never signs or submits a transaction. This is quote evidence, not a fill. A forked-mainnet execution has not been demonstrated.

The card's default standing endpoint is `localhost:3001`, for local development only. Set a reachable URL before registration for a public paid endpoint. The UI is synthetic and must not be presented as live standing.

## Validation

`npm run check` runs lint, TypeScript, 34 deterministic unit/integration tests, one local Solidity execution test, and production builds. Tests do not require funded accounts. Live evidence above was checked separately with testnet receipts and mirror reads. The public template was scaffolded again after the MCP/dashboard changes; `npm ci` and the full check passed in that fresh checkout.

| Package | Role |
| --- | --- |
| `packages/agent` | CLI, key-isolated setup, policy guard, swap adapter, guardian actions |
| `packages/shared` | Mirror/HCS readers, identity validation, UAID, SQLite state |
| `packages/server` | Hono API, x402 settlement, signed standing |
| `packages/contracts` | Guardian-owned policy configuration |
| `packages/nextjs` | Local interactive demo |

Sources: [bounty brief](https://hedera.com/blog/scaffold-hbar-template-bounty/), [Scaffold-HBAR CLI](https://github.com/hedera-dev/create-scaffold-hbar), [Hedera SDK deployment guide](https://hedera.com/blog/how-to-deploy-smart-contracts-on-hedera-part-1-a-simple-getter-and-setter-contract/), [SaucerSwap contracts](https://docs.saucerswap.finance/developers/contracts.md), [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), [Blocky402 API](https://blocky402.com/docs/api-reference/).

MIT licensed.
