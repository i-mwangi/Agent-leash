import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress,ZeroAddress } from 'ethers';
import { z } from 'zod';
import { DATA } from './files';
import { AppError,entityId,address,evmAddress,type Deployment } from './model';
import { Mirror,exactUnits } from './mirror';
import { verifyVaultApproval,verifyVaultRules } from './vaultVerification';
import { vaultReadAbi,vaultReportSchema } from './vaultReport';

const recordSchema=z.object({
  context:z.object({network:z.literal('hedera:testnet'),agentAccount:entityId,guardianAccount:entityId}).strict(),
  terms:z.object({version:z.literal(1),asset:z.literal('HBAR'),maxPerTxTinybars:z.string(),maxPerUtcDayTinybars:z.string(),allowedRecipients:z.array(address)}).strict(),
  hash:z.string(),signature:z.string(),contractId:entityId,contractAddress:address,
}).strict();
export type VaultRecord=z.infer<typeof recordSchema>;
export function loadVaultRecord():VaultRecord|null {
  const path=resolve(DATA,'vault.json');
  return existsSync(path)?recordSchema.parse(JSON.parse(readFileSync(path,'utf8'))):null;
}

/** Read-only source shared by the attestor and buyer; never loads a spend key. */
export async function readVaultReport(d:Deployment,mirror:Mirror,record:VaultRecord|null=loadVaultRecord()) {
  if(!record) return null;
  const v=recordSchema.parse(record);
  if(!d.agentAccount || !d.guardianId) throw new AppError('VAULT_CONTEXT_MISSING');
  const day=BigInt(Math.floor(Date.now()/86_400_000));
  const methods=['guardian','agent','paused','maxPerTx','maxPerDay','agreementHash','recipients'] as const;
  const [values,guardianAccount,balance,spent]=await Promise.all([
    Promise.all(methods.map(method=>mirror.call(v.contractAddress,vaultReadAbi,method))),
    mirror.account(d.guardianId),mirror.account(v.contractId),mirror.call(v.contractAddress,vaultReadAbi,'spentByUtcDay',[day]),
  ]);
  const [guardian,agent,paused,perTx,perDay,hash,recipients]=values;
  if(guardianAccount.deleted || balance.deleted || getAddress(v.contractAddress)!==getAddress(evmAddress(v.contractId)) || getAddress(String(guardian[0]))!==getAddress(guardianAccount.evm_address)) throw new AppError('VAULT_POLICY_MISMATCH');
  verifyVaultApproval(v,{network:'hedera:testnet',agentAccount:d.agentAccount,guardianAccount:d.guardianId},guardianAccount.evm_address);
  const activeAgent=getAddress(String(agent[0]));
  if(activeAgent!==ZeroAddress && activeAgent!==getAddress(evmAddress(d.agentAccount))) throw new AppError('VAULT_AGENT_MISMATCH');
  const allowedRecipients=Array.from(recipients[0] as string[]).map(getAddress);
  verifyVaultRules(v.terms,v.hash,{hash:String(hash[0]),maxPerTx:BigInt(perTx[0]),maxPerDay:BigInt(perDay[0]),recipients:allowedRecipients});
  if(day!==BigInt(Math.floor(Date.now()/86_400_000))) throw new AppError('VAULT_DAY_CHANGED_RETRY');
  return vaultReportSchema.parse({contractId:v.contractId,contractAddress:getAddress(v.contractAddress),guardian:getAddress(String(guardian[0])),agent:activeAgent,paused:Boolean(paused[0]),termsHash:v.hash,maxPerTxTinybars:BigInt(perTx[0]).toString(),maxPerUtcDayTinybars:BigInt(perDay[0]).toString(),allowedRecipients,balanceTinybars:exactUnits(balance.balance.balance).toString(),spentTodayTinybars:BigInt(spent[0]).toString(),utcDay:day.toString()});
}
