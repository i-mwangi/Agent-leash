"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { checkWalletTransaction, guardianBalance, requiredTinybars, verifyAgreementMessage, walletRejected, type Progress, type SetupState } from './setup-actions';
import { WALLETCONNECT_PROJECT_ID } from './wallet-config';
import { connectWallet, disconnectWallet, restoredAccounts, signerFor } from './wallet-session';

type WalletStage='fund'|'topic'|'allow'|'agreement';
type Pending={stage:WalletStage;transactionId:string;submittedAt:number};
const PROJECT_ID=WALLETCONNECT_PROJECT_ID;
const PENDING_KEY='setup-wallet-pending:testnet';
const HEADERS={'x-accountable-setup':'1','Content-Type':'application/json'};
const STEPS:{label:string;wallet:boolean;stage:Progress['stage']|null;kind?:string}[]=[
  {label:'Connect the guardian wallet',wallet:true,stage:'connect',kind:'Wallet connection'},
  {label:'Fund the local setup account',wallet:true,stage:'fund'},
  {label:'Create the 1-of-2 agent account',wallet:false,stage:null},
  {label:'Create the HCS profile topic',wallet:true,stage:'topic'},
  {label:'Publish identity and deploy the policy contract',wallet:false,stage:null},
  {label:'Allow the spend asset in the policy',wallet:true,stage:'allow'},
  {label:'Register the ERC-8004 identity',wallet:false,stage:null},
  {label:'Review and approve the agreement',wallet:true,stage:'agreement'},
];
const STAGE_INDEX:Record<Progress['stage'],number>={connect:0,fund:1,topic:3,allow:5,agreement:7,done:8,cli:8};
const hbar=(tinybars:string)=>(Number(BigInt(tinybars))/1e8).toString();

async function api(path:string,init?:RequestInit):Promise<SetupState> {
  const response=await fetch(path,{...init,headers:HEADERS,cache:'no-store'});
  const body=await response.json().catch(()=>({})) as SetupState&{error?:string};
  if(!response.ok) throw new Error(body.error??`Setup runtime returned ${response.status}`);
  return body;
}

