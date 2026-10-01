"use client";
import { useCallback, useEffect, useState } from "react";
import { toUnits, tokenAmount } from "./live-data";
import { REASON_TEXT } from "./reasons";
import { restoredAccounts, signerFor } from "./wallet-session";

type Token = { id: string; symbol: string; decimals: number };
type Fill = { transactionId: string; status: string; amount: string; received: string | null; reason: string | null; scheduleId: string | null; recordedAt: string; sequence: number };
type Fills = { spendToken: Token; outputToken: Token; fills: Fill[] };
type Schedule = { schedule_id: string; tx_id: string; amount: string; minimum: string; execute_at: string; status: string; reason: string | null };
type Task = { kind: string; running: boolean; result: unknown; error: string | null; startedAt: string };
type AgentState = { task: Task | null; schedules: Schedule[] };
type VenueQuote = { venue: string; kind: string; filledIn: string; usdcOut: string; bestBid?: string | null; bestAsk?: string | null };
type Venues = { amountIn: string; readAt: string; venues: ({ ok: true; quote: VenueQuote } | { ok: false; error: string })[] };

const SETUP_HEADERS = { "x-accountable-setup": "1", "Content-Type": "application/json" };
const hashscan = (kind: "transaction" | "schedule" | "topic", id: string) => `https://hashscan.io/testnet/${kind}/${encodeURIComponent(id)}`;
const when = (consensus: string) => new Date(Number(consensus.split(".")[0]) * 1000).toLocaleString();
const explain = (code: string) => REASON_TEXT[code] ? `${code}: ${REASON_TEXT[code]}` : code;

