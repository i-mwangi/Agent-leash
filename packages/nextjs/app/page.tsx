"use client";
import { useEffect, useRef, useState } from "react";
import { createLiveReader, tokenAmount, type Snapshot, type SpendToken } from './live-data';
import { GuardianWallet } from './guardian-wallet';
import { SetupWizard } from './setup-wizard';
import { OverviewSummary } from './overview';
import { StandingPanel } from './standing-panel';
import { AgentCard } from './agent-card';
import { AgentLookup, OwnReputation } from './agent-lookup';
import { DexPanel } from './dex-panel';
import { PayPanel } from './pay-panel';
import { REASON_TEXT } from './reasons';
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
  Receipt,
} from "lucide-react";

const tabs = [
  "Overview",
  "Create agent",
  "Identity",
  "Policy",
  "Standing",
  "Pay services",
  "Optional DEX",
] as const;
type Tab = (typeof tabs)[number];
type LiveView={mode:string;deployment?:{agentAccount?:string;guardianId?:string;guardianPublicKey?:string;policyContractId?:string;hcsTopic?:string;uaid?:string;erc8004AgentId?:string;policyAddress?:string;spendAsset?:string;name?:string;registry?:string;guardianMode?:'local'|'wallet'};status?:{liveAdaptersReady:boolean;milestones:{name:string;ready:boolean}[]};agentKeyActive?:boolean;paused?:boolean;agreement?:{hash:string;version:number}};
const units=(value:string)=>BigInt(value).toLocaleString('en-US');
function usagePercent(s:Snapshot){const cap=BigInt(s.maxPerDay);return cap===0n?0:Number((BigInt(s.spentToday)*100n)/cap);}
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
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [token,setToken]=useState<SpendToken|null>(null);
  const [liveError,setLiveError]=useState<string|null>(null);
  const [apiWait,setApiWait]=useState<string|null>(null);
  const [refreshing,setRefreshing]=useState(false);
  const reader=useRef<ReturnType<typeof createLiveReader>|null>(null);
  const liveRevision=useRef(0);
  useEffect(()=>{
    let mounted=true;
    let timer:ReturnType<typeof setInterval>|undefined;
    const reads=createLiveReader(state=>{
      if(!mounted) return;
      ++liveRevision.current;
      setSnapshot(state.value?.snapshot??null);
      if(state.value) setToken(state.value.token);
      setLiveError(state.error);
      setRefreshing(state.loading);
      setResult(null);
      setLive(current=>current?{...current,status:state.value?.status,agentKeyActive:state.value?.facts.keyState.agentKeyActive,paused:state.value?.facts.paused,agreement:state.value?.facts.agreement}:current);
    });
    reader.current=reads;
    (async()=>{
      // Keep asking while the API is starting or still verifying a deployment, then go live.
      while(mounted) {
        try {
          const response=await fetch('/api/deployment',{signal:AbortSignal.timeout(15_000)});
          if(!response.ok) throw new Error('API_UNAVAILABLE');
          const deployment=await response.json();
          if(!mounted) return;
          setLive({mode:deployment.mode,deployment:deployment.deployment});
          if(deployment.mode==='testnet') {
            setApiWait(null);
            void reads.refresh();
            timer=setInterval(()=>{void reads.refresh();},30_000);
            return;
          }
          if(!deployment.deployment?.erc8004AgentId) {setApiWait(null);return;} // No deployment yet: the demo is correct.
          setApiWait('Verifying your agent on Hedera testnet. Live data appears as soon as the check passes.');
        } catch {
          if(mounted) setApiWait('Waiting for the local API to start. Retrying…');
        }
        await new Promise(resolve=>setTimeout(resolve,5000));
      }
    })();
    return ()=>{mounted=false;if(timer)clearInterval(timer);reads.dispose();};
  },[]);
  const testnet=live?.mode==='testnet';
  const policyAsset=testnet?live?.deployment?.spendAsset??'unavailable':'0.0.429274';
  // Live amounts in the token's own units once its mirror-reported decimals are known.
  const liveToken=testnet?token:null;
  const amountOf=(raw:string)=>liveToken?tokenAmount(raw,liveToken.decimals):units(raw);
  const unitLabel=liveToken?.symbol??'units';
  const emptyBalance=testnet && !!snapshot && BigInt(snapshot.balance)===0n;
  const SAUCE_TOKEN='0.0.1183558';
  async function preview() {
    const revision=liveRevision.current;
    setBusy(true);
    setResult(null);
    try {
      // Testnet reads the live policy contract and mirror; demo evaluates the local scenario.
      const response = testnet
        ? await fetch("/api/policy/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount }),
          })
        : await fetch("/api/demo/policy/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              amount,
              asset: policyAsset,
              paused,
              agentKeyActive: active,
            }),
          });
      const data = await response.json();
      if(testnet && revision!==liveRevision.current) return;
      if (testnet && (!response.ok || !data.snapshot)) {
        setSnapshot(null);
        setLiveError('Live policy check unavailable. Refresh to read current state.');
        setLive(current=>current?{...current,status:undefined,agentKeyActive:undefined,paused:undefined,agreement:undefined}:current);
      }
      setResult(
        response.ok
          ? data
          : { ok: false, reason: data.error ?? "API_UNAVAILABLE" },
      );
    } catch {
      if(testnet && revision!==liveRevision.current) return;
      if(testnet) { setSnapshot(null);setLiveError("Live policy check unavailable. Refresh to read current state.");setLive(current=>current?{...current,status:undefined,agentKeyActive:undefined,paused:undefined,agreement:undefined}:current); }
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
              Receipt,
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
          <small>{live?.mode==='testnet'?'Live reads · optional guardian wallet':'Sample data until setup completes'}</small>
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
          <span className="demo-pill">{live?.mode==='testnet'?'TESTNET READS':'SAMPLE DATA'}</span>
        </header>
        <div className="content">
          <div className="heading">
            <div>
              <p className="eyebrow">HUMAN OVERSIGHT. AGENT AUTONOMY.</p>
              <h1>{tab === "Overview" ? "Your agent. Your rules." : tab}</h1>
              <p className="subtitle">
                {tab === "Overview"
                  ? "An AI agent's wallet on Hedera that you, the guardian, can check and stop."
                  : testnet
                    ? "Live view of this deployment on Hedera testnet."
                    : tab === "Create agent"
                      ? "Set up your agent on Hedera testnet."
                      : "Sample data until your agent is set up."}
              </p>
            </div>
            {!testnet && <button
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
            </button>}
          </div>
          <div className="notice">
            <span>{testnet?'TESTNET':tab==='Create agent'?'SETUP':'SAMPLE DATA'}</span>{' '}
            {testnet
              ?'Everything on this page reads Hedera testnet through the local API. Guardian actions are signed in your own wallet; this page never holds a key.'
              :tab==='Create agent'
                ?'Setup below submits real Hedera testnet transactions, approved in your HashPack wallet. Until it completes, the rest of the dashboard shows sample data.'
                :'No verified agent in this workspace yet, so figures and controls here are simulated and move no funds. Set up your agent under Create agent.'}
          </div>
          {apiWait && <div className="notice" role="status"><div>{apiWait}</div></div>}
          {liveError && <p role="alert">{liveError}</p>}
          {tab === "Overview" && (
            <OverviewSummary
              testnet={testnet}
              deployment={live?.deployment}
              agentKeyActive={live?.agentKeyActive}
              paused={live?.paused}
              agreement={live?.agreement}
              paymentReady={!!live?.status?.milestones.find(item => item.name === 'x402 payment challenge')?.ready}
              snapshot={snapshot}
              token={liveToken}
              goTo={setTab}
            />
          )}
          {live?.mode==='testnet' && tab==='Overview' && <details className="panel detail technical" aria-label="Live testnet status">
            <summary>Technical details</summary>
            <button className="secondary" disabled={refreshing} onClick={()=>{void reader.current?.refresh();}}>{refreshing?'Refreshing...':'Refresh live data'}</button>
            <p>Agent: <code>{live.deployment?.agentAccount??'not configured'}</code> · Guardian: <code>{live.deployment?.guardianId??'not configured'}</code></p>
            <p>Key: {live.agentKeyActive===undefined?(liveError?'unavailable':'reading...'):live.agentKeyActive?'agent active':'guardian-only'} · Policy: {live.paused===undefined?(liveError?'unavailable':'reading...'):live.paused?'paused':'active'}</p>
            <p>Guardian policy record: {live.agreement?<><code>v{live.agreement.version}</code> · <code>{live.agreement.hash}</code> · <a href={`https://hashscan.io/testnet/topic/${live.deployment?.hcsTopic}`} target="_blank" rel="noreferrer">HCS topic</a></>:liveError?'unavailable':refreshing?'reading...':'not approved for this deployment'}</p>
            <p>{live.status?.milestones?.map(item=>`${item.name}: ${item.ready?'ready':'pending'}`).join(' · ')}</p>
          </details>}
          {tab === "Policy" && !testnet && <section className="agent-card">
            <div className="agent-identity">
              <div className="agent-icon">
                <Fingerprint size={32} />
              </div>
              <div>
                <div className="agent-name">
                  Atlas <span className="badge">DEMO AGENT</span>
                </div>
                <p>
                  Guardian-controlled wallet <span>·</span> paid standing
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
          </section>}
          {tab === "Policy" && (
            <>
              <div className="metrics">
                <article>
                  <span>
                    Available balance <CircleDollarSign size={17} />
                  </span>
                  <strong>
                    {testnet ? (snapshot ? amountOf(snapshot.balance) : liveError ? "Unavailable" : "...") : "8,000,000"} <small>{testnet ? unitLabel : "units"}</small>
                  </strong>
                  <p>{testnet ? (liveToken && snapshot ? `Agent balance of ${liveToken.symbol} (${liveToken.id}); ${units(snapshot.balance)} raw units` : `Agent balance of ${policyAsset}, raw units`) : "Synthetic token balance"}</p>
                </article>
                <article>
                  <span>
                    Daily policy usage <Activity size={17} />
                  </span>
                  <strong>
                    {testnet ? (snapshot ? usagePercent(snapshot) : liveError ? "Unavailable" : "...") : 24}{(!testnet || snapshot) && <small>%</small>}
                  </strong>
                  <div className="progress">
                    <i style={{ width: `${Math.min(100, testnet ? (snapshot ? usagePercent(snapshot) : 0) : 24)}%` }} />
                  </div>
                  <p>
                    {testnet
                      ? snapshot
                        ? `${amountOf(snapshot.spentToday)} of ${amountOf(snapshot.maxPerDay)} ${unitLabel} today (UTC)`
                        : liveError ? "Current policy unavailable" : "Reading policy..."
                      : "1,200,000 of 5,000,000 raw units"}
                  </p>
                </article>
                <article>
                  <span>
                    Per-transaction cap <SlidersHorizontal size={17} />
                  </span>
                  <strong>
                    {testnet ? (snapshot ? amountOf(snapshot.maxPerTx) : liveError ? "Unavailable" : "...") : "1,000,000"} <small>{testnet ? unitLabel : "units"}</small>
                  </strong>
                  <p>{testnet ? `${snapshot ? `${units(snapshot.maxPerTx)} raw units; ` : ""}live from the policy contract, checked by the supplied client` : "Enforced by the supplied client"}</p>
                </article>
              </div>
              {emptyBalance && (
                <div className="notice">
                  <div>
                    <strong>The agent holds no {unitLabel} yet.</strong>{" "}
                    Every spend check refuses with INSUFFICIENT BALANCE until it is funded.{" "}
                    {policyAsset === SAUCE_TOKEN
                      ? <>To buy testnet SAUCE for the agent through SaucerSwap with up to 1 HBAR from the setup account, run <code>npm run agent -- fund-dex 100000000</code> in the project folder.</>
                      : <>Send {unitLabel} ({policyAsset}) to agent account {live?.deployment?.agentAccount}.</>}
                  </div>
                </div>
              )}
              <div className="two-col">
                <section className="panel">
                  <div className="panel-title">
                    <h2>Try a policy check</h2>
                    <span className="tag">{testnet ? "LIVE READ" : "INTERACTIVE"}</span>
                  </div>
                  <p className="muted">
                    {testnet
                      ? "Check this spend against the live policy contract, key state, and balance."
                      : "See whether the client would sign this spend."}
                  </p>
                  <label htmlFor="amount">{liveToken ? `Amount in raw units (1 ${liveToken.symbol} = ${units((10n ** BigInt(liveToken.decimals)).toString())})` : "Amount in smallest units"}</label>
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
                    <code>{liveToken ? `${liveToken.symbol} (${liveToken.id})` : policyAsset}</code>
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
                      {REASON_TEXT[result.reason] && <span>{REASON_TEXT[result.reason]}</span>}
                      <small>
                        {testnet
                          ? "Advisory live check. No transaction was submitted."
                          : "Preview only. No transaction was submitted."}
                      </small>
                    </div>
                  )}
                </section>
                <section className="panel">
                  <div className="panel-title">
                    <h2>{testnet ? "Agent state" : "Guardian controls"}</h2>
                    <LockKeyhole size={19} />
                  </div>
                  <p className="muted">
                    {testnet
                      ? "Live state from the chain. Pause or unpause under Guardian actions in HashPack below."
                      : "Change the local scenario, then check the policy again."}
                  </p>
                  {testnet ? <>
                  <div className="control">
                    <div>
                      <strong>Agent policy</strong>
                      <p>{live?.paused===undefined?"Reading…":live.paused?"Paused: client checks refuse new spends.":"Active."}</p>
                    </div>
                  </div>
                  <div className="control">
                    <div>
                      <strong>Agent key access</strong>
                      <p>{live?.agentKeyActive===undefined?"Reading…":live.agentKeyActive?"Active on the account key.":"Revoked: guardian-only account key."}</p>
                    </div>
                  </div>
                  </> : <>
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
                  </>}
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
                sign, and the guardian can revoke its access. Setup also gives
                it an HCS profile, a policy contract, an ERC-8004 identity and a
                guardian-approved agreement.
              </p>
              <SetupWizard/>
            </section>
          )}
          {live?.mode==='testnet' && live.deployment && <section className="panel detail compact" style={{display:tab==='Policy'?undefined:'none'}}><h2>Guardian actions in HashPack</h2><GuardianWallet deployment={live.deployment} onConfirmed={()=>{void reader.current?.refresh();}}/></section>}
          {tab === "Identity" && (() => {
            const d = live?.deployment;
            const registered = testnet && d?.erc8004AgentId && d.hcsTopic && d.uaid;
            return (
              <section className="panel detail">
                <h2>Identity that other agents can verify</h2>
                <p>
                  Other agents and services use this public identity to look the
                  agent up, see who its guardian is, and check its records before
                  they deal with it.
                </p>
                {registered ? (
                  <>
                    <div className="notice">
                      Registered during setup. There is nothing to do on this
                      page; each item links to its public record.
                    </div>
                    <ul className="identity-list">
                      <li>
                        <strong>HCS profile topic</strong>{" "}
                        <a href={`https://hashscan.io/testnet/topic/${d.hcsTopic}`} target="_blank" rel="noreferrer">{d.hcsTopic}</a>
                        <small>Ordered, signed records: creation, UAID, policy, registration, agreement and guardian actions.</small>
                      </li>
                      <li>
                        <strong>HCS-14 UAID</strong> <code>{d.uaid}</code>
                        <small>A standard identifier derived from the agent's name and account, published to the topic.</small>
                      </li>
                      <li>
                        <strong>ERC-8004 agent {d.erc8004AgentId}</strong>{" "}
                        {d.registry && <a href={`https://hashscan.io/testnet/contract/${d.registry}`} target="_blank" rel="noreferrer">registry</a>}
                        <small>An on-chain identity registry entry whose agent card names the account, guardian, topic, UAID and policy.</small>
                      </li>
                      <li>
                        <strong>Agent card</strong>{" "}
                        <a href="/api/.well-known/agent-card.json" target="_blank" rel="noreferrer">agent-card.json</a>
                        <small>The card as read back from the registry and checked against this deployment.</small>
                      </li>
                    </ul>
                    <AgentCard agentId={d.erc8004AgentId!} registry={d.registry} />
                    <OwnReputation agentId={d.erc8004AgentId!} />
                  </>
                ) : (
                  <>
                    <ol>
                      <li>An HCS profile topic records the agent's identity.</li>
                      <li>A standards-verified HCS-14 UAID is published to it.</li>
                      <li>An ERC-8004 agent card is registered and read back.</li>
                    </ol>
                    <div className="notice">
                      No agent is registered in this workspace yet. Setup under
                      Create agent does this automatically; the results appear
                      here once verified.
                    </div>
                  </>
                )}
                <AgentLookup ownAgentId={d?.erc8004AgentId} />
              </section>
            );
          })()}
          {tab === "Standing" && (
            <StandingPanel testnet={testnet} agentAccount={live?.deployment?.agentAccount} agreementVersion={live?.agreement?.version} onShowCard={() => setTab("Identity")} />
          )}
          {tab === 'Pay services' && !testnet && <section className="panel detail">
            <h2>Pay for services with x402</h2>
            <p>After setup, the agent can pay HTTP services that charge per request over x402, in USDC on Hedera testnet and within its policy, and can sell paid LLM inference itself.</p>
          </section>}
          {tab === 'Pay services' && live?.mode==='testnet' && live.deployment && <PayPanel deployment={live.deployment} />}
          {tab === 'Optional DEX' && !testnet && <section className="panel detail">
            <h2>Optional SaucerSwap testnet route</h2>
            <p>After setup, this page reads a live SAUCE → WHBAR quote from SaucerSwap on Hedera testnet. The agent's own swaps are checked against its policy before it signs.</p>
          </section>}
          {tab === 'Optional DEX' && live?.mode==='testnet' && <DexPanel hcsTopic={live.deployment?.hcsTopic} agentAccount={live.deployment?.agentAccount} guardianId={live.deployment?.guardianId} />}
          {tab === "Overview" && <section className="roadmap">
            <div className="panel-title">
              <h2>From scaffold to accountable agent</h2>
              <span>BUILD PROGRESS</span>
            </div>
            <div className="steps">
              {[
                "Policy foundation",
                "Account & identity",
                "Paid standing",
                "Guardian oversight",
              ].map((step, i) => {
                // A step is checked only when its live source was read successfully.
                const done = i === 0 || (testnet && !liveError && !refreshing && (
                  i === 1 ? live.agentKeyActive !== undefined
                  : i === 2 ? !!live.status?.milestones.find(item => item.name === 'x402 payment challenge')?.ready
                  : live.paused !== undefined));
                return (
                <div key={step}>
                  <span
                    className={done ? "step-number done" : "step-number"}
                  >
                    {done ? <Check size={15} /> : `0${i + 1}`}
                  </span>
                  <strong>{step}</strong>
                  <small>
                    {i===0?'Local implementation':!testnet?'Demo only':liveError?'Live data unavailable':refreshing?'Reading current state':i===1?(live.agentKeyActive===undefined?'Identity unavailable':'Identity verified'):i===2?(live.status?.milestones.find(item=>item.name==='x402 payment challenge')?.ready?'Payment challenge ready':'Payment source unavailable'):(live.paused===undefined?'Policy unavailable':'Guardian policy read')}
                  </small>
                </div>
                );
              })}
            </div>
          </section>}
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
