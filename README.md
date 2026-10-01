# Accountable Agent

**Give an AI agent on Hedera a human guardian, a verifiable identity, and spending rules a counterparty can check.** One command scaffolds the dApp; the browser sets up the agent.

Accountable Agent is a [Scaffold-HBAR](https://github.com/hedera-dev/create-scaffold-hbar) template. It creates a 1-of-2 Hedera account that the agent and a human guardian both control, registers the agent's identity on HCS and ERC-8004, records guardian-approved spending terms on-chain, and sells a signed **standing report** over x402 so other agents can verify it before dealing with it. Testnet only.

---

## The problem

Anyone can hand an AI agent a wallet. Nothing about that wallet makes the agent trustworthy with money: no one is visibly answerable for it, its spending rules live only in its own code, and there is no clean way to stop it or get the funds back when it misbehaves. A counterparty has no way to check any of this before dealing with it.

---

## Features

- **Guardian-controlled account** — a 1-of-2 Hedera key: the agent signs on its own; the guardian can pause it or revoke its key
- **Browser setup** — `npm run dev`, connect HashPack, approve four transactions; a local agent runtime does the rest
- **Verifiable identity** — HCS profile topic, HCS-14 UAID and ERC-8004 registration on Hedera testnet
- **Guardian-approved terms** — the agreement hash is published to HCS and bound into every standing report
- **Paid standing** — `GET /standing/:id` sells an EIP-712 signed report over x402 (USDC via Blocky402, settlement confirmed on the mirror)
- **Pay for services over x402** — the agent pays any HTTP service that charges in USDC on Hedera, such as an LLM API, within the guardian's limits, from the dashboard, the CLI or an AI assistant over MCP; and it can sell paid LLM inference itself
- **Agent lookup and reputation** — verify any other agent by its ERC-8004 ID before dealing with it, and rate agents you dealt with in the ERC-8004 reputation registry on Hedera
- **Contract-enforced vault (optional)** — caps, recipient allowlist, pause and recovery that hold even if the agent bypasses its client
- **Guardian wallet controls** — pause, unpause and vault recovery from HashPack in the dashboard
- **DEX on demand or on a schedule (optional)** — tell the agent to swap on SaucerSwap now, or at a set time through the Hedera Schedule Service, always after a policy check; compare live mainnet prices on SaucerSwap and Lambdaplex

---

## Prerequisites

- **Node.js** ≥ 22.13 (24 recommended) — [nodejs.org](https://nodejs.org/)
- **Git** (with `user.name` and `user.email` configured) — [git-scm.com](https://git-scm.com/)
- **npm** (the template uses npm workspaces)
- **HashPack** with an **ECDSA** Hedera testnet account holding about **50 HBAR**; it becomes the guardian. [Get testnet HBAR](https://portal.hedera.com/)

No Foundry install is needed: the template uses Hardhat.

---

## Quick start

Scaffold without prompts:

```sh
npx create-scaffold-hbar@latest agent-leash -t i-mwangi/Agent-leash -y --skip-hedera-skills --frontend nextjs-app --solidity-framework hardhat --network testnet --package-manager=npm
```

Then run:

```sh
cd agent-leash
npm run check
npm run dev
```

Open `http://localhost:3000` and go to **Create agent** ([browser setup](#set-up-an-agent-in-the-browser)).

`npm run dev` starts three processes: the dashboard at `http://localhost:3000`, the API at `http://127.0.0.1:3001` and the local agent runtime at `http://127.0.0.1:3002`. Before starting, it creates any missing local key files (`.env.operator`, `.env.agent`, `.env.server`; ignored by git, never printed, never overwritten) and compiles the contracts if needed. Until this workspace has a complete, verified deployment, the dashboard shows an explicitly labelled synthetic demo.

### Interactive scaffold

To answer the scaffolder's questions instead:

```sh
npx create-scaffold-hbar@latest -t i-mwangi/Agent-leash
```

| Question                                | Choose                                      |
| --------------------------------------- | ------------------------------------------- |
| What is your project name?              | A lowercase name, for example `agent-leash` |
| Install Hedera Skills marketplace …?    | Either; **Yes** only adds agent guide files |
| Which Hedera network?                   | **Testnet** (the template is testnet-only)  |
| Install dependencies after scaffolding? | **Yes**                                     |
| Which frontend framework? _(if asked)_  | **Next.js (App Router)**                    |
| Which Solidity framework? _(if asked)_  | **Hardhat**, not the default Foundry        |
| Which package manager? _(if asked)_     | **Npm**, not the default Yarn               |

The last three questions normally do not appear: the scaffolder reads Next.js, Hardhat and npm from this template's `template.json`. They appear only if it cannot fetch that file, and then their defaults (Foundry, Yarn) are wrong for this template. The interactive form needs a real terminal.

**Scaffold notes:** the full command pins every option, so it also works when the scaffolder cannot fetch template defaults. `-y` skips prompts and `--skip-hedera-skills` skips the optional Hedera Skills install. If you use `npm create` instead of `npx`, put `--` before the project name; npm 11 otherwise consumes the template flag.

### Smoke check

With `npm run dev` running and no deployment yet: the dashboard, `http://127.0.0.1:3001/health` and `/status` return 200 in demo mode, and `/standing/:id` returns unpaid **503** because no identity or payment source is configured. It never substitutes a mock 402.

---

## Set up an agent in the browser

After `npm run dev`, open **Create agent** and click **Connect HashPack**. The page asks for four HashPack approvals; the local agent runtime performs every other step. The agent is **live** once it is funded.

| Step                                            | Who                     |
| ----------------------------------------------- | ----------------------- |
| Connect the guardian wallet                     | HashPack connection     |
| Fund the local setup account with 45 HBAR       | HashPack approval       |
| Create the 1-of-2 agent account                 | Agent runtime           |
| Create the HCS profile topic (guardian admin)   | HashPack approval       |
| Publish the UAID and deploy the policy contract | Agent runtime           |
| Allow the spend asset and USDC in the policy    | HashPack approval       |
| Associate tokens and register ERC-8004          | Agent runtime           |
| Review and approve the agreement                | HashPack approval       |
| Fund the agent (required before it transacts)   | Setup account or faucet |
| Live: ready to transact                         | Status                  |

When setup finishes, the API verifies the deployment (identity, HCS records, policy, registry card and agreement) and the dashboard switches from demo to live testnet data without a restart. If verification fails, it keeps serving demo and standing stays unpaid 503.

**What to know**

- **Cost.** The setup account (the generated `.env.operator` key) pays the policy deployment, HCS records and ERC-8004 registration, owns the registration, and keeps any unspent HBAR. A measured testnet setup used 28.7 of the 45 HBAR.
- **Keys.** The browser receives only public keys. The setup and agent keys stay with the agent runtime; the API refuses to load either. The runtime listens on loopback only and rejects requests without its setup header or from another web origin.
- **Resumable.** Progress is re-read from the mirror: the setup account is found by its public key, and the topic by its exact guardian admin key and 1-of-3 submit key list. Runtime writes use the same operation store as the CLI, so a reload or crash never repeats a confirmed transaction. A wallet request with an unknown outcome stays pending until the mirror shows it succeeded, failed or expired.
- **Agreement approval.** The guardian's wallet publishes the exact terms, their hash and `approval: "guardian-hcs-transaction"` to the agent's topic. The guardian key signs that HCS transaction, and verifiers accept the record only when the mirror shows the guardian account as its payer. The page recomputes the terms hash before asking for approval. It is a technical policy record, not a legal agreement.
- **WalletConnect.** The template ships a public WalletConnect project ID so HashPack connects from a fresh scaffold. To use your own, set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` in `packages/nextjs/.env.local`.

**Fund the agent (step 9, required).** The on-chain steps leave the agent with 5 HBAR and no tokens, so it cannot swap or pay yet. Step 9 shows what it holds and tops it up. The agent becomes **live** (step 10) once it is ready for swaps (fee HBAR and SAUCE) or for x402 payments (USDC):

| Agent holds | Used for                                          | How to top up                                                                                                                                          |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HBAR        | Network fees for swaps, schedules and HCS records | **Send from setup account** (up to 20 HBAR at a time; the setup account keeps a 2 HBAR reserve)                                                        |
| SAUCE       | Swaps on the Optional DEX page                    | **Buy SAUCE on SaucerSwap** with up to 1 HBAR of setup-account funds at a time                                                                         |
| USDC        | Paying x402 services                              | [Circle's testnet faucet](https://faucet.circle.com/) (Hedera Testnet), sent straight to the agent's account, which setup already associates with USDC |

Setup's allow step also allows USDC in the policy, so a new agent can pay services without a separate guardian step; deployments created earlier use **Allow USDC payments** on the Pay services page. Low balances on the DEX and Pay services pages link to this panel. The same top-ups from the CLI are `fund-agent`, `fund-dex` and, from an operator that holds USDC, `fund-usdc`.

**Verification status:** on 30 September 2026 the complete flow ran on Hedera testnet from a fresh public scaffold with all four steps **approved in HashPack** ([evidence](#browser-setup)): agent `0.0.10798474`, ERC-8004 agent `125`. The API then verified the deployment and wallet-approved agreement, switched to testnet on its own and returned a 402 standing challenge. An earlier run of the same flow, with a script-held guardian key, also produced a verified version 2 standing report.

---

## Architecture

```mermaid
flowchart LR
  subgraph local["Your machine: npm run dev"]
    UI["Dashboard<br/>Next.js :3000<br/>no keys"]
    API["Standing API<br/>Hono :3001<br/>attestation key"]
    RT["Agent runtime<br/>:3002, loopback only<br/>setup + agent keys"]
    CLI["CLI and MCP server<br/>setup + agent keys"]
  end
  HP["HashPack<br/>guardian key"]
  BUY["Other agents<br/>(x402 buyers)"]
  FAC["Blocky402<br/>facilitator"]
  subgraph hedera["Hedera testnet"]
    ACC["1-of-2 agent account<br/>agent key + guardian key"]
    HCS["HCS profile topic"]
    POL["PolicyRegistry"]
    VAULT["GuardedHbarVault<br/>(optional)"]
    REG["ERC-8004 identity +<br/>reputation registries"]
    HTS["HTS USDC, SAUCE"]
    DEX["SaucerSwap V1"]
    HSS["Schedule Service"]
    MIR["Mirror node"]
  end
  LPX["Lambdaplex market data<br/>(mainnet, read-only)"]

  UI -- "/api proxy" --> API
  UI -- "/setup proxy" --> RT
  UI -- "WalletConnect" --> HP
  HP -- "fund setup account, create topic,<br/>allow asset, approve agreement, pause" --> hedera
  RT -- "agent account, UAID, policy deploy,<br/>token association, registration" --> hedera
  CLI -- "policy-checked spends, vault,<br/>reviews of other agents" --> hedera
  RT -- "swaps now, or scheduled<br/>for Hedera to execute" --> HSS
  API -- "venue prices" --> LPX
  API -- "identity, policy, settlement reads" --> MIR
  BUY -- "GET /standing (x402)" --> API
  API -- "verify and settle" --> FAC
  FAC -- "USDC transfer" --> HTS
```

- **Keys stay where they are used.** The dashboard holds none. The API holds only the attestation key that signs standing reports and refuses to start with a spend key in its environment. The agent runtime and CLI hold the setup and agent keys. The guardian key stays in HashPack (or `.env.guardian` for CLI setup).
- **Hedera is the source of truth.** Every check (identity, key state, pause, caps, agreement, payment settlement) is read from the mirror node at the moment it is needed, never from local state alone.
- **The agent's client enforces the policy** before every signature; only the optional vault enforces rules on-chain.

## Ecosystem integrations

Each integration carries part of the template's job. Removing any of the first four removes a capability, not a feature flag.

| Integration                      | What it does here                                                                                                                                                                                                                | Why the template needs it                                                                                                                                      | Live evidence                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **x402 + Blocky402**             | Sells the signed standing report and paid LLM inference, and lets the agent pay any x402 service in USDC under its policy; Blocky402 verifies, settles and pays the fee, and both sides confirm the exact transfer on the mirror | Standing is how a counterparty checks the agent before trusting it; x402 makes that check payable by another agent over plain HTTP, with no account or API key | [Paid standing](#cli-deployment-2527-september-2026), [version 2](#cli-deployment-2527-september-2026) and [version 3](#vaults) reports; [agent-to-agent payment](#x402-service-payments) |
| **ERC-8004 identity registry**   | Registers each agent; its card names the account, guardian, HCS topic, UAID, policy and standing endpoint; lookups verify any agent from it                                                                                      | The shared directory where other agents find this one and see who answers for it                                                                               | Agents [121](https://hashscan.io/testnet/transaction/0.0.5792828%401790349275.514184066), [125](https://hashscan.io/testnet/transaction/0.0.10798471%401790805543.885864012)              |
| **ERC-8004 reputation registry** | Agents rate agents they dealt with; every lookup lists the reviews with their reviewers                                                                                                                                          | Turns individual checks into a shared track record; the registry blocks owners from rating their own agent                                                     | [First review](#agent-to-agent-lookup-and-review)                                                                                                                                         |
| **HashPack (WalletConnect)**     | The guardian approves setup and signs pause, unpause and vault controls; the guardian key never leaves the wallet                                                                                                                | Puts a human in control without the template ever holding the guardian's key                                                                                   | [HashPack setup run](#browser-setup), [vault controls](#vaults)                                                                                                                           |
| **SaucerSwap V1**                | The agent's example spend: a policy-checked SAUCE → WHBAR swap on testnet, now or scheduled, started from the dashboard or CLI; mainnet quotes for price comparison                                                              | Shows the policy check guarding a real DeFi action, not a mock transfer                                                                                        | [Policy-checked swap](#saucerswap), [scheduled swap](#scheduled-swaps-and-venue-prices)                                                                                                   |
| **Hedera Schedule Service**      | A scheduled swap is signed now and executed by Hedera at the chosen time; the guardian and the agent are both admin keys and can delete it                                                                                       | Lets a guardian direct the agent to act later without a process staying up to sign; revoking the agent key stops it at execution                               | [Scheduled, cancelled and revoked schedules](#scheduled-swaps-and-venue-prices)                                                                                                           |
| **Lambdaplex**                   | Read-only HBAR/USDC order book from its public API, compared with SaucerSwap for the same amount, including how much the book can fill                                                                                           | Price discovery across Hedera venues before the agent trades. Lambdaplex settles on mainnet only, so the agent compares it and does not trade there            | [Venue comparison](#scheduled-swaps-and-venue-prices)                                                                                                                                     |
| **HCS-14 UAID**                  | A standards-derived identifier published to the agent's topic and its card                                                                                                                                                       | Gives the agent one portable ID other HCS tools can resolve                                                                                                    | [UAID message](https://hashscan.io/testnet/transaction/0.0.5792828%401790349056.243185055)                                                                                                |

Hedera services used: **native accounts** with a 1-of-2 `KeyList` (agent and guardian) and guardian key rotation; **HCS** for the identity, policy, agreement, guardian-action and fill records; **HTS** for USDC and SAUCE; **smart contracts** (`PolicyRegistry`, `GuardedHbarVault`, the ERC-8004 registries, the SaucerSwap router); the **Schedule Service** for swaps executed later; and the **mirror node** as the source of truth for every check.

A paid standing check, end to end:

```mermaid
sequenceDiagram
  participant B as Buyer agent
  participant A as Standing API
  participant F as Blocky402
  participant H as Hedera (mirror)
  B->>A: GET /standing/0.0.agent
  A->>H: verify identity, key, policy, agreement
  A-->>B: 402 Payment Required: 0.001 USDC to the agent account
  B->>A: same request + PAYMENT-SIGNATURE
  A->>F: verify and settle the payment
  F->>H: USDC transfer reaches consensus
  A->>H: confirm the exact transfer, re-read current state
  A-->>B: EIP-712 signed report, valid for 2 minutes
  B->>H: check the signed fields against Hashscan
```

---

## What is enforced, and what is not

| Need                                        | What the template provides                                                                                                                                                                                                                                                        | Enforced by                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Someone answerable for the agent            | A **guardian** account holding the second key of the agent's 1-of-2 Hedera account, named in the agent's HCS profile and ERC-8004 registration                                                                                                                                    | Hedera account key                                               |
| Stop and recover                            | Guardian `pause`/`unpause` in the policy contract, and `revoke`, which updates the agent account to a guardian-only key                                                                                                                                                           | Pause: supplied client only. Revoke: Hedera network              |
| Spending rules written as terms             | For the optional vault, one sentence in a fixed grammar (_"No more than 0.01 HBAR per transaction and 0.05 HBAR per UTC day; only to 0x…"_) compiles to a per-transaction cap, a per-UTC-day cap and a recipient list                                                             | Vault contract                                                   |
| Rules that hold against a misbehaving agent | `GuardedHbarVault` checks caps, the recipient allowlist, pause and the active agent on every `spend()`, even if the agent bypasses the supplied client                                                                                                                            | Vault contract, for HBAR deposited into it                       |
| Signed terms anchored on-chain              | The guardian approves the terms hash. The vault stores it as `agreementHash`, and a guardian-approved policy record is published to the agent's HCS topic by the guardian account                                                                                                 | Hedera contract state and HCS                                    |
| Counterparties can check the agent          | A free lookup verifies any agent's ERC-8004 card, HCS records, key, policy and agreement and lists its reviews. `GET /standing/:id` sells an EIP-712 signed standing report over x402; version 2 binds the HCS policy record, version 3 also signs verified vault rules and state | Hedera mirror reads, offline signature verification and Hashscan |

**Limits**

- **No legal ownership.** The guardian is a key, not a verified legal person or entity. Nothing here is proof of legal ownership or an enforceable legal agreement.
- **Not a general law-to-code translator.** The terms compiler accepts one fixed sentence shape and rejects everything else. It never guesses from free text.
- **The native account's limits are client-enforced.** A native 1-of-2 Hedera key **does not enforce caps, pause or recipients** against an agent that bypasses the supplied client. The HCS policy record describes those limits; it does not make them mandatory. Only HBAR deposited into the vault is under contract-enforced rules; HBAR and HTS tokens (USDC, SAUCE) in the native account are not.
- **Vault standing is opt-in.** The API reads the local public vault record at startup; restart it after deploying or replacing a vault. Without a configured vault, standing remains version 1 or 2; it does not claim that no other vault exists.
- **Revocation cannot undo past spending.**
- **A scheduled swap is not re-checked by Hedera.** The policy is checked when the swap is scheduled. While the agent runtime is running it deletes a pending swap that a pause, a lower per-transaction cap or a removed token would now refuse; if the runtime is stopped, only deleting the schedule or revoking the agent key stops it.
- **Testnet only.** SaucerSwap is an optional spending example, not a prerequisite for paid standing.

---

## Usage

### Guardian controls

- **In the dashboard (Policy page):** connect the guardian's HashPack account to pause and unpause the policy; each action is confirmed on the mirror and then recorded as a guardian HCS event. The HCS request uses Hedera's maximum 180-second validity window; after an expired approval click **Retry HCS record** and do not repeat the contract action. Pending records survive page reloads. No guardian private key reaches the dashboard or API.
- **Native key revocation is CLI-only:** HashPack's published WalletConnect transaction list does not include Account Update. A browser-set-up agent's guardian key lives in HashPack, so its revocation needs a wallet that supports Account Update.
- **CLI** (local guardian key): `npm run agent -- pause`, `unpause`, `revoke`, `restore`. `revoke` updates the account to a guardian-only key; `restore` deliberately re-enables the agent key. A fresh paid standing check after revocation reports the inactive agent key.
- If browser signing fails after a confirmed pause, `npm run agent -- reconcile-pause GUARDIAN_PAUSE_TXID` verifies the guardian payer, the exact `pause()` call to this deployment's policy, the current paused state and the missing HCS record, then signs only that HCS event with the local guardian key.

### Paid standing (x402)

`GET /standing/:id` first returns an x402 challenge. After the Blocky402 settlement and an independent mirror confirmation of the exact HTS USDC transfer, it returns an EIP-712 signed standing report plus Hashscan account, topic and policy links.

| Version | Signed content                                                                                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Pinned 12-field report: identity, UAID, pause state, agent key state, caps, HCS topic, validity window                                                                       |
| 2       | Version 1 plus the guardian-approved HCS agreement's hash and version                                                                                                        |
| 3       | Version 2 plus the vault address, guardian, active vault agent, pause state, terms hash, caps, complete recipient list, balance and UTC-day usage (HBAR amounts in tinybars) |

- Before advertising payment, the server verifies a configured vault's guardian signature and on-chain terms; a configured but unverifiable vault returns unpaid 503. A version 3 report without an HCS agreement uses agreement version 0 and the zero hash.
- The supplied buyer (`npm run agent -- pay-standing`) rechecks the HCS record, current policy and vault against the signed report. It pays from the operator account with a $0.001 limit, so that account must hold testnet USDC and the agent must be associated with USDC. A browser-created setup account holds only HBAR.
- Reports expire after two minutes and are short-lived mirror observations, not guarantees about future state. Payments have replay protection.
- HCS reads enforce publisher authority: forged or malformed agent messages cannot replace guardian or operator identity records. Malformed authoritative records and unavailable mirror pages fail closed, and agent fill records are independently verified before they count toward daily spend.
- This service cannot enforce an arbitrary buyer's own spend cap, pause or guardian controls; buyers need their own wallet policy.

### Pay for services over x402

x402 lets an HTTP service charge per request: it answers `402 Payment Required` with a price, the caller pays, and the service answers. The agent can pay any service that accepts USDC on Hedera testnet, for example an LLM API, a data feed or another agent's standing report. Use the dashboard's **Pay services** page, the CLI or the MCP tool `pay_service`:

```sh
npm run agent -- allow-token 0.0.429274
npm run agent -- price https://seller.example/paid/inference --prompt "Hello"
npm run agent -- pay https://seller.example/paid/inference --prompt "Hello" --max 50000 --seller 125
```

- **Under the guardian's policy.** The guardian first allows USDC in the policy contract (`allow-token`, or **Allow USDC payments** in HashPack for a browser setup). Every payment then passes the same check as a swap, immediately before signing: pause, agent key, allowed token, per-payment cap, daily cap and balance. Each token's daily spend is counted separately against the same caps; USDC and SAUCE both have six decimals.
- **Paid by the agent key.** The agent refuses any option other than exact USDC on `hedera:testnet`, any price above `--max`, and payment to itself. Before sending, it checks the signed transfer moves exactly the price from the agent to the seller. With `--seller AGENT_ID` it also requires the seller to verify as that ERC-8004 agent and be paid at that agent's account.
- **Confirmed and recorded.** The amount is reserved before the payment is sent. The mirror, not the service's reply, decides whether money moved. A confirmed payment is recorded on the agent's HCS topic as a `fill` with `kind: "x402"`. If the seller never submits the payment, it is released after Hedera's 180-second validity window.
- **Scheduled and repeating payments.** Choose **At** on the Pay services page (optionally **Repeat every** N minutes, hours or days for up to 100 payments), or run `schedule-pay URL --at 2026-10-02T09:00:00Z --max 20000 [--prompt TEXT] [--seller ID] [--every MINUTES --times N]`, or use the MCP tool `schedule_payment`. A Hedera schedule cannot carry an x402 payment, because x402 is an HTTP exchange of request, price, payment and answer. So the local agent runtime makes each payment when it is due, through the same code as **Pay and send**, and checks the policy at that moment, right before signing. A paused policy, a removed key or a spent daily cap therefore stops the next run. Jobs run only while `npm run dev` is running; a payment more than 15 minutes late is recorded as missed and never made late. `payment-jobs` lists jobs and runs any that are due, and `cancel-payment-job ID` stops one.
- **No extra HBAR.** Blocky402 is the fee payer for Hedera x402 payments, so the agent needs USDC but no HBAR for them. `fund-usdc 1000000` sends 1 testnet USDC from the operator; the agent must be associated with USDC, which setup does.
- **Where to find services.** Few public x402 services accept Hedera yet. Most listings in Coinbase's x402 directory use Base or Solana. This template's own endpoints (standing and paid inference) give other agents something to buy now.

**Sell paid LLM inference.** On the **Pay services** page, under **LLM provider**, choose a provider, paste its API key, pick a model and a price, then **Save provider** and **Test**. Inference runs through the [AI SDK](https://ai-sdk.dev):

| Provider          | Key                                                                               | Example model                                                                 |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Vercel AI Gateway | AI Gateway API key from the Vercel dashboard                                      | `moonshotai/kimi-k3`, `anthropic/claude-haiku-4.5`, `google/gemini-2.5-flash` |
| OpenAI            | platform.openai.com                                                               | `gpt-4o-mini`                                                                 |
| Anthropic         | console.anthropic.com                                                             | `claude-haiku-4-5`                                                            |
| Google Gemini     | Google AI Studio                                                                  | `gemini-2.5-flash`                                                            |
| OpenAI-compatible | Any `/chat/completions` provider, with its base URL (Groq, OpenRouter and others) | the provider's model name                                                     |

- **Where the key goes.** The browser sends the key once to the local agent runtime (loopback only, behind its setup header and origin check). The runtime writes it to `.env.server`, which git ignores, and never returns, logs or displays it again. A saved key is kept only for the same provider; switching providers needs that provider's key. **Remove** deletes the settings. The API re-reads `.env.server` on each request, so changes apply without a restart.
- **Same settings without the browser:** `INFERENCE_PROVIDER` (`gateway`, `openai`, `anthropic`, `google` or `openai-compatible`), `INFERENCE_API_KEY`, `INFERENCE_MODEL`, `INFERENCE_PRICE` (USDC smallest units, default 10000 = 0.01 USDC) and, for `openai-compatible` only, `INFERENCE_BASE_URL`.
- **Charging.** `POST /paid/inference` with `{"prompt": "..."}` charges the price in USDC to the agent's account. The model runs only after the buyer's payment signature is verified, and the payment is settled only after the model answers, so a failed request is never charged. Answers are capped at 2,048 output tokens, which leaves reasoning models room to answer; an empty answer is not charged. Provider error bodies are not passed on, only their HTTP status. Without a provider the endpoint answers an unpaid 503. The page shows the endpoint and the USDC received.
- **AI Gateway example.** `npm run example:ai-gateway` asks `moonshotai/kimi-k3` through the Vercel AI Gateway to invent a holiday. It reads `AI_GATEWAY_API_KEY` from `.env.local` (git-ignored), or a Gateway key saved on the Pay services page.

### Optional HBAR vault

For **deposited HBAR only**, `GuardedHbarVault` checks a per-transaction cap, a UTC-day cap, the guardian's recipient list, pause state and the active vault agent on every transfer. The guardian can pause, remove the vault agent and recover the remaining HBAR while paused.

Put exactly one sentence in a local text file (use an EVM address you control):

```text
No more than 0.01 HBAR per transaction and 0.05 HBAR per UTC day; only to 0xYOUR_40_HEX_CHARACTER_ADDRESS.
```

Then run:

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

- Amounts are **tinybars** (`1000000` = 0.01 HBAR). Funding is capped at 1 HBAR per command.
- The parser rejects other wording and amounts with more than eight decimal places.
- `approve-vault-terms` signs the reviewed, account-bound terms with the local guardian key; `deploy-vault` anchors their hash in the contract. The operator pays deployment and funding.
- New vaults install the complete recipient list in the constructor. Caps, recipients and the agreement hash are fixed for the vault's lifetime; changed terms need a new reviewed deployment. `vault-status` verifies the guardian signature, deployment context, caps, hash and the complete on-chain recipient list. `allow-vault-recipients` only verifies the installed list.
- The agent's `vault-spend` reads mirror-backed rules immediately before signing; the contract checks them again even if a caller bypasses the client.
- The dashboard's **Contract-controlled HBAR vault** panel lets the guardian's HashPack account pause, unpause, revoke the vault agent and recover the full balance. Each request re-verifies the vault; confirmation checks the mirror payer, contract, result and exact calldata. **Check transaction** reads an existing receipt without resubmitting.
- The CLI supports one local vault at a time. Legacy vault `0.0.10748172` predates immutable terms: the CLI refuses new funding and agent spending for it, while pause, revocation and recovery remain. Changing source code does not upgrade a deployed contract.

### Optional DEX: swaps now, on a schedule, and venue prices

The dashboard's **Optional DEX** page passes your instructions to the local agent runtime, which holds the agent key: **Swap now**, or **Schedule swap** for a time between two minutes and seven days ahead. It also compares what selling HBAR for USDC returns on SaucerSwap and on Lambdaplex right now. The same actions from the CLI:

```sh
npm run agent -- quote 1000000
npm run agent -- fund-dex 100000000
npm run agent -- spend 1000000
npm run agent -- schedule-swap 1000000 2026-10-02T09:00:00Z
npm run agent -- schedules
npm run agent -- cancel-schedule 0.0.12345
```

- Amounts are raw smallest units. Testnet USDC `0.0.429274` and SAUCE `0.0.1183558` both have six decimals: `1000` is 0.001 USDC and `1000000` is 1 SAUCE. The dashboard converts the amount you type using the decimals read from the mirror.
- **The agent pays its own network fees in HBAR.** Hedera requires the payer to cover the full gas limit, so swaps use 300,000 gas (a swap measured 112,946). Before signing, the agent checks it holds enough HBAR at the current gas price: about 0.35 HBAR for a swap and 1.6 HBAR to schedule one, since creating a schedule costs about 1.05 HBAR. The DEX page shows the agent's HBAR. `fund-agent 300000000` sends 3 HBAR from the setup account to the agent, and `fund-agent 2000000000 0.0.12345` sends 20 HBAR to another agent account you run; sending HBAR from HashPack works too.
- `fund-dex 100000000` uses up to 1 HBAR of operator funds to buy testnet SAUCE for the agent. It is a funding trade, not the policy-gated agent spend. Check the live quote and operator balance first.
- `spend` serializes requests, reserves the amount durably before submission, checks mirror-backed account, HCS, registry, policy and balance sources immediately before signing, and confirms the router call and token amounts before publishing a fill. Uncertain submissions stay reserved; a mirror-confirmed failed swap is recorded to HCS and released.
- `schedule-swap` runs the same policy check, then signs a `ScheduleCreate` that wraps the router call, with `waitForExpiry` set to the chosen time and a 1-of-2 admin key (guardian and agent). It accepts up to 3% less output than quoted, keeps the router allowance covering every pending schedule, reserves the amount against the daily limit until the outcome is recorded, and publishes a `scheduled` record to HCS.
- The agent runtime checks pending schedules every 20 seconds (`schedules` does the same once). It records each outcome on HCS from the mirror (success after checking the token movements, failure, expiry or cancellation) and deletes a pending swap that the current policy would refuse. **Cancel as guardian** in the dashboard deletes it from HashPack with the guardian key, independently of the agent; this button has not yet been tried with HashPack.
- Venue prices are read from Hedera mainnet: SaucerSwap V1 (router `0.0.3045981`, WHBAR `0.0.1456986`, USDC `0.0.456858`, token decimals checked on the mainnet mirror) and the Lambdaplex public API (`/api/v1/depth` and `/api/v1/avgPrice` for `HBAR-USDC`). The comparison is read-only, excludes fees and reports how much the order book can fill. Lambdaplex has no testnet deployment, so the agent does not trade there.
- New deployments use the live SaucerSwap V1 SAUCE → WHBAR pool. For an older USDC → WHBAR deployment, run `restore` if the agent key was revoked, then `configure-dex`.
- Run guardian `revoke` only after the intended agent spends.

### Look up and rate other agents

Registering an agent only helps if others can check it. The **Identity** page, `npm run agent -- lookup AGENT_ID` and the `GET /agents/:id` API route look up any agent in the ERC-8004 identity registry on Hedera testnet and verify it the same way paid standing verifies this one: the registry card, the HCS records published by its registry owner and guardian, its 1-of-2 account key, its policy contract and any guardian-approved agreement (both the CLI signature and the wallet format). The result is one of:

| Result            | Meaning                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `verified`        | Every check passed; key state, pause state, caps and agreement are shown                                       |
| `unverified`      | The card could not be confirmed on Hedera; the failing check is named. Do not rely on it                       |
| `not-accountable` | Registered, but the card does not describe a guardian-controlled agent this template can verify                |
| `external-card`   | The card is hosted at a URL. It is not fetched, so a lookup can never make the server request an arbitrary URL |

**How agents discover each other.** Registration puts the agent in a public directory: the ERC-8004 identity registry stores its card and emits a public `Registered` event. Another agent finds it by browsing those events, by its number, or through a shared card, UAID or topic, and then verifies it rather than trusting the card. The Identity page lists the agents registered in the last six days (`GET /agents/recent`, read from the mirror's event logs, which only search windows under seven days), marks your own, and verifies any of them with one click. There is no search by name or capability: the registry is a numbered list, and searching it would need an indexer.

Each lookup also lists the agent's reviews from the ERC-8004 **reputation** registry (`0x8004B663…8713`, Hedera `0.0.7919998`). The registry's summary needs an explicit reviewer list, its Sybil guard, so every review is shown with its reviewer's account rather than as a bare average.

To rate an agent you dealt with:

```sh
npm run agent -- give-feedback AGENT_ID SCORE [TAG]
```

The agent signs the review with its own key: an integer score from 0 to 100, a short tag (default `interaction`), and a second tag recording whether the target was `verified` at that moment. The command refuses to rate this agent itself, and the registry rejects feedback from an agent's owner or approved operators. A review costs about 0.17 HBAR from the agent account. The template calls the registry with the ABI of its implementation (`0x16e0…da34`), whose deployed bytecode on Hedera is identical to the source-verified copy on Base Sepolia.

### MCP server

`npm run agent -- mcp` starts a local stdio MCP server with `link_account`, `check_policy`, `record_outcome`, `resolve_agent`, `give_feedback`, `service_price`, `pay_service` and `schedule_payment`. Run it in the project directory with the agent key file present. `link_account` verifies the account and stores a local ignored binding; `check_policy` is advisory; `record_outcome` checks mirror evidence before writing an HCS fill; `resolve_agent` lets the agent check another agent before dealing with it; `give_feedback` rates another agent, signed by this one; `service_price` reads an x402 price without paying; `pay_service` pays an x402 service under the policy, up to a `maxAmount` the assistant must state; `schedule_payment` schedules one or repeating payments that the runtime makes when due.

---

## CLI setup

The browser is the main setup path. To script setup with your own funded account instead: `npm run dev` already created `.env.operator` with a generated key; replace `HEDERA_OPERATOR_KEY` with your funded ECDSA testnet account's key and set `HEDERA_OPERATOR_ID`. The CLI then generates a local guardian key and account.

```sh
npm run agent -- onboard
npm run agent -- approve-agreement
npm run agent -- status
npm run agent -- pay-standing
```

- `onboard` is resumable. It writes `.accountable/agreement-draft.json`: **read it before `approve-agreement`**, which checks it against the on-chain caps and asset, signs its hash with the local guardian key (EIP-191) and publishes it to the agent's HCS topic.
- A later cap or asset change needs a new approval (`draft-agreement`, then `approve-agreement`) before paid standing resumes. Move a stale draft out of `.accountable` before regenerating it.
- To reattach an existing deployment after re-scaffolding, copy the four role files, keep the old public `.accountable/deployment.json` outside the project, and run `npm run agent -- adopt /path/to/deployment.json` instead of `onboard`. It verifies every public key and source against the mirror and creates no account.
- A successful transaction whose local result was interrupted needs manual reconciliation, not a duplicate write.

### Commands

Run as `npm run agent -- <command>`.

| Command                                                                                                | Description                                                                        |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `onboard`                                                                                              | Resumable CLI setup: accounts, topic, UAID, policy, registration, draft            |
| `draft-agreement` / `approve-agreement`                                                                | Write the agreement draft / sign and publish it with the local guardian key        |
| `status`                                                                                               | Cross-check account key, HCS events, registry card and policy on the mirror        |
| `pay-standing`                                                                                         | Pay 0.001 USDC for standing and verify the signed report                           |
| `pause` / `unpause` / `revoke` / `restore`                                                             | Guardian actions with the local guardian key                                       |
| `caps TX DAY`                                                                                          | Set new policy caps (requires a new agreement approval)                            |
| `reconcile-pause TXID`                                                                                 | Record the missing HCS event for a confirmed browser pause                         |
| `draft-vault-terms FILE` / `approve-vault-terms` / `deploy-vault`                                      | Compile, approve and deploy vault terms                                            |
| `vault-status` / `allow-vault-recipients`                                                              | Verify the vault and its installed recipient list                                  |
| `fund-vault TINYBARS` / `vault-spend RECIPIENT TINYBARS`                                               | Fund the vault / spend from it as the agent                                        |
| `vault-pause` / `vault-unpause` / `vault-revoke` / `vault-recover`                                     | Guardian vault controls                                                            |
| `quote AMOUNT` / `quote-fallback AMOUNT`                                                               | Read-only SaucerSwap quotes                                                        |
| `fund-dex TINYBARS` / `spend AMOUNT` / `configure-dex`                                                 | DEX funding, policy-checked swap, route update                                     |
| `allow-token TOKEN` / `disallow-token TOKEN`                                                           | Guardian: allow or remove a token in the policy, recorded on HCS                   |
| `price URL` / `pay URL --max UNITS [--prompt TEXT \| --body JSON] [--seller AGENT_ID]`                 | Read an x402 price / pay an x402 service under the policy                          |
| `schedule-pay URL --at ISO_TIME --max UNITS [--prompt TEXT] [--seller ID] [--every MINUTES --times N]` | Schedule one or repeating x402 payments, made by the runtime when due              |
| `payment-jobs` / `cancel-payment-job ID`                                                               | List scheduled payments and run any that are due / cancel one                      |
| `fund-usdc UNITS [ACCOUNT]`                                                                            | Send operator testnet USDC to the agent or another agent account                   |
| `schedule-swap AMOUNT ISO_TIME`                                                                        | Policy-checked swap that Hedera executes at the given time                         |
| `fund-agent TINYBARS [ACCOUNT]`                                                                        | Send setup-account HBAR for network fees to the agent, or to another agent account |
| `schedules` / `cancel-schedule SCHEDULE_ID`                                                            | Record scheduled-swap outcomes and list them / delete a pending one                |
| `init` / `setup` / `register` / `adopt PUBLIC_DEPLOYMENT_JSON`                                         | Individual setup steps and reattaching an existing deployment                      |
| `set-standing-url HTTPS_URL`                                                                           | Publish a reachable standing base URL in the agent's ERC-8004 card                 |
| `lookup AGENT_ID`                                                                                      | Verify any agent by ERC-8004 ID and list its reviews (read-only)                   |
| `give-feedback AGENT_ID SCORE [TAG]`                                                                   | Rate another agent 0–100 in the ERC-8004 reputation registry                       |
| `evidence`                                                                                             | Print the recorded testnet transaction links                                       |
| `mcp`                                                                                                  | Start the local stdio MCP server                                                   |

---

## Configuration

| File or variable                       | Purpose                                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.operator`                        | Setup/operator key (generated by `npm run dev`); `HEDERA_OPERATOR_ID` is added once the account exists                                         |
| `.env.agent`                           | Agent key, used only by the agent runtime and CLI                                                                                              |
| `.env.server`                          | Attestation key that signs standing reports, and optional `INFERENCE_*` provider settings saved from the dashboard; the API refuses spend keys |
| `.env.local`                           | Optional `AI_GATEWAY_API_KEY` for `npm run example:ai-gateway`                                                                                 |
| `.env.guardian`                        | Local guardian key, created only by CLI setup                                                                                                  |
| `.accountable/`                        | Deployment record, drafts, operation stores and evidence log                                                                                   |
| `APP_MODE`                             | API mode: `auto` (default: demo until the deployment verifies), `testnet` (strict: fail before serving) or `demo`                              |
| `PORT`                                 | API port (default 3001), for running a second agent's API on the same computer                                                                 |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional override in `packages/nextjs/.env.local`                                                                                              |

All role files and `.accountable/` are ignored by git; keep them out of GitHub. To run the API alone in strict testnet mode: PowerShell `$env:APP_MODE='testnet'; npm run dev -w @accountable/server`, Bash `APP_MODE=testnet npm run dev -w @accountable/server`. Strict mode verifies the account, HCS, registry, policy, facilitator support and payment token association, and fails before serving if a source is unavailable.

The agent card's default standing endpoint is `localhost:3001`, which only this computer can reach: other agents can read the card but not buy a report. To publish a reachable endpoint, serve the API at a public HTTPS address (for example a tunnel to port 3001) and run:

```sh
npm run agent -- set-standing-url https://your-public-host
```

It rewrites the card in the ERC-8004 registry from the setup account (about 0.2 HBAR) and saves the new base URL locally only after the registry update succeeds; restart `npm run dev` so the 402 challenge advertises it. Use an address that stays stable: the card keeps pointing at it after a tunnel closes, so switch it back (`set-standing-url http://localhost:3001`) before closing a temporary tunnel.

On 1 October 2026 agent `125`'s card was [pointed at a temporary ngrok address](https://hashscan.io/testnet/transaction/0.0.10798471%401790847836.941582342). A lookup of `125` then still verified and returned the public standing address, and an unpaid request through the tunnel returned a real `402 Payment Required` advertising that address. The card was then [switched back to localhost](https://hashscan.io/testnet/transaction/0.0.10798471%401790847905.023312762) and the tunnel closed. No report was purchased through the tunnel.

---

## Development

- **Full check:** `npm run check` (lint, TypeScript, unit and integration tests, Solidity execution tests, production builds)
- **Lint:** `npm run lint`
- **Typecheck:** `npm run typecheck`
- **Tests:** `npm test`
- **Build:** `npm run build`
- **Format README:** `npm run format`

Tests are deterministic and need no funded accounts. The pinned raw-digest Hedera signing and offline EIP-712 standing verification tests must keep passing when transaction or report formats change.

---

## Project structure

```
agent-leash/
├── packages/
│   ├── agent/        # CLI, local runtime (service.ts, wizard.ts), policy guard, vault, swaps and scheduled swaps, MCP
│   ├── server/       # Hono API: x402 settlement, signed standing, paid LLM inference, auto/testnet/demo modes
│   ├── shared/       # Mirror and HCS readers, identity checks, UAID, agreement and vault verification, venue prices
│   ├── contracts/    # PolicyRegistry (client-enforced policy) and GuardedHbarVault (contract-enforced HBAR)
│   └── nextjs/       # Dashboard: demo, browser setup, live status, guardian wallet controls
├── tests/            # Vitest suites (deterministic, no funded accounts)
└── template.json     # Scaffold-HBAR manifest: Next.js, Hardhat, npm
```

---

## Testnet evidence

All entries below are **real testnet writes**, separate from the demo and from local contract execution. Public IDs are examples, not fresh-scaffold defaults. No forked-mainnet execution is claimed.

### Browser setup

**HashPack run.** On 30 September 2026 a fresh public scaffold was set up entirely in the browser. Guardian `0.0.10715881` approved all four steps in HashPack; the local agent runtime did the rest.

| Step                          | Evidence                                                                                                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HashPack: fund setup account  | [45 HBAR account creation](https://hashscan.io/testnet/transaction/0.0.10715881%401790805106.982244281), setup account `0.0.10798471`                                                                                                                                   |
| Runtime: create agent account | [1-of-2 agent `0.0.10798474`](https://hashscan.io/testnet/transaction/0.0.10798471%401790805124.960715885)                                                                                                                                                              |
| HashPack: create HCS topic    | [topic `0.0.10798482`](https://hashscan.io/testnet/transaction/0.0.10715881%401790805194.818428388)                                                                                                                                                                     |
| Runtime: deploy policy        | [policy `0.0.10798534`](https://hashscan.io/testnet/transaction/0.0.10798471%401790805484.394915383)                                                                                                                                                                    |
| HashPack: allow spend asset   | [`setAllowedTokens`](https://hashscan.io/testnet/transaction/0.0.10715881%401790805529.772818896)                                                                                                                                                                       |
| Runtime: register ERC-8004    | [agent `125`](https://hashscan.io/testnet/transaction/0.0.10798471%401790805543.885864012), [card update](https://hashscan.io/testnet/transaction/0.0.10798471%401790805548.366782068)                                                                                  |
| HashPack: approve agreement   | [guardian-published HCS record](https://hashscan.io/testnet/transaction/0.0.10715881%401790805576.599885166), hash `0xbece15d44ceebc5a16dc2dab066a051777480b7bd55e4709360be17845e22f89`; the API verified it, switched to testnet and returned a 402 standing challenge |

Setup used 28.7 of the 45 HBAR. No paid standing request was made for this agent: its setup account holds no USDC.

**Scripted run.** Earlier the same day the runtime ran from a fresh copy of this code (no keys or deployment state), with a script-held ECDSA key playing the guardian `0.0.10797338` and submitting the same four transactions the page builds.

| Step                          | Evidence                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Guardian funds setup account  | [45 HBAR account creation](https://hashscan.io/testnet/transaction/0.0.10797338%401790799627.591959633); the runtime found setup account `0.0.10797345` by its public key                                                                                    |
| Runtime creates agent account | [1-of-2 agent `0.0.10797348`](https://hashscan.io/testnet/transaction/0.0.10797345%401790799640.009303896)                                                                                                                                                   |
| Guardian creates HCS topic    | [topic `0.0.10797352`](https://hashscan.io/testnet/transaction/0.0.10797338%401790799645.252941289); admin and 1-of-3 submit keys verified by the runtime                                                                                                    |
| Runtime deploys policy        | [policy `0.0.10797363`](https://hashscan.io/testnet/transaction/0.0.10797345%401790799687.295367487)                                                                                                                                                         |
| Guardian allows spend asset   | [`setAllowedTokens`](https://hashscan.io/testnet/transaction/0.0.10797338%401790799717.447339155)                                                                                                                                                            |
| Runtime registers ERC-8004    | [agent `124`](https://hashscan.io/testnet/transaction/0.0.10797345%401790799722.505483660)                                                                                                                                                                   |
| Guardian approves agreement   | [guardian-published HCS record](https://hashscan.io/testnet/transaction/0.0.10797338%401790799741.989296153), hash `0x1d2a894bc0605a8d9ee4ced72f8d7e6675c890ae261c4859c000cabf8a5bfd2a`; the API accepted it and signed a version 2 report binding this hash |

The run took about two minutes and left 16.3 of the 45 HBAR in the setup account. No paid standing request was made for this agent: its setup account holds no USDC.

### CLI deployment (25–27 September 2026)

| Item                                | Evidence                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guardian account `0.0.10715881`     | [creation](https://hashscan.io/testnet/transaction/0.0.5792828%401790349018.352739409)                                                                                                                                                                                                                                                              |
| 1-of-2 agent account `0.0.10715883` | [creation](https://hashscan.io/testnet/transaction/0.0.5792828%401790349024.163447892)                                                                                                                                                                                                                                                              |
| HCS topic `0.0.10715890`            | [creation](https://hashscan.io/testnet/transaction/0.0.5792828%401790349046.149672625), [UAID message](https://hashscan.io/testnet/transaction/0.0.5792828%401790349056.243185055)                                                                                                                                                                  |
| Policy contract `0.0.10715941`      | [deployment](https://hashscan.io/testnet/transaction/0.0.5792828%401790349205.179484212), [allowlist](https://hashscan.io/testnet/transaction/0.0.10715881%401790349210.300763930)                                                                                                                                                                  |
| ERC-8004 agent `121`                | [registration](https://hashscan.io/testnet/transaction/0.0.5792828%401790349275.514184066), [card update](https://hashscan.io/testnet/transaction/0.0.5792828%401790349280.300460069)                                                                                                                                                               |
| Token associations                  | [USDC](https://hashscan.io/testnet/transaction/0.0.10715883%401790349220.774920691), [WHBAR](https://hashscan.io/testnet/transaction/0.0.10715883%401790349224.140844625)                                                                                                                                                                           |
| x402 paid standing                  | [0.001 USDC settlement](https://hashscan.io/testnet/transaction/0.0.7162784%401790350541.346608081), operator `0.0.5792828` → agent `0.0.10715883`; [a later settlement](https://hashscan.io/testnet/transaction/0.0.7162784%401790502158.010293147) whose signed report and derived account/topic/policy links passed the supplied client verifier |
| Guardian policy record              | [guardian-signed HCS publication](https://hashscan.io/testnet/transaction/0.0.10715881%401790534670.287987571) on topic `0.0.10715890`; version 1 hash `0xe88cb434742bcab8ff9606794b3bb4f26e27efe6c2101cd427d7374d03815c8f`                                                                                                                         |
| Version 2 paid standing             | [0.001 USDC settlement](https://hashscan.io/testnet/transaction/0.0.7162784%401790534853.007138227); the buyer verified the settlement, HCS policy record, current policy and EIP-712 signature containing the same hash and version                                                                                                                |
| Guardian pause/unpause              | [pause](https://hashscan.io/testnet/transaction/0.0.10715881%401790351849.434983179), [unpause](https://hashscan.io/testnet/transaction/0.0.10715881%401790351875.376849531)                                                                                                                                                                        |
| Browser pause and HCS recovery      | [HashPack-signed pause](https://hashscan.io/testnet/transaction/0.0.10715881%401790473656.056565005), [guardian HCS record](https://hashscan.io/testnet/transaction/0.0.10715881%401790475981.763264663)                                                                                                                                            |
| Browser wallet HCS retry            | [HashPack-signed pause](https://hashscan.io/testnet/transaction/0.0.10715881%401790500372.264324397), [HashPack-signed HCS event](https://hashscan.io/testnet/transaction/0.0.10715881%401790501022.616111836); topic `0.0.10715890` records the pause transaction ID                                                                               |
| Browser wallet unpause              | [HashPack-signed unpause](https://hashscan.io/testnet/transaction/0.0.10715881%401790501434.858306810), [HashPack-signed HCS event](https://hashscan.io/testnet/transaction/0.0.10715881%401790501442.745705531); topic `0.0.10715890` records the unpause transaction ID                                                                           |
| Guardian revocation                 | [key update](https://hashscan.io/testnet/transaction/0.0.10715881%401790351896.589395734), [HCS rotated event](https://hashscan.io/testnet/transaction/0.0.10715881%401790351899.146336845)                                                                                                                                                         |
| Standing after revocation           | [second USDC settlement](https://hashscan.io/testnet/transaction/0.0.7162784%401790351936.882024325); verified EIP-712 report returned `agentKeyActive: false`                                                                                                                                                                                      |

The agent was later [restored by its guardian](https://hashscan.io/testnet/transaction/0.0.10715881%401790369383.959931297) to test the DEX route; its key is active again. The revoked-state standing evidence remains valid for the time it was issued.

### Vaults

**Legacy vault** [`0.0.10748172`](https://hashscan.io/testnet/contract/0.0.10748172) (predates immutable terms) anchored guardian-approved hash `0x2f3789592bb1eb1a39ab041d02527412e24ad26b4ef7d4d329efc847df0c14d7`: [guardian allowlist](https://hashscan.io/testnet/transaction/0.0.10715881%401790536453.749688714), [0.02 HBAR funding](https://hashscan.io/testnet/transaction/0.0.5792828%401790536476.459345908), [0.01 HBAR agent spend](https://hashscan.io/testnet/transaction/0.0.10715883%401790536487.595052999), [guardian pause](https://hashscan.io/testnet/transaction/0.0.10715881%401790536502.671587111), [0.01 HBAR recovery](https://hashscan.io/testnet/transaction/0.0.10715881%401790536526.827710143) and [vault agent revocation](https://hashscan.io/testnet/transaction/0.0.10715881%401790536541.410582156). The mirror showed a 1,000,000-tinybar recipient credit on spend and a zero balance after recovery; a paused spend was rejected before signing. These receipts are evidence of the earlier flow, not of the corrected contract.

**Corrected vault** [`0.0.10764331`](https://hashscan.io/testnet/transaction/0.0.5792828%401790617860.743341105), deployed 28 September 2026 with the same 0.01-HBAR per-transaction and 0.05-HBAR UTC-day terms: [funding](https://hashscan.io/testnet/transaction/0.0.5792828%401790617873.087150801), [agent spend](https://hashscan.io/testnet/transaction/0.0.10715883%401790617885.660720931), [pause](https://hashscan.io/testnet/transaction/0.0.10715881%401790617906.222816585), rejection of a later client spend, [recovery](https://hashscan.io/testnet/transaction/0.0.10715881%401790618001.365508847) and [vault-agent revocation](https://hashscan.io/testnet/transaction/0.0.10715881%401790618011.616088337). The legacy vault's zero balance was confirmed before its local state was archived.

**Browser vault controls** — all four approved through HashPack and checked against mirror receipts for vault `0.0.10764331`:

| Browser action                         | Evidence                                                                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unpause (29 September 2026)            | [Guardian transaction](https://hashscan.io/testnet/transaction/0.0.10715881%401790681811.389604462), exact `setPaused(false)` call                                                                                |
| Pause (30 September 2026)              | [Guardian transaction](https://hashscan.io/testnet/transaction/0.0.10715881%401790767897.005691536), exact `setPaused(true)` call                                                                                 |
| Recover (30 September 2026)            | [Guardian transaction](https://hashscan.io/testnet/transaction/0.0.10715881%401790768206.464550186), exact `recover(guardian)` call; 1,000,000 tinybars returned to the guardian, which also paid the network fee |
| Revoke vault agent (30 September 2026) | [Guardian transaction](https://hashscan.io/testnet/transaction/0.0.10715881%401790768402.243390677), exact `setAgent(address(0))` call                                                                            |

The recovery trial used [0.01 HBAR of operator funding](https://hashscan.io/testnet/transaction/0.0.5792828%401790768130.738559684). Before the browser revocation trial, the [local guardian restored the vault agent](https://hashscan.io/testnet/transaction/0.0.10715881%401790768329.857390374) while the vault was paused and empty; that was a CLI-signed transaction, not a browser approval. Afterwards the mirror showed `paused = true`, a zero-address vault agent and a zero balance. Native account `0.0.10715883` stayed active: vault actions affect only the vault.

**Version 3 standing** — on 29 September 2026, [a paid standing request](https://hashscan.io/testnet/transaction/0.0.7162784%401790661109.480107192) returned a version 3 report for vault `0.0.10764331` with its approved caps and recipient, paused state, revoked vault agent and zero balance. A network error interrupted the buyer's final verification; the saved report was recovered without another payment, its EIP-712 signature verified at its issuance time, and its exact USDC settlement confirmed on the mirror. This is historical evidence, not an unexpired report.

### Second deployment from a fresh public scaffold

[Agent account `0.0.10719538`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368400.901918984), [HCS topic `0.0.10719539`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368403.419699553), [policy `0.0.10719558`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368452.706297608), [ERC-8004 agent `122`](https://hashscan.io/testnet/transaction/0.0.5792828%401790368490.311414726), [paid standing](https://hashscan.io/testnet/transaction/0.0.7162784%401790368535.441608179), [guardian revocation](https://hashscan.io/testnet/transaction/0.0.10719536%401790368579.022184355) and [paid standing after revocation](https://hashscan.io/testnet/transaction/0.0.7162784%401790368604.066112463), which returned `agentKeyActive: false`. A live SAUCE → WHBAR quote succeeded between payment and revocation; the configured USDC swap failed before signing because no pool exists, and after revocation failed with `AGENT_KEY_INACTIVE`. This run used the published template at commit `7f7c412`. The same revoked agent was later reattached with `adopt` from another fresh scaffold without submitting a transaction.

### Agent-to-agent lookup and review

On 1 October 2026 the CLI agent (ERC-8004 `121`, account `0.0.10715883`) looked up the browser-set-up agent `125`, which verified, and [rated it 90 in the reputation registry](https://hashscan.io/testnet/transaction/0.0.10715883%401790844857.267883429) (`0.0.7919998`) with tags `identity-check` and `verified`. Reading the registry back returned one review, average 90, from `0.0.10715883`. A self-rating attempt by agent `121` was refused before any transaction was sent. Lookups of `121` and `124` also verified, including both agreement formats; agent `1`, which belongs to another project, was reported as an external card and not fetched.

### SaucerSwap

The V1 router `0.0.19264` exists on testnet, but there is no USDC → WHBAR pool, so new scaffolds use the SAUCE → WHBAR V1 pool. On 25 September 2026 [the operator bought 54.935622 SAUCE for the agent with 1 HBAR](https://hashscan.io/testnet/transaction/0.0.5792828%401790369426.644109430), [the policy-checked agent swapped 1 SAUCE for 0.01809430 WHBAR](https://hashscan.io/testnet/transaction/0.0.10715883%401790369523.124021573) and [published the fill](https://hashscan.io/testnet/transaction/0.0.10715883%401790369529.955985574). Hedera reports the HTS transfers on the contract call's child nonces; the adapter checks those rows and the router parent before accepting a fill.

The browser-set-up agent `125` made the same kind of swap on 1 October 2026. Its setup account [bought 54.872058 SAUCE for the agent](https://hashscan.io/testnet/transaction/0.0.10798471%401790808878.898287168) with `fund-dex`; the agent then checked its policy and [swapped 0.5 SAUCE for 0.00905763 WHBAR](https://hashscan.io/testnet/transaction/0.0.10798474%401790849202.494431270), confirmed the token movements on the mirror and recorded the fill as HCS message 7 on topic `0.0.10798482`. The policy's daily usage then read 0.5 of 5 SAUCE, and the dashboard's Optional DEX page lists the swap with the received amount read from the mirror.

### Scheduled swaps and venue prices

On 1 October 2026 the CLI agent `121` (account `0.0.10715883`) used the new DEX code on testnet:

- **Swap now:** it checked its policy and [swapped 0.3 SAUCE for 0.00543457 WHBAR](https://hashscan.io/testnet/transaction/0.0.10715883%401790855729.877392525), then [recorded the fill](https://hashscan.io/testnet/transaction/0.0.10715883%401790855733.099589526).
- **Scheduled:** it [created schedule `0.0.10807893`](https://hashscan.io/testnet/transaction/0.0.10715883%401790855750.869779418) for 0.3 SAUCE at 11:58:45 UTC, with the guardian and agent keys as a 1-of-2 admin key. [Hedera executed the router call](https://hashscan.io/testnet/schedule/0.0.10807893) at 11:58:45 UTC. The agent confirmed the 0.3 SAUCE debit and 0.00543457 WHBAR credit on the mirror's child records and [recorded the success](https://hashscan.io/testnet/transaction/0.0.10715883%401790855976.366883803) as HCS message 19. The policy's daily usage then read 0.6 SAUCE, counting both swaps.
- **Cancelled on pause:** it scheduled 0.2 SAUCE as `0.0.10807905`. The guardian then [paused the policy](https://hashscan.io/testnet/transaction/0.0.10715881%401790855801.528668459). The agent's next check [deleted the schedule](https://hashscan.io/testnet/transaction/0.0.10715883%401790855932.283457907) and [recorded it as cancelled for `PAUSED`](https://hashscan.io/testnet/transaction/0.0.10715883%401790855937.655725776). The guardian then [unpaused](https://hashscan.io/testnet/transaction/0.0.10715881%401790855993.634293808).
- **Revocation stops a signed schedule:** in a separate experiment, two throwaway accounts each signed a scheduled 0.1 HBAR transfer, and one account's key was replaced before expiry. At expiry the [unchanged account's schedule](https://hashscan.io/testnet/schedule/0.0.10807700) executed with `SUCCESS`, while [the other's](https://hashscan.io/testnet/schedule/0.0.10807702) failed with `INVALID_PAYER_SIGNATURE` and moved nothing. Revoking the agent key is an account key change of the same kind.
- **Out of fee HBAR:** a schedule created from the browser-set-up agent `125` with 0.31 HBAR left after paying for it [failed at execution](https://hashscan.io/testnet/schedule/0.0.10809489) with `INSUFFICIENT_PAYER_BALANCE`: the 1,500,000-gas limit needed about 1.2 HBAR. No tokens moved and the runtime recorded the failure. Swaps now use a 300,000-gas limit and the agent refuses to sign without enough HBAR; [schedule `0.0.10809572`](https://hashscan.io/testnet/schedule/0.0.10809572) then executed with the new limit (112,946 gas, 0.091 HBAR fee).
- **Venue prices:** at 11:47 UTC the comparison for 100 HBAR returned 10.406786 USDC from SaucerSwap V1 on mainnet and 10.329 USDC from the Lambdaplex order book (best bid 0.103290). For 5,000 HBAR the book could fill only 435 HBAR, which the comparison reports instead of estimating.

The dashboard's swap and schedule buttons call the same functions through the agent runtime, and those routes are covered by local tests; the swaps above were run from the CLI.

A forked-mainnet execution has **not** been demonstrated: a Hardhat 3 fork of `https://mainnet.hashio.io/api` loaded the mainnet router bytecode, but calls failed because the fork lacked Hedera's hardfork history, and the Hedera forking plugin declares a Hardhat 2 peer dependency.

### x402 service payments

On 1 October 2026 the CLI agent `121` paid for a service sold by the browser-set-up agent `125`. The guardian [allowed USDC in `121`'s policy](https://hashscan.io/testnet/transaction/0.0.10715881%401790865461.097218817) and [recorded it on HCS](https://hashscan.io/testnet/transaction/0.0.10715881%401790865464.765415953), and the operator [sent the agent 1 USDC](https://hashscan.io/testnet/transaction/0.0.5792828%401790865476.869712944). `pay http://127.0.0.1:3001/standing/0.0.10798474 --max 5000 --seller 125` then read the 402 price (0.001 USDC to `0.0.10798474`), verified agent `125`, checked `121`'s policy and [paid with the agent key](https://hashscan.io/testnet/transaction/0.0.7162784%401790865514.672779373) (Blocky402 paid the fee). It confirmed the transfer on the mirror, received `125`'s signed standing report and [recorded the payment](https://hashscan.io/testnet/transaction/0.0.10715883%401790865521.492151984) as HCS message 24. The policy's USDC usage then read 0.001 for the day, separate from its 0.7 SAUCE of swaps. Both agents ran on the same computer, so the seller was reached at `127.0.0.1`.

Paid inference followed. Agent `125`'s seller configured Vercel AI Gateway with `inclusionai/ling-3.0-flash-sante` from the dashboard. Before the Vercel account had a card on file, the Gateway answered HTTP 403 even for this $0 model. Agent `121`'s purchase then failed with `PAYMENT_NOT_SETTLED`: the seller never settled, and `121`'s USDC balance was 1.004 before and after. Once the card was added, `pay http://127.0.0.1:3001/paid/inference --prompt "In two sentences, what is the Hedera Consensus Service?" --max 20000 --seller 125` [paid 0.01 USDC](https://hashscan.io/testnet/transaction/0.0.7162784%401790869428.707484294) to `0.0.10798474`. It received a two-sentence answer (32 input and 391 output tokens) and [recorded the payment on HCS](https://hashscan.io/testnet/transaction/0.0.10715883%401790869434.925392092). An earlier 512-token output limit left this reasoning model with no answer, so the limit is now 2,048 tokens and an empty answer is refused before settlement. A scheduled payment followed: `schedule-pay http://127.0.0.1:3001/paid/inference --at <40 seconds ahead> --max 20000 --seller 125 --prompt "Name one benefit of scheduling payments, in one sentence."` ran when due, [paid 0.01 USDC](https://hashscan.io/testnet/transaction/0.0.7162784%401790870455.757308533), [recorded it on HCS](https://hashscan.io/testnet/transaction/0.0.10715883%401790870465.716523179) and kept the answer on the job.

### Local validation

On 1 October 2026 the published template at `90d7127` was scaffolded with the bounty's exact command, `npm create scaffold-hbar@latest -- --template i-mwangi/Agent-leash`, accepting every default (`HBAR_ACCEPT_DEFAULTS=1`, which also installs Hedera Skills). The scaffolder selected Next.js, Hardhat and npm from `template.json`. In that fresh copy, `npm run check` passed (75 TypeScript tests, five Solidity execution tests, lint, type checking, production builds); the `npm run dev` bootstrap generated the three local key files; the built dashboard returned 200; and in demo mode `/health`, `/status` and `/deployment` returned 200 while `/standing/:id` returned the deliberate unpaid 503. The API routes were exercised in-process because another dev server held the default ports. Earlier, on 30 September, the template at `565bd8c` also passed with the full command. These local checks are separate from the testnet receipts above.

---

## Links

- [Scaffold-HBAR CLI](https://github.com/hedera-dev/create-scaffold-hbar) · [bounty brief](https://hedera.com/blog/scaffold-hbar-template-bounty/)
- [Hedera documentation](https://docs.hedera.com/) · [Get testnet HBAR](https://portal.hedera.com/)
- [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) · [Blocky402 API](https://blocky402.com/docs/api-reference/) · [SaucerSwap contracts](https://docs.saucerswap.finance/developers/contracts.md)
- [Hedera SDK contract deployment guide](https://hedera.com/blog/how-to-deploy-smart-contracts-on-hedera-part-1-a-simple-getter-and-setter-contract/)

---

## License

MIT
