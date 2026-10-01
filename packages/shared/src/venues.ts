import { AppError, evmAddress } from './model';
import { Mirror, type Fetcher } from './mirror';
import { ROUTER_ABI } from './sources';

/**
 * Read-only mainnet price discovery across two Hedera venues: SaucerSwap V1 (an AMM pool) and
 * Lambdaplex (a central limit order book that settles on Hedera mainnet and has no testnet).
 * Nothing here signs or submits; the agent only trades on testnet SaucerSwap.
 */
export const MAINNET_MIRROR='https://mainnet-public.mirrornode.hedera.com';
export const LAMBDAPLEX_API='https://api.lambdaplex.io';
export const MAINNET={router:'0.0.3045981',whbar:'0.0.1456986',usdc:'0.0.456858'} as const;
const PAIR='HBAR-USDC';

/** Parse an exchange decimal string into integer units; refuses anything it would have to round. */
export function decimalUnits(value:string,scale:number) {
  const match=/^(\d{1,20})(?:\.(\d+))?$/.exec(value);
  if(!match) throw new AppError('VENUE_INVALID_NUMBER');
  const fraction=(match[2]??'').replace(/0+$/,'');
  if(fraction.length>scale) throw new AppError('VENUE_INVALID_NUMBER');
  return BigInt(match[1]+fraction.padEnd(scale,'0'));
}

/** Sell `tinybars` of HBAR into the bid side, best price first. USDC out has 6 decimals. */
export function sellIntoBids(bids:[string,string][],tinybars:bigint) {
  let remaining=tinybars,usdc=0n,last:bigint|null=null;
  for(const [priceText,quantityText] of bids) {
    const price=decimalUnits(priceText,6),quantity=decimalUnits(quantityText,8);
    if(last!==null && price>last) throw new AppError('VENUE_BOOK_UNSORTED');
    last=price;
    const take=quantity<remaining?quantity:remaining;
    usdc+=take*price/100_000_000n;
    remaining-=take;
    if(remaining===0n) break;
  }
  return {filled:tinybars-remaining,usdc};
}

export async function lambdaplexQuote(tinybars:bigint,fetcher:Fetcher=fetch) {
  const read=async<T>(path:string)=>{
    const response=await fetcher(new URL(path,LAMBDAPLEX_API),{signal:AbortSignal.timeout(10_000)});
    if(!response.ok) throw new AppError('LAMBDAPLEX_UNAVAILABLE');
    return await response.json() as T;
  };
  const [depth,average]=await Promise.all([
    read<{bids:[string,string][];asks:[string,string][]}>(`/api/v1/depth?symbol=${PAIR}&limit=50`),
    read<{price:string}>(`/api/v1/avgPrice?symbol=${PAIR}`),
  ]);
  if(!Array.isArray(depth.bids) || !Array.isArray(depth.asks)) throw new AppError('LAMBDAPLEX_UNAVAILABLE');
  const {filled,usdc}=sellIntoBids(depth.bids,tinybars);
  return {
    venue:'Lambdaplex',kind:'order book',network:'hedera:mainnet',pair:PAIR,
    amountIn:tinybars.toString(),filledIn:filled.toString(),usdcOut:usdc.toString(),
    bestBid:depth.bids[0]?.[0]??null,bestAsk:depth.asks[0]?.[0]??null,averagePrice:average.price,
  };
}

export async function saucerSwapMainnetQuote(tinybars:bigint,mirror=new Mirror(fetch,MAINNET_MIRROR)) {
  const [whbar,usdc]=await Promise.all([mirror.token(MAINNET.whbar),mirror.token(MAINNET.usdc)]);
  if(whbar.deleted || usdc.deleted || whbar.decimals!=='8' || usdc.decimals!=='6' || usdc.symbol!=='USDC') throw new AppError('MAINNET_TOKEN_MISMATCH');
  const amounts=Array.from((await mirror.call(evmAddress(MAINNET.router),ROUTER_ABI,'getAmountsOut',[tinybars,[MAINNET.whbar,MAINNET.usdc].map(evmAddress)]))[0] as bigint[]);
  if(amounts.length!==2 || amounts[0]!==tinybars || amounts[1]<=0n) throw new AppError('SAUCERSWAP_MAINNET_QUOTE_INVALID');
  return {venue:'SaucerSwap V1',kind:'AMM pool',network:'hedera:mainnet',pair:PAIR,router:MAINNET.router,amountIn:tinybars.toString(),filledIn:tinybars.toString(),usdcOut:amounts[1].toString()};
}

/** Both venues for the same HBAR amount; a venue that fails to answer is reported, never estimated. */
export async function compareVenues(tinybars:bigint,options:{fetcher?:Fetcher;mirror?:Mirror}={}) {
  if(tinybars<=0n || tinybars>1_000_000n*100_000_000n) throw new AppError('INVALID_AMOUNT',400);
  const settle=async<T>(work:Promise<T>)=>work.then(quote=>({ok:true as const,quote}),error=>({ok:false as const,error:error instanceof AppError?error.code:'VENUE_UNAVAILABLE'}));
  const venues=await Promise.all([settle(saucerSwapMainnetQuote(tinybars,options.mirror)),settle(lambdaplexQuote(tinybars,options.fetcher))]);
  return {network:'hedera:mainnet',readOnly:true,transactionSubmitted:false,amountIn:tinybars.toString(),readAt:new Date().toISOString(),venues};
}
