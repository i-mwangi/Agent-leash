"use client";
import { useState } from "react";
import { tokenAmount } from "./live-data";

type Challenge = { status: number; price?: string; payTo?: string; feePayer?: string; network?: string; error?: string };
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";

/** Explains paid standing and shows this agent's real x402 challenge without paying. */
export function StandingPanel({ testnet, agentAccount, agreementVersion, onShowCard }: { testnet: boolean; agentAccount?: string; agreementVersion?: number; onShowCard: () => void }) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const endpoint = agentAccount ? `http://localhost:3001/standing/${agentAccount}` : "http://localhost:3001/standing/<agent account>";

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
              <strong>Buying a report.</strong> <code>npm run agent -- pay-standing</code> pays from the setup account and verifies
              the signed report. That account must be associated with testnet USDC and hold some. A setup account created in
              the browser holds only HBAR, so the command fails there; any x402 client with its own testnet USDC can buy a report.
            </div>
          </div>
        </>
      ) : (
        <div className="notice">
          <div>Standing becomes available once an agent is set up and verified. Until then the endpoint deliberately returns 503 and never asks for payment.</div>
        </div>
      )}
    </section>
  );
}
