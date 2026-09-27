# Accountable Agent

A Scaffold-HBAR template for one workflow: create a Hedera agent account with a human guardian, register its ERC-8004 identity and HCS-14 profile, then sell a signed standing check over x402. The supplied agent client also demonstrates a policy check immediately before its own spending signatures. A guardian can approve a structured technical policy record whose signed hash is published to HCS and included in version 2 standing reports. This is not legal-ownership verification or a general-purpose law-to-code translator. A native 1-of-2 Hedera key **does not enforce caps or pause** against an agent that bypasses this client. An optional HBAR vault provides contract-enforced caps, recipient permissions, pause, and recovery for HBAR deposited into that vault. SaucerSwap remains an optional spending example, not a prerequisite for paid standing.

## Scaffold and run

```sh
npm create scaffold-hbar@latest -- agent-leash --template i-mwangi/Agent-leash --frontend nextjs-app --solidity-framework hardhat --network testnet --package-manager npm --skip-hedera-skills --ci
cd agent-leash
npm run check
npm run dev
```

Use Node 22.13+ (Node 24 recommended). `npm run dev` launches the explicitly synthetic local demo at `http://localhost:3000` with its API at `http://127.0.0.1:3001`. Stop it before starting the testnet API below.

The published `i-mwangi/Agent-leash#main` template was fetched with the current `create-scaffold-hbar@latest` CLI; dependency installation and `npm run check` passed in a fresh scaffold. On npm 11.2.0, use the `--` separator shown above: without it, npm consumes `--template` and the CLI mistakes `i-mwangi/Agent-leash` for a project name. The project name must be lowercase. The bounty brief's shorter command did not scaffold on this npm version; the command above did.

For a judge-facing smoke check, run `npm run dev`, open `http://localhost:3000`, and request `http://127.0.0.1:3001/health` and `/status`; the page and both API routes should return 200 in demo mode. Before testnet setup, `/standing/:id` deliberately returns unpaid 503 because its authoritative identity and payment sources are not configured. The separate testnet steps below turn that endpoint into a real 402 challenge followed by paid standing.

The scaffold itself takes one command. Creating an agent and accepting testnet payments still requires a funded operator account, local role keys, a testnet API process, and the steps below. For a **new testnet deployment**, copy `.env.operator.example` to `.env.operator`, set a funded `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` locally, then run:

```sh
npm run agent -- onboard
npm run agent -- approve-agreement
npm run agent -- status
npm run agent -- pay-standing
```

`onboard` is resumable: it creates/verifies the guardian and 1-of-2 agent accounts, HCS topic and UAID, policy contract, and ERC-8004 registration, then writes ignored `.accountable/agreement-draft.json` and prints public IDs and links. **Read the draft before running `approve-agreement`.** That explicit command checks the draft against current on-chain caps and allowed asset, signs its deterministic hash with the isolated guardian key, and submits the signed record to the agent's HCS topic. It does not attest to legal ownership, enforce counterparty restrictions, or move custody into a constrained contract. The record covers the currently configured asset and per-transaction/per-UTC-day client limits; a later cap or asset change requires a new approval (`npm run agent -- draft-agreement`, then `approve-agreement`) before paid standing resumes. The previous `init`, `setup`, and `register` commands remain available individually for troubleshooting and older deployments. A stale local draft must be reviewed and removed or moved out of `.accountable` before regenerating it.

Start the testnet API in a separate terminal before `pay-standing`: PowerShell: `$env:APP_MODE='testnet'; npm run dev -w @accountable/server`; Bash: `APP_MODE=testnet npm run dev -w @accountable/server`. Start the dashboard separately with `npm run dev -w @accountable/web`. Startup verifies the account, HCS, registry, policy, facilitator support, and payment token association; it fails before serving if a required source is unavailable. The operator account must hold testnet USDC and the agent account must be associated with it.

