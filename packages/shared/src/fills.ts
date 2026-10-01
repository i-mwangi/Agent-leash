import { Mirror, exactUnits, type MirrorTransaction } from './mirror';
import { USDC } from './model';
import type { ConsensusEvent, Deployment } from './model';

/**
 * The agent's recent swaps, newest first, from the fill records it published to its HCS topic.
 * For each success, the amount received is read from the mirror rather than trusted from the record.
 */
export async function recentFills(d:Pick<Deployment,'agentAccount'|'spendAsset'|'outputAsset'>,events:ConsensusEvent[],mirror:Mirror,limit=10) {
  const fills=events.filter(e=>e.type==='fill' && e.publisher===d.agentAccount && e.payload.kind!=='x402').slice(-limit).reverse();
  const [spend,output]=await Promise.all([mirror.token(d.spendAsset),mirror.token(d.outputAsset)]);
  const rows=await Promise.all(fills.map(async event=>{
    const payload=event.payload;
    const transactionId=String(payload.transactionId??'');
    let received:string|null=null;
    if(payload.status==='success') {
      const {transfers}=await mirror.contractTransfers(transactionId,payload.scheduled===true).catch(()=>({transfers:[]}));
      const net=transfers.filter(t=>t.account===d.agentAccount && t.token_id===d.outputAsset).reduce((n,t)=>n+exactUnits(t.amount),0n);
      received=net>0n?net.toString():null;
    }
    return {
      transactionId,
      status:String(payload.status),
      amount:String(payload.amount??''),
      received,
      reason:typeof payload.reason==='string'?payload.reason:null,
      scheduleId:typeof payload.scheduleId==='string'?payload.scheduleId:null,
      recordedAt:event.consensusTimestamp,
      sequence:event.sequence,
    };
  }));
  const token=(t:typeof spend)=>({id:t.token_id,symbol:t.symbol,decimals:Number(t.decimals)});
  return {spendToken:token(spend),outputToken:token(output),fills:rows};
}

/** x402 payments the agent made, from its own HCS records; amounts link to the mirror-checked transfer. */
export function recentPayments(d:Pick<Deployment,'agentAccount'>,events:ConsensusEvent[],limit=10) {
  return events.filter(e=>e.type==='fill' && e.publisher===d.agentAccount && e.payload.kind==='x402').slice(-limit).reverse().map(e=>({
    transactionId:String(e.payload.transactionId??''),amount:String(e.payload.amount??''),asset:String(e.payload.asset??''),
    payTo:String(e.payload.payTo??''),resource:String(e.payload.resource??''),recordedAt:e.consensusTimestamp,sequence:e.sequence,
  }));
}

/** USDC the agent received, for example from selling inference over x402, read from the mirror. */
export async function recentIncome(account:string,mirror:Mirror,limit=10) {
  const page=await mirror.json<{transactions:MirrorTransaction[]}>(`/api/v1/transactions?account.id=${account}&transactiontype=cryptotransfer&result=success&order=desc&limit=50`);
  return page.transactions.flatMap(tx=>{
    const credit=tx.token_transfers.filter(t=>t.token_id===USDC && t.account===account).reduce((n,t)=>n+exactUnits(t.amount),0n);
    const payer=tx.token_transfers.find(t=>t.token_id===USDC && exactUnits(t.amount)<0n)?.account;
    return credit>0n?[{transactionId:tx.transaction_id,amount:credit.toString(),payer:payer??null,consensusTimestamp:tx.consensus_timestamp}]:[];
  }).slice(0,limit);
}
