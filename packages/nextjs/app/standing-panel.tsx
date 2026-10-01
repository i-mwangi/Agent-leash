"use client";
import { useState } from "react";
import { tokenAmount } from "./live-data";

type Challenge = { status: number; price?: string; payTo?: string; feePayer?: string; network?: string; error?: string };
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";

/** Explains paid standing and shows this agent's real x402 challenge without paying. */
export function StandingPanel({ testnet, agentAccount, agreementVersion, standingBaseUrl, onShowCard }: { testnet: boolean; agentAccount?: string; agreementVersion?: number; standingBaseUrl?: string; onShowCard: () => void }) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  // The base URL the agent card advertises; set-standing-url changes it.
  const base = (standingBaseUrl ?? "http://localhost:3001").replace(/\/+$/, "");
  const endpoint = `${base}/standing/${agentAccount ?? "<agent account>"}`;

  async function requestUnpaid() {
    if (!agentAccount) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/standing/${agentAccount}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { accepts?: { asset: string; amount: string; payTo: string; network: string; extra?: { feePayer?: string } }[]; error?: string };
      const offer = body.accepts?.[0];
      if (response.status !== 402 || !offer) { setChallenge({ status: response.status, error: body.error ?? "No payment challenge returned" }); return; }
      // Format the price only with decimals the mirror reports for the payment token.
      const token = await fetch(`${MIRROR}/tokens/${offer.asset}`).then(r => r.ok ? r.json() as Promise<{ decimals: string; symbol: string }> : null).catch(() => null);
      const price = token ? `${tokenAmount(offer.amount, Number(token.decimals))} ${token.symbol} (${offer.asset})` : `${offer.amount} raw units of ${offer.asset}`;
      setChallenge({ status: 402, price, payTo: offer.payTo, feePayer: offer.extra?.feePayer, network: offer.network });
    } catch {
      setChallenge({ status: 0, error: "The local API did not answer" });
    } finally { setBusy(false); }
  }

  return (
    <section className="panel detail">
      <h2>Paid status report (standing)</h2>
      <p>
        Before another agent or service trusts this agent with money, it can buy a short, signed report about it.
        The report is paid with <strong>x402</strong>, the HTTP payment standard: the first request is answered with
        <strong> 402 Payment Required</strong> and payment instructions; once the USDC transfer is confirmed on the Hedera
        mirror, the same request returns the signed report.
      </p>
      <div className="identity-list standing-facts">
        <div>
          <strong>Endpoint</strong> <code>GET {endpoint}</code>
          <small>
            Other agents learn this address from your agent card in the ERC-8004 registry.{" "}
            <button className="text-link" onClick={onShowCard}>See the agent card</button>
          </small>
        </div>
        <div>
          <strong>What the report contains</strong>
          <small>
            The agent's account, ERC-8004 ID and UAID; whether its key is still active; whether the guardian paused it; its
            per-payment and daily caps; its HCS topic{agreementVersion ? `; the hash of the guardian-approved agreement (v${agreementVersion})` : ""}; and a two-minute validity window.
            It is signed (EIP-712), so the buyer can verify it offline and compare it with Hashscan. With an optional vault
            configured, the report also covers the vault's rules, balance, pause state and agent.
          </small>
        </div>
      </div>
      {testnet && agentAccount ? (
        <>
          <button className="secondary" disabled={busy} onClick={() => void requestUnpaid()}>{busy ? "Requesting…" : "Request without paying"}</button>
          {challenge && (
            <div className="notice" role="status">
              {challenge.status === 402 ? (
                <div>
                  <strong>402 Payment Required.</strong> The API asks for <strong>{challenge.price}</strong> on {challenge.network},
                  paid to the agent account {challenge.payTo}; Blocky402 account {challenge.feePayer} pays the network fee. Nothing was paid.
                </div>
              ) : (
                <div><strong>No challenge ({challenge.status || "offline"}).</strong> {challenge.error}</div>
              )}
            </div>
          )}
          <div className="notice">
            <div>
              <strong>Buying a report.</strong> Any x402 client with testnet USDC can buy this report. Your own agent buys other
              agents&apos; reports on the <strong>Pay services</strong> page: enter their standing URL (for example{" "}
              <code>https://their-host/standing/0.0.12345</code>) and their ERC-8004 ID, and it checks your policy, pays and
              verifies the seller. USDC you receive for your report appears there under <strong>USDC received</strong>.
            </div>
          </div>
          {/^https?:\/\/(localhost|127\.0\.0\.1)/.test(endpoint) && (
            <div className="notice">
              <div>
                <strong>Only this computer can reach this endpoint.</strong> Your agent card advertises a localhost address, so
                other agents can read the card but cannot buy the report. Serve the API at a public HTTPS address, then run{" "}
                <code>npm run agent -- set-standing-url https://your-host</code> to publish it in the card.
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="notice">
          <div>Standing becomes available once an agent is set up and verified. Until then the endpoint deliberately returns 503 and never asks for payment.</div>
        </div>
      )}
    </section>
  );
}