`GET /standing/:id` first returns an x402 challenge. After the Blocky402 settlement and an independent mirror confirmation of the exact HTS USDC transfer, it returns an EIP-712 signed standing report plus Hashscan account, topic, and policy links. Existing deployments without an agreement return the pinned 12-field version 1 report. Once a guardian-approved HCS record exists, version 2 also signs its hash and version. The supplied buyer rechecks that HCS record and the current contract policy against the signed report. The example buyer is the operator account with a $0.001 payment limit; this service cannot enforce an arbitrary buyer's local spend cap, pause, or guardian controls. Buyers need their own wallet/client policy for that. The agent's guardian pause lives in the Hedera policy contract, and key revocation is a Hedera account update; standing reports those facts even while paused or revoked.

To demonstrate guardian control after paid standing, run `npm run agent -- pause`, `npm run agent -- unpause`, then `npm run agent -- revoke`. A fresh paid standing check after revocation reports the inactive agent key. Run the optional DEX example below **before** revocation if you want to try it with this same agent account.

### Optional contract-controlled HBAR vault

The native agent account's client limits are advisory to the agent key. For **deposited HBAR only**, `GuardedHbarVault` independently checks a per-transaction cap, a UTC-day cap, the guardian's recipient list, pause state, and the active vault agent on every transfer. The guardian can pause, remove the vault agent, and recover remaining HBAR while paused. It does not control HBAR or HTS tokens left in the native account, and it does not establish legal ownership. This optional path is separate from paid standing and the SaucerSwap example.

After onboarding, put precisely one sentence in a local text file (replace the address with an EVM address you control):

```text
No more than 0.01 HBAR per transaction and 0.05 HBAR per UTC day; only to 0xYOUR_40_HEX_CHARACTER_ADDRESS.
```

The constrained parser rejects other wording and amounts with more than eight decimal places; it never guesses from ambiguous prose. Then run:

```sh
npm run agent -- draft-vault-terms path/to/terms.txt
# Review .accountable/vault-terms-draft.json before approval.
npm run agent -- approve-vault-terms
npm run agent -- deploy-vault
npm run agent -- allow-vault-recipients
npm run agent -- fund-vault 2000000
npm run agent -- vault-spend 0xYOUR_40_HEX_CHARACTER_ADDRESS 1000000
npm run agent -- vault-pause
npm run agent -- vault-recover
npm run agent -- vault-revoke
```

All amounts in these commands are tinybars: `1000000` is 0.01 HBAR. Funding is capped at 1 HBAR per command. `approve-vault-terms` signs the reviewed, account-bound technical terms with the isolated guardian key; `deploy-vault` anchors their hash in the vault contract. The operator pays deployment and funding costs. The contract's guardian controls require the guardian key. The agent's vault spend command reads mirror-backed rules immediately before signing; the contract checks them again even if a caller bypasses this client. Keep `.accountable/` and the role environment files out of GitHub. The CLI currently supports one local vault deployment at a time; use a new scaffold or carefully archive the ignored vault state before a separate deployment.

The **optional SaucerSwap spending example** uses:

```sh
npm run agent -- quote 1000
npm run agent -- fund-dex 100000000
npm run agent -- spend 1000000
```

The CLI creates separate ignored `.env.agent`, `.env.guardian`, and `.env.server` files. Never commit keys or load spend keys in the server. Amounts are raw smallest units: testnet USDC `0.0.429274` and SAUCE `0.0.1183558` each have six decimals, so `1000` is 0.001 USDC and `1000000` is 1 SAUCE. `fund-dex 100000000` uses up to 1 HBAR from the operator to buy testnet SAUCE for the agent through SaucerSwap; it is a separate funding trade, not the policy-gated agent spend. Check the live quote and available operator HBAR before running it. Setup is resumable; a successful transaction whose local result was interrupted requires manual reconciliation rather than a duplicate write.

To reattach an existing deployment after re-scaffolding, copy the four ignored role environment files locally and keep the old public `.accountable/deployment.json` outside the new project. Run `npm run agent -- adopt /path/to/old/deployment.json` **instead of `init`**. The command verifies all four public keys, the account, HCS, registry, and policy against the mirror before saving local state; it creates no Hedera account. Do not put the private environment files in GitHub.
This path was exercised from another fresh public scaffold against the already revoked testnet agent `0.0.10719538`; it recovered the existing deployment without submitting a transaction.

