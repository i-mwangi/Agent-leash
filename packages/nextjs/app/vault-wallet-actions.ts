import { getAddress,Interface,ZeroAddress } from 'ethers';
import { evmAddress } from '../../shared/src/model';
import type { VaultReport } from '../../shared/src/vaultReport';

export type VaultAction='pause'|'unpause'|'revoke'|'recover';
export type VaultRequest={action:VaultAction;contractId:string;contractAddress:string;guardianId:string;data:string};
const abi=new Interface(['function setPaused(bool)','function setAgent(address)','function recover(address)']);
export function planVaultAction(v:VaultReport,action:VaultAction,guardianId:string,connectedAccount:string):VaultRequest {
  if(connectedAccount!==guardianId) throw new Error('Connect the configured guardian account');
  if(getAddress(v.contractAddress)!==getAddress(evmAddress(v.contractId))) throw new Error('Vault address mismatch');
  if(action==='recover' && !v.paused) throw new Error('Pause the vault before recovery');
  if(action==='recover' && BigInt(v.balanceTinybars)===0n) throw new Error('The vault is empty');
  if(action==='revoke' && v.agent===ZeroAddress) throw new Error('Vault agent already revoked');
  if(action==='pause' && v.paused || action==='unpause' && !v.paused) throw new Error('Vault is already in that state');
  const method=action==='revoke'?'setAgent':action==='recover'?'recover':'setPaused';
  const value=action==='revoke'?ZeroAddress:action==='recover'?v.guardian:action==='pause';
  return {action,contractId:v.contractId,contractAddress:v.contractAddress,guardianId,data:abi.encodeFunctionData(method,[value])};
}
export async function confirmVaultTransaction(request:VaultRequest,transactionId:string,fetcher:typeof fetch=fetch) {
  if(!/^0\.0\.\d+@\d+\.\d{9}$/.test(transactionId) || !transactionId.startsWith(request.guardianId+'@')) throw new Error('Vault payer mismatch');
  const id=transactionId.replace('@','-').replace(/\.(\d{9})$/,'-$1');
  const base='https://testnet.mirrornode.hedera.com/api/v1';
  const response=await fetcher(`${base}/transactions/${id}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(response.status===404) return false;
  if(!response.ok) throw new Error('Mirror unavailable; keep this transaction pending');
  const body=await response.json() as {transactions:{transaction_id:string;nonce:number;result:string;name:string;entity_id:string}[]};
  const tx=body.transactions.find(row=>row.transaction_id===id && row.nonce===0 && row.result!=='DUPLICATE_TRANSACTION');
  if(!tx) return false;
  if(tx.result!=='SUCCESS') throw new Error(`Vault transaction failed: ${tx.result}`);
  if(tx.name!=='CONTRACTCALL' || tx.entity_id!==request.contractId) throw new Error('Vault transaction target mismatch');
  const result=await fetcher(`${base}/contracts/results/${id}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(result.status===404) return false;
  if(!result.ok) throw new Error('Contract result unavailable');
  const call=await result.json() as {contract_id:string;function_parameters:string;error_message:string|null};
  if(call.contract_id!==request.contractId || call.error_message || call.function_parameters.replace(/^0x/,'').toLowerCase()!==request.data.slice(2).toLowerCase()) throw new Error('Vault call evidence mismatch');
  return true;
}
