Accountable Agent
Implementation-grade template spec

A reusable Scaffold-HBAR starter for this job: an AI agent that can hold funds on Hedera, be found by other agents, and use client-enforced spending rules with guardian key revocation.

npm create scaffold-hbar@latest --template your-org/accountable-agent

The public GitHub repo is the template. No extra npm package.

This spec takes the Hedera rail that already works in production-shaped code — x402 v2, Blocky402, HTS USDC, mirror-node settlement, 1-of-2 KeyList, ERC-8004 on Hedera testnet, HCS-14, EIP-712 standing signatures — and turns it into a scaffold other developers can run.

1. Pitch

Accountable Agent creates a 1-of-2 Hedera account, publishes an HCS profile and HCS-14 UAID, registers the agent on ERC-8004 on Hedera testnet, sells a signed standing check over x402, and provides a client-policy-gated SaucerSwap spend path with guardian revocation.

The first release implements one DEX integration: SaucerSwap, matching the default configuration. Verify its deployment and supported execution mode before implementation. Lambdaplex is a possible later extension, outside the first-release scope.

A caller can pay GET /standing/:id, verify the answer offline, and see the same facts on Hashscan.

2. What already works and should be copied into the template

These are proven mechanics, not theory.

| Mechanic | How it is built |
|---|---|
| Paid check | GET /standing/:id priced in HTS USDC 0.0.429274 on Hedera testnet |
| x402 stack | x402 v2: @x402/core, @x402/hono or equivalent, @x402/hedera |
| Facilitator | Blocky402 testnet. Agent receives 402 with requirements in PAYMENT-REQUIRED |
| Settlement truth | Facilitator reply is not enough. Mark paid only after the Hedera mirror node shows a USDC transfer of the right amount to the right account |
| Custody | Agent signs with its own key. Template server never sees that key |
| Signing trick | Hedera ECDSA signs keccak256 of the transaction body over secp256k1. A raw-digest signer works through transaction.signWith |
| Hollow accounts | Agent account can hold USDC and pay x402 with zero HBAR, because the facilitator pays network fees |
| Leash | Float/spend account is a 1-of-2 KeyList: agent + guardian. Agent pays alone. Guardian revokes by key-update |
| Policy before pay | Balance, pause, identity status checked before any spend is signed |
| Registry | ERC-8004 Identity Registry on Hedera testnet: 0x8004A818BFB912233c491871b3d84c89A494BD9e |
| UAID | HCS-14, SHA-384 → Base58, canonicalization pinned to the standards-SDK golden vector |
| Standing signature | EIP-712 from a dedicated attestation key that must differ from operator, guardian, and agent keys |
| Drift lock | Twelve-field standing type + a golden signature pinned in server and client tests |

3. Actors and keys

Four keys. All different.

| Key | Role | Lives where |
|---|---|---|
| Guardian | Key B on the 1-of-2 account. Pause, cap, rotate | Guardian wallet / env |
| Agent | Key A. Signs DEX spends and x402 payments it makes as a buyer | Agent runtime only |
| Operator | Creates topic, deploys policy, pays setup fees | Template .env |
| Attestation | Signs standing JSON / EIP-712 typed data | Server only |

If any two of these resolve to the same public key, boot fails.

4. Invariants

Funds sit on a Hedera native account.
That account key is threshold 1-of-2: agent, guardian.
Guardian can drop the agent key with a key-update.
One HCS profile topic per agent.
HCS-14 UAID is written to that topic. A UAID that exists only in memory is not registration.
ERC-8004 registration on Hedera testnet is required before standing can succeed.
/standing/:id returns 402 until x402 settlement is confirmed on the mirror node.
Standing payload is built from ERC-8004 + account info + HCS + policy. The server does not invent pause state.
Server never holds the agent spend key.
Primary spend demo is a policy-gated DEX action.
Policy deny means the agent client refuses to sign.
The native 1-of-2 account does not enforce policy caps or pause state. An agent holding an active key can bypass the client checks. Guardian revocation removes that key's authority once the key-update takes effect; it does not reverse earlier spending.
Created, registered, paused, rotated, and fill are HCS messages.

5. Repo

accountable-agent/
  template.json
  README.md
  AGENTS.md
  LICENSE
  .env.example
  packages/
    contracts/
      contracts/PolicyRegistry.sol
      scripts/deploy.ts
      test/PolicyRegistry.ts
    nextjs/                         guardian dashboard
    server/                         Hono standing API
      src/index.ts
      src/standing.ts
      src/x402.ts
      src/mirror.ts                 settlement verifier
      src/sources.ts                ERC-8004, HCS, account info
      src/eip712.ts
      test/standing.golden.spec.ts
    agent/
      src/policyClient.ts
      src/signWith.ts               raw-digest Hedera signer
      src/spend.ts
      src/mcp.ts                    link / check / record tools
      test/uaid.golden.spec.ts
  scripts/
    self-check.sh
    print-evidence.ts

UI tabs: Create agent, Register, Policy, Standing, Spend.

6. Environment