The spend command serializes requests, reserves the raw amount durably before submission, checks mirror-backed account/HCS/registry/policy/balance sources immediately before signing, and confirms the router call and token amounts before publishing a fill. Uncertain submissions stay reserved; a mirror-confirmed failed swap is recorded to HCS and released. Guardian `revoke` updates the account to a guardian-only key. It cannot undo prior spending. Run revoke after the intended agent spends; `restore` deliberately re-enables agent signing through a new guardian-approved key update.

New deployments use the live SaucerSwap V1 SAUCE → WHBAR testnet pool. For an older deployment configured with USDC → WHBAR, run `npm run agent -- restore` if the agent key was revoked, followed by `npm run agent -- configure-dex`; this verifies the pool, allows SAUCE in the guardian policy, associates SAUCE to the agent, and updates only the local deployment route. `restore` is a guardian-signed key update and re-enables the agent key; use it only when that is intended.

`npm run agent -- mcp` starts a local stdio MCP server with `link_account`, `check_policy`, and `record_outcome`. Run it in the repository directory with the isolated agent environment present. `link_account` verifies the account and stores a local ignored binding; `check_policy` is advisory; `record_outcome` checks mirror evidence before writing an HCS fill. The dashboard exposes live identity, policy and pool quote data in testnet mode. Demo switches and sample metrics remain labelled simulations.

The Policy tab has optional browser-wallet controls for pause and unpause. Put a public Reown/WalletConnect project ID in ignored `packages/nextjs/.env.local` as `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...`, restart Next.js, and connect a Hedera testnet wallet that controls the configured guardian account. The UI checks the connected account ID, asks that wallet to sign, checks the transaction on the mirror, and then asks it to publish a guardian HCS event. No guardian private key is sent to the dashboard or API. A HashPack browser session signed testnet pause and unpause contract calls and HCS messages; the transactions and matching topic messages were confirmed on the mirror. The HCS request uses Hedera's maximum 180-second validity window and surfaces an expired approval as a retry instruction. The UI preserves the pending HCS record across a page reload and confirms the topic message on the mirror before reporting success. Click **Retry HCS record** after an expired approval; do not repeat the contract action. If browser signing is unavailable, `npm run agent -- reconcile-pause GUARDIAN_PAUSE_TXID` verifies the guardian payer, successful call to this deployment's policy contract, exact `pause()` function, current paused state, and absence of an HCS record before signing only the missing HCS event with the local ignored guardian key. It does not repeat the contract call. The CLI guardian actions remain the verified live path. HashPack's published WalletConnect transaction list does not include Account Update, so browser revocation is disabled; use the isolated CLI.

## Real testnet evidence

These are **testnet writes** from one local deployment on 25–27 September 2026, separate from the demo and local contract execution.

