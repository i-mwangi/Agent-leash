"use client";
import { useCallback, useEffect, useState } from "react";
import { toUnits, tokenAmount } from "./live-data";
import { REASON_TEXT } from "./reasons";
import { restoredAccounts, signerFor } from "./wallet-session";

type Token = { id: string; symbol: string; decimals: number };
type Paid = { transactionId: string; amount: string; payTo: string; resource: string; recordedAt: string; sequence: number };
type Received = { transactionId: string; amount: string; payer: string | null; consensusTimestamp: string };
type Payments = { token: Token; usdcAllowed: boolean; balance: string | null; policyContractId?: string; paid: Paid[]; received: Received[]; selling: { endpoint: string; model: string; price: string } | null };
type Price = { paymentRequired: false; status: number } | { paymentRequired: true; description: string | null; amount: string; payTo: string };
type Task = { kind: string; running: boolean; result: unknown; error: string | null };

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

export function PayPanel({ deployment }: { deployment: { agentAccount?: string; guardianId?: string; guardianMode?: "local" | "wallet"; hcsTopic?: string; policyAddress?: string } }) {
  const [payments, setPayments] = useState<Payments | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [seller, setSeller] = useState("");
  const [prompt, setPrompt] = useState("In two sentences, what is the Hedera Consensus Service?");
  const [max, setMax] = useState("0.05");
  const [price, setPrice] = useState<Price | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowMessage, setAllowMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/agent/payments", { cache: "no-store" })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Payments unavailable"); return data as Payments; })
      .then(value => { setPayments(value); setLoadError(null); })
      .catch(reason => setLoadError(reason instanceof Error ? reason.message : "Payments unavailable"));
  }, []);
  useEffect(() => { load(); }, [load]);
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
    return { url: url.trim(), prompt: prompt.trim() || undefined, maxAmount: maxAmount.toString(), sellerAgentId: seller.trim() || undefined };
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
  async function allowUsdc() {
    setAllowMessage("Approve the policy change, then the HCS record, in HashPack…");
    try {
      const { guardianId, hcsTopic, agentAccount, policyAddress } = deployment;
      if (!guardianId || !hcsTopic || !agentAccount || !policyAddress || !payments?.policyContractId) throw new Error("Live deployment is incomplete");
      const id = await allowUsdcWithWallet(guardianId, payments.policyContractId, hcsTopic, agentAccount, policyAddress);
      setAllowMessage(`USDC allowed: ${id}`); load();
    } catch (reason) { setAllowMessage(`Not allowed: ${reason instanceof Error ? reason.message : "unknown error"}`); }
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
          USDC payments are <strong>{payments.usdcAllowed ? "allowed" : "not allowed yet"}</strong> by the policy.
        </p>
      )}
      {payments && !payments.usdcAllowed && (
        <div className="notice"><div>
          The guardian must allow USDC ({USDC}) before the agent may pay with it.{" "}
          {deployment.guardianMode === "wallet"
            ? <><button className="secondary" type="button" onClick={() => void allowUsdc()}>Allow USDC payments (HashPack)</button>{allowMessage && <span> {allowMessage}</span>}</>
            : <>Run <code className="command">npm run agent -- allow-token {USDC}</code> with the guardian key.</>}
        </div></div>
      )}

      <h3 className="dex-heading">Ask the agent to pay a service</h3>
      <div className="pay-form">
        <label>Service URL<div className="amount-field"><input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://… or http://127.0.0.1:3001/paid/inference" /></div></label>
        <label>Seller&apos;s ERC-8004 agent ID (optional; the agent refuses unless it verifies)<div className="amount-field"><input value={seller} onChange={event => setSeller(event.target.value)} inputMode="numeric" placeholder="e.g. 125" /></div></label>
        <label>Prompt (sent as {"{\"prompt\": …}"} for an inference endpoint)<textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} maxLength={4000} /></label>
        <label>Highest price you accept<div className="amount-field"><input value={max} onChange={event => setMax(event.target.value)} inputMode="decimal" /><span>USDC</span></div></label>
        <div className="pay-actions">
          <button className="secondary" type="button" disabled={!url || !!task?.running} onClick={() => void checkPrice()}>Check price</button>
          <button className="primary" type="button" disabled={!url || !!task?.running} onClick={() => void pay()}>{task?.running ? "Agent paying…" : "Pay and send"}</button>
        </div>
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
            This agent sells one {payments.selling.model} completion for <strong>{usdc(payments.selling.price)}</strong> at{" "}
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
          Not configured. Add <code>INFERENCE_BASE_URL</code>, <code>INFERENCE_API_KEY</code> and <code>INFERENCE_MODEL</code>{" "}
          (optional <code>INFERENCE_PRICE</code>, default 10000 = 0.01 USDC) to <code>.env.server</code> and restart{" "}
          <code>npm run dev</code>. Any OpenAI-compatible provider works; the README lists examples. Until then the endpoint
          answers 503 and charges nothing.
        </p>
      )}
      <p className="boundary-note">
        Policy limits are enforced by the agent&apos;s own client before it signs, as for swaps; they are not enforced on-chain.
        Payments run on Hedera testnet with testnet USDC.
      </p>
    </section>
  );
}
