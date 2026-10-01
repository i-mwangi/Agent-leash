"use client";
import { useCallback, useEffect, useState } from "react";
import { toUnits, tokenAmount } from "./live-data";
import { InferenceSettings } from "./inference-settings";
import { REASON_TEXT } from "./reasons";
import { restoredAccounts, signerFor } from "./wallet-session";

type Token = { id: string; symbol: string; decimals: number };
type Paid = { transactionId: string; amount: string; payTo: string; resource: string; recordedAt: string; sequence: number };
type Received = { transactionId: string; amount: string; payer: string | null; consensusTimestamp: string };
type Payments = { token: Token; usdcAllowed: boolean; balance: string | null; policyContractId?: string; paid: Paid[]; received: Received[]; selling: { endpoint: string; provider: string; model: string; price: string } | null };
type Price = { paymentRequired: false; status: number } | { paymentRequired: true; description: string | null; amount: string; payTo: string };
type Task = { kind: string; running: boolean; result: unknown; error: string | null };
type Job = { id: number; url: string; prompt: string | null; max_amount: string; seller_agent_id: string | null; next_run: number; every_seconds: number | null; remaining: number; runs: number; status: string; last_status: string | null; last_transaction: string | null; last_body: string | null; last_run: number | null };
const UNIT_SECONDS = { minutes: 60, hours: 3600, days: 86400 } as const;
/** Value for a datetime-local input, in the browser's time zone. */
function localInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** A job's last answer, shown as the model's text when the body is an inference result. */
function lastAnswer(body: string | null) {
  if (!body) return null;
  try { const parsed = JSON.parse(body) as { answer?: unknown }; return typeof parsed.answer === "string" ? parsed.answer : body.slice(0, 300); }
  catch { return body.slice(0, 300); }
}

const SETUP_HEADERS = { "x-accountable-setup": "1", "Content-Type": "application/json" };
const USDC = "0.0.429274";
const hashscan = (kind: "transaction" | "account" | "topic", id: string) => `https://hashscan.io/testnet/${kind}/${encodeURIComponent(id)}`;
const when = (consensus: string) => new Date(Number(consensus.split(".")[0]) * 1000).toLocaleString();
const explain = (code: string) => { const base = code.split(":")[0]; return REASON_TEXT[base] ? `${base}: ${REASON_TEXT[base]}` : code; };
const usdc = (raw: string) => `${tokenAmount(raw, 6)} USDC`;

async function runtime<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/setup/${path}`, { method: body ? "POST" : "GET", headers: SETUP_HEADERS, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `AGENT_RUNTIME_${response.status}`);
  return data;
}

/** The guardian allows USDC in the policy contract from HashPack, then records it on HCS. */
async function allowUsdcWithWallet(guardianId: string, policyContractId: string, hcsTopic: string, agentAccount: string, policyAddress: string) {
  if (!(await restoredAccounts()).includes(guardianId)) throw new Error(`Connect the guardian wallet (${guardianId}) on the Overview or Policy page first`);
  const [{ Client, ContractExecuteTransaction, Hbar, TopicMessageSubmitTransaction, TransactionId }, { Interface, getBytes }] = await Promise.all([import("@hiero-ledger/sdk"), import("ethers")]);
  const signer = await signerFor(guardianId);
  const client = Client.forTestnet();
  const confirm = async (id: string) => {
    const mirrorId = id.replace("@", "-").replace(/\.(\d{9})$/, "-$1");
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${mirrorId}`);
      if (response.ok) {
        const parent = (await response.json() as { transactions: { nonce: number; result: string }[] }).transactions.find(t => t.nonce === 0);
        if (parent) { if (parent.result !== "SUCCESS") throw new Error(`Transaction failed: ${parent.result}`); return; }
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error(`Submitted ${id}; check it on HashScan before trying again so nothing is sent twice`);
  };
  try {
    const call = new ContractExecuteTransaction().setContractId(policyContractId).setGas(300000)
      .setFunctionParameters(getBytes(new Interface(["function setAllowedTokens(string[],bool)"]).encodeFunctionData("setAllowedTokens", [[USDC], true])));
    call.setTransactionId(TransactionId.generate(guardianId)).setMaxTransactionFee(new Hbar(3)).freezeWith(client);
    const transactionId = (await signer.call(call)).transactionId.toString();
    await confirm(transactionId);
    const record = JSON.stringify({ v: 1, type: "policy", ts: new Date().toISOString(), agentAccount, payload: { address: policyAddress, token: USDC, allowed: true, transactionId } });
    // Same submission path as the guardian's pause records in guardian-wallet.tsx.
    const { HederaJsonRpcMethod, transactionToBase64String } = await import("@hashgraph/hedera-wallet-connect");
    const hcs = new TopicMessageSubmitTransaction().setTopicId(hcsTopic).setMessage(record);
    const hcsId = TransactionId.generate(guardianId);
    hcs.setTransactionId(hcsId).setTransactionValidDuration(180).setMaxTransactionFee(new Hbar(3)).freezeWith(client);
    await signer.request({ method: HederaJsonRpcMethod.SignAndExecuteTransaction, params: { signerAccountId: `hedera:testnet:${guardianId}`, transactionList: transactionToBase64String(hcs) } });
    await confirm(hcsId.toString());
    return transactionId;
  } finally { client.close(); }
}