| Item                                | Evidence                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guardian account `0.0.10715881`     | [creation](https://hashscan.io/testnet/transaction/0.0.5792828%401790349018.352739409)                                                                                                      |
| 1-of-2 agent account `0.0.10715883` | [creation](https://hashscan.io/testnet/transaction/0.0.5792828%401790349024.163447892)                                                                                                      |
| HCS topic `0.0.10715890`            | [creation](https://hashscan.io/testnet/transaction/0.0.5792828%401790349046.149672625), [UAID message](https://hashscan.io/testnet/transaction/0.0.5792828%401790349056.243185055)          |
| Policy contract `0.0.10715941`      | [deployment](https://hashscan.io/testnet/transaction/0.0.5792828%401790349205.179484212), [allowlist](https://hashscan.io/testnet/transaction/0.0.10715881%401790349210.300763930)          |
| ERC-8004 agent `121`                | [registration](https://hashscan.io/testnet/transaction/0.0.5792828%401790349275.514184066), [card update](https://hashscan.io/testnet/transaction/0.0.5792828%401790349280.300460069)       |
| Token associations                  | [USDC](https://hashscan.io/testnet/transaction/0.0.10715883%401790349220.774920691), [WHBAR](https://hashscan.io/testnet/transaction/0.0.10715883%401790349224.140844625)                   |
| x402 paid standing                  | [0.001 USDC settlement](https://hashscan.io/testnet/transaction/0.0.7162784%401790350541.346608081), operator `0.0.5792828` → agent `0.0.10715883`                                          |
| Paid standing with evidence links   | [0.001 USDC settlement](https://hashscan.io/testnet/transaction/0.0.7162784%401790502158.010293147); the signed report and derived account/topic/policy links passed the supplied client verifier |
| Guardian policy record              | [guardian-signed HCS publication](https://hashscan.io/testnet/transaction/0.0.10715881%401790534670.287987571) on topic `0.0.10715890`; version 1 hash `0xe88cb434742bcab8ff9606794b3bb4f26e27efe6c2101cd427d7374d03815c8f` |
| Version 2 paid standing             | [0.001 USDC settlement](https://hashscan.io/testnet/transaction/0.0.7162784%401790534853.007138227); the buyer verified the settlement, HCS policy record, current policy, and EIP-712 signature containing the same hash and version |
| Optional HBAR vault                  | [contract `0.0.10748172`](https://hashscan.io/testnet/contract/0.0.10748172) anchors guardian-approved hash `0x2f3789592bb1eb1a39ab041d02527412e24ad26b4ef7d4d329efc847df0c14d7`; [guardian allowlist](https://hashscan.io/testnet/transaction/0.0.10715881%401790536453.749688714), [0.02 HBAR funding](https://hashscan.io/testnet/transaction/0.0.5792828%401790536476.459345908), [0.01 HBAR agent spend](https://hashscan.io/testnet/transaction/0.0.10715883%401790536487.595052999), [guardian pause](https://hashscan.io/testnet/transaction/0.0.10715881%401790536502.671587111), [0.01 HBAR recovery](https://hashscan.io/testnet/transaction/0.0.10715881%401790536526.827710143), and [vault agent revocation](https://hashscan.io/testnet/transaction/0.0.10715881%401790536541.410582156). The mirror showed a 1,000,000-tinybar recipient credit on spend and a zero vault balance after recovery; a paused spend was rejected before signing. |
| Guardian pause/unpause              | [pause](https://hashscan.io/testnet/transaction/0.0.10715881%401790351849.434983179), [unpause](https://hashscan.io/testnet/transaction/0.0.10715881%401790351875.376849531)                |
| Browser pause and HCS recovery      | [HashPack-signed pause](https://hashscan.io/testnet/transaction/0.0.10715881%401790473656.056565005), [guardian HCS record](https://hashscan.io/testnet/transaction/0.0.10715881%401790475981.763264663) |
| Browser wallet HCS retry            | [HashPack-signed pause](https://hashscan.io/testnet/transaction/0.0.10715881%401790500372.264324397), [HashPack-signed HCS event](https://hashscan.io/testnet/transaction/0.0.10715881%401790501022.616111836); topic `0.0.10715890` records the pause transaction ID |
| Browser wallet unpause              | [HashPack-signed unpause](https://hashscan.io/testnet/transaction/0.0.10715881%401790501434.858306810), [HashPack-signed HCS event](https://hashscan.io/testnet/transaction/0.0.10715881%401790501442.745705531); topic `0.0.10715890` records the unpause transaction ID |
| Guardian revocation                 | [key update](https://hashscan.io/testnet/transaction/0.0.10715881%401790351896.589395734), [HCS rotated event](https://hashscan.io/testnet/transaction/0.0.10715881%401790351899.146336845) |
| Standing after revocation           | [second USDC settlement](https://hashscan.io/testnet/transaction/0.0.7162784%401790351936.882024325); verified EIP-712 report returned `agentKeyActive: false`                              |

`npm run agent -- status` reads and cross-checks the mirror account key, HCS publishers/events, registry owner/card, and guardian policy. These public IDs are examples, not fresh-scaffold defaults.

The first agent was later [restored by its guardian](https://hashscan.io/testnet/transaction/0.0.10715881%401790369383.959931297) to test the live DEX route; its current key state is active. The historical revoked-state standing evidence above remains valid for the time it was issued.

A **second deployment from a freshly downloaded public scaffold** also completed the allowed fallback flow on testnet: [agent account `0.0.10719538`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368400.901918984), [HCS topic `0.0.10719539`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368403.419699553), [policy `0.0.10719558`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368452.706297608), [ERC-8004 agent `122`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368490.311414726), [paid standing](https://hashscan.io/testnet/transaction/0.0.7162784%401790368535.441608179), [guardian revocation](https://hashscan.io/testnet/transaction/0.0.10719536%401790368579.022184355), and [paid standing after revocation](https://hashscan.io/testnet/transaction/0.0.7162784%401790368604.066112463). The second verified report returned `agentKeyActive: false`. A live SAUCE → WHBAR read-only quote succeeded between payment and revocation. The configured USDC swap failed before signing because no pool exists; after revocation it failed with `AGENT_KEY_INACTIVE`. This fresh-scaffold run used the published template at commit `7f7c412` before the subsequent API startup preflight change.

## Current integration limits

The API implements x402 v2 payment requirements, Blocky402 verification/settlement, independent mirror transfer confirmation, replay protection, and signed EIP-712 standing. With the local testnet server running (`APP_MODE=testnet`), `pay-standing` paid 0.001 USDC, checked the mirror debit/credit, and verified the signed report against the pinned attestation address and policy. A separate live payment verified version 2 against the guardian-signed HCS technical policy record above. The report expires after two minutes. Missing identity or settlement sources fail closed. The HCS record does not make the native account's client-enforced limits mandatory for a bypassing agent.

The SaucerSwap V1 router `0.0.19264` exists on testnet, but there is no V1 or V2 USDC → WHBAR pool at the configured addresses. New scaffolds use the verified SAUCE → WHBAR V1 pool instead. On 25 September 2026, [the operator bought 54.935622 SAUCE for the agent with 1 HBAR](https://hashscan.io/testnet/transaction/0.0.5792828%401790369426.644109430), and [the policy-checked agent swapped 1 SAUCE for 0.01809430 WHBAR](https://hashscan.io/testnet/transaction/0.0.10715883%401790369523.124021573), then [published the fill](https://hashscan.io/testnet/transaction/0.0.10715883%401790369529.955985574). Hedera reports the HTS transfers on the contract call's child nonces; the adapter checks those mirror rows and the router parent before accepting a fill. `quote-fallback 1000000` remains a read-only pool check. A forked-mainnet execution has not been demonstrated. A Hardhat 3 fork of `https://mainnet.hashio.io/api` loaded chain 295 and the mainnet SaucerSwap router bytecode, but local router calls failed because the fork lacked Hedera's hardfork activation history. The Hedera system-contract forking plugin currently declares a Hardhat 2 peer dependency, so this attempt is not counted as execution. The real testnet swap above is the execution evidence.

The card's default standing endpoint is `localhost:3001`, for local development only. Set a reachable URL before registration for a public paid endpoint. The UI is synthetic and must not be presented as live standing.

## Validation

`npm run check` runs lint, TypeScript, deterministic unit/integration tests, local Solidity execution tests, and production builds. Tests do not require funded accounts. Live evidence above was checked separately with testnet receipts and mirror reads. The previously published public template was scaffolded again with the current Scaffold-HBAR CLI; dependency installation and the full check passed in that fresh checkout. Re-run a fresh public scaffold after publishing this vault addition before treating it as independently verified from the published template.

| Package              | Role                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `packages/agent`     | CLI, key-isolated setup, policy guard, swap adapter, guardian actions |
| `packages/shared`    | Mirror/HCS readers, identity validation, UAID, SQLite state           |
| `packages/server`    | Hono API, x402 settlement, signed standing                            |
| `packages/contracts` | Guardian-owned policy configuration                                   |
| `packages/nextjs`    | Local interactive demo                                                |

Sources: [bounty brief](https://hedera.com/blog/scaffold-hbar-template-bounty/), [Scaffold-HBAR CLI](https://github.com/hedera-dev/create-scaffold-hbar), [Hedera SDK deployment guide](https://hedera.com/blog/how-to-deploy-smart-contracts-on-hedera-part-1-a-simple-getter-and-setter-contract/), [SaucerSwap contracts](https://docs.saucerswap.finance/developers/contracts.md), [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), [Blocky402 API](https://blocky402.com/docs/api-reference/).

MIT licensed.
