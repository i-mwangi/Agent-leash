import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createClientHederaSigner } from '@x402/hedera';
import { readDeployment } from '../../shared/src/files';
import { AppError, PRICE, USDC } from '../../shared/src/model';
import { Mirror, verifyTransfer } from '../../shared/src/mirror';
import { verifyStanding } from '../../shared/src/standing';
import { roleKey, writeEvidence } from './runtime';

/** Operator-only test payer. The API process never receives this key. */
export async function payStanding() {
  const d=readDeployment();
  if(!d?.agentAccount || !d.policyAddress || !d.erc8004AgentId) throw new AppError('SETUP_REQUIRED');
  const mirror=new Mirror();
  if(await mirror.balance(d.operatorId,USDC)<BigInt(PRICE)) throw new AppError('PAYER_USDC_INSUFFICIENT');
  const client=new x402Client();
  client.setSpendControls({maxAmountPerPayment:'$0.001'});
  client.register('hedera:testnet',new ExactHederaScheme(createClientHederaSigner(d.operatorId,roleKey('operator'),{network:'hedera:testnet'})));
  const request=wrapFetchWithPayment(fetch,client);
  let response:Response;
  try {response=await request(`${d.standingBaseUrl}/standing/${d.agentAccount}`);}
  catch {throw new AppError('PAID_STANDING_REQUEST_FAILED');}
  if(response.status!==200) throw new AppError(`PAID_STANDING_HTTP_${response.status}`);
  const header=response.headers.get('PAYMENT-RESPONSE');
  if(!header) throw new AppError('PAYMENT_RESPONSE_MISSING');
  const settlement=decodePaymentResponseHeader(header);
  if(!settlement.success || settlement.network!=='hedera:testnet' || settlement.payer!==d.operatorId) throw new AppError('PAYMENT_RESPONSE_INVALID');
  const transaction=await mirror.waitTransaction(settlement.transaction);
  verifyTransfer(transaction,{txId:settlement.transaction,asset:USDC,payer:d.operatorId,payTo:d.agentAccount,amount:BigInt(PRICE)});
  const body=await response.json();
  const report=verifyStanding(body,d.attestationAddress,d.policyAddress,d.agentAccount);
  writeEvidence('x402-paid-standing',settlement.transaction);
  return {transactionId:settlement.transaction,report,verified:true};
}
