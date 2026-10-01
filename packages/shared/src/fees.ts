import { AppError } from './model';
import type { Mirror } from './mirror';

/**
 * HBAR the agent account needs for network fees. Hedera requires the payer to cover the full
 * gas limit at the current gas price, even though a swap uses far less, so limits stay tight.
 */
export const GAS={approve:1_000_000n,swap:300_000n} as const; // measured: approve 726,804, swap 112,946
/** A long-term ScheduleCreate wrapping a router call cost 1.05 HBAR on testnet; HCS records cost under 0.01. */
export const SCHEDULE_CREATE_TINYBARS=120_000_000n;
export const MARGIN_TINYBARS=10_000_000n;

export function hbarNeeded(gasPrice:bigint,{approve,schedule}:{approve:boolean;schedule:boolean}) {
  return (approve?GAS.approve*gasPrice:0n)+GAS.swap*gasPrice+(schedule?SCHEDULE_CREATE_TINYBARS:0n)+MARGIN_TINYBARS;
}

/** Current contract-call gas price in tinybars, from the mirror. */
export async function gasPrice(mirror:Mirror) {
  const data=await mirror.json<{fees:{gas:number;transaction_type:string}[]}>('/api/v1/network/fees');
  const fee=data.fees.find(f=>f.transaction_type==='ContractCall');
  if(!fee || !Number.isSafeInteger(fee.gas) || fee.gas<=0) throw new AppError('GAS_PRICE_UNAVAILABLE');
  return BigInt(fee.gas);
}

/** Fail before signing when the agent cannot pay; a scheduled swap would otherwise fail at execution. */
export async function requireHbar(mirror:Mirror,account:string,needs:{approve:boolean;schedule:boolean}) {
  const [price,info]=await Promise.all([gasPrice(mirror),mirror.account(account)]);
  const needed=hbarNeeded(price,needs);
  if(BigInt(info.balance.balance)<needed) throw new AppError(`AGENT_HBAR_LOW:${needed}`,422);
  return needed;
}
