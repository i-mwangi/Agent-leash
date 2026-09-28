import { ContractCreateTransaction, ContractExecuteTransaction, FileAppendTransaction, FileCreateTransaction, Hbar, TransferTransaction } from '@hiero-ledger/sdk';
import { AbiCoder, Interface, Wallet, getBytes, keccak256, isError } from 'ethers';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DATA, ROOT, atomicJson, readDeployment } from '../../shared/src/files';
import { AppError, evmAddress } from '../../shared/src/model';
import { Mirror } from '../../shared/src/mirror';
import { Store } from '../../shared/src/store';
import { accountKeyState } from '../../shared/src/keys';
import { compileVaultTerms, vaultTermsHash } from '../../shared/src/vaultTerms';
import { verifyVaultApproval, verifyVaultRules } from '../../shared/src/vaultVerification';
import { clientFor, nativeOperation, roleKey } from './runtime';

const DRAFT=resolve(DATA,'vault-terms-draft.json');
const APPROVED=resolve(DATA,'vault-terms-approved.json');
const STATE=resolve(DATA,'vault.json');
const vaultAbi=new Interface(['function guardian() view returns(address)','function agent() view returns(address)','function paused() view returns(bool)','function maxPerTx() view returns(uint256)','function maxPerDay() view returns(uint256)','function agreementHash() view returns(bytes32)','function allowedRecipients(address) view returns(bool)','function spentByUtcDay(uint256) view returns(uint256)','function recipients() view returns(address[])','function setPaused(bool)','function setAgent(address)','function recover(address)','function spend(address,uint256)']);
const draftSchema=z.object({context:z.object({network:z.literal('hedera:testnet'),agentAccount:z.string(),guardianAccount:z.string()}),terms:z.object({version:z.literal(1),asset:z.literal('HBAR'),maxPerTxTinybars:z.string(),maxPerUtcDayTinybars:z.string(),allowedRecipients:z.array(z.string())}),hash:z.string()});
const approvedSchema=draftSchema.extend({signature:z.string()});
const stateSchema=approvedSchema.extend({contractId:z.string(),contractAddress:z.string()});

function reviewedDraft() {
  if(!existsSync(DRAFT)) throw new AppError('VAULT_DRAFT_MISSING');
  const draft=draftSchema.parse(JSON.parse(readFileSync(DRAFT,'utf8')));
  const canonical=compileVaultTerms(`No more than ${formatHbar(BigInt(draft.terms.maxPerTxTinybars))} HBAR per transaction and ${formatHbar(BigInt(draft.terms.maxPerUtcDayTinybars))} HBAR per UTC day; only to ${draft.terms.allowedRecipients.join(', ')}.`);
  const d=deployment();
  if(draft.context.agentAccount!==d.agentAccount || draft.context.guardianAccount!==d.guardianId || JSON.stringify(canonical)!==JSON.stringify(draft.terms) || vaultTermsHash(canonical,draft.context)!==draft.hash) throw new AppError('VAULT_DRAFT_INVALID');
  return {context:draft.context,terms:canonical,hash:draft.hash};
}
function formatHbar(tinybars:bigint) {
  const whole=tinybars/100_000_000n, fraction=(tinybars%100_000_000n).toString().padStart(8,'0').replace(/0+$/,'');
  return fraction?`${whole}.${fraction}`:whole.toString();
}
function deployment() {
  const d=readDeployment();
  if(!d?.agentAccount || !d.guardianId || !d.hcsTopic || !d.policyAddress || !d.erc8004AgentId) throw new AppError('SETUP_REQUIRED');
  return d;
}
function approvedRecord() {
  if(!existsSync(APPROVED)) throw new AppError('VAULT_APPROVAL_MISSING');
  const approved=approvedSchema.parse(JSON.parse(readFileSync(APPROVED,'utf8')));
  const current=reviewedDraft();
  if(approved.hash!==current.hash || JSON.stringify(approved.terms)!==JSON.stringify(current.terms) || JSON.stringify(approved.context)!==JSON.stringify(current.context)) throw new AppError('VAULT_APPROVAL_STALE');
  return approved;
}

