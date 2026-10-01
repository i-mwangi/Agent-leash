"use client";
import { useEffect, useState } from "react";

type Review = { reviewer: string; reviewerAccount: string | null; value: string; tag1: string; tag2: string };
type Resolution = {
  agentId: string;
  status: "verified" | "unverified" | "not-accountable" | "external-card";
  name?: string | null;
  account?: string;
  guardian?: string;
  hcsTopic?: string;
  policy?: string;
  standing?: string | null;
  owner: { evm: string; account: string | null };
  agentKeyActive?: boolean;
  paused?: boolean;
  maxPerTx?: string;
  maxPerDay?: string;
  agreement?: { hash: string; version: number; spendAsset: string } | null;
  reason?: string;
  reputation: { count: number; average: string | null; reviews: Review[] };
};

const VERDICT: Record<Resolution["status"], string> = {
  verified: "Verified: its card, HCS records, account key, policy and agreement all check out on Hedera.",
  unverified: "Not verified: the card could not be confirmed against Hedera, so do not rely on it.",
  "not-accountable": "Registered, but its card does not describe a guardian-controlled agent this template can verify.",
  "external-card": "Registered with a card hosted at a URL; it is not fetched or verified here.",
};

async function lookup(id: string): Promise<Resolution> {
  const response = await fetch(`/api/agents/${id}`, { cache: "no-store" });
  const body = await response.json().catch(() => ({})) as Resolution & { error?: string };
  if (!response.ok) throw new Error(body.error === "AGENT_NOT_FOUND" ? `No agent #${id} in the registry` : body.error ?? `Lookup failed (${response.status})`);
  return body;
}

const hashscan = (kind: string, id: string) => <a href={`https://hashscan.io/testnet/${kind}/${id}`} target="_blank" rel="noreferrer">{id}</a>;

export function Reviews({ reputation }: { reputation: Resolution["reputation"] }) {
  if (!reputation.count) return <p>No reviews yet in the ERC-8004 reputation registry.</p>;
  return (
    <>
      <p>
        <strong>{reputation.count} review{reputation.count === 1 ? "" : "s"}</strong>, average <strong>{reputation.average}</strong> out of 100.
        Anyone can leave a review, so judge each reviewer, not just the average.
      </p>
      <table className="card-table">
        <tbody>
          {reputation.reviews.map((review, i) => (
            <tr key={`${review.reviewer}-${i}`}>
              <th>{review.value}</th>
              <td>
                by {review.reviewerAccount ? hashscan("account", review.reviewerAccount) : review.reviewer}
                <small>{[review.tag1, review.tag2].filter(Boolean).join(" · ")}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Result({ result }: { result: Resolution }) {
  const rows: [string, React.ReactNode][] = [
    ["Name", result.name],
    ["Agent wallet", result.account && hashscan("account", result.account)],
    ["Guardian", result.guardian && hashscan("account", result.guardian)],
    ["Registered by", result.owner.account ? hashscan("account", result.owner.account) : result.owner.evm],
    ["Key", result.agentKeyActive === undefined ? undefined : result.agentKeyActive ? "Agent key active" : "Revoked: guardian-only"],
    ["Policy", result.paused === undefined ? undefined : result.paused ? "Paused by its guardian" : "Active"],
    ["Caps (raw units)", result.maxPerTx && `${result.maxPerTx} per payment, ${result.maxPerDay} per day`],
    ["Agreement", result.agreement ? `v${result.agreement.version}, guardian-approved, asset ${result.agreement.spendAsset}` : result.status === "verified" ? "None approved" : undefined],
    ["Status report", result.standing && <code>{result.standing}</code>],
  ];
  return (
    <div className="lookup-result">
      <div className={`notice verdict ${result.status}`}><div><strong>Agent #{result.agentId}.</strong> {VERDICT[result.status]}{result.reason && result.status === "unverified" ? ` Reason: ${result.reason}.` : ""}</div></div>
      <table className="card-table">
        <tbody>{rows.filter(([, value]) => value).map(([label, value]) => <tr key={label}><th>{label}</th><td>{value}</td></tr>)}</tbody>
      </table>
      <h4>Reviews</h4>
      <Reviews reputation={result.reputation} />
    </div>
  );
}

/** Reviews this agent has received, read from the ERC-8004 reputation registry. */
export function OwnReputation({ agentId }: { agentId: string }) {
  const [result, setResult] = useState<Resolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    lookup(agentId).then(value => { if (active) setResult(value); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Unavailable"); });
    return () => { active = false; };
  }, [agentId]);
  return (
    <div className="agent-card-view">
      <h3>Your agent's reputation</h3>
      <p>
        Agents that dealt with yours can rate it in the ERC-8004 reputation registry on Hedera. The registry refuses
        feedback from the account that registered your agent, and this template refuses to rate its own agent.
      </p>
      {error && <div className="notice"><div>{error}</div></div>}
      {!result && !error && <p>Reading reviews…</p>}
      {result && <Reviews reputation={result.reputation} />}
    </div>
  );
}

/** Look up and verify any agent by its ERC-8004 ID before dealing with it. */
export function AgentLookup() {
  const [id, setId] = useState("");
  const [result, setResult] = useState<Resolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    if (!/^[1-9]\d{0,30}$/.test(id.trim())) { setError("Enter an ERC-8004 agent ID, for example 121"); setResult(null); return; }
    setBusy(true); setError(null); setResult(null);
    try { setResult(await lookup(id.trim())); } catch (reason) { setError(reason instanceof Error ? reason.message : "Lookup failed"); } finally { setBusy(false); }
  }
  return (
    <div className="agent-card-view">
      <h3>Look up another agent</h3>
      <p>
        Before your agent deals with another one, check it here. This reads the ERC-8004 registry and verifies the agent's
        card, its HCS records, its account key, its policy and its agreement on Hedera, then shows its reviews.
      </p>
      <form className="lookup-form" onSubmit={event => { event.preventDefault(); void run(); }}>
        <div className="amount-field">
          <input value={id} onChange={event => setId(event.target.value)} inputMode="numeric" placeholder="ERC-8004 agent ID, e.g. 121" aria-label="ERC-8004 agent ID" />
        </div>
        <button className="secondary" type="submit" disabled={busy}>{busy ? "Checking…" : "Look up"}</button>
      </form>
      {error && <div className="notice"><div>{error}</div></div>}
      {result && <Result result={result} />}
      <p className="boundary-note">
        To rate an agent you dealt with, run <code>npm run agent -- give-feedback AGENT_ID SCORE [TAG]</code>: your agent signs the
        review with its own key. The same lookup and rating are available to the AI agent as the <code>resolve_agent</code> and
        <code> give_feedback</code> MCP tools.
      </p>
    </div>
  );
}
