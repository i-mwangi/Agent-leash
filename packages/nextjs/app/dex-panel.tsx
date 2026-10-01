"use client";
import { useEffect, useState } from "react";
import { tokenAmount } from "./live-data";

type Token = { id: string; symbol: string; decimals: number };
type Fill = { transactionId: string; status: string; amount: string; received: string | null; reason: string | null; recordedAt: string; sequence: number };
type Fills = { spendToken: Token; outputToken: Token; fills: Fill[] };

const tx = (id: string) => `https://hashscan.io/testnet/transaction/${encodeURIComponent(id)}`;
const when = (consensus: string) => new Date(Number(consensus.split(".")[0]) * 1000).toLocaleString();

/** The agent's SaucerSwap example: a live quote and the policy-checked swaps it recorded on HCS. */
export function DexPanel({ hcsTopic }: { hcsTopic?: string }) {
  const [quote, setQuote] = useState<string | null>(null);
  const [fills, setFills] = useState<Fills | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/agent/fills", { cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error("Swap history unavailable"); return response.json() as Promise<Fills>; })
      .then(value => { if (active) setFills(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Swap history unavailable"); });
    return () => { active = false; };
  }, []);

  async function readQuote() {
    setQuote("Checking the testnet pool…");
    try {
      const response = await fetch("/api/dex/fallback-quote?amount=1000000");
      const data = await response.json() as { amountOut?: string; decimalsOut?: string; error?: string };
      setQuote(response.ok && data.amountOut && data.decimalsOut
        ? `1 SAUCE → ${tokenAmount(data.amountOut, Number(data.decimalsOut))} WHBAR right now. Read-only: no transaction submitted.`
        : `Quote unavailable: ${data.error ?? response.status}`);
    } catch { setQuote("Quote unavailable: the API did not answer"); }
  }

  const amount = (raw: string, token: Token) => `${tokenAmount(raw, token.decimals)} ${token.symbol}`;
  return (
    <section className="panel detail">
      <h2>SaucerSwap: the agent spending under its rules</h2>
      <p>
        SaucerSwap is the main token exchange on Hedera. This is the template's example of the agent spending on its own:
        it swaps SAUCE for WHBAR (wrapped HBAR) in a live testnet pool, and every swap is checked against the policy you
        approved before the agent signs it. Nothing on this page trades; the agent trades from the local agent runtime,
        which holds its key.
      </p>

      <h3 className="dex-heading">Current price</h3>
      <button className="secondary" onClick={() => void readQuote()}>Read pool quote</button>
      {quote && <p role="status">{quote}</p>}

      <h3 className="dex-heading">Make the agent swap</h3>
      <p>In the project folder, for example 0.5 SAUCE:</p>
      <code className="command">npm run agent -- spend 500000</code>
      <ol className="how-it-works">
        <li><strong>Checks the policy immediately before signing:</strong> per-payment cap, daily limit, pause state, key access and balance. If any check fails it signs nothing.</li>
        <li><strong>Signs and sends</strong> the swap to the SaucerSwap router with the agent's own key.</li>
        <li><strong>Confirms on the mirror</strong> that the expected tokens moved.</li>
        <li><strong>Records the swap</strong> on the agent's HCS topic, which is what the daily limit counts.</li>
      </ol>

      <h3 className="dex-heading">Recent swaps by this agent</h3>
      {error && <div className="notice"><div>{error}</div></div>}
      {!fills && !error && <p>Reading the agent's HCS records…</p>}
      {fills && fills.fills.length === 0 && <p>No swaps recorded yet. Fund the agent with SAUCE, then run the command above.</p>}
      {fills && fills.fills.length > 0 && (
        <table className="card-table">
          <thead><tr><th>When</th><th>Swap</th></tr></thead>
          <tbody>
            {fills.fills.map(fill => (
              <tr key={`${fill.transactionId}-${fill.sequence}`}>
                <th>{when(fill.recordedAt)}</th>
                <td>
                  {fill.status === "success"
                    ? <>{amount(fill.amount, fills.spendToken)} → {fill.received ? amount(fill.received, fills.outputToken) : "received amount unavailable"}</>
                    : <>Failed: {amount(fill.amount, fills.spendToken)} returned to the daily limit{fill.reason ? ` (${fill.reason})` : ""}</>}
                  <small>
                    <a href={tx(fill.transactionId)} target="_blank" rel="noreferrer">swap transaction</a>
                    {hcsTopic && <> · <a href={`https://hashscan.io/testnet/topic/${hcsTopic}`} target="_blank" rel="noreferrer">HCS record #{fill.sequence}</a></>}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="boundary-note">
        Optional: identity, guardian control and paid standing do not depend on SaucerSwap. A forked-mainnet swap has not
        been demonstrated; the swaps above are real testnet transactions.
      </p>
    </section>
  );
}