export function PayPanel({ deployment, onFund }: { onFund?: () => void; deployment: { agentAccount?: string; guardianId?: string; guardianMode?: "local" | "wallet"; hcsTopic?: string; policyAddress?: string } }) {
  const [payments, setPayments] = useState<Payments | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [seller, setSeller] = useState("");
  const [prompt, setPrompt] = useState("In two sentences, what is the Hedera Consensus Service?");
  // A prompt turns the request into a POST; only inference endpoints take one, so default to sending it there.
  const [sendPrompt, setSendPrompt] = useState(false);
  useEffect(() => { setSendPrompt(/\/paid\/inference\/?$/.test(url.trim())); }, [url]);
  const [max, setMax] = useState("0.05");
  const [price, setPrice] = useState<Price | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowMessage, setAllowMessage] = useState<string | null>(null);
  const [allowing, setAllowing] = useState(false);
  const [timing, setTiming] = useState<"now" | "later">("now");
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + 5 * 60_000)));
  const [repeat, setRepeat] = useState(false);
  const [every, setEvery] = useState("1");
  const [unit, setUnit] = useState<keyof typeof UNIT_SECONDS>("hours");
  const [times, setTimes] = useState("3");
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobMessage, setJobMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/agent/payments", { cache: "no-store" })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Payments unavailable"); return data as Payments; })
      .then(value => { setPayments(value); setLoadError(null); })
      .catch(reason => setLoadError(reason instanceof Error ? reason.message : "Payments unavailable"));
  }, []);
  useEffect(() => { load(); }, [load]);
  const loadJobs = useCallback(() => { runtime<Job[]>("agent/payment-jobs").then(setJobs).catch(() => setJobs(null)); }, []);
  useEffect(() => { loadJobs(); }, [loadJobs]);
  // While a payment is scheduled, follow its runs and refresh the payment list after each.
  const scheduledCount = jobs?.filter(j => j.status === "scheduled").length ?? 0;
  useEffect(() => {
    if (!scheduledCount) return;
    const timer = setInterval(() => { loadJobs(); load(); }, 20_000);
    return () => clearInterval(timer);
  }, [scheduledCount, loadJobs, load]);
  useEffect(() => {
    if (!task?.running) return;
    const timer = setInterval(() => {
      runtime<{ task: Task | null }>("agent").then(state => { setTask(state.task); if (!state.task?.running) load(); }).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [task?.running, load]);

  const request = () => {
    const maxAmount = toUnits(max, 6);
    if (!maxAmount) throw new Error("Enter the highest price you accept in USDC, e.g. 0.05");
    return { url: url.trim(), prompt: sendPrompt ? prompt.trim() || undefined : undefined, maxAmount: maxAmount.toString(), sellerAgentId: seller.trim() || undefined };
  };
  async function checkPrice() {
    setError(null); setPrice(null);
    try { setPrice(await runtime<Price>("agent/price", request())); }
    catch (reason) { setError(explain(reason instanceof Error ? reason.message : "PRICE_FAILED")); }
  }
  async function pay() {
    setError(null);
    try { setTask((await runtime<{ task: Task }>("agent/pay", request())).task); }
    catch (reason) { setError(explain(reason instanceof Error ? reason.message : "PAYMENT_FAILED")); }
  }
  async function schedule() {
    setError(null); setJobMessage(null);
    try {
      const base = request();
      const runAt = new Date(at);
      if (Number.isNaN(runAt.getTime())) throw new Error("Pick a date and time");
      const job = { url: base.url, maxAmount: base.maxAmount, runAt: runAt.toISOString(), ...(base.prompt ? { prompt: base.prompt } : {}), ...(base.sellerAgentId ? { sellerAgentId: base.sellerAgentId } : {}),
        ...(repeat ? { everySeconds: Math.round(Number(every) * UNIT_SECONDS[unit]), times: Number(times) } : {}) };
      const saved = await runtime<Job>("agent/payment-jobs", job);
      setJobMessage(`Scheduled payment #${saved.id} for ${new Date(saved.next_run).toLocaleString()}${saved.every_seconds ? `, then ${saved.remaining - 1} more` : ""}. Keep npm run dev running.`);
      loadJobs();
    } catch (reason) { setError(explain(reason instanceof Error ? reason.message : "SCHEDULE_FAILED")); }
  }
  async function cancelJob(id: number) {
    try { await runtime(`agent/payment-jobs/${id}/cancel`, {}); loadJobs(); }
    catch (reason) { setError(explain(reason instanceof Error ? reason.message : "CANCEL_FAILED")); }
  }
  async function allowUsdc() {
    // One request at a time: a second click while HashPack is open would send a second allow.
    if (allowing) return;
    setAllowing(true);
    setAllowMessage("Approve the policy change, then the HCS record, in HashPack…");
    try {
      const { guardianId, hcsTopic, agentAccount, policyAddress } = deployment;
      if (!guardianId || !hcsTopic || !agentAccount || !policyAddress || !payments?.policyContractId) throw new Error("Live deployment is incomplete");
      const id = await allowUsdcWithWallet(guardianId, payments.policyContractId, hcsTopic, agentAccount, policyAddress);
      setAllowMessage(`USDC allowed: ${id}`); load();
    } catch (reason) { setAllowMessage(`Not allowed: ${reason instanceof Error ? reason.message : "unknown error"}`); }
    finally { setAllowing(false); }
  }

  const result = task && !task.running && !task.error && task.kind === "pay" ? task.result as { paid: boolean; transactionId?: string; amount?: string; status?: number | null; body?: unknown } : null;
  const answer = result?.body && typeof result.body === "object" && "answer" in result.body ? String((result.body as { answer: unknown }).answer) : null;
  return (
    <section className="panel detail">
      <h2>Pay for services with x402</h2>
      <p>
        Many APIs now charge per request over x402: the service answers <code>402 Payment Required</code> with a price,
        the caller pays, and the service answers. Here the agent pays in USDC on Hedera testnet under your policy: the
        same pause, per-payment and daily limits as its swaps, checked just before it signs. The facilitator, Blocky402,
        pays the network fee, so the agent needs USDC but no extra HBAR for this.
      </p>

      {loadError && <div className="notice"><div>{loadError}</div></div>}
      {payments && (
        <p>
          Agent balance: <strong>{payments.balance === null ? "USDC not associated" : usdc(payments.balance)}</strong> ·
          USDC payments are <strong>{payments.usdcAllowed ? "allowed" : "not allowed yet"}</strong> by the policy.{onFund && (!payments.balance || BigInt(payments.balance) < 10000n) && <> <button className="link" type="button" onClick={onFund}>Get testnet USDC</button></>}
        </p>
      )}
      {payments && !payments.usdcAllowed && (
        <div className="notice"><div>
          The guardian must allow USDC ({USDC}) before the agent may pay with it.{" "}
          {deployment.guardianMode === "wallet"
            ? <><button className="secondary" type="button" disabled={allowing} onClick={() => void allowUsdc()}>{allowing ? "Waiting for HashPack…" : "Allow USDC payments (HashPack)"}</button>{allowMessage && <span> {allowMessage}</span>}</>
            : <>Run <code className="command">npm run agent -- allow-token {USDC}</code> with the guardian key.</>}
        </div></div>
      )}

      <h3 className="dex-heading">Ask the agent to pay a service</h3>
      <div className="pay-form">
        <label>Service URL<div className="amount-field"><input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://… or http://127.0.0.1:3001/paid/inference" /></div></label>
        <label>Seller&apos;s ERC-8004 agent ID (optional; the agent refuses unless it verifies)<div className="amount-field"><input value={seller} onChange={event => setSeller(event.target.value)} inputMode="numeric" placeholder="e.g. 125" /></div></label>
        <label className="check"><input type="checkbox" checked={sendPrompt} onChange={event => setSendPrompt(event.target.checked)} /> Send a prompt (POST {"{\"prompt\": …}"}, for inference endpoints such as /paid/inference). Leave off for GET services like /standing.</label>
        {sendPrompt && <label>Prompt<textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} maxLength={4000} /></label>}
        <label>Highest price you accept<div className="amount-field"><input value={max} onChange={event => setMax(event.target.value)} inputMode="decimal" /><span>USDC</span></div></label>
        <div className="dex-mode" role="radiogroup" aria-label="When">
          <label><input type="radio" checked={timing === "now"} onChange={() => setTiming("now")} /> Now</label>
          <label><input type="radio" checked={timing === "later"} onChange={() => setTiming("later")} /> At</label>
          {timing === "later" && <input type="datetime-local" value={at} onChange={event => setAt(event.target.value)} aria-label="Payment time" />}
        </div>
        {timing === "later" && (
          <div className="dex-mode">
            <label><input type="checkbox" checked={repeat} onChange={event => setRepeat(event.target.checked)} /> Repeat every</label>
            {repeat && <>
              <input className="small-input" value={every} onChange={event => setEvery(event.target.value)} inputMode="decimal" aria-label="Interval" />
              <select className="select" value={unit} onChange={event => setUnit(event.target.value as keyof typeof UNIT_SECONDS)} aria-label="Interval unit"><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select>
              <span>for</span>
              <input className="small-input" value={times} onChange={event => setTimes(event.target.value)} inputMode="numeric" aria-label="Number of payments" />
              <span>payments in total</span>
            </>}
          </div>
        )}
        <div className="pay-actions">
          <button className="secondary" type="button" disabled={!url || !!task?.running} onClick={() => void checkPrice()}>Check price</button>
          {timing === "now"
            ? <button className="primary" type="button" disabled={!url || !!task?.running} onClick={() => void pay()}>{task?.running ? "Agent paying…" : "Pay and send"}</button>
            : <button className="primary" type="button" disabled={!url} onClick={() => void schedule()}>Schedule payment</button>}
        </div>
        {timing === "later" && <small>The local agent runtime makes each payment when it is due, checking your policy at that moment. It runs only while npm run dev is running; a payment more than 15 minutes late is skipped, never made late. Minimum interval: 5 minutes; at most 100 payments.</small>}
      </div>
      {error && <div className="notice"><div>{error}</div></div>}
      {price && <div className="notice" role="status"><div>
        {price.paymentRequired
          ? <>Price: <strong>{usdc(price.amount)}</strong> to <a href={hashscan("account", price.payTo)} target="_blank" rel="noreferrer">{price.payTo}</a>{price.description && ` for ${price.description}`}. Nothing paid yet.</>
          : <>This request did not ask for payment (HTTP {price.status}).</>}
      </div></div>}
      {task?.kind === "pay" && (
        <div className="notice" role="status"><div>
          {task.running && <>The agent is checking the policy, paying and waiting for the mirror to confirm the transfer…</>}
          {!task.running && task.error && <>Not paid: {explain(task.error)}</>}
          {result && !result.paid && <>The service answered without asking for payment (HTTP {result.status}).</>}
          {result?.paid && result.transactionId && <>Paid {usdc(result.amount ?? "0")}, confirmed on the mirror and recorded on HCS. <a href={hashscan("transaction", result.transactionId)} target="_blank" rel="noreferrer">View payment</a>. The service answered with HTTP {result.status ?? "no response"}.</>}
        </div></div>
      )}
      {answer && <blockquote className="service-answer">{answer}</blockquote>}
      {result?.body !== undefined && result?.body !== null && !answer && <pre className="service-answer">{typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2)}</pre>}

      {jobMessage && <div className="notice" role="status"><div>{jobMessage}</div></div>}

      <h3 className="dex-heading">Scheduled payments</h3>
      {jobs === null && <p>Restart npm run dev to schedule payments: the local agent runtime runs them.</p>}
      {jobs && jobs.length === 0 && <p>None yet.</p>}
      {jobs && jobs.length > 0 && (
        <table className="card-table">
          <thead><tr><th>Next run</th><th>Payment</th></tr></thead>
          <tbody>{jobs.map(job => (
            <tr key={job.id}>
              <th>{job.status === "scheduled" ? new Date(job.next_run).toLocaleString() : job.status}</th>
              <td>
                #{job.id} · up to {usdc(job.max_amount)} to {job.url}{job.seller_agent_id && ` (agent ${job.seller_agent_id})`}
                <small>
                  {job.every_seconds ? `Every ${job.every_seconds >= 86400 ? `${job.every_seconds / 86400} d` : job.every_seconds >= 3600 ? `${job.every_seconds / 3600} h` : `${job.every_seconds / 60} min`} · ` : ""}
                  {job.runs} run{job.runs === 1 ? "" : "s"}, {job.status === "scheduled" ? `${job.remaining} left` : job.status}
                  {job.last_status && <> · last: <strong>{job.last_status}</strong>{REASON_TEXT[job.last_status] && ` (${REASON_TEXT[job.last_status]})`}</>}
                  {job.last_transaction && <> · <a href={hashscan("transaction", job.last_transaction)} target="_blank" rel="noreferrer">last payment</a></>}
                  {job.status === "scheduled" && <> · <button className="link" type="button" onClick={() => void cancelJob(job.id)}>Cancel</button></>}
                </small>
                {lastAnswer(job.last_body) && <small>Last answer: {lastAnswer(job.last_body)}</small>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}

      <h3 className="dex-heading">Payments made</h3>
      {payments && payments.paid.length === 0 && <p>None yet.</p>}
      {payments && payments.paid.length > 0 && (
        <table className="card-table">
          <thead><tr><th>When</th><th>Payment</th></tr></thead>
          <tbody>{payments.paid.map(p => (
            <tr key={p.transactionId}>
              <th>{when(p.recordedAt)}</th>
              <td>{usdc(p.amount)} to {p.payTo}<small>{p.resource} · <a href={hashscan("transaction", p.transactionId)} target="_blank" rel="noreferrer">payment</a>{deployment.hcsTopic && <> · <a href={hashscan("topic", deployment.hcsTopic)} target="_blank" rel="noreferrer">HCS record #{p.sequence}</a></>}</small></td>
            </tr>
          ))}</tbody>
        </table>
      )}

      <h3 className="dex-heading">Sell a service: paid LLM inference</h3>
      {payments?.selling ? (
        <>
          <p>
            This agent sells one {payments.selling.model} completion ({payments.selling.provider}) for <strong>{usdc(payments.selling.price)}</strong> at{" "}
            <code>{payments.selling.endpoint}</code> (POST {"{\"prompt\": …}"}). The model only runs after the buyer&apos;s
            payment signature checks out, and the buyer is charged only if it answers.
          </p>
          <h4>USDC received</h4>
          {payments.received.length === 0 ? <p>Nothing received yet.</p> : (
            <table className="card-table">
              <tbody>{payments.received.map(r => (
                <tr key={r.transactionId}><th>{when(r.consensusTimestamp)}</th><td>{usdc(r.amount)}{r.payer && ` from ${r.payer}`}<small><a href={hashscan("transaction", r.transactionId)} target="_blank" rel="noreferrer">transaction</a></small></td></tr>
              ))}</tbody>
            </table>
          )}
        </>
      ) : (
        <p>
          Not selling yet. Choose a provider and enter its API key below. Until then the endpoint answers 503 and charges
          nothing.
        </p>
      )}
      <h4>LLM provider</h4>
      <InferenceSettings onSaved={load} />
      <p className="boundary-note">
        Policy limits are enforced by the agent&apos;s own client before it signs, as for swaps; they are not enforced on-chain.
        Payments run on Hedera testnet with testnet USDC.
      </p>
    </section>
  );
}
