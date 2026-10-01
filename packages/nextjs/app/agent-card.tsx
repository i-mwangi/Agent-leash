"use client";
import { useEffect, useState } from "react";

type Card = {
  name?: string;
  description?: string;
  hederaAccount?: string;
  guardian?: string;
  policy?: string;
  hcsTopic?: string;
  uaid?: string;
  x402Support?: boolean;
  active?: boolean;
  services?: { name: string; endpoint: string }[];
  registrations?: { agentId: string; agentRegistry: string }[];
};

/**
 * The ERC-8004 agent card exactly as other agents read it: the API fetches the registry entry's
 * tokenURI and checks it against this deployment before returning it.
 */
export function AgentCard({ agentId, registry }: { agentId: string; registry?: string }) {
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/.well-known/agent-card.json", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error(`Card unavailable (${response.status})`);
        return response.json() as Promise<Card>;
      })
      .then(value => { if (active) setCard(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Card unavailable"); });
    return () => { active = false; };
  }, []);

  const standing = card?.services?.find(service => service.name === "standing")?.endpoint;
  const localOnly = !!standing && /\/\/(localhost|127\.0\.0\.1)[:/]/.test(standing);
  const rows: [string, React.ReactNode, string][] = card ? [
    ["Name", card.name, "Display name"],
    ["Agent wallet", card.hederaAccount && <a href={`https://hashscan.io/testnet/account/${card.hederaAccount}`} target="_blank" rel="noreferrer">{card.hederaAccount}</a>, "The account to pay or check"],
    ["Guardian", card.guardian && <a href={`https://hashscan.io/testnet/account/${card.guardian}`} target="_blank" rel="noreferrer">{card.guardian}</a>, "Who is answerable for the agent"],
    ["Policy contract", card.policy && <a href={`https://hashscan.io/testnet/contract/${card.policy}`} target="_blank" rel="noreferrer">{card.policy}</a>, "Holds the caps and the pause switch"],
    ["HCS topic", card.hcsTopic && <a href={`https://hashscan.io/testnet/topic/${card.hcsTopic}`} target="_blank" rel="noreferrer">{card.hcsTopic}</a>, "The agent's public history"],
    ["UAID", <code key="uaid">{card.uaid}</code>, "Standard HCS-14 identifier"],
    ["Status report", <code key="standing">{standing}</code>, card.x402Support ? "Paid with x402" : "No x402 support declared"],
  ] : [];

  return (
    <div className="agent-card-view">
      <h3>Your agent card, as other agents see it</h3>
      <p>
        Another agent finds yours by reading entry <strong>#{agentId}</strong> in the ERC-8004 registry
        {registry && <> <a href={`https://hashscan.io/testnet/contract/${registry}`} target="_blank" rel="noreferrer">{registry}</a></>} on
        Hedera testnet: the registry returns this card (its <code>tokenURI</code>), and the card points to everything else.
      </p>
      {error && <div className="notice"><div>{error}</div></div>}
      {!card && !error && <p>Reading the card from the registry…</p>}
      {card && (
        <>
          <table className="card-table">
            <tbody>
              {rows.map(([label, value, hint]) => (
                <tr key={label}><th>{label}</th><td>{value}<small>{hint}</small></td></tr>
              ))}
            </tbody>
          </table>
          {localOnly && (
            <div className="notice">
              <div>
                <strong>The status-report address is local.</strong> <code>localhost</code> means this computer, so other agents can
                read this card but cannot reach the paid report. Serve the API at a public URL to change that.
              </div>
            </div>
          )}
          <a className="text-link" href="/api/.well-known/agent-card.json" target="_blank" rel="noreferrer">Open the raw card JSON</a>
        </>
      )}
    </div>
  );
}
