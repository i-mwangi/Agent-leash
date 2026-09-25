"use client";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  ShieldCheck,
  Fingerprint,
  CircleDollarSign,
  SlidersHorizontal,
  Activity,
  ArrowRight,
  Check,
  LockKeyhole,
  RotateCcw,
} from "lucide-react";

const tabs = [
  "Overview",
  "Create agent",
  "Register",
  "Policy",
  "Standing",
  "Spend",
] as const;
type Tab = (typeof tabs)[number];
type LiveView={mode:string;deployment?:{agentAccount?:string;guardianId?:string;hcsTopic?:string;uaid?:string;erc8004AgentId?:string;policyAddress?:string};status?:{liveAdaptersReady:boolean;milestones:{name:string;ready:boolean}[]};agentKeyActive?:boolean;paused?:boolean};
export default function Home() {
  const [tab, setTab] = useState<Tab>("Overview");
  const [paused, setPaused] = useState(false);
  const [active, setActive] = useState(true);
  const [amount, setAmount] = useState("250000");
  const [result, setResult] = useState<{ ok: boolean; reason: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [live,setLive]=useState<LiveView|null>(null);
  const [fallback,setFallback]=useState<string|null>(null);
  useEffect(()=>{
    let mounted=true;
    (async()=>{
      try {
        const [d,s]=await Promise.all([fetch('/api/deployment'),fetch('/api/status')]);
        if(!d.ok || !s.ok) return;
        const deployment=await d.json(),status=await s.json();
        let agentKeyActive: boolean|undefined,livePaused:boolean|undefined;
        if(deployment.mode==='testnet' && deployment.configured){
          const a=await fetch('/api/agent/status');
          if(a.ok){const facts=await a.json();agentKeyActive=facts.keyState?.agentKeyActive;livePaused=facts.paused;}
        }
        if(mounted) setLive({mode:deployment.mode,deployment:deployment.deployment,status,agentKeyActive,paused:livePaused});
      } catch { /* Local demo remains available when the API is offline. */ }
    })();
    return ()=>{mounted=false;};
  },[]);
  async function readFallback(){
    setFallback('Checking testnet pool…');
    try{const response=await fetch('/api/dex/fallback-quote?amount=1000000');const data=await response.json();setFallback(response.ok?`Read-only quote: 1 SAUCE → ${Number(data.amountOut)/100000000} WHBAR. No transaction submitted.`:`Quote unavailable: ${data.error??response.status}`);}catch{setFallback('Quote unavailable: API offline');}
  }
  async function preview() {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/demo/policy/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          asset: "0.0.429274",
          paused,
          agentKeyActive: active,
        }),
      });
      const data = await response.json();
      setResult(
        response.ok
          ? data
          : { ok: false, reason: data.error ?? "API_UNAVAILABLE" },
      );
    } catch {
      setResult({ ok: false, reason: "API_UNAVAILABLE" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/">
          <span className="brand-icon">
            <ShieldCheck size={24} />
          </span>
          <span>
            accountable<span className="brand-sub">AGENT CONTROL</span>
          </span>
        </a>
        <div className="workspace">
          <span className="avatar">G</span>
          <div>
            Guardian workspace<small>Local development</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          {tabs.map((name, i) => {
            const Icon = [
              Activity,
              CircleDollarSign,
              Fingerprint,
              SlidersHorizontal,
              ShieldCheck,
              ArrowUpRight,
            ][i];
            return (
              <button
                key={name}
                className={tab === name ? "selected" : ""}
                onClick={() => setTab(name)}
              >
                <Icon size={18} />
                {name}
                {tab === name && <span className="nav-dot" />}
              </button>
            );
          })}
        </nav>
        <div className="aside-bottom">
          <span className="network-dot" /> Hedera testnet target
          <small>{live?.mode==='testnet'?'Live reads · no browser signing':'Demo data · no network transactions'}</small>
          <a
            href="https://hedera.com/blog/scaffold-hbar-template-bounty/"
            target="_blank"
            rel="noreferrer"
          >
            Built with Scaffold-HBAR <ArrowUpRight size={14} />
          </a>
        </div>
      </aside>
      <main>
        <header>
          <div>
            Workspace <span>/</span> <strong>{tab}</strong>
          </div>
          <span className="demo-pill">{live?.mode==='testnet'?'TESTNET READS':'LOCAL DEMO'}</span>
        </header>
        <div className="content">
          <div className="heading">
            <div>
              <p className="eyebrow">HUMAN OVERSIGHT. AGENT AUTONOMY.</p>
              <h1>{tab === "Overview" ? "Your agent. Your rules." : tab}</h1>
              <p className="subtitle">
                {tab === "Overview"
                  ? "A clear view of identity, permissions, and the next action."
                  : "Explore the accountable agent workflow in a safe local demo."}
              </p>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setPaused(false);
                setActive(true);
                setResult(null);
                setAmount("250000");
              }}
            >
              <RotateCcw size={15} /> Reset demo
            </button>
          </div>
          <div className="notice">
            <span>{live?.mode==='testnet'?'TESTNET EVIDENCE':'DEMO WORKSPACE'}</span>{' '}
            {live?.mode==='testnet'?'The live status panel reads the API. The switches and sample metrics remain simulations; no browser key is used.':'All account data is synthetic. Controls below simulate policy checks; no funds move.'}
          </div>
          {live?.mode==='testnet' && <section className="panel detail" aria-label="Live testnet status">
            <h2>Live testnet status</h2>
            <p>Agent: <code>{live.deployment?.agentAccount??'not configured'}</code> · Guardian: <code>{live.deployment?.guardianId??'not configured'}</code></p>
            <p>Key: {live.agentKeyActive===undefined?'unavailable':live.agentKeyActive?'agent active':'guardian-only'} · Policy: {live.paused===undefined?'unavailable':live.paused?'paused':'active'}</p>
            <p>{live.status?.milestones?.map(item=>`${item.name}: ${item.ready?'ready':'pending'}`).join(' · ')}</p>
          </section>}
          <section className="agent-card">
            <div className="agent-identity">
              <div className="agent-icon">
                <Fingerprint size={32} />
              </div>
              <div>
                <div className="agent-name">
                  Atlas <span className="badge">DEMO AGENT</span>
                </div>
                <p>
                  Treasury assistant <span>·</span> SaucerSwap spend path
                </p>
              </div>
            </div>
            <div className="agent-status">
              <span
                className={active && !paused ? "status-dot" : "status-dot off"}
              />
              {!active
                ? "Key revoked locally"
                : paused
                  ? "Policy paused locally"
                  : "Ready to preview"}
              <small>Simulated state</small>
            </div>
          </section>
          {(tab === "Overview" || tab === "Policy" || tab === "Spend") && (
            <>
              <div className="metrics">
                <article>
                  <span>
                    Available balance <CircleDollarSign size={17} />
                  </span>
                  <strong>
                    8,000,000 <small>units</small>
                  </strong>
                  <p>Synthetic token balance</p>
                </article>
                <article>
                  <span>
                    Daily policy usage <Activity size={17} />
                  </span>
                  <strong>
                    24<small>%</small>
                  </strong>
                  <div className="progress">
                    <i />
                  </div>
                  <p>1,200,000 of 5,000,000 raw units</p>
                </article>
                <article>
                  <span>
                    Per-transaction cap <SlidersHorizontal size={17} />
                  </span>
                  <strong>
                    1,000,000 <small>units</small>
                  </strong>
                  <p>Enforced by the supplied client</p>
                </article>
              </div>
              <div className="two-col">
                <section className="panel">
                  <div className="panel-title">
                    <h2>Try a policy check</h2>
                    <span className="tag">INTERACTIVE</span>
                  </div>
                  <p className="muted">
                    See whether the client would sign this spend.
                  </p>
                  <label htmlFor="amount">Amount in smallest units</label>
                  <div className="amount-field">
                    <input
                      id="amount"
                      disabled={busy}
                      inputMode="numeric"
                      value={amount}
                      onChange={(e) => {
                        setAmount(e.target.value);
                        setResult(null);
                      }}
                    />
                    <span>raw units</span>
                  </div>
                  <div className="asset-row">
                    <span>Allowed asset</span>
                    <code>0.0.429274</code>
                  </div>
                  <button className="primary" onClick={preview} disabled={busy}>
                    {busy ? "Checking policy…" : "Check spending policy"}
                    <ArrowRight size={17} />
                  </button>
                  {result && (
                    <div
                      role="status"
                      className={"result " + (result.ok ? "allow" : "deny")}
                    >
                      <strong>
                        {result.ok
                          ? "Client would allow signing"
                          : "Client refuses to sign"}
                      </strong>
                      <span>{result.reason.replaceAll("_", " ")}</span>
                      <small>Preview only. No transaction was submitted.</small>
                    </div>
                  )}
                </section>
                <section className="panel">
                  <div className="panel-title">
                    <h2>Guardian controls</h2>
                    <LockKeyhole size={19} />
                  </div>
                  <p className="muted">
                    Change the local scenario, then check the policy again.
                  </p>
                  <div className="control">
                    <div>
                      <strong>Pause agent policy</strong>
                      <p>Client checks refuse new spends.</p>
                    </div>
                    <button
                      role="switch"
                      disabled={busy}
                      aria-checked={paused}
                      aria-label="Pause demo policy"
                      className={"switch " + (paused ? "on" : "")}
                      onClick={() => {
                        setPaused(!paused);
                        setResult(null);
                      }}
                    >
                      <i />
                    </button>
                  </div>
                  <div className="control">
                    <div>
                      <strong>Agent key access</strong>
                      <p>
                        {active
                          ? "Active in this demo scenario."
                          : "Revoked in this demo scenario."}
                      </p>
                    </div>
                    <button
                      className="small-button"
                      disabled={busy}
                      onClick={() => {
                        setActive(!active);
                        setResult(null);
                      }}
                    >
                      {active ? "Simulate revoke" : "Restore demo key"}
                    </button>
                  </div>
                  <div className="boundary">
                    <ShieldCheck size={18} />
                    <p>
                      Policy limits live in the client. A valid account key can
                      bypass them. A confirmed guardian key-update revokes the
                      agent’s account access.
                    </p>
                  </div>
                </section>
              </div>
            </>
          )}
          {tab === "Create agent" && (
            <section className="panel detail">
              <h2>A wallet with two independent keys</h2>
              <p>
                Create a Hedera account with a 1-of-2 threshold: the agent can
                sign, and the guardian can revoke its access.
              </p>
              <ol>
                <li>Generate the agent key inside the agent runtime.</li>
                <li>Connect a separate guardian wallet.</li>
                <li>Create and fund the account on testnet.</li>
                <li>
                  Verify the threshold and both keys through the mirror node.
                </li>
              </ol>
              <div className="notice">
                {live?.deployment?.agentAccount?<>Live account <a href={`https://hashscan.io/testnet/account/${live.deployment.agentAccount}`} target="_blank" rel="noreferrer">{live.deployment.agentAccount}</a> is deployed. The browser never receives its keys.</>:'Run the isolated CLI setup to create a live testnet account; this page does not hold spend keys.'}
              </div>
            </section>
          )}
          {tab === "Register" && (
            <section className="panel detail">
              <h2>Identity that other agents can verify</h2>
              <p>
                The registration path connects an HCS profile, an HCS-14 UAID,
                and an ERC-8004 agent card.
              </p>
              <ol>
                <li>
                  Create the profile topic and publish its account identity.
                </li>
                <li>Calculate and publish the standards-verified UAID.</li>
                <li>
                  Register the agent card and confirm it can be retrieved.
                </li>
              </ol>
              <div className="notice">
                {live?.deployment?.erc8004AgentId?<>Live ERC-8004 agent ID: {live.deployment.erc8004AgentId}. HCS topic: {live.deployment.hcsTopic}. UAID: <code>{live.deployment.uaid}</code>.</>:'Switch the API to testnet mode to view a deployed identity. The local demo does not claim registration.'}
              </div>
            </section>
          )}
          {tab === "Standing" && (
            <section className="panel detail">
              <h2>Paid, verifiable standing</h2>
              <p>
                A signed report will describe the agent’s identity, policy, and
                key status. Payment must be confirmed on the Hedera mirror node
                before a report is issued.
              </p>
              <code>GET /standing/:id</code>
              <div className="notice">
                {live?.mode==='testnet' && live.deployment?.agentAccount?<>The live endpoint returns an x402 payment challenge. Run <code>npm run agent -- pay-standing</code> from the isolated CLI to pay and verify the report.</>:'In demo mode, standing remains unavailable; no payment is requested.'}
              </div>
            </section>
          )}
          {tab === 'Spend' && live?.mode==='testnet' && <section className="panel detail">
            <h2>SaucerSwap testnet fallback</h2>
            <p>The configured USDC → WHBAR pool is unavailable. Inspect a real SAUCE → WHBAR V1 pool quote without signing a swap.</p>
            <button className="secondary" onClick={readFallback}>Read pool quote</button>
            {fallback && <p role="status">{fallback}</p>}
          </section>}
          <section className="roadmap">
            <div className="panel-title">
              <h2>From scaffold to accountable agent</h2>
              <span>BUILD PROGRESS</span>
            </div>
            <div className="steps">
              {[
                "Policy foundation",
                "Account & identity",
                "Paid standing",
                "DEX & revocation",
              ].map((step, i) => (
                <div key={step}>
                  <span
                    className={i === 0 ? "step-number done" : "step-number"}
                  >
                    {i === 0 ? <Check size={15} /> : `0${i + 1}`}
                  </span>
                  <strong>{step}</strong>
                  <small>
                    {i===0?'Local implementation':i===1?'Testnet verified':i===2?'Paid testnet verified':'Read-only DEX fallback'}
                  </small>
                </div>
              ))}
            </div>
          </section>
          <footer>
            <span>
              Accountable Agent <span> / </span> Developer preview
            </span>
            <span>Identity. Policy. Evidence.</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