export async function approveVaultTerms() {
  const d=deployment(),draft=reviewedDraft();
  const guardianKey=roleKey('guardian');
  if(guardianKey.publicKey.toStringRaw()!==d.guardianPublicKey) throw new AppError('GUARDIAN_KEY_MISMATCH');
  const guardian=await new Mirror().account(d.guardianId!);
  const wallet=new Wallet('0x'+guardianKey.toStringRaw());
  if(wallet.address.toLowerCase()!==guardian.evm_address.toLowerCase()) throw new AppError('GUARDIAN_ACCOUNT_KEY_MISMATCH');
  const signature=await wallet.signMessage(getBytes(draft.hash));
  atomicJson(APPROVED,{...draft,signature});
  return {approved:APPROVED,hash:draft.hash,note:'Guardian signed the technical terms; no funds have moved.'};
}

export async function deployVault() {
  const d=deployment(),approved=approvedRecord(),mirror=new Mirror();
  if(existsSync(STATE)) return vaultStatus();
  const guardian=await mirror.account(d.guardianId!);
  const expected=new Wallet('0x'+roleKey('guardian').toStringRaw());
  if(expected.address.toLowerCase()!==guardian.evm_address.toLowerCase()) throw new AppError('GUARDIAN_ACCOUNT_KEY_MISMATCH');
  const {verifyMessage}=await import('ethers');
  if(verifyMessage(getBytes(approved.hash),approved.signature).toLowerCase()!==expected.address.toLowerCase()) throw new AppError('VAULT_APPROVAL_INVALID');
  const artifact=JSON.parse(readFileSync(resolve(ROOT,'packages/contracts/artifacts/contracts/GuardedHbarVault.sol/GuardedHbarVault.json'),'utf8')) as {bytecode:string};
  const bytecode=artifact.bytecode.replace(/^0x/,'');
  const operation=`vault-${approved.hash.slice(2,10)}-${keccak256(getBytes('0x'+bytecode)).slice(2,10)}`;
  const store=new Store(resolve(DATA,'operator.sqlite'));
  const client=clientFor(d.operatorId,roleKey('operator'));
  try{return await store.exclusive('vault-deploy',async()=>{
    const file=await nativeOperation(`${operation}-file`,new FileCreateTransaction().setKeys([roleKey('operator').publicKey]).setContents(bytecode.slice(0,2048)),client,store);
    for(let offset=2048;offset<bytecode.length;offset+=2048) await nativeOperation(`${operation}-bytecode-${offset}`,new FileAppendTransaction().setFileId(file.fileId!).setContents(bytecode.slice(offset,offset+2048)),client,store);
    const constructor=AbiCoder.defaultAbiCoder().encode(['address','address','uint256','uint256','bytes32','address[]'],[guardian.evm_address,evmAddress(d.agentAccount!),BigInt(approved.terms.maxPerTxTinybars),BigInt(approved.terms.maxPerUtcDayTinybars),approved.hash,approved.terms.allowedRecipients]);
    const deployed=await nativeOperation(`${operation}-create`,new ContractCreateTransaction().setBytecodeFileId(file.fileId!).setGas(1_800_000).setConstructorParameters(getBytes(constructor)),client,store);
    const contractId=deployed.contractId!;
    atomicJson(STATE,{...approved,contractId,contractAddress:evmAddress(contractId)});
    return vaultStatus();
  });}finally{client.close();store.close();}
}

