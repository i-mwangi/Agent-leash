import { Interface } from 'ethers';
import { AppError, MIRROR, entityId, eventSchema, type ConsensusEvent } from './model';
export type Fetcher = typeof fetch;
export interface MirrorKey { _type: string; key: string }
export interface MirrorAccount { account:string; evm_address:string; deleted:boolean; key:MirrorKey; balance:{balance:number;tokens:{token_id:string;balance:number}[]} }
export interface MirrorTransfer { token_id:string; account:string; amount:number|string }
export interface MirrorTransaction { transaction_id:string; result:string; consensus_timestamp:string; token_transfers:MirrorTransfer[]; nonce?:number; name?:string; entity_id?:string }
export function mirrorTxId(value: string) {
  if (/^0\.0\.\d+-\d+-\d{9}$/.test(value)) return value;
  const m = /^(0\.0\.\d+)@(\d+)\.(\d{1,9})$/.exec(value);
  if (!m) throw new AppError('INVALID_TRANSACTION_ID',400);
  return `${m[1]}-${m[2]}-${m[3].padEnd(9,'0')}`;
}
export function exactUnits(value:number|string) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new AppError('UNSAFE_MIRROR_AMOUNT');
  if (!/^-?\d+$/.test(String(value))) throw new AppError('INVALID_MIRROR_AMOUNT');
  return BigInt(value);
}
export class Mirror {
  constructor(private fetcher:Fetcher = fetch, readonly base = MIRROR) {}
  async json<T>(path:string, init?:RequestInit):Promise<T> {
    const url = new URL(path, this.base);
    if (url.origin !== new URL(this.base).origin || !url.pathname.startsWith('/api/v1/')) throw new AppError('INVALID_MIRROR_PATH');
    const response = await this.fetcher(url, {...init, signal:AbortSignal.timeout(15000)});
    if (!response.ok) {
      if(response.status===400 && (await response.clone().text()).includes('CONTRACT_REVERT_EXECUTED')) throw new AppError('CONTRACT_REVERT');
      throw new AppError(response.status === 404 ? 'MIRROR_NOT_FOUND' : 'MIRROR_UNAVAILABLE');
    }
    return await response.json() as T;
  }
  async account(id:string) { entityId.parse(id); return this.json<MirrorAccount>(`/api/v1/accounts/${id}`); }
  async token(id:string) { entityId.parse(id); return this.json<{token_id:string;decimals:string;deleted:boolean;symbol:string;custom_fees?:{fixed_fees?:unknown[];fractional_fees?:unknown[]}}>(`/api/v1/tokens/${id}`); }
  async balance(account:string, asset:string) {
    entityId.parse(account); entityId.parse(asset);
    const data = await this.json<{tokens:{token_id:string;balance:number|string}[]}>(`/api/v1/accounts/${account}/tokens?token.id=${asset}`);
    const token = data.tokens.find(t=>t.token_id === asset);
    if (!token) throw new AppError('TOKEN_NOT_ASSOCIATED');
    return exactUnits(token.balance);
  }
  async events(topic:string):Promise<ConsensusEvent[]> {
    entityId.parse(topic); let next:string|null = `/api/v1/topics/${topic}/messages?limit=100&order=asc`;
    const events:ConsensusEvent[]=[]; let pages=0;
    while(next) {
      if (++pages > 100) throw new AppError('HCS_HISTORY_LIMIT');
      const page: {messages:{message:string;consensus_timestamp:string;sequence_number:number;payer_account_id:string}[];links:{next:string|null}} = await this.json(next);
      for(const row of page.messages) {
        try { const event=eventSchema.parse(JSON.parse(Buffer.from(row.message,'base64').toString('utf8'))); events.push({...event,consensusTimestamp:row.consensus_timestamp,sequence:row.sequence_number,publisher:row.payer_account_id}); }
        catch { throw new AppError('HCS_INVALID_MESSAGE'); }
      }
      next=page.links.next;
    }
    return events.sort((a,b)=>a.sequence-b.sequence);
  }
  async transaction(id:string) {
    const txId = mirrorTxId(id);
    const data = await this.json<{transactions:MirrorTransaction[]}>(`/api/v1/transactions/${txId}`);
    const tx = data.transactions.find(t=>t.transaction_id===txId && (t.nonce??0)===0 && t.result!=='DUPLICATE_TRANSACTION');
    if(!tx) throw new AppError('SETTLEMENT_UNCONFIRMED');
    return tx;
  }
  async waitTransaction(id:string, attempts=8) {
    for(let i=0;i<attempts;i++) {
      try { return await this.transaction(id); } catch(error) {
        if(!(error instanceof AppError) || !['MIRROR_NOT_FOUND','SETTLEMENT_UNCONFIRMED'].includes(error.code) || i===attempts-1) throw error;
        await new Promise(r=>setTimeout(r,1500));
      }
    }
    throw new AppError('SETTLEMENT_UNCONFIRMED');
  }
  async call(contract:string, abi:Interface, method:string, args:unknown[]=[]) {
    const data = await this.json<{result:string}>('/api/v1/contracts/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:contract,data:abi.encodeFunctionData(method,args),block:'latest'})});
    return abi.decodeFunctionResult(method,data.result);
  }
}
export function verifyTransfer(tx:MirrorTransaction, expected:{txId:string;asset:string;payTo:string;payer:string;amount:bigint}) {
  if(tx.transaction_id!==mirrorTxId(expected.txId) || tx.result!=='SUCCESS' || (tx.nonce??0)!==0) throw new AppError('SETTLEMENT_UNCONFIRMED');
  let credit=0n, debit=0n;
  for(const t of tx.token_transfers) if(t.token_id===expected.asset) {
    if(t.account===expected.payTo) credit+=exactUnits(t.amount);
    if(t.account===expected.payer) debit+=exactUnits(t.amount);
  }
  if(expected.payer===expected.payTo || credit!==expected.amount || debit!==-expected.amount) throw new AppError('SETTLEMENT_TRANSFER_MISMATCH',422);
}
