"use client";
import { WALLETCONNECT_PROJECT_ID } from './wallet-config';

type Connector=import('@hashgraph/hedera-wallet-connect').DAppConnector;
let connector:Promise<Connector>|null=null;

/**
 * One WalletConnect connector for the whole dashboard. init() restores sessions that
 * WalletConnect persisted in this browser, so a page refresh keeps the wallet connected.
 */
export function walletConnector():Promise<Connector> {
  connector??=(async()=>{
    if(!WALLETCONNECT_PROJECT_ID) throw new Error('Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in packages/nextjs/.env.local and restart the dashboard');
    const [{DAppConnector,HederaJsonRpcMethod,HederaSessionEvent,HederaChainId},{LedgerId}]=await Promise.all([import('@hashgraph/hedera-wallet-connect'),import('@hiero-ledger/sdk')]);
    const instance=new DAppConnector({name:'Accountable Agent',description:'Set up and control a guardian-controlled Hedera testnet agent',url:window.location.origin,icons:[`${window.location.origin}/icon.svg`]},LedgerId.TESTNET,WALLETCONNECT_PROJECT_ID,Object.values(HederaJsonRpcMethod),[HederaSessionEvent.AccountsChanged,HederaSessionEvent.ChainChanged],[HederaChainId.Testnet]);
    await instance.init({logger:'error'});
    return instance;
  })().catch(error=>{connector=null;throw error;});
  return connector;
}

/** Testnet accounts from a session this browser already has; never opens the wallet modal. */
export async function restoredAccounts():Promise<string[]> {
  try{return (await walletConnector()).signers.map(signer=>signer.getAccountId().toString());}
  catch{return [];}
}

/** Reuse a restored session, or open the pairing modal when there is none. */
export async function connectWallet():Promise<string[]> {
  const instance=await walletConnector();
  if(!instance.signers.length) await instance.openModal();
  const accounts=instance.signers.map(signer=>signer.getAccountId().toString());
  if(!accounts.length) throw new Error('The wallet did not expose a testnet account');
  return accounts;
}

export async function signerFor(account:string) {
  const [{AccountId},instance]=await Promise.all([import('@hiero-ledger/sdk'),walletConnector()]);
  return instance.getSigner(AccountId.fromString(account));
}

/** End every WalletConnect session for this dashboard, in the browser and the wallet. */
export async function disconnectWallet() {
  const instance=await walletConnector();
  await instance.disconnectAll().catch(()=>undefined);
}