function savedVault() {
  if(!existsSync(STATE)) throw new AppError('VAULT_NOT_DEPLOYED');
  return stateSchema.parse(JSON.parse(readFileSync(STATE,'utf8')));
}
export async function vaultStatus() { return readVaultState(true); }
async function readVaultState(verifyTerms:boolean) {
  const d=deployment(),v=savedVault(),mirror=new Mirror();
  const [guardian,agent,paused,perTx,perDay,hash,guardianAccount]=await Promise.all([
    mirror.call(v.contractAddress,vaultAbi,'guardian'),mirror.call(v.contractAddress,vaultAbi,'agent'),mirror.call(v.contractAddress,vaultAbi,'paused'),
    mirror.call(v.contractAddress,vaultAbi,'maxPerTx'),mirror.call(v.contractAddress,vaultAbi,'maxPerDay'),mirror.call(v.contractAddress,vaultAbi,'agreementHash'),mirror.account(d.guardianId!),
  ]);
  if(v.contractAddress.toLowerCase()!==evmAddress(v.contractId).toLowerCase() || String(guardian[0]).toLowerCase()!==guardianAccount.evm_address.toLowerCase()) throw new AppError('VAULT_POLICY_MISMATCH');
  verifyVaultApproval(v,{network:'hedera:testnet',agentAccount:d.agentAccount!,guardianAccount:d.guardianId!},guardianAccount.evm_address);
  if(verifyTerms) {
    if(!['0x0000000000000000000000000000000000000000',evmAddress(d.agentAccount!).toLowerCase()].includes(String(agent[0]).toLowerCase())) throw new AppError('VAULT_AGENT_MISMATCH');
    let recipients:string[];
    try { recipients=Array.from((await mirror.call(v.contractAddress,vaultAbi,'recipients'))[0] as string[]); }
    catch(error) {
      if(error instanceof AppError && error.code==='CONTRACT_REVERT' || isError(error,'BAD_DATA')) throw new AppError('VAULT_LEGACY_REDEPLOY_REQUIRED');
      throw error;
    }
    verifyVaultRules(v.terms,v.hash,{hash:String(hash[0]),maxPerTx:BigInt(perTx[0]),maxPerDay:BigInt(perDay[0]),recipients});
  }
  return {termsVerified:verifyTerms,contractId:v.contractId,contractAddress:v.contractAddress,hash:v.hash,agent:String(agent[0]),paused:Boolean(paused[0]),terms:v.terms,hashscan:`https://hashscan.io/testnet/contract/${v.contractId}`};
}

/** Compatibility command: new vaults install the complete immutable list at deployment. */
export async function allowVaultRecipients() {
  const status=await vaultStatus();
  return {contractId:status.contractId,termsVerified:true,recipients:status.terms.allowedRecipients,transactions:[]};
}

export async function guardianVaultAction(action:'pause'|'unpause'|'revoke') {
  const d=deployment(),v=savedVault();
  const status=await readVaultState(false);
  if(action==='revoke' && status.agent.toLowerCase()==='0x0000000000000000000000000000000000000000') return status;
  if(action==='pause' && status.paused || action==='unpause' && !status.paused) return status;
  const key=roleKey('guardian');
  if(key.publicKey.toStringRaw()!==d.guardianPublicKey) throw new AppError('GUARDIAN_KEY_MISMATCH');
  const method=action==='revoke'?'setAgent':'setPaused';
  const arg=action==='revoke'?'0x0000000000000000000000000000000000000000':action==='pause';
  const store=new Store(resolve(DATA,'guardian.sqlite'));
  const client=clientFor(d.guardianId!,key);
  try{return await store.exclusive('vault-guardian',async()=>{
    const result=await nativeOperation(`vault-${action}-${Date.now()}`,new ContractExecuteTransaction().setContractId(v.contractId).setGas(300_000).setFunctionParameters(getBytes(vaultAbi.encodeFunctionData(method,[arg]))),client,store);
    return {transactionId:result.txId,status:await readVaultState(false)};
  });}finally{client.close();store.close();}
}

export async function recoverVault() {
  const d=deployment(),v=savedVault();
  const status=await readVaultState(false);
  if(!status.paused) throw new AppError('VAULT_MUST_BE_PAUSED');
  const key=roleKey('guardian');
  if(key.publicKey.toStringRaw()!==d.guardianPublicKey) throw new AppError('GUARDIAN_KEY_MISMATCH');
  const recipient=(await new Mirror().account(d.guardianId!)).evm_address;
  const store=new Store(resolve(DATA,'guardian.sqlite'));
  const client=clientFor(d.guardianId!,key);
  try{return await store.exclusive('vault-recover',async()=>nativeOperation(`vault-recover-${Date.now()}`,new ContractExecuteTransaction().setContractId(v.contractId).setGas(400_000).setFunctionParameters(getBytes(vaultAbi.encodeFunctionData('recover',[recipient]))),client,store));}
  finally{client.close();store.close();}
}

