"use client";
import { useRef, useState } from 'react';

type Deployment={agentAccount?:string;guardianId?:string;guardianPublicKey?:string;policyContractId?:string;hcsTopic?:string};
type WalletConnector=import('@hashgraph/hedera-wallet-connect').DAppConnector;
const PROJECT_ID=process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

/** All signatures are requested from the connected testnet guardian wallet in the browser. */
export function GuardianWallet({deployment,onConfirmed}:{deployment:Deployment;onConfirmed:()=>void}) {
  const connector=useRef<WalletConnector|null>(null);
  const [account,setAccount]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  async function connect() {
    if(!PROJECT_ID || !deployment.guardianId) throw new Error('WalletConnect project ID or guardian account is missing');
    const [{DAppConnector,HederaJsonRpcMethod,HederaSessionEvent,HederaChainId},{LedgerId,AccountId}]=await Promise.all([import('@hashgraph/hedera-wallet-connect'),import('@hiero-ledger/sdk')]);
    const instance=new DAppConnector({name:'Accountable Agent',description:'Guardian controls for Hedera testnet',url:window.location.origin,icons:[`${window.location.origin}/favicon.ico`]},LedgerId.TESTNET,PROJECT_ID,Object.values(HederaJsonRpcMethod),[HederaSessionEvent.AccountsChanged,HederaSessionEvent.ChainChanged],[HederaChainId.Testnet]);
    await instance.init({logger:'error'});
    await instance.openModal();
    instance.getSigner(AccountId.fromString(deployment.guardianId));
    connector.current=instance;setAccount(deployment.guardianId);
  }
  async function run(action:'pause'|'unpause'|'revoke') {
    if(!deployment.guardianId || !deployment.agentAccount || !deployment.policyContractId || !deployment.guardianPublicKey || !deployment.hcsTopic) throw new Error('Live deployment is incomplete');
    const instance=connector.current;if(!instance) throw new Error('Connect the guardian wallet first');
    const [{AccountId,AccountUpdateTransaction,Client,ContractExecuteTransaction,Hbar,PublicKey,TopicMessageSubmitTransaction,TransactionId},{Interface,getBytes}]=await Promise.all([import('@hiero-ledger/sdk'),import('ethers')]);
    const signer=instance.getSigner(AccountId.fromString(deployment.guardianId));
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
      const hcs=new TopicMessageSubmitTransaction().setTopicId(deployment.hcsTopic).setMessage(JSON.stringify(event));
      hcs.setTransactionId(TransactionId.generate(deployment.guardianId)).setMaxTransactionFee(new Hbar(3)).freezeWith(client);
      const hcsResponse=await signer.call(hcs);
      setMessage(`${action} confirmed: ${transactionId}. HCS: ${hcsResponse.transactionId.toString()}`);
      onConfirmed();
    } finally {client.close();}
  }
  async function perform(action:'connect'|'pause'|'unpause'|'revoke') {
    setBusy(true);setMessage('');
    try{if(action==='connect') await connect();else await run(action);}catch(error){setMessage(error instanceof Error?error.message:'Wallet action failed');}finally{setBusy(false);}
  }
  return <div className="notice">
    <strong>Connected guardian wallet</strong>
    <p>Testnet signing stays in your wallet. The connected account must be {deployment.guardianId??'the configured guardian'}.</p>
    {!PROJECT_ID?<p>Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in packages/nextjs/.env.local to enable wallet connection.</p>:<>
      <button className="secondary" disabled={busy} onClick={()=>void perform('connect')}>{account?`Connected ${account}`:'Connect wallet'}</button>
      {account&&<><button className="secondary" disabled={busy} onClick={()=>void perform('pause')}>Pause</button><button className="secondary" disabled={busy} onClick={()=>void perform('unpause')}>Unpause</button><button className="secondary" disabled={busy} onClick={()=>void perform('revoke')}>Revoke agent key</button></>}
    </>}
    {message&&<p role="status">{message}</p>}
  </div>;
}
