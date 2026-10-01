import { readDeployment } from '../../shared/src/files';
import { gasPrice, hbarNeeded } from '../../shared/src/fees';
import { AppError, USDC } from '../../shared/src/model';
import { Mirror } from '../../shared/src/mirror';
import { fundAgent, fundDex } from './setup';

/**
 * What the agent holds for each feature, and top-ups paid by the setup account (the operator), whose
 * key the local runtime already holds. HBAR pays network fees, the swap token is spent on the DEX page,
 * and USDC pays x402 services. Testnet USDC comes from Circle's faucet, sent straight to the agent.
 */
export const SETUP_RESERVE_TINYBARS=200_000_000n; // the setup account keeps 2 HBAR for its own records
export const MAX_HBAR_TOP_UP=2_000_000_000n;
export const MAX_SAUCE_BUY_TINYBARS=100_000_000n;

export async function fundingStatus(mirror=new Mirror()) {
  const d=readDeployment();
  if(!d?.agentAccount) throw new AppError('SETUP_REQUIRED',409);
  const [agent,setup,price,spend,usdc]=await Promise.all([mirror.account(d.agentAccount),mirror.account(d.operatorId),gasPrice(mirror),mirror.token(d.spendAsset),mirror.token(USDC)]);
  const held=(token:string)=>{const row=agent.balance.tokens.find(t=>t.token_id===token);return row?String(row.balance):null;};
  return {
    agentAccount:d.agentAccount,setupAccount:d.operatorId,
    hbar:{balance:String(agent.balance.balance),forSwap:hbarNeeded(price,{approve:true,schedule:false}).toString(),forSchedule:hbarNeeded(price,{approve:true,schedule:true}).toString()},
    spendToken:{id:spend.token_id,symbol:spend.symbol,decimals:Number(spend.decimals),balance:held(d.spendAsset)},
    usdc:{id:usdc.token_id,symbol:usdc.symbol,decimals:Number(usdc.decimals),balance:held(USDC)},
    setupHbar:String(setup.balance.balance),
    // The buy route only exists for the template's SAUCE pool.
    canBuySpendToken:d.spendAsset==='0.0.1183558',
  };
}

/** A top-up must be in range and leave the setup account its reserve; checked before anything is signed. */
export function checkTopUp(tinybars:bigint,setupBalance:bigint,max:bigint) {
  if(tinybars<=0n || tinybars>max) throw new AppError('FUND_AMOUNT_OUT_OF_RANGE',400);
  if(setupBalance-tinybars<SETUP_RESERVE_TINYBARS) throw new AppError('SETUP_ACCOUNT_HBAR_LOW',422);
}

async function setupHbar(mirror:Mirror) {
  const d=readDeployment();
  if(!d) throw new AppError('SETUP_REQUIRED',409);
  return BigInt((await mirror.account(d.operatorId)).balance.balance);
}

/** Send HBAR from the setup account to the agent, keeping a reserve in the setup account. */
export async function topUpHbar(tinybars:bigint,mirror=new Mirror()) {
  checkTopUp(tinybars,await setupHbar(mirror),MAX_HBAR_TOP_UP);
  return fundAgent(tinybars);
}

/** Buy the swap token for the agent on SaucerSwap with setup-account HBAR (up to 1 HBAR at a time). */
export async function buySpendToken(tinybars:bigint,mirror=new Mirror()) {
  checkTopUp(tinybars,await setupHbar(mirror),MAX_SAUCE_BUY_TINYBARS);
  return fundDex(tinybars);
}