/** Browser setup: the guardian approves four transactions; the local agent runtime does the rest. */
export function SetupWizard() {
  const [account,setAccount]=useState<string|null>(null);
  const restored=useRef(false);
  const [state,setState]=useState<SetupState|null>(null);
  const [offline,setOffline]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [pending,setPending]=useState<Pending|null>(null);
  const progress=state?.progress??null;

  const savePending=(value:Pending|null)=>{
    setPending(value);
    try{if(value)sessionStorage.setItem(PENDING_KEY,JSON.stringify(value));else sessionStorage.removeItem(PENDING_KEY);}catch{/* Pending state is then kept in memory only. */}
  };
  const refresh=useCallback(async()=>{
    try{setState(await api('/setup/state'));setOffline(false);}catch{setOffline(true);}
  },[]);
  useEffect(()=>{
    try{const saved=sessionStorage.getItem(PENDING_KEY);if(saved)setPending(JSON.parse(saved) as Pending);}catch{/* Ignore unreadable pending state. */}
    void refresh();
  },[refresh]);
  // Reattach the wallet session WalletConnect kept in this browser, so a refresh stays connected.
  // At the connect step a restored account is only offered; the guardian is chosen by a click.
  useEffect(()=>{
    if(!progress || restored.current || !PROJECT_ID) return;
    restored.current=true;
    void restoredAccounts().then(accounts=>{
      const match=progress.guardianId?accounts.find(a=>a===progress.guardianId):accounts[0];
      if(match) setAccount(match);
    });
  },[progress]);
  // Poll while the runtime works so long steps such as the policy deployment show progress.
  useEffect(()=>{
    if(!state?.running) return;
    const timer=setInterval(()=>void refresh(),2500);
    return ()=>clearInterval(timer);
  },[state?.running,refresh]);
  // Once setup is done, wait for the API to verify the deployment, then load the live dashboard.
  useEffect(()=>{
    if(progress?.stage!=='done') return;
    let cancelled=false;
    void (async()=>{
      for(let i=0;i<12 && !cancelled;i++){
        const response=await fetch('/api/deployment',{cache:'no-store'}).catch(()=>null);
        if(response?.ok && (await response.json() as {mode?:string}).mode==='testnet'){window.location.reload();return;}
        await new Promise(resolve=>setTimeout(resolve,5000));
      }
    })();
    return ()=>{cancelled=true;};
  },[progress?.stage]);
  // A pending wallet request is reconciled against the mirror before anything is resubmitted.
  useEffect(()=>{
    if(!pending || busy) return;
    if(progress && progress.stage!==pending.stage){savePending(null);return;}
    void (async()=>{
      const result=await checkWalletTransaction(pending.transactionId,pending.submittedAt).catch(()=>'unknown' as const);
      if(result==='success'){setMessage('Wallet transaction confirmed. Continuing setup…');await api('/setup/advance',{method:'POST'}).then(setState).catch(()=>undefined);}
      else if(result==='failed' || result==='expired'){savePending(null);setMessage(`The previous ${pending.stage} request ${result==='failed'?'failed on Hedera':'expired without reaching Hedera'}. You can try again.`);}
    })();
  },[pending,progress,busy]);

  async function connect() {
    const accounts=account?[account]:await connectWallet();
    const id=progress?.guardianId?accounts.find(a=>a===progress.guardianId):accounts[0];
    if(!id) throw new Error(`This setup's guardian is ${progress?.guardianId}; connect that account in HashPack`);
    setAccount(id);
    if(progress?.stage==='connect') setState(await api('/setup/guardian',{method:'POST',body:JSON.stringify({accountId:id})}));
  }
  async function disconnect() {
    await disconnectWallet();
    setAccount(null);
  }

  async function approve(stage:WalletStage) {
    if(!progress || !account) throw new Error('Connect the guardian wallet first');
    if(pending) throw new Error('Reconcile the pending wallet request first');
    const [sdk,{HederaJsonRpcMethod,transactionToBase64String},{Interface,getBytes}]=await Promise.all([import('@hiero-ledger/sdk'),import('@hashgraph/hedera-wallet-connect'),import('ethers')]);
    const {AccountCreateTransaction,ContractExecuteTransaction,Hbar,KeyList,PublicKey,TopicCreateTransaction,TopicMessageSubmitTransaction,TransactionId,Client}=sdk;
    let tx;
    if(stage==='fund') tx=new AccountCreateTransaction().setKeyWithoutAlias(PublicKey.fromStringECDSA(progress.operatorPublicKey)).setInitialBalance(Hbar.fromTinybars(progress.fundingTinybars)).setAccountMemo('Accountable Agent setup');
    else if(stage==='topic'){
      const t=progress.topic;if(!t)throw new Error('Topic details are not ready');
      tx=new TopicCreateTransaction().setTopicMemo(t.memo).setAdminKey(PublicKey.fromStringECDSA(t.adminKey)).setSubmitKey(new KeyList(t.submitKeys.map(k=>PublicKey.fromStringECDSA(k)),t.threshold));
    } else if(stage==='allow'){
      const a=progress.allow;if(!a)throw new Error('Policy details are not ready');
      tx=new ContractExecuteTransaction().setContractId(a.policyContractId).setGas(300000).setFunctionParameters(getBytes(new Interface(['function setAllowedTokens(string[],bool)']).encodeFunctionData('setAllowedTokens',[[a.spendAsset],true])));
    } else {
      const g=progress.agreement,topic=progress.deployment?.hcsTopic;if(!g||!topic)throw new Error('Agreement details are not ready');
      verifyAgreementMessage(g,progress);
      tx=new TopicMessageSubmitTransaction().setTopicId(topic).setMessage(g.message);
    }
    // Check the guardian can pay before asking the wallet; an unfunded request fails with no detail.
    const needed=requiredTinybars(stage,progress.fundingTinybars);
    const balance=await guardianBalance(account);
    if(balance!==null && balance<needed) throw new Error(`Guardian ${account} has ${hbar(balance.toString())} HBAR; this step needs about ${hbar(needed.toString())} HBAR including fees. Add testnet HBAR at portal.hedera.com/faucet, then try again.`);
    const client=Client.forTestnet();
    try{
      const id=TransactionId.generate(account);
      tx.setTransactionId(id).setTransactionValidDuration(180).setMaxTransactionFee(new Hbar(5)).freezeWith(client);
      const record={stage,transactionId:id.toString(),submittedAt:Date.now()};
      savePending(record);
      const signer=await signerFor(account);
      try{await signer.request({method:HederaJsonRpcMethod.SignAndExecuteTransaction,params:{signerAccountId:`hedera:testnet:${account}`,transactionList:transactionToBase64String(tx)}});}
      catch(error){
        // A rejected request was never signed, so it cannot reach Hedera; anything else is reconciled on the mirror.
        if(walletRejected(error)){savePending(null);setMessage('The request was declined in HashPack. Nothing was submitted; you can try again.');return;}
        setMessage(`HashPack did not confirm the request. Checking ${record.transactionId} on the mirror before allowing a retry (up to four minutes).`);return;
      }
      setMessage('Approved in HashPack. Waiting for Hedera confirmation…');
    } finally{client.close();}
  }

  async function perform(action:()=>Promise<void>) {
    setBusy(true);setMessage('');
    try{await action();}catch(error){setMessage(error instanceof Error?error.message:'Setup action failed');}
    finally{setBusy(false);void refresh();}
  }

  if(offline) return <div className="notice">The local setup runtime is not reachable. Start the dashboard with <code>npm run dev</code> from the project root; it runs the setup runtime alongside the API.</div>;
  if(!state || !progress) return <div className="notice">{state?.lastError?`Setup check failed: ${state.lastError}`:'Checking setup progress…'}</div>;
  if(progress.stage==='cli') return <div className="notice"><strong>Configured with the CLI</strong><p>Agent <a href={`https://hashscan.io/testnet/account/${progress.deployment?.agentAccount}`} target="_blank" rel="noreferrer">{progress.deployment?.agentAccount}</a> uses a local guardian key. Browser setup is for new workspaces; use a fresh scaffold for another agent.</p></div>;

  const current=STAGE_INDEX[progress.stage];
  const stage=progress.stage;
  const walletStage=(['fund','topic','allow','agreement'] as const).find(s=>s===stage);
  return <div className="create-agent-form setup-wizard">
    <h3>Set up this agent on Hedera testnet</h3>
    <p>Your HashPack account becomes the guardian and approves four transactions. The local agent runtime performs the other steps with generated keys that stay on this machine; the browser only receives public keys.</p>
    <ol className="setup-steps">
      {STEPS.map((step,index)=>{
        const status=index<current||progress.stage==='done'?'done':index===current&&!state.running?'current':'todo';
        return <li key={step.label} className={`setup-step ${status}`}><span>{status==='done'?'✓':index+1}</span>{step.label}<small>{step.kind??(step.wallet?'HashPack approval':'Automatic')}</small></li>;
      })}
    </ol>
    {state.running&&<p role="status">{state.step||'Working'}… The policy deployment can take a few minutes.</p>}
    {state.lastError&&!state.running&&<p role="alert">Setup stopped: <code>{state.lastError}</code>. {state.lastError.includes('INSUFFICIENT')?'The setup account needs more HBAR; send some from the guardian account, then retry.':'Retry after checking the message.'} <button className="secondary" disabled={busy} onClick={()=>void perform(async()=>{setState(await api('/setup/advance',{method:'POST'}));})}>Retry</button></p>}
    {stage==='fund'&&<p>The guardian creates the setup account with <strong>{hbar(progress.fundingTinybars)} HBAR</strong>. It pays for the agent account, HCS records, policy deployment and ERC-8004 registration (about 30 HBAR); the rest stays in the setup account.</p>}
    {stage==='agreement'&&progress.agreement&&<div className="notice"><strong>Agreement to approve</strong><p>Scope: client-enforced technical policy, not a legal agreement. Asset {String(progress.agreement.terms.spendAsset)}; at most {String(progress.agreement.terms.maxPerTx)} per transaction and {String(progress.agreement.terms.maxPerDay)} per UTC day (raw units); policy {String(progress.agreement.terms.policyContract)}.</p><p>Hash <code>{progress.agreement.hash}</code>. Approving publishes these exact terms to the agent's HCS topic from your guardian account.</p></div>}
    {stage==='done'&&<p role="status">Setup complete: agent <a href={`https://hashscan.io/testnet/account/${progress.deployment?.agentAccount}`} target="_blank" rel="noreferrer">{progress.deployment?.agentAccount}</a>, ERC-8004 ID {progress.deployment?.erc8004AgentId}. Loading the live dashboard once the API has verified it…</p>}
    {pending&&<p>Waiting for <a href={`https://hashscan.io/testnet/transaction/${encodeURIComponent(pending.transactionId)}`} target="_blank" rel="noreferrer">{pending.stage} transaction</a> to reach the mirror. It will not be resubmitted.</p>}
    {!PROJECT_ID&&<p role="alert">Set <code>NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID</code> in <code>packages/nextjs/.env.local</code> and restart the dashboard to connect HashPack.</p>}
    <div className="create-agent-actions">
      {stage!=='done'&&(stage==='connect'
        ?<button className="secondary" disabled={busy||!PROJECT_ID} onClick={()=>void perform(connect)}>{account?`Use ${account} as guardian`:'Connect HashPack'}</button>
        :<button className="secondary" disabled={busy||!!account||!PROJECT_ID} onClick={()=>void perform(connect)}>{account?`Guardian ${account}`:'Connect HashPack'}</button>)}
      {account&&stage!=='done'&&<button className="secondary" disabled={busy} onClick={()=>void perform(disconnect)}>Disconnect</button>}
      {walletStage&&<button className="primary" disabled={busy||!account||!!pending||state.running} onClick={()=>void perform(()=>approve(walletStage))}>{{fund:'Fund setup account',topic:'Create HCS topic',allow:'Allow spend asset',agreement:'Approve agreement'}[walletStage]} in HashPack</button>}
    </div>
    {message&&<p role="status">{message}</p>}
    <p className="boundary-note">The policy's caps and pause are enforced by the supplied agent client, not by the account key. Setup uses about 30 HBAR in fees and account balances. Testnet only.</p>
  </div>;
}