/** Value for a datetime-local input, in the browser's time zone. */
function localInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function runtime<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/setup/${path}`, { method: body ? "POST" : "GET", headers: SETUP_HEADERS, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `AGENT_RUNTIME_${response.status}`);
  return data;
}

/** Mainnet price discovery across SaucerSwap and Lambdaplex. Read-only. */
function VenueComparison() {
  const [hbar, setHbar] = useState("100");
  const [venues, setVenues] = useState<Venues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function compare() {
    const tinybars = toUnits(hbar, 8);
    if (!tinybars) { setError("Enter an HBAR amount, e.g. 100"); return; }
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/dex/venues?amount=${tinybars}`, { cache: "no-store" });
      const data = await response.json() as Venues & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setVenues(data);
    } catch (reason) { setError(`Comparison unavailable: ${reason instanceof Error ? reason.message : "unknown error"}`); }
    finally { setBusy(false); }
  }
  const quotes = venues?.venues.flatMap(v => v.ok ? [v.quote] : []) ?? [];
  const best = quotes.filter(q => q.filledIn === venues?.amountIn).sort((a, b) => BigInt(b.usdcOut) > BigInt(a.usdcOut) ? 1 : -1)[0];
  return (
    <>
      <h3 className="dex-heading">Compare Hedera venues (mainnet prices, read-only)</h3>
      <p>
        What would selling HBAR for USDC return right now on SaucerSwap (an automated pool) versus Lambdaplex (an order
        book)? Prices come from Hedera mainnet: SaucerSwap through the public mirror node, Lambdaplex from its public
        market-data API. Lambdaplex runs only on mainnet, so the agent compares it but does not trade there.
      </p>
      <form className="lookup-form" onSubmit={event => { event.preventDefault(); void compare(); }}>
        <div className="amount-field">
          <input value={hbar} onChange={event => setHbar(event.target.value)} inputMode="decimal" aria-label="HBAR amount to price" />
          <span>HBAR</span>
        </div>
        <button className="secondary" type="submit" disabled={busy}>{busy ? "Reading prices…" : "Compare"}</button>
      </form>
      {error && <div className="notice"><div>{error}</div></div>}
      {venues && (
        <table className="card-table">
          <thead><tr><th>Venue</th><th>You would receive</th></tr></thead>
          <tbody>
            {venues.venues.map((entry, index) => entry.ok ? (
              <tr key={entry.quote.venue}>
                <th>{entry.quote.venue}<small>{entry.quote.kind}</small></th>
                <td>
                  {entry.quote.filledIn === "0" ? "No bids on the order book at this moment; compare again shortly" : <>{tokenAmount(entry.quote.usdcOut, 6)} USDC</>}
                  {entry.quote === best && <em className="mine">best price</em>}
                  {entry.quote.filledIn !== "0" && entry.quote.filledIn !== venues.amountIn && <small>Only {tokenAmount(entry.quote.filledIn, 8)} HBAR fits in the current order book</small>}
                  {entry.quote.bestBid && <small>Best bid {entry.quote.bestBid} · best ask {entry.quote.bestAsk} USDC</small>}
                </td>
              </tr>
            ) : (
              <tr key={index}><th>{index === 0 ? "SaucerSwap V1" : "Lambdaplex"}</th><td>Unavailable ({entry.error})</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {venues && <p className="boundary-note">Read at {new Date(venues.readAt).toLocaleTimeString()}. Fees and price movement before a trade are not included; nothing was submitted.</p>}
    </>
  );
}

/** Ask the agent to swap now or at a set time, and follow what it scheduled. */
function DirectAgent({ token, guardianId, onChanged }: { token: Token | null; guardianId?: string; onChanged: () => void }) {
  const [state, setState] = useState<AgentState | null>(null);
  const [offline, setOffline] = useState(false);
  const [amount, setAmount] = useState("0.5");
  const [mode, setMode] = useState<"now" | "later">("now");
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + 10 * 60_000)));
  const [error, setError] = useState<string | null>(null);
  const [guardianMessage, setGuardianMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setState(await runtime<AgentState>("agent")); setOffline(false); }
    catch { setOffline(true); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // While the agent works, follow it; afterwards refresh the swap history once.
  useEffect(() => {
    if (!state?.task?.running) return;
    const timer = setInterval(() => void refresh().then(() => onChanged()), 3000);
    return () => clearInterval(timer);
  }, [state?.task?.running, refresh, onChanged]);
  // Pending schedules change on Hedera's clock; check them while any is pending.
  const pending = state?.schedules.some(s => s.status === "pending");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  async function submit() {
    setError(null);
    if (!token) { setError("The spend token is not known yet; wait for the swap history to load."); return; }
    const units = toUnits(amount, token.decimals);
    if (!units) { setError(`Enter a ${token.symbol} amount with at most ${token.decimals} decimals.`); return; }
    try {
      setState(mode === "now"
        ? await runtime<AgentState>("agent/swap", { amount: units.toString() })
        : await runtime<AgentState>("agent/schedule", { amount: units.toString(), executeAt: new Date(at).toISOString() }));
    } catch (reason) { setError(explain(reason instanceof Error ? reason.message : "TASK_FAILED")); }
  }
  async function cancel(id: string) {
    setError(null);
    try { setState(await runtime<AgentState>(`agent/schedules/${id}/cancel`, {})); }
    catch (reason) { setError(explain(reason instanceof Error ? reason.message : "TASK_FAILED")); }
  }
  /** The guardian deletes the schedule from HashPack; it is the other admin key, independent of the agent. */
  async function cancelAsGuardian(id: string) {
    setGuardianMessage(null);
    try {
      if (!guardianId) throw new Error("No guardian account is configured");
      if (!(await restoredAccounts()).includes(guardianId)) throw new Error(`Connect the guardian wallet (${guardianId}) on the Guardian page first`);
      const { Client, Hbar, ScheduleDeleteTransaction, TransactionId } = await import("@hiero-ledger/sdk");
      const client = Client.forTestnet();
      try {
        const tx = new ScheduleDeleteTransaction().setScheduleId(id).setTransactionId(TransactionId.generate(guardianId)).setMaxTransactionFee(new Hbar(2)).freezeWith(client);
        const response = await (await signerFor(guardianId)).call(tx);
        setGuardianMessage(`Delete submitted as guardian: ${response.transactionId.toString()}. The agent runtime records the cancellation on HCS when it next checks.`);
      } finally { client.close(); }
    } catch (reason) { setGuardianMessage(`Guardian cancel failed: ${reason instanceof Error ? reason.message : "unknown error"}`); }
  }

  if (offline) return (
    <>
      <h3 className="dex-heading">Direct the agent</h3>
      <div className="notice"><div>
        The local agent runtime is not answering, so the dashboard cannot pass tasks to the agent. Start everything with
        <code className="command">npm run dev</code>, or use the CLI in the project folder:
        <code className="command">npm run agent -- spend 500000</code>
        <code className="command">npm run agent -- schedule-swap 500000 2026-10-02T09:00:00Z</code>
      </div></div>
    </>
  );
  const task = state?.task;
  const amountText = (raw: string) => token ? `${tokenAmount(raw, token.decimals)} ${token.symbol}` : `${raw} units`;
  return (
    <>
      <h3 className="dex-heading">Direct the agent (testnet SaucerSwap)</h3>
      <p>
        Tell the agent to swap {token?.symbol ?? "its spend token"} for WHBAR now, or at a time you pick. Either way the
        agent checks your policy before it signs. A scheduled swap is signed now and executed by Hedera itself at the
        chosen time, using the Hedera Schedule Service.
      </p>
      <form className="dex-task" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="amount-field">
          <input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" aria-label="Amount to swap" />
          <span>{token?.symbol ?? ""}</span>
        </div>
        <div className="dex-mode" role="radiogroup" aria-label="When">
          <label><input type="radio" checked={mode === "now"} onChange={() => setMode("now")} /> Now</label>
          <label><input type="radio" checked={mode === "later"} onChange={() => setMode("later")} /> At</label>
          {mode === "later" && <input type="datetime-local" value={at} min={localInput(new Date(Date.now() + 3 * 60_000))} onChange={event => setAt(event.target.value)} aria-label="Execution time" />}
        </div>
        <button className="primary" type="submit" disabled={!!task?.running}>{task?.running ? "Agent working…" : mode === "now" ? "Swap now" : "Schedule swap"}</button>
      </form>
      {error && <div className="notice"><div>{error}</div></div>}
      {task && (
        <div className="notice" role="status"><div>
          {task.running && <>The agent is {task.kind === "swap" ? "checking the policy and swapping" : task.kind === "schedule" ? "checking the policy and scheduling the swap" : "cancelling the schedule"}…</>}
          {!task.running && task.error && <>Refused: {explain(task.error)}</>}
          {!task.running && !task.error && task.kind === "swap" && <>Swap confirmed on the mirror and recorded on HCS. {typeof task.result === "object" && task.result && "transactionId" in task.result && <a href={hashscan("transaction", String(task.result.transactionId))} target="_blank" rel="noreferrer">View transaction</a>}</>}
          {!task.running && !task.error && task.kind === "schedule" && <>Scheduled on Hedera. It appears in the list below.</>}
          {!task.running && !task.error && task.kind === "cancel" && <>Schedule deleted and the cancellation recorded on HCS.</>}
        </div></div>
      )}

      <h3 className="dex-heading">Scheduled swaps</h3>
      {!state?.schedules.length && <p>None yet.</p>}
      {!!state?.schedules.length && (
        <table className="card-table">
          <thead><tr><th>Executes</th><th>Swap</th></tr></thead>
          <tbody>
            {state.schedules.map(s => (
              <tr key={s.schedule_id}>
                <th>{new Date(s.execute_at).toLocaleString()}</th>
                <td>
                  {amountText(s.amount)} · <strong>{s.status}</strong>{s.reason && ` (${s.reason})`}
                  <small>
                    <a href={hashscan("schedule", s.schedule_id)} target="_blank" rel="noreferrer">schedule {s.schedule_id}</a>
                    {s.status === "pending" && <> · <button className="link" type="button" disabled={!!task?.running} onClick={() => void cancel(s.schedule_id)}>Cancel (agent)</button>
                      {guardianId && <> · <button className="link" type="button" onClick={() => void cancelAsGuardian(s.schedule_id)}>Cancel as guardian (HashPack)</button></>}</>}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {guardianMessage && <div className="notice"><div>{guardianMessage}</div></div>}
      <ul className="how-it-works">
        <li><strong>Checked before signing:</strong> the same policy checks as an immediate swap, and the amount counts against the daily limit until its outcome is recorded.</li>
        <li><strong>Cancellable:</strong> the guardian and the agent are both admin keys on each schedule. While the agent runtime is running it deletes any pending swap that a pause or a lower cap would now refuse.</li>
        <li><strong>Revocation stops it:</strong> Hedera checks the signature when the swap executes, so a swap scheduled before the guardian removes the agent key fails with INVALID_PAYER_SIGNATURE.</li>
        <li><strong>Not enforced on-chain:</strong> Hedera does not read the policy at execution. If the runtime is stopped, a pause made after scheduling does not stop the swap; remove the agent key or cancel it.</li>
      </ul>
    </>
  );
}

/** The agent on Hedera's exchanges: price discovery across venues, swaps on demand or on a schedule, and its record. */
export function DexPanel({ hcsTopic, guardianId }: { hcsTopic?: string; guardianId?: string }) {
  const [fills, setFills] = useState<Fills | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFills = useCallback(() => {
    fetch("/api/agent/fills", { cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error("Swap history unavailable"); return response.json() as Promise<Fills>; })
      .then(value => { setFills(value); setError(null); })
      .catch(reason => setError(reason instanceof Error ? reason.message : "Swap history unavailable"));
  }, []);
  useEffect(() => { loadFills(); }, [loadFills]);

  const amount = (raw: string, token: Token) => `${tokenAmount(raw, token.decimals)} ${token.symbol}`;
  const describe = (fill: Fill, f: Fills) => {
    if (fill.status === "success") return <>{amount(fill.amount, f.spendToken)} → {fill.received ? amount(fill.received, f.outputToken) : "received amount unavailable"}{fill.scheduleId && " (scheduled)"}</>;
    if (fill.status === "scheduled") return <>Scheduled {amount(fill.amount, f.spendToken)}</>;
    if (fill.status === "cancelled") return <>Cancelled scheduled {amount(fill.amount, f.spendToken)}{fill.reason ? ` (${fill.reason})` : ""}</>;
    return <>Failed: {amount(fill.amount, f.spendToken)} returned to the daily limit{fill.reason ? ` (${fill.reason})` : ""}</>;
  };
  return (
    <section className="panel detail">
      <h2>DEX: the agent trading under its rules</h2>
      <p>
        The agent can trade on Hedera exchanges on its own, within the policy you approved. It compares prices across
        venues, swaps on SaucerSwap when you ask, or schedules a swap for later. Trading runs in the local agent runtime,
        which holds the agent key; this page only passes your instructions to it.
      </p>

      <VenueComparison />
      <DirectAgent token={fills?.spendToken ?? null} guardianId={guardianId} onChanged={loadFills} />

      <h3 className="dex-heading">Swap record on HCS</h3>
      {error && <div className="notice"><div>{error}</div></div>}
      {!fills && !error && <p>Reading the agent&apos;s HCS records…</p>}
      {fills && fills.fills.length === 0 && <p>No swaps recorded yet. Fund the agent with {fills.spendToken.symbol}, then ask it to swap.</p>}
      {fills && fills.fills.length > 0 && (
        <table className="card-table">
          <thead><tr><th>When</th><th>Swap</th></tr></thead>
          <tbody>
            {fills.fills.map(fill => (
              <tr key={`${fill.transactionId}-${fill.sequence}`}>
                <th>{when(fill.recordedAt)}</th>
                <td>
                  {describe(fill, fills)}
                  <small>
                    {fill.scheduleId
                      ? <a href={hashscan("schedule", fill.scheduleId)} target="_blank" rel="noreferrer">schedule {fill.scheduleId}</a>
                      : <a href={hashscan("transaction", fill.transactionId)} target="_blank" rel="noreferrer">swap transaction</a>}
                    {hcsTopic && <> · <a href={hashscan("topic", hcsTopic)} target="_blank" rel="noreferrer">HCS record #{fill.sequence}</a></>}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="boundary-note">
        Optional: identity, guardian control and paid standing do not depend on any exchange. Swaps run on Hedera testnet;
        venue prices are read from mainnet and nothing is traded there.
      </p>
    </section>
  );
}
