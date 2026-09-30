"use client";
import { ArrowRight } from "lucide-react";
import { tokenAmount, type Snapshot, type SpendToken } from "./live-data";

type Tab = "Overview" | "Create agent" | "Identity" | "Policy" | "Standing" | "Optional DEX";
interface Props {
  testnet: boolean;
  deployment?: { agentAccount?: string; guardianId?: string; erc8004AgentId?: string };
  agentKeyActive?: boolean;
  paused?: boolean;
  agreement?: { hash: string; version: number };
  paymentReady: boolean;
  snapshot: Snapshot | null;
  token: SpendToken | null;
  goTo: (tab: Tab) => void;
}

function Card({ title, value, children, action }: { title: string; value: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <article className="overview-card">
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{children}</p>
      {action}
    </article>
  );
}

/** A plain-language summary of the agent: who controls it, its rules, and what to do next. */
export function OverviewSummary(props: Props) {
  const { testnet, deployment: d, snapshot, token, goTo } = props;
  const link = (tab: Tab, label: string) => <button className="text-link" onClick={() => goTo(tab)}>{label} <ArrowRight size={14} /></button>;
  const amount = (raw: string) => (token ? `${tokenAmount(raw, token.decimals)} ${token.symbol}` : `${BigInt(raw).toLocaleString("en-US")} raw units`);
  const status = props.agentKeyActive === false ? "Key revoked" : props.paused ? "Paused" : props.agentKeyActive ? "Active" : "Checking…";

  const intro = (
    <p className="overview-intro">
      Accountable Agent gives an AI agent its own Hedera wallet while a person, the <strong>guardian</strong>, stays in charge.
      The agent can pay on its own, but its client checks the spending rules the guardian approved before every payment,
      and the guardian can pause it or remove its key. Other agents can look it up and pay for a signed report on its current status.
    </p>
  );

  if (!testnet || !d?.agentAccount) {
    return (
      <section className="panel detail overview">
        <h2>What this dashboard does</h2>
        {intro}
        <div className="notice">
          This workspace has no agent yet, so the figures on other pages are samples. Setting one up takes four HashPack approvals and about 30 testnet HBAR.
        </div>
        <ol className="how-it-works">
          <li><strong>Set up.</strong> Connect HashPack as the guardian and approve four transactions. The local agent runtime creates the agent's wallet, identity and policy.</li>
          <li><strong>Control.</strong> Approve the agent's spending rules, then pause it or remove its key whenever you need to.</li>
          <li><strong>Prove.</strong> The agent gets a public identity, and anyone can buy a signed report of its status.</li>
        </ol>
        <button className="primary" onClick={() => goTo("Create agent")}>Set up your agent <ArrowRight size={17} /></button>
      </section>
    );
  }

  return (
    <section className="panel detail overview">
      <h2>Your agent at a glance</h2>
      {intro}
      <div className="overview-grid">
        <Card title="Agent wallet" value={<>{d.agentAccount} <em className={status === "Active" ? "ok" : "warn"}>{status}</em></>}
          action={<a className="text-link" href={`https://hashscan.io/testnet/account/${d.agentAccount}`} target="_blank" rel="noreferrer">View on Hashscan</a>}>
          The account the agent pays from. It has two keys, the agent's own and yours; either one can sign.
        </Card>
        <Card title="You, the guardian" value={d.guardianId} action={link("Policy", "Guardian controls")}>
          Your HashPack account. It can pause the agent's spending or replace the account key so only you can sign.
        </Card>
        <Card title="Spending rules" value={snapshot ? `${amount(snapshot.maxPerTx)} per payment` : "Checking…"} action={link("Policy", "Check a payment")}>
          {snapshot ? `Up to ${amount(snapshot.maxPerDay)} per day. ` : ""}
          {props.agreement ? `You approved these rules on-chain (agreement v${props.agreement.version}). ` : "Not yet approved on-chain. "}
          The agent's client checks them before paying; the account key alone does not enforce them.
        </Card>
        <Card title="Balance" value={snapshot ? amount(snapshot.balance) : "Checking…"} action={link("Optional DEX", "Get a live quote")}>
          {snapshot && BigInt(snapshot.balance) === 0n
            ? "The agent has nothing to spend yet, so every payment is refused until it is funded."
            : "What the agent can spend, still subject to the rules above."}
        </Card>
        <Card title="Public identity" value={d.erc8004AgentId ? `ERC-8004 agent ${d.erc8004AgentId}` : "Not registered"} action={link("Identity", "See the identity")}>
          How other agents find this one and check who its guardian is.
        </Card>
        <Card title="Paid status report" value={props.paymentReady ? "Ready" : "Unavailable"} action={link("Standing", "How it works")}>
          Anyone can pay 0.001 testnet USDC for a signed report of this agent's keys, rules and pause state.
        </Card>
      </div>
    </section>
  );
}