HEDERA_NETWORK=testnet
HEDERA_OPERATOR_ID=
HEDERA_OPERATOR_KEY=
GUARDIAN_ACCOUNT_ID=
GUARDIAN_PRIVATE_KEY=
AGENT_ACCOUNT_ID=
AGENT_PRIVATE_KEY=                 # agent runtime only, never server
POLICY_CONTRACT_ADDRESS=
HCS_TOPIC_ID=
ERC8004_IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
X402_FACILITATOR_URL=              # Blocky402 testnet
X402_PAY_TO=
X402_ASSET=0.0.429274              # HTS USDC testnet
X402_AMOUNT=1000                   # 0.001 USDC if 3 decimals; confirm decimals in README
DEX=saucerswap
SAUCERSWAP_ROUTER=
STANDING_PUBLIC_BASE_URL=
ATTESTATION_PRIVATE_KEY=

Confirm USDC decimals against Hashscan for 0.0.429274 and print both human amount and smallest units in the README.

7. Create agent — 1-of-2 account

Generate agent key A, or import one.
Take guardian key B from the connected wallet.
AccountCreate with KeyList threshold 1, keys [A, B].
Fund with testnet HBAR for setup txs. Later x402 buyer payments can be hollow: USDC in, zero HBAR, facilitator pays fees.
Read the account back from the mirror node and assert threshold 1 and two keys.

Exceptionalities

Same public key for A and B → reject.
Create tx succeeds, fund fails → show account id + faucet. Register stays disabled.
Re-scaffold → offer “use existing account,” do not silently create another.
Accidental 2-of-2 → fail the assert. Agent must be able to pay alone.
Rotate: guardian key-update to [A2, B] or [B]. After [B] only, standing reports agentKeyActive: false.
Hollow account: agent can still buy standing/services via x402 if it holds USDC. Setup txs (topic create, register) still need an HBAR-paying operator or guardian.

8. PolicyRegistry.sol

State: guardian, agentAccount, paused, maxPerTx, maxPerDay, allowedTokens, optional daily spend window.

Functions: pause, unpause, setCaps, setAllowedTokens, preview(asset, amount) → (ok, reason).

Reasons the client handles: PAUSED, ASSET_NOT_ALLOWED, OVER_TX_CAP, OVER_DAY_CAP, AGENT_KEY_INACTIVE, NO_POLICY, HCS_NOT_READY, IDENTITY_MISSING.

Exceptionalities

Solidity policy does not by itself block a native Hedera transfer. The supplied client enforces preview() before signing; guardian key-update removes the agent key from the account. A valid agent key can authorize transactions outside this client, so caps, allowlists, and pause are not account-level spending guarantees. README and dashboard must describe these as client-enforced controls with guardian revocation, not protection against a malicious or compromised agent bypassing the client.
Daily cap: prefer summing HCS fill messages in the current UTC day. If HCS cannot be read, fail closed.
maxPerTx = 0 means no DEX spend. Standing still sells.
Empty allowlist means nothing is spendable. HBAR is allowed only if 0.0.0 is listed.
Redeploy writes a new policy HCS message. Old address is not used by the agent client.

9. HCS profile topic

One topic per agent. Latest message per type wins.

{
  "v": 1,
  "type": "created|uaid|registered|policy|paused|unpaused|rotated|fill",
  "ts": "2026-09-24T21:34:00Z",
  "agentAccount": "0.0.x",
  "payload": {}
}

Exceptionalities

UAID computed but not submitted → HCS_UAID_MISSING, standing fails.
Mirror lag after write → retry a few seconds, then HCS_NOT_READY.
Server on boot reads created and checks agentAccount matches env. Mismatch → refuse to serve.
Duplicate types → latest consensus timestamp wins.

10. HCS-14 UAID

Copy the canonicalization from the Hashgraph Online standards SDK and pin a golden vector in tests. Do not pull a second full Hedera SDK just for this hash if the template already uses @hiero-ledger/sdk.

Hash: SHA-384 of the canonical agent fields
Encoding: Base58
Write the resulting UAID onto the topic
Put the same UAID in the ERC-8004 agent card

If the golden vector test fails, registration is considered broken.

11. ERC-8004

Registry on Hedera testnet:

0x8004A818BFB912233c491871b3d84c89A494BD9e

Register after the topic exists. Agent card / agentURI includes:

name
guardian account
agent Hedera account
HCS topic
UAID
standing URL
policy contract
DEX used for spend

Exceptionalities

Register before topic create → reject.
Registry call succeeds, card URI 404s → standing fails CARD_UNREACHABLE.
If this official registry is down, README may document a fallback deploy, but the default path is the live testnet registry.

12. Standing API — the Hedera rail

Route: GET /standing/:id
:id may be Hedera account, ERC-8004 agentId, or UAID. Resolve in that order.

Payment

Caller hits the route with no payment.
Server returns 402 with x402 v2 requirements in PAYMENT-REQUIRED:
   scheme exact
   network hedera:testnet
   asset 0.0.429274
   amount smallest units for 0.001 USDC
   payTo standing receiver
   extra.feePayer from Blocky402 GET /supported
