# AGENTS.md

Guidance for AI coding agents working in this template, and for AI agents operating a deployed agent through its MCP tools. Read [README.md](README.md) first: it is the public setup guide and the source of testnet evidence.

Accountable Agent gives an AI agent on Hedera testnet a 1-of-2 account it shares with a human guardian, an HCS and ERC-8004 identity, a guardian-approved spending policy, and a paid, signed standing report sold over x402.

## Orientation

| Command | Purpose |
| --- | --- |
| `npm run dev` | Generates missing local keys, then starts the dashboard (:3000), API (:3001) and agent runtime (:3002) |
| `npm run check` | Lint, typecheck, unit and integration tests, Solidity tests, production builds. Run after every change |
| `npm test` | Vitest suites in `tests/` plus Solidity tests |
| `npm run agent -- <command>` | CLI; commands are listed in the README's Commands table and the usage line in `packages/agent/src/cli.ts` |
| `npm run agent -- mcp` | Local stdio MCP server for an AI agent |

| Where | What lives there |
| --- | --- |
| `packages/agent/src/` | CLI (`cli.ts`), setup shared by CLI and browser (`setup.ts`), local runtime for browser setup and dashboard agent tasks (`service.ts`, `wizard.ts`), pre-signing policy check (`policyClient.ts`), spend, scheduled swaps (`schedule.ts`), x402 payments (`pay.ts`) and their schedules (`payJobs.ts`), LLM provider settings (`inferenceSettings.ts`), vault, feedback, MCP (`mcp.ts`) |
| `packages/server/src/` | Hono API: modes (`index.ts`), routes (`app.ts`), live sources (`live.ts`), x402 settlement (`x402.ts`), paid LLM inference route |
| `packages/shared/src/` | Mirror client, `readFacts` identity verification (`sources.ts`), agent lookup and reputation (`resolve.ts`), read-only mainnet venue prices (`venues.ts`), AI SDK inference providers (`inference.ts`), agreement and standing formats, UAID, vault terms |
| `packages/contracts/contracts/` | `PolicyRegistry.sol` (client-enforced policy) and `GuardedHbarVault.sol` (contract-enforced HBAR) with Solidity tests |
| `packages/nextjs/app/` | Dashboard; `setup-wizard.tsx` (browser setup), `guardian-wallet.tsx` (HashPack actions), `agent-lookup.tsx` |
| `tests/` | Deterministic tests; `agent-lookup.test.ts` shows how to fake the mirror |

### Who holds which key

| Key | Lives in | Never in |
| --- | --- | --- |
| Agent key (`.env.agent`) | Agent runtime and CLI | API, browser |
| Setup/operator key (`.env.operator`) | Agent runtime and CLI | API, browser |
| Guardian key | HashPack (browser setup) or `.env.guardian` (CLI setup) | API, dashboard code |
| Attestation key (`.env.server`) | API, to sign standing reports | Anything else |
| LLM provider key (`.env.server`, optional) | Written by the agent runtime from the dashboard form; read by the API to sell inference | Browser storage, HCS, logs, API responses |

The API refuses to start with spend keys in its environment. The agent runtime listens on loopback only and rejects requests without its setup header or from another web origin; that includes the dashboard's swap and schedule requests, which run the same policy-checked code as the CLI.

## Making changes

- **Setup steps**: `setup.ts` serves both the CLI and browser setup; `wizard.ts` decides which wallet step the browser shows next. Every on-chain write goes through `nativeOperation`, which records the transaction before sending so a retry never duplicates it. Keep that.
- **Spending rules**: `policyClient.ts` is a pure function with its own tests. The agent must run it against fresh mirror reads immediately before signing.
- **Scheduled swaps**: `schedule.ts` checks the policy before signing the `ScheduleCreate`; Hedera does not check it at execution. Keep the reservation until the outcome is recorded, the guardian as an admin key, the runtime's cancel-on-refusal check, and reads with `scheduled=true` for the executed transaction (its child transfers come from the unfiltered rows).
- **x402 payments**: `pay.ts` must check the policy for USDC immediately before signing, inspect the signed transfer, reserve before sending, and let the mirror decide whether money moved. Sellers use `Payments` in `x402.ts`; paid work that can fail runs with `prepareFirst` so a buyer is never charged for it. Never return a mock 402, and never log or return the inference provider key or its error bodies. The key is entered in the dashboard and stored only through the agent runtime's `/setup/inference` route into `.env.server`; never add a route that reads it back.
- **Venue prices**: `venues.ts` is read-only mainnet data. Never sign or submit on mainnet, and report a venue that fails rather than estimating it.
- **Standing report fields**: `packages/shared/src/standing.ts`. Add a new signed version rather than changing an existing one; the version 1–3 tests are pinned.
- **Verifying agents**: change `readFacts` in `sources.ts`; it backs standing, the dashboard and `resolveAgent`, so all of them stay consistent.
- **Dashboard data**: add an API route in `app.ts`, then read it through the `/api` proxy. The browser never talks to the agent runtime except through `/setup`.
- **MCP tools**: register in `mcp.ts` and update the tool list asserted in `tests/integrations.test.ts`.
- **Amounts**: use `bigint` smallest units everywhere. Format human amounts only with decimals read from the mirror (`tokenAmount` in the dashboard).

