import { Client, ContractCreateTransaction, Hbar, PrivateKey, Transaction, TransactionId } from '@hiero-ledger/sdk';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { DATA, ROOT, atomicJson } from '../../shared/src/files';
import { privateKey, rawDigestSigner } from '../../shared/src/keys';
import { AppError } from '../../shared/src/model';
import { Mirror, mirrorTxId } from '../../shared/src/mirror';
import { Store } from '../../shared/src/store';
export function roleEnv(role:'operator'|'guardian'|'agent'|'server') {
  const path=resolve(ROOT,`.env.${role}`);
  if(!existsSync(path)) throw new AppError(`MISSING_${role.toUpperCase()}_ENV`);
  return parse(readFileSync(path));
}
export function roleKey(role:'operator'|'guardian'|'agent') {
  const env=roleEnv(role); const name=role==='operator'?'HEDERA_OPERATOR_KEY':`${role.toUpperCase()}_PRIVATE_KEY`;
  if(!env[name]) throw new AppError(`MISSING_${name}`);
  return privateKey(env[name]);
}
export function clientFor(account:string,key:PrivateKey) {
  return Client.forTestnet().setOperator(account,key).setDefaultMaxTransactionFee(new Hbar(3)).setMaxQueryPayment(new Hbar(1));
}
export interface OperationResult {txId:string;accountId?:string;topicId?:string;contractId?:string;fileId?:string;returnData?:string}
export async function nativeOperation(name:string,tx:Transaction,client:ReturnType<typeof clientFor>,store:Store,additional:PrivateKey[]=[],getReturn=false,beforeSend?:(txId:string)=>void):Promise<OperationResult> {
  const old=store.operation(name);
  if(old?.result) return JSON.parse(old.result);
  if(old) {
    const prior=await new Mirror().transaction(old.tx_id).catch(()=>null);
    if(!prior) throw new AppError(`RECONCILIATION_REQUIRED:${name}:${old.tx_id}`);
    if(prior.result==='SUCCESS') throw new AppError(`RECONCILIATION_REQUIRED:${name}:${old.tx_id}`);
    store.removeOperation(name,old.tx_id);
  }
  tx.setTransactionId(TransactionId.generate(client.operatorAccountId!));
  tx.setMaxTransactionFee(new Hbar(tx instanceof ContractCreateTransaction?30:3)); tx.freezeWith(client);
  for(const key of additional) await tx.signWith(key.publicKey,rawDigestSigner(key));
  const txId=tx.transactionId!.toString();
  store.beginOperation(name,txId); // Persist before sending; a crash must never cause a second account/payment.
  beforeSend?.(txId);
  const response=await tx.execute(client);
  const receipt=await response.getReceipt(client);
  if(receipt.status.toString()!=='SUCCESS') throw new AppError('TRANSACTION_FAILED');
  const result:OperationResult={txId,accountId:receipt.accountId?.toString(),topicId:receipt.topicId?.toString(),contractId:receipt.contractId?.toString(),fileId:receipt.fileId?.toString()};
  store.endOperation(name,result);
  if(getReturn) {
    const record=await response.getRecord(client);
    result.returnData=record.contractFunctionResult ? '0x'+Buffer.from(record.contractFunctionResult.bytes).toString('hex') : undefined;
    store.endOperation(name,result);
  }
  await new Mirror().waitTransaction(txId);
  writeEvidence(name,txId);
  console.error(`${name}: https://hashscan.io/testnet/transaction/${encodeURIComponent(txId)}`);
  return result;
}
export function writeEvidence(action:string,txId:string) {
  const path=resolve(DATA,'evidence.json');
  const rows:Record<string,unknown>[]=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];
  if(!rows.some(r=>r.transactionId===txId)) rows.push({action,network:'testnet',transactionId:txId,hashscan:`https://hashscan.io/testnet/transaction/${encodeURIComponent(txId)}`,mirror:`https://testnet.mirrornode.hedera.com/api/v1/transactions/${mirrorTxId(txId)}`,verifiedAt:new Date().toISOString()});
  atomicJson(path,rows);
}
export function createSecretFile(role:string,contents:string) {
  writeFileSync(resolve(ROOT,`.env.${role}`),contents,{flag:'wx',mode:0o600});
}
