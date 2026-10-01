"use client";
import { VaultWallet } from './vault-wallet';
import { WALLETCONNECT_PROJECT_ID } from './wallet-config';
import { connectWallet, disconnectWallet, restoredAccounts, signerFor } from './wallet-session';
import { checkWalletTransaction, walletRejected } from './setup-actions';
import { useEffect, useState } from 'react';

type Deployment={agentAccount?:string;guardianId?:string;guardianPublicKey?:string;policyContractId?:string;hcsTopic?:string;guardianMode?:'local'|'wallet'};
type PendingEvent={action:'pause'|'unpause'|'revoke';transactionId:string;message:string;hcsTransactionId?:string;hcsSubmittedAt?:number};
const PROJECT_ID=WALLETCONNECT_PROJECT_ID;

/** All signatures are requested from the connected testnet guardian wallet in the browser. */
export function GuardianWallet({deployment,onConfirmed}:{deployment:Deployment;onConfirmed:()=>void}) {
  const [account,setAccount]=useState<string|null>(null);
  // Reattach a WalletConnect session this browser already holds for the configured guardian.
  useEffect(()=>{
    if(!PROJECT_ID || !deployment.guardianId) return;
    let active=true;
    void restoredAccounts().then(accounts=>{if(active && accounts.includes(deployment.guardianId!)) setAccount(deployment.guardianId!);});
    return ()=>{active=false;};
  },[deployment.guardianId]);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [pending,setPending]=useState<PendingEvent|null>(null);
  const pendingKey=`guardian-hcs-pending:${deployment.agentAccount??'unknown'}`;
  useEffect(()=>{
    try {
      const saved=sessionStorage.getItem(pendingKey);
      if(!saved) return;
      const record=JSON.parse(saved) as PendingEvent;
      if(['pause','unpause','revoke'].includes(record.action) && typeof record.transactionId==='string' && /^0\.0\.\d+@\d+\.\d{9}$/.test(record.transactionId) && typeof record.message==='string') setPending(record);
    } catch {sessionStorage.removeItem(pendingKey);}
  },[pendingKey]);
  function savePending(record:PendingEvent|null) {
    setPending(record);
    if(record) sessionStorage.setItem(pendingKey,JSON.stringify(record));
    else sessionStorage.removeItem(pendingKey);
  }
  async function connect() {
    if(!PROJECT_ID || !deployment.guardianId) throw new Error('WalletConnect project ID or guardian account is missing');
    const accounts=await connectWallet();
    if(!accounts.includes(deployment.guardianId)) throw new Error(`Connected ${accounts.join(', ')}; this deployment's guardian is ${deployment.guardianId}`);
    setAccount(deployment.guardianId);
  }
  async function disconnect() {
    await disconnectWallet();
    setAccount(null);
  }
  async function run(action:'pause'|'unpause'|'revoke') {
    if(!deployment.guardianId || !deployment.agentAccount || !deployment.policyContractId || !deployment.guardianPublicKey || !deployment.hcsTopic) throw new Error('Live deployment is incomplete');
    if(!account) throw new Error('Connect the guardian wallet first');
    const [{AccountUpdateTransaction,Client,ContractExecuteTransaction,Hbar,PublicKey,TransactionId},{Interface,getBytes}]=await Promise.all([import('@hiero-ledger/sdk'),import('ethers')]);
    const signer=await signerFor(deployment.guardianId);
    const client=Client.forTestnet();
    try {
      const tx=action==='revoke'
        ?new AccountUpdateTransaction().setAccountId(deployment.agentAccount).setKey(PublicKey.fromStringECDSA(deployment.guardianPublicKey))
        :new ContractExecuteTransaction().setContractId(deployment.policyContractId).setGas(300000).setFunctionParameters(getBytes(new Interface([`function ${action}()`]).encodeFunctionData(action)));
      tx.setTransactionId(TransactionId.generate(deployment.guardianId)).setMaxTransactionFee(new Hbar(3)).freezeWith(client);
      const response=await signer.call(tx);
      const transactionId=response.transactionId.toString();
      const mirrorId=transactionId.replace('@','-').replace(/\.(\d{9})$/,'-$1');
      let confirmed=false;
      for(let attempt=0;attempt<10;attempt++) {
        const receipt=await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${mirrorId}`);
        if(receipt.ok) {
          const rows=(await receipt.json() as {transactions:{nonce:number;result:string}[]}).transactions;
          const parent=rows.find(row=>row.nonce===0);
          if(parent){if(parent.result!=='SUCCESS') throw new Error(`Guardian transaction failed: ${parent.result}`);confirmed=true;break;}
        }
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
      if(!confirmed) throw new Error(`Submitted ${transactionId}; mirror confirmation is pending`);
      const event={v:1,type:action==='revoke'?'rotated':action==='pause'?'paused':'unpaused',ts:new Date().toISOString(),agentAccount:deployment.agentAccount,payload:action==='revoke'?{agentKeyActive:false,transactionId}:{transactionId}};
      const record={action,transactionId,message:JSON.stringify(event)};
      savePending(record);
      onConfirmed();
      try {await publishEvent(record,signer,client);} catch(error) {throw new Error(`Contract action confirmed: ${transactionId}. HCS record pending: ${error instanceof Error?error.message:'unknown error'}`);}
    } finally {client.close();}
  }
  async function publishEvent(record:PendingEvent,signer:Awaited<ReturnType<typeof signerFor>>,client:import('@hiero-ledger/sdk').Client) {
    if(!deployment.guardianId || !deployment.hcsTopic) throw new Error('Live deployment is incomplete');
    const mirrorId=(id:string)=>id.replace('@','-').replace(/\.(\d{9})$/,'-$1');
    const findRecord=async()=>{
      let path:string|null=`/api/v1/topics/${deployment.hcsTopic}/messages?order=desc&limit=100`;
      for(let page=0;path && page<20;page++) {
        const response:Response=await fetch(`https://testnet.mirrornode.hedera.com${path}`);
        if(!response.ok) throw new Error('HCS mirror unavailable');
        const body=await response.json() as {messages:{message:string;payer_account_id:string}[];links:{next:string|null}};
        for(const row of body.messages) {
          if(row.payer_account_id!==deployment.guardianId) continue;
          try {
            const bytes=Uint8Array.from(atob(row.message),char=>char.charCodeAt(0));
            const event=JSON.parse(new TextDecoder().decode(bytes)) as {type?:string;agentAccount?:string;payload?:{transactionId?:string}};
            const expectedType=record.action==='revoke'?'rotated':record.action==='pause'?'paused':'unpaused';
            if(event.type===expectedType && event.agentAccount===deployment.agentAccount && event.payload?.transactionId===record.transactionId) return true;
          } catch { /* Ignore unrelated non-JSON messages. */ }
        }
        path=body.links.next;
      }
      if(path) throw new Error('HCS history exceeds recovery scan limit');
      return false;
    };
    if(await findRecord()) {savePending(null);setMessage(`${record.action} and its HCS record are confirmed: ${record.transactionId}`);return;}
    if(record.hcsTransactionId) {
      // Reconcile the earlier HCS submission on the mirror before ever sending another.
      const outcome=await checkWalletTransaction(record.hcsTransactionId,record.hcsSubmittedAt??0);
      if(outcome==='success') throw new Error(`HCS transaction ${record.hcsTransactionId} succeeded; its topic message is not indexed yet. Click Check HCS record again shortly.`);
      if(outcome==='unknown') throw new Error(`HCS transaction ${record.hcsTransactionId} is not on the mirror yet. Check again in a minute; it will not be submitted twice.`);
      // It failed or expired without reaching Hedera, so a new submission cannot duplicate it.
      record={action:record.action,transactionId:record.transactionId,message:record.message};
      savePending(record);
    }
    const [{Hbar,TopicMessageSubmitTransaction,TransactionId},{HederaJsonRpcMethod,transactionToBase64String}]=await Promise.all([import('@hiero-ledger/sdk'),import('@hashgraph/hedera-wallet-connect')]);
    const hcs=new TopicMessageSubmitTransaction().setTopicId(deployment.hcsTopic).setMessage(record.message);
    const hcsId=TransactionId.generate(deployment.guardianId);
    hcs.setTransactionId(hcsId).setTransactionValidDuration(180).setMaxTransactionFee(new Hbar(3)).freezeWith(client);
    const hcsTransactionId=hcsId.toString();
    try {
      // DAppSigner.call() falls back to Query.fromBytes() after a wallet error, masking
      // TRANSACTION_EXPIRED with an unrelated getByKey decoder error.
      await signer.request({method:HederaJsonRpcMethod.SignAndExecuteTransaction,params:{signerAccountId:`hedera:testnet:${deployment.guardianId}`,transactionList:transactionToBase64String(hcs)}});
    } catch(error) {
      const detail=JSON.stringify(error);
      if(/"_code"\s*:\s*4\b/.test(detail)) throw new Error('HCS approval expired before submission. Click Retry HCS record and approve the new HashPack request within three minutes.');
      // A declined request was never signed, so it cannot reach Hedera.
      if(walletRejected(error)) throw new Error(`The HCS record was declined in HashPack; nothing was submitted. The ${record.action} itself is confirmed. Click Retry HCS record to publish it.`);
      // A transport error may occur after submission. Record the ID so retry
      // checks the mirror instead of sending an identical event twice.
      savePending({...record,hcsTransactionId,hcsSubmittedAt:Date.now()});
      throw new Error(`HashPack did not confirm the HCS record. Click Check HCS record: transaction ${hcsTransactionId} is checked on the mirror before anything is resubmitted.`);
    }
    savePending({...record,hcsTransactionId,hcsSubmittedAt:Date.now()});
    let confirmed=false;
    for(let attempt=0;attempt<10;attempt++) {
      const response=await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${mirrorId(hcsTransactionId)}`);
      if(response.ok) {
        const rows=(await response.json() as {transactions:{nonce:number;result:string}[]}).transactions;
        const parent=rows.find(row=>row.nonce===0);
        if(parent) {
          if(parent.result!=='SUCCESS') {savePending({action:record.action,transactionId:record.transactionId,message:record.message});throw new Error(`HCS transaction failed: ${parent.result}. Click Retry HCS record to publish it again.`);}
          confirmed=true;break;
        }
      }
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
    if(!confirmed) throw new Error(`HCS transaction ${hcsTransactionId} submitted; mirror confirmation is pending`);
    for(let attempt=0;attempt<10;attempt++) {
      if(await findRecord()) {savePending(null);setMessage(`${record.action} confirmed: ${record.transactionId}. HCS confirmed: ${hcsTransactionId}`);return;}
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
    throw new Error(`HCS transaction ${hcsTransactionId} succeeded but the topic message is not indexed yet`);
  }
  async function retryEvent() {
    if(!pending || !account || !deployment.guardianId) throw new Error('No pending guardian event');
    const {Client}=await import('@hiero-ledger/sdk');
    const client=Client.forTestnet();
    try {await publishEvent(pending,await signerFor(deployment.guardianId),client);} finally {client.close();}
  }
  async function perform(action:'connect'|'disconnect'|'pause'|'unpause'|'revoke'|'retry-hcs') {
    setBusy(true);setMessage('');
    try{if(action==='connect') await connect();else if(action==='disconnect') await disconnect();else if(action==='retry-hcs') await retryEvent();else await run(action);}catch(error){setMessage(error instanceof Error?error.message:'Wallet action failed');}finally{setBusy(false);}
  }
  return <><div className="notice">
    <strong>Guardian wallet</strong>
    <p>Testnet signing stays in your wallet. The connected account must be {deployment.guardianId??'the configured guardian'}.</p>
    {!PROJECT_ID?<p>Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in packages/nextjs/.env.local to enable wallet connection.</p>:<>
      <button className="secondary" disabled={busy||!!account} onClick={()=>void perform('connect')}>{account?`Connected ${account}`:'Connect wallet'}</button>
      {account&&<><button className="secondary" disabled={busy||!!pending} onClick={()=>void perform('pause')}>Pause</button><button className="secondary" disabled={busy||!!pending} onClick={()=>void perform('unpause')}>Unpause</button><button className="secondary" disabled title={deployment.guardianMode==='wallet'?'Removing the agent key is an Account Update, which HashPack does not sign over WalletConnect. The guardian key is only in HashPack, so it needs a wallet that supports Account Update.':'HashPack WalletConnect does not document Account Update support; use the isolated CLI'} onClick={()=>void perform('revoke')}>{deployment.guardianMode==='wallet'?'Revoke agent key (not supported by HashPack)':'Revoke agent key (CLI only)'}</button>{pending&&<button className="secondary" disabled={busy} onClick={()=>void perform('retry-hcs')}>{pending.hcsTransactionId?'Check HCS record':'Retry HCS record'}</button>}<button className="secondary" disabled={busy} onClick={()=>void perform('disconnect')}>Disconnect</button></>}
    </>}
    {message&&<p role="status">{message}</p>}
  </div>{deployment.guardianId && <VaultWallet guardianId={deployment.guardianId} account={account} getSigner={async()=>{if(!account)throw new Error('Connect guardian wallet');return signerFor(deployment.guardianId!);}} onConfirmed={onConfirmed}/>}</>;
}