export async function fundVault(tinybars:bigint) {
  if(tinybars<=0n || tinybars>100_000_000n) throw new AppError('VAULT_FUND_LIMIT');
  const d=deployment(),v=savedVault();
  await vaultStatus();
  const store=new Store(resolve(DATA,'operator.sqlite'));
  const client=clientFor(d.operatorId,roleKey('operator'));
  try{return await store.exclusive('vault-fund',async()=>nativeOperation(`vault-fund-${Date.now()}`,new TransferTransaction().addHbarTransfer(d.operatorId,Hbar.fromTinybars((-tinybars).toString())).addHbarTransfer(v.contractId,Hbar.fromTinybars(tinybars.toString())),client,store));}
  finally{client.close();store.close();}
}

export async function vaultSpend(recipient:string,tinybars:bigint) {
  const d=deployment(),v=savedVault(),mirror=new Mirror();
  const address=recipient.toLowerCase();
  if(!v.terms.allowedRecipients.some(value=>value.toLowerCase()===address)) throw new AppError('VAULT_RECIPIENT_DENIED');
  if(tinybars<=0n || tinybars>BigInt(v.terms.maxPerTxTinybars)) throw new AppError('VAULT_TX_CAP');
  const key=roleKey('agent');
  if(key.publicKey.toStringRaw()!==d.agentPublicKey) throw new AppError('AGENT_KEY_MISMATCH');
  const store=new Store(resolve(DATA,'agent.sqlite'));
  const client=clientFor(d.agentAccount!,key);
  try{return await store.exclusive('vault-spend',async()=>{
    await vaultStatus();
    // Read authoritative sources immediately before signing. The vault enforces these again on-chain.
    const [account,guardianAccount,guardian,agent,paused,allowed,perTx,perDay,hash,balance]=await Promise.all([
      mirror.account(d.agentAccount!),mirror.account(d.guardianId!),mirror.call(v.contractAddress,vaultAbi,'guardian'),mirror.call(v.contractAddress,vaultAbi,'agent'),mirror.call(v.contractAddress,vaultAbi,'paused'),mirror.call(v.contractAddress,vaultAbi,'allowedRecipients',[recipient]),
      mirror.call(v.contractAddress,vaultAbi,'maxPerTx'),mirror.call(v.contractAddress,vaultAbi,'maxPerDay'),mirror.call(v.contractAddress,vaultAbi,'agreementHash'),mirror.account(v.contractId),
    ]);
    if(!accountKeyState(account.key,d.agentPublicKey,d.guardianPublicKey).agentKeyActive) throw new AppError('AGENT_KEY_INACTIVE');
    if(String(guardian[0]).toLowerCase()!==guardianAccount.evm_address.toLowerCase() || String(agent[0]).toLowerCase()!==evmAddress(d.agentAccount!).toLowerCase() || paused[0] || !allowed[0] || String(hash[0]).toLowerCase()!==v.hash.toLowerCase()) throw new AppError('VAULT_POLICY_DENIED');
    if(tinybars>BigInt(perTx[0]) || tinybars>BigInt(v.terms.maxPerTxTinybars)) throw new AppError('VAULT_TX_CAP');
    const day=BigInt(Math.floor(Date.now()/86_400_000));
    const used=BigInt((await mirror.call(v.contractAddress,vaultAbi,'spentByUtcDay',[day]))[0]);
    if(used+tinybars>BigInt(perDay[0]) || used+tinybars>BigInt(v.terms.maxPerUtcDayTinybars)) throw new AppError('VAULT_DAY_CAP');
    if(!Number.isSafeInteger(balance.balance.balance) || BigInt(balance.balance.balance)<tinybars) throw new AppError('VAULT_BALANCE_LOW');
    return nativeOperation(`vault-spend-${Date.now()}`,new ContractExecuteTransaction().setContractId(v.contractId).setGas(400_000).setFunctionParameters(getBytes(vaultAbi.encodeFunctionData('spend',[recipient,tinybars]))),client,store);
  });}finally{client.close();store.close();}
}
