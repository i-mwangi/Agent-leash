"use client";
import { useEffect,useState } from 'react';
import { formatUnits,ZeroAddress } from 'ethers';
import { vaultReportSchema,type VaultReport } from '../../shared/src/vaultReport';
import { confirmVaultTransaction,planVaultAction,type VaultAction,type VaultRequest } from './vault-wallet-actions';

type Pending={request:VaultRequest;transactionId:string};
type Signer=ReturnType<import('@hashgraph/hedera-wallet-connect').DAppConnector['getSigner']>;
export function VaultWallet({guardianId,account,getSigner,onConfirmed}:{guardianId:string;account:string|null;getSigner:()=>Promise<Signer>;onConfirmed:()=>void}) {
  const [vault,setVault]=useState<VaultReport|null>(null);
  const [error,setError]=useState('');
  const [loaded,setLoaded]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [pending,setPending]=useState<Pending|null>(null);
  const storageKey=`vault-wallet-pending:${guardianId}`;
  useEffect(()=>{
    try{const value=sessionStorage.getItem(storageKey);if(value)setPending(JSON.parse(value) as Pending);}catch{setError('Could not restore pending vault transaction');}
  },[storageKey]);
  function savePending(value:Pending|null) {setPending(value);if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}
  async function read() {
    const response=await fetch('/api/vault/status',{cache:'no-store',signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw new Error('Vault verification unavailable. No new action can be signed.');
    const body=await response.json();
    return body.vault===null?null:vaultReportSchema.parse(body.vault);
  }
  useEffect(()=>{
    let active=true,generation=0;
    const refresh=async()=>{
      const revision=++generation;setVault(null);setLoaded(false);
      try{const value=await read();if(active && revision===generation){setVault(value);setError('');setLoaded(true);}}
      catch(e){if(active && revision===generation)setError(e instanceof Error?e.message:'Vault unavailable');}
    };
    void refresh();const timer=setInterval(()=>void refresh(),30000);
    return ()=>{active=false;++generation;clearInterval(timer);};
  },[]);
  async function check(record:Pending) {
    for(let attempt=0;attempt<10;attempt++) {
      if(await confirmVaultTransaction(record.request,record.transactionId)) {
        savePending(null);setMessage(`Vault ${record.request.action} confirmed: ${record.transactionId}`);
        setVault(null);onConfirmed();setVault(await read());return;
      }
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
    setMessage(`Submitted ${record.transactionId}. Mirror confirmation is pending; use Check transaction.`);
  }
  async function perform(action:VaultAction|'check') {
    setBusy(true);setMessage('');
    try {
      if(action==='check'){if(pending)await check(pending);return;}
      if(pending)throw new Error('Check the pending transaction before another action');
      const fresh=await read();if(!fresh || !account)throw new Error('Connect the guardian wallet to a verified vault');
      const request=planVaultAction(fresh,action,guardianId,account);
      const signer=await getSigner();
      const [{Client,ContractExecuteTransaction,Hbar,TransactionId},{getBytes},{HederaJsonRpcMethod,transactionToBase64String}]=await Promise.all([import('@hiero-ledger/sdk'),import('ethers'),import('@hashgraph/hedera-wallet-connect')]);
      const client=Client.forTestnet();
      try {
        const id=TransactionId.generate(guardianId);
        const tx=new ContractExecuteTransaction().setContractId(request.contractId).setGas(action==='recover'?400000:300000).setFunctionParameters(getBytes(request.data)).setTransactionId(id).setTransactionValidDuration(180).setMaxTransactionFee(new Hbar(3)).freezeWith(client);
        const record={request,transactionId:id.toString()};
        savePending(record);
        try{await signer.request({method:HederaJsonRpcMethod.SignAndExecuteTransaction,params:{signerAccountId:`hedera:testnet:${guardianId}`,transactionList:transactionToBase64String(tx)}});}
        catch{throw new Error(`Wallet request was not confirmed. Check transaction ${record.transactionId} before retrying; do not submit it twice.`);}
        await check(record);
      } finally{client.close();}
    }catch(e){setMessage(e instanceof Error?e.message:'Vault action failed');}
    finally{setBusy(false);}
  }
  return <section className="panel detail compact"><h3>Contract-controlled HBAR vault</h3>
    <p>These controls apply only to deposited vault HBAR. Recovery sends its entire balance to the guardian.</p>
    {error?<p role="alert">{error}</p>:!loaded?<p>Reading verified vault state...</p>:!vault?<p>No optional vault configured. Deploy one with the CLI, then restart the testnet API.</p>:<>
      <p><a href={`https://hashscan.io/testnet/contract/${vault.contractId}`} target="_blank" rel="noreferrer">Vault {vault.contractId}</a> · {vault.paused?'Paused':'Unpaused'} · Agent {vault.agent===ZeroAddress?'revoked':'active'}</p>
      <p>Balance: {formatUnits(vault.balanceTinybars,8)} HBAR · Per transaction: {formatUnits(vault.maxPerTxTinybars,8)} HBAR · UTC day: {formatUnits(vault.spentTodayTinybars,8)} / {formatUnits(vault.maxPerUtcDayTinybars,8)} HBAR</p>
      <p>Approved recipients: {vault.allowedRecipients.join(', ')}</p><p>Signed terms hash: <code>{vault.termsHash}</code></p>
      <div className="notice">{(['pause','unpause','revoke','recover'] as const).map(action=><button key={action} className="secondary" disabled={busy||!!pending||!account||(action==='pause'&&vault.paused)||(action==='unpause'&&!vault.paused)||(action==='revoke'&&vault.agent===ZeroAddress)||(action==='recover'&&(!vault.paused||BigInt(vault.balanceTinybars)===0n))} onClick={()=>void perform(action)}>{action==='revoke'?'Revoke vault agent':action==='recover'?'Recover all HBAR to guardian':action==='pause'?'Pause vault':'Unpause vault'}</button>)}</div>
    </>}
    {pending&&<p><button className="secondary" disabled={busy} onClick={()=>void perform('check')}>Check transaction</button> <a href={`https://hashscan.io/testnet/transaction/${encodeURIComponent(pending.transactionId)}`} target="_blank" rel="noreferrer">Pending transaction</a>. If rejected or failed, reconcile this ID before clearing the browser session.</p>}
    {message&&<p role="status">{message}</p>}
  </section>;
}
