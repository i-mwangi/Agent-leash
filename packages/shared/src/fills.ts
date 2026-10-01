import { Mirror, exactUnits } from './mirror';
import type { ConsensusEvent, Deployment } from './model';

/**
 * The agent's recent swaps, newest first, from the fill records it published to its HCS topic.
 * For each success, the amount received is read from the mirror rather than trusted from the record.
 */
export async function recentFills(d:Pick<Deployment,'agentAccount'|'spendAsset'|'outputAsset'>,events:ConsensusEvent[],mirror:Mirror,limit=10) {
  const fills=events.filter(e=>e.type==='fill' && e.publisher===d.agentAccount).slice(-limit).reverse();
  const [spend,output]=await Promise.all([mirror.token(d.spendAsset),mirror.token(d.outputAsset)]);
  const rows=await Promise.all(fills.map(async event=>{
    const payload=event.payload;
    const transactionId=String(payload.transactionId??'');
    let received:string|null=null;
    if(payload.status==='success') {
      const {transfers}=await mirror.contractTransfers(transactionId).catch(()=>({transfers:[]}));
      const net=transfers.filter(t=>t.account===d.agentAccount && t.token_id===d.outputAsset).reduce((n,t)=>n+exactUnits(t.amount),0n);
      received=net>0n?net.toString():null;
    }
    return {
      transactionId,
      status:String(payload.status),
      amount:String(payload.amount??''),
      received,
      reason:typeof payload.reason==='string'?payload.reason:null,
      recordedAt:event.consensusTimestamp,
      sequence:event.sequence,
    };
  }));
  const token=(t:typeof spend)=>({id:t.token_id,symbol:t.symbol,decimals:Number(t.decimals)});
  return {spendToken:token(spend),outputToken:token(output),fills:rows};
}