## Operating an agent through MCP

| Tool | Use it to |
| --- | --- |
| `check_policy` | Ask whether a spend would be allowed. Advisory; the CLI spend repeats the check before signing |
| `resolve_agent` | Verify a counterparty by ERC-8004 ID before dealing with it. Treat anything other than `verified` as untrusted |
| `give_feedback` | Rate an agent you actually dealt with, 0–100. Never rate your own agent; the tool refuses |
| `record_outcome` | Publish a verified swap result to the agent's HCS topic |
| `link_account` | Verify and bind the agent account and its keys |
| `service_price` | Read what an x402 service charges, without paying |
| `schedule_payment` | Schedule one or repeating x402 payments; the runtime makes each when due, after the same policy check |
| `pay_service` | Pay an x402 service in USDC under the policy. Always state `maxAmount`; pass `sellerAgentId` when you know the seller, and treat a refusal as final |

A paused policy or a revoked agent key means stop. Do not look for a way around it.

## Rules

- Read README.md and the relevant package source before changing behavior. The local planning guide is intentionally excluded from the public template; README.md is the public setup and evidence source. Report demo, local contract execution, fork execution, and real testnet evidence separately.
- Keep the supplied agent's policy check immediately before signing. Fail closed when required sources are unavailable.
- Policy is client-enforced. Never claim that the 1-of-2 native account enforces caps or pause against a bypassing agent. Only HBAR deposited into `GuardedHbarVault` is under contract-enforced rules.
- Use bigint for all smallest-unit amounts. Verify token decimals before formatting human amounts.
- Keep agent, setup and guardian spend keys out of the API and the browser. Never log keys, seed phrases, signed payment payloads or environment contents.
- Testnet only for live writes. Do not fabricate addresses, transaction receipts, UAID vectors, signatures, registry identities or successful protocol integrations.
- The ERC-8004 identity registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`, reputation registry `0x8004B663056A597Dffe9eCcC1965A193B7388713`, USDC `0.0.429274`, Blocky402 payment flow, and SaucerSwap SAUCE/WHBAR route have live evidence linked in README.md. Recheck deployed contracts, token decimals, and pool liquidity before new live writes.
- Paid standing requires authoritative identity sources and independent mirror settlement confirmation. Keep the unconfigured route at unpaid 503; never substitute a mock 402 response for a working x402 integration.
- Preserve the pinned raw-digest Hedera signing and offline EIP-712 standing verification tests when changing transaction or report formats.
- The guardian-approved HCS agreement is a structured technical policy record. It is approved either by the CLI's EIP-191 guardian signature or, in browser setup, by the guardian account paying for the HCS message; keep both verification paths. Version 2 standing binds its hash and version; neither it nor the native account enforces recipient or daily caps against an agent bypassing the client. Never present it as proof of legal ownership.
- Agent lookups read only self-contained data-URI cards; never fetch a card URL. Report anything that cannot be fully verified as unverified.
- Show each reputation review with its reviewer. Never present an average as proof of trust, and never rate this agent itself.
- Wallet requests in the dashboard must be reconciled on the mirror before any retry, so nothing is submitted twice.
- Run `npm run check` after implementation changes. Keep local tests deterministic and independent of funded accounts.
- Public template installation and real testnet evidence must be verified before marking the submission ready.
