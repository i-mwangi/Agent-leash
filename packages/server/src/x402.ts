import { createHash } from 'node:crypto';
import { HTTPFacilitatorClient, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { inspectHederaTransaction } from '@x402/hedera';
import { FACILITATOR, NETWORK, USDC, PRICE, AppError, entityId } from '../../shared/src/model';
import { mirrorTxId, type Mirror, verifyTransfer } from '../../shared/src/mirror';
import { Store } from '../../shared/src/store';
export interface Facilitator {
  getSupported():Promise<{kinds:{x402Version:number;scheme:string;network:string;extra?:Record<string,unknown>}[]}>;
  verify(payload:PaymentPayload,requirements:PaymentRequirements):Promise<{isValid:boolean;payer?:string;invalidReason?:string}>;
  settle(payload:PaymentPayload,requirements:PaymentRequirements):Promise<SettleResponse>;
}
export class Payments {
  constructor(readonly mirror:Mirror,readonly store:Store,readonly payTo:string,readonly facilitator:Facilitator=new HTTPFacilitatorClient({url:FACILITATOR})) { entityId.parse(payTo); }
  async requirements():Promise<PaymentRequirements> {
    const [supported,token]=await Promise.all([this.facilitator.getSupported(),this.mirror.token(USDC)]);
    if(token.decimals!=='6' || token.deleted) throw new AppError('PAYMENT_ASSET_INVALID');
    const kind=supported.kinds.find(k=>k.x402Version===2 && k.scheme==='exact' && k.network===NETWORK);
    const feePayer=entityId.parse(kind?.extra?.feePayer);
    // Verify receiver is actually associated before advertising a payable resource.
    await this.mirror.balance(this.payTo,USDC);
    return {scheme:'exact',network:NETWORK,asset:USDC,amount:PRICE,payTo:this.payTo,maxTimeoutSeconds:120,extra:{feePayer}};
  }
  challenge(requirements:PaymentRequirements,url:string) {
    const body={x402Version:2 as const,resource:{url,description:'Signed Accountable Agent standing',mimeType:'application/json'},accepts:[requirements]};
    return {body,header:encodePaymentRequiredHeader(body)};
  }
  async accept(header:string,requirements:PaymentRequirements,resource:string,build:()=>Promise<unknown>) {
    if(header.length>65536) throw new AppError('PAYMENT_TOO_LARGE',400);
    let payload:PaymentPayload;
    try{payload=decodePaymentSignatureHeader(header);}catch{throw new AppError('PAYMENT_INVALID',400);}
    const accepted=payload.accepted;
    if(payload.x402Version!==2 || !accepted || ['scheme','network','asset','amount','payTo','maxTimeoutSeconds'].some(k=>accepted[k as keyof PaymentRequirements]!==requirements[k as keyof PaymentRequirements]) || accepted.extra?.feePayer!==requirements.extra?.feePayer) throw new AppError('PAYMENT_REQUIREMENTS_MISMATCH',400);
    const bytes=payload.payload?.transaction;
    if(typeof bytes!=='string') throw new AppError('PAYMENT_INVALID',400);
    const tx=inspectHederaTransaction(bytes);
    if(tx.hasNonTransferOperations || tx.transactionIdAccountId!==requirements.extra?.feePayer) throw new AppError('PAYMENT_INVALID',400);
    const transfers=tx.tokenTransfers[USDC];
    const debit=transfers?.filter(t=>BigInt(t.amount)<0n);
    if(!debit || debit.length!==1 || BigInt(debit[0].amount)!==-BigInt(PRICE)) throw new AppError('PAYMENT_INVALID',400);
    const payer=debit[0].accountId;
    if(payer===this.payTo) throw new AppError('PAYMENT_SELF_TRANSFER',400);
    const id=mirrorTxId(tx.transactionId);
    const hash=createHash('sha256').update(bytes).digest('hex');
    return this.store.exclusive('payment:'+id,async()=>{
      // Valid signature before reserving a transaction ID, preventing unsigned claim poisoning.
      const previous=this.store.db.prepare('SELECT payload_hash,resource,response FROM payments WHERE tx_id=?').get(id) as {payload_hash:string;resource:string;response:string|null}|undefined;
      if(previous && (previous.payload_hash!==hash || previous.resource!==resource)) throw new AppError('PAYMENT_REPLAY',409);
      if(previous?.response) return JSON.parse(previous.response) as {body:unknown;responseHeader:string};
      if(!previous) {
        const verification=await this.facilitator.verify(payload,requirements);
        if(!verification.isValid || verification.payer!==payer) throw new AppError('PAYMENT_SIGNATURE_INVALID',402);
      }
      const claim=this.store.claimPayment(id,hash,resource);
      if(claim.fresh) {
        try {
          const settled=await this.facilitator.settle(payload,requirements);
          if(!settled.success || settled.network!==NETWORK || mirrorTxId(settled.transaction)!==id || settled.payer!==payer) throw new AppError('SETTLEMENT_UNCONFIRMED');
        } catch { /* A timeout is ambiguous: recover exclusively from this exact mirror transaction. */ }
      }
      const confirmed=await this.mirror.waitTransaction(id);
      verifyTransfer(confirmed,{txId:id,asset:USDC,payTo:this.payTo,payer,amount:BigInt(PRICE)});
      const body=await build();
      const responseHeader=encodePaymentResponseHeader({success:true,transaction:tx.transactionId,network:NETWORK,payer});
      const result={body,responseHeader}; this.store.finishPayment(id,result); return result;
    });
  }
}
