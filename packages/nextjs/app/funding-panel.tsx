"use client";
import { useCallback, useEffect, useState } from "react";
import { readiness, toUnits, tokenAmount } from "./live-data";
import { REASON_TEXT } from "./reasons";

type Token = { id: string; symbol: string; decimals: number; balance: string | null };
export type Funding = { agentAccount: string; setupAccount: string; hbar: { balance: string; forSwap: string; forSchedule: string }; spendToken: Token; usdc: Token; setupHbar: string; canBuySpendToken: boolean };

const HEADERS = { "x-accountable-setup": "1", "Content-Type": "application/json" };
const CIRCLE_FAUCET = "https://faucet.circle.com/";
const hashscan = (id: string) => `https://hashscan.io/testnet/transaction/${encodeURIComponent(id)}`;
const explain = (code: string) => REASON_TEXT[code] ? `${code}: ${REASON_TEXT[code]}` : code;
const hbar = (tinybars: string) => `${tokenAmount(tinybars, 8)} HBAR`;
const held = (token: Token) => token.balance === null ? "not associated" : `${tokenAmount(token.balance, token.decimals)} ${token.symbol}`;

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/setup/funding${path}`, { method: body ? "POST" : "GET", headers: HEADERS, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `AGENT_RUNTIME_${response.status}`);
  return data;
}

/**
 * After setup the agent holds only a little HBAR. This panel shows what each feature needs and tops the
 * agent up: HBAR and the swap token are paid by the setup account through the local runtime; testnet
 * USDC comes from Circle's faucet, sent straight to the agent's account.
 */
export function FundingPanel({ onStatus }: { onStatus?: (ready: boolean) => void }) {
  const [funding, setFunding] = useState<Funding | null>(null);
  const [offline, setOffline] = useState(false);
  const [hbarAmount, setHbarAmount] = useState("3");
  const [sauceAmount, setSauceAmount] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [transaction, setTransaction] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    call<Funding>("").then(value => { setFunding(value); setOffline(false); }).catch(() => setOffline(true));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (funding) onStatus?.(readiness(funding).ready); }, [funding, onStatus]);

  if (offline) return <p>Restart <code className="command">npm run dev</code> to fund the agent from here: the local agent runtime pays the top-ups.</p>;
  if (!funding) return <p>Reading the agent&apos;s balances…</p>;

  async function topUp(kind: "hbar" | "spend-token", amount: string) {
    const tinybars = toUnits(amount, 8);
    if (!tinybars) { setMessage("Enter an HBAR amount, for example 1"); return; }
    setBusy(kind); setMessage(null); setTransaction(null);
    try {
      const result = await call<{ transactionId: string; received?: string }>(`/${kind}`, { tinybars: tinybars.toString() });
      setMessage(kind === "hbar"
        ? `Sent ${hbar(tinybars.toString())} to the agent.`
        : `Bought ${tokenAmount(result.received ?? "0", funding!.spendToken.decimals)} ${funding!.spendToken.symbol} for the agent.`);
      setTransaction(result.transactionId);
      load();
    } catch (reason) { setMessage(explain(reason instanceof Error ? reason.message : "FUNDING_FAILED")); }
    finally { setBusy(null); }
  }
  async function copyAccount() {
    try { await navigator.clipboard.writeText(funding!.agentAccount); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  }

  const hbarLow = BigInt(funding.hbar.balance) < BigInt(funding.hbar.forSchedule);
  const ready = readiness(funding);
  const usdcEmpty = !funding.usdc.balance || funding.usdc.balance === "0";
  const spendEmpty = !funding.spendToken.balance || funding.spendToken.balance === "0";
  return (
    <div className="funding">
      <p className="readiness">
        Ready for swaps: <strong>{ready.swaps ? "yes" : "no"}</strong> · Ready for x402 payments: <strong>{ready.payments ? "yes" : "no"}</strong>
        {!ready.ready && <> · Fund at least one to make the agent live.</>}
      </p>
      <p>
        Setup gives the agent a little HBAR and nothing else. Swaps need fee HBAR and {funding.spendToken.symbol}; x402 payments need USDC. Top-ups are paid by
        the setup account <a href={`https://hashscan.io/testnet/account/${funding.setupAccount}`} target="_blank" rel="noreferrer">{funding.setupAccount}</a>,
        which has <strong>{hbar(funding.setupHbar)}</strong> left (it keeps 2 HBAR for its own records).
      </p>
      <table className="card-table">
        <thead><tr><th>Agent holds</th><th>Used for · top up</th></tr></thead>
        <tbody>
          <tr>
            <th>{hbar(funding.hbar.balance)}{hbarLow && <em className="warn">low</em>}</th>
            <td>
              Network fees for swaps (about {hbar(funding.hbar.forSwap)} to start a swap; {hbar(funding.hbar.forSchedule)} to schedule one) and HCS records.
              <div className="funding-action">
                <div className="amount-field"><input value={hbarAmount} onChange={event => setHbarAmount(event.target.value)} inputMode="decimal" aria-label="HBAR to send" /><span>HBAR</span></div>
                <button className="secondary" type="button" disabled={!!busy} onClick={() => void topUp("hbar", hbarAmount)}>{busy === "hbar" ? "Sending…" : "Send from setup account"}</button>
              </div>
            </td>
          </tr>
          <tr>
            <th>{held(funding.spendToken)}{spendEmpty && <em className="warn">empty</em>}</th>
            <td>
              Swaps on the Optional DEX page.
              {funding.canBuySpendToken ? (
                <div className="funding-action">
                  <div className="amount-field"><input value={sauceAmount} onChange={event => setSauceAmount(event.target.value)} inputMode="decimal" aria-label="HBAR to spend on SAUCE" /><span>HBAR</span></div>
                  <button className="secondary" type="button" disabled={!!busy} onClick={() => void topUp("spend-token", sauceAmount)}>{busy === "spend-token" ? "Buying…" : `Buy ${funding.spendToken.symbol} on SaucerSwap`}</button>
                </div>
              ) : <small>Send {funding.spendToken.symbol} to the agent account from any wallet.</small>}
              <small>Uses up to 1 HBAR of setup-account funds at a time, at the live testnet pool price.</small>
            </td>
          </tr>
          <tr>
            <th>{held(funding.usdc)}{usdcEmpty && <em className="warn">empty</em>}</th>
            <td>
              Paying x402 services on the Pay services page.
              <ol className="faucet-steps">
                <li>Open <a href={CIRCLE_FAUCET} target="_blank" rel="noreferrer">Circle&apos;s testnet faucet</a> and choose <strong>Hedera Testnet</strong>.</li>
                <li>Paste the agent&apos;s account <code>{funding.agentAccount}</code> <button className="link" type="button" onClick={() => void copyAccount()}>{copied ? "copied" : "copy"}</button> and request USDC.</li>
                <li><button className="link" type="button" onClick={load}>Refresh balances</button> once it arrives.</li>
              </ol>
              <small>The agent is already associated with USDC, so it can receive it directly. Setup also allows USDC in the policy.</small>
            </td>
          </tr>
        </tbody>
      </table>
      {message && <div className="notice" role="status"><div>{message}{transaction && <> <a href={hashscan(transaction)} target="_blank" rel="noreferrer">View transaction</a></>}</div></div>}
    </div>
  );
}