Caller signs a TransferTransaction with its own key via signWith / @x402/hedera.
Caller retries with the payment payload.
Server asks the facilitator to verify/settle.
Server then runs report_payment:
   read the tx from the Hedera mirror node
   require a USDC transfer
   require exact amount
   require exact payTo
   require success status
Only then mark the request settled and build the body.

Body

EIP-712 typed data, twelve fields, signed by the attestation key. Suggested fields:

domain / chain / contract version
publicId
hederaAccount
erc8004AgentId
uaid
paused
agentKeyActive
maxPerTx
hcsTopic
hashscanAccount
issuedAt
expiresAt

Client package contains the same twelve-field type and a golden signature test so server and client cannot drift.

Exceptionalities

Trusting only Blocky402’s JSON → forbidden. Mirror node is source of truth.
Facilitator success, mirror miss → SETTLEMENT_UNCONFIRMED, fail closed.
Wrong token or wrong amount on mirror → reject even if facilitator said ok.
Attestation key equals agent, guardian, or operator → process exits.
Expired expiresAt → client treats standing as invalid.
ERC-8004 missing or HCS UAID missing → do not sell a body. Return a paid or unpaid error that names the missing source. Prefer unpaid 409/503 before payment if identity cannot be built; fail closed rather than selling empty standing.
Hollow caller with USDC and no HBAR can still pay. Document that.
Replay: standing payment payload used twice → reject. Tie accepted payloads to tx id.

13. Agent tools before spend

Three tools, usable from the dashboard and from an MCP/agent runtime:

link_account — bind agent key + guardian key + account id.
check_policy — read PolicyRegistry, account key list, HCS latest paused/rotated, ERC-8004 presence, spend-asset allowlist, balances.
record_outcome — write fill or failure reason to HCS.

check_policy runs before every DEX signature. Fail closed.

14. Spend path

Happy path is not cryptoTransfer to a random account.

check_policy(asset, amount).
Build a SaucerSwap swap.
Agent signs.
Wait for mirror confirmation.
record_outcome on HCS.

Complete and document this one DEX path before adding another. Do not assume a usable SaucerSwap testnet deployment or liquidity: verify both and record the supported network, addresses, and execution mode in the README.

If the protocol has no usable Hedera testnet deployment, the bounty permits a documented read-only or forked-mainnet integration. A fork demonstrates execution locally; a read-only integration demonstrates quotes or reads and must not be presented as a completed spend. Identify the fallback explicitly in the UI and README, document reproduction steps and limitations, and retain at least one separate verifiable Hedera testnet transaction with a Hashscan or mirror-node link. Never label fork receipts or read-only results as testnet fills.

Brief: https://hedera.com/blog/scaffold-hbar-template-bounty/

Exceptionalities

Policy pass, DEX revert → HCS fill with status: failed. Daily cap does not increase.
Guardian pauses between preview and signature → second preview immediately before sign. This reduces the race window but does not make pause atomic with execution or enforce it against a bypassing client.
Agent key already rotated → signer fails at Hedera, UI shows AGENT_KEY_INACTIVE.
Debug raw transfer may exist behind a collapsed “advanced” panel. It is not the tab default.

15. Flows

Onboard. Guardian funds HBAR → create 1-of-2 account → deploy policy → create HCS topic → write created + uaid → register ERC-8004 → write registered.

Standing. Caller GET /standing/:id → 402 → sign payment → facilitator settle → mirror confirms USDC → EIP-712 standing returned.

Spend. check_policy → DEX action → mirror confirm → HCS fill.

Rotate. Guardian key-update → HCS rotated → standing agentKeyActive: false.

16. Tests that make this look finished

UAID golden vector matches standards SDK.
EIP-712 golden signature matches in server and a small client helper.
Account create asserts 1-of-2.
Policy preview deny cases.
Standing: 402 without payment.
Standing: facilitator ok + wrong mirror transfer → reject.
Standing: facilitator ok + correct USDC transfer → 200.
Distinct-key boot check.

17. Docs and evidence

README path: faucet → create → register → pay standing → one SaucerSwap spend → guardian revocation → verify agentKeyActive: false → Hashscan evidence.

Reproduce this flow from a fresh scaffold. If using the documented DEX fallback, replace the live spend step with the clearly labelled fork execution or read-only demonstration and include separate testnet evidence. Explain the client-enforced policy boundary and guardian revocation before the spend instructions.

Hashscan links to print:

account create or key-update
ERC-8004 register
HCS profile message
USDC standing payment
DEX fill (when executed on testnet; otherwise provide clearly labelled fork receipts or read-only output separately)

AGENTS.md: policy client first, never log keys, testnet only, registry address, facilitator URL, USDC token id, how to signWith, how to verify standing offline.

18. Rubric

Hedera services at work: native KeyList, HCS topic, HTS USDC, mirror-node reads.

Ecosystem protocols at work: ERC-8004 registry, x402 + Blocky402, and the single SaucerSwap integration.

Standing cannot be produced without ERC-8004 and HCS. The caller cannot get it without x402 plus a real USDC transfer. The supplied agent client's spend demo requires the DEX and policy checks; the account key alone does not enforce those checks. A read-only DEX fallback must be described as a demonstration of integration rather than a completed spend.

That is the template.
