import { Interface } from 'ethers';
import { Mirror, exactUnits, mirrorTxId } from './mirror';
import { AppError, evmAddress, type Deployment, type ConsensusEvent } from './model';
import { accountKeyState } from './keys';
import { agentData, createUaid } from './uaid';
import type { PolicySnapshot } from '../../agent/src/policyClient';
export const POLICY_ABI=new Interface(['function guardian() view returns(address)','function agentAccount() view returns(string)','function paused() view returns(bool)','function maxPerTx() view returns(uint256)','function maxPerDay() view returns(uint256)','function allowedTokens(string) view returns(bool)','function pause()','function unpause()','function setCaps(uint256,uint256)','function setAllowedTokens(string[],bool)']);
export const IDENTITY_ABI=new Interface(['function register(string) returns(uint256)','function tokenURI(uint256) view returns(string)','function ownerOf(uint256) view returns(address)','function setAgentURI(uint256,string)','event Registered(uint256 indexed agentId,string agentURI,address indexed owner)']);
export function makeCard(d:Deployment) {
  return {type:'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',name:d.name,description:'Agent wallet with client-enforced policy and guardian revocation on Hedera testnet.',services:[{name:'standing',endpoint:`${d.standingBaseUrl}/standing/${d.agentAccount}`,version:'1'},{name:'HCS',endpoint:`hedera:testnet:${d.hcsTopic}`}],x402Support:true,active:true,supportedTrust:[],...(d.erc8004AgentId?{registrations:[{agentId:d.erc8004AgentId,agentRegistry:`eip155:296:${d.registry}`}]}:{}),guardian:d.guardianId,hederaAccount:d.agentAccount,hcsTopic:d.hcsTopic,uaid:d.uaid,policy:d.policyAddress,dex:'saucerswap',network:'hedera:testnet'};
}
export function cardUri(d:Deployment){return 'data:application/json;base64,'+Buffer.from(JSON.stringify(makeCard(d))).toString('base64');}
export function resolvePublicId(d:Deployment,id:string){return [d.agentAccount,d.erc8004AgentId,d.uaid].includes(id);}
export async function readFacts(d:Deployment,mirror:Mirror) {
  if(!d.agentAccount || !d.hcsTopic || !d.policyAddress || !d.uaid || !d.erc8004AgentId || !d.guardianId) throw new AppError('IDENTITY_MISSING',409);
  const account=d.agentAccount,topic=d.hcsTopic,agentId=d.erc8004AgentId;
  const [accountInfo,allEvents,owner,uri,guardianInfo]=await Promise.all([
    mirror.account(account), mirror.events(topic), mirror.call(d.registry,IDENTITY_ABI,'ownerOf',[agentId]),mirror.call(d.registry,IDENTITY_ABI,'tokenURI',[agentId]),mirror.account(d.guardianId),
  ]);
  if(accountInfo.deleted) throw new AppError('ACCOUNT_DELETED');
  const events=allEvents.filter(e=>e.type==='fill' ? e.publisher===account : [d.operatorId,d.guardianId].includes(e.publisher));
  const keyState=accountKeyState(accountInfo.key,d.agentPublicKey,d.guardianPublicKey);
  const latest=(type:string)=>events.filter(e=>e.type===type).at(-1);
  if(events.some(e=>e.agentAccount!==account)) throw new AppError('HCS_ACCOUNT_MISMATCH');
  if(!latest('created')) throw new AppError('HCS_NOT_READY');
  if(latest('uaid')?.payload.uaid!==d.uaid || createUaid(agentData(d.name,account))!==d.uaid) throw new AppError('HCS_UAID_MISSING');
  if(String(latest('registered')?.payload.agentId)!==agentId) throw new AppError('HCS_REGISTRATION_MISSING');
  const policy=String(latest('policy')?.payload.address??'');
  if(policy.toLowerCase()!==d.policyAddress.toLowerCase()) throw new AppError('POLICY_ADDRESS_MISMATCH');
  const encoded=String(uri[0]);
  // Our template uses self-contained ERC-8004 data URIs: no untrusted URL fetch / SSRF.
  if(!encoded.startsWith('data:application/json;base64,') || encoded.length>32768) throw new AppError('CARD_UNREACHABLE');
  let card:Record<string,unknown>;
  try{card=JSON.parse(Buffer.from(encoded.split(',')[1],'base64').toString('utf8'));}catch{throw new AppError('CARD_INVALID');}
  const expected=makeCard(d);
  for(const field of ['hederaAccount','hcsTopic','uaid','guardian','policy'] as const) if(card[field]!==expected[field]) throw new AppError('CARD_IDENTITY_MISMATCH');
  const operator=await mirror.account(d.operatorId);
  if(String(owner[0]).toLowerCase()!==operator.evm_address.toLowerCase()) throw new AppError('REGISTRY_OWNER_MISMATCH');
  const [guardian,agent,paused,perTx,perDay]=await Promise.all(['guardian','agentAccount','paused','maxPerTx','maxPerDay'].map(method=>mirror.call(policy,POLICY_ABI,method)));
  if(String(guardian[0]).toLowerCase()!==guardianInfo.evm_address.toLowerCase() || agent[0]!==account) throw new AppError('POLICY_OWNER_MISMATCH');
  return {account:accountInfo,events,card,policy,keyState,paused:Boolean(paused[0]),maxPerTx:BigInt(perTx[0]),maxPerDay:BigInt(perDay[0])};
}
export async function dailySpend(events:ConsensusEvent[],account:string,asset:string,mirror:Mirror,now=Date.now()) {
  let total=0n; const confirmed=new Set<string>(); const today=new Date(now).toISOString().slice(0,10);
  // Verify every success record's transaction; never trust a claimed amount or local timestamp.
  for(const event of events.filter(e=>e.type==='fill' && e.payload.status==='success')) {
    const txId=mirrorTxId(String(event.payload.transactionId));
    if(confirmed.has(txId)) continue;
    const tx=await mirror.transaction(txId);
    if(tx.result!=='SUCCESS') throw new AppError('HCS_FILL_MISMATCH');
    confirmed.add(txId);
    if(new Date(Number(tx.consensus_timestamp.split('.')[0])*1000).toISOString().slice(0,10)!==today) continue;
    const net=tx.token_transfers.filter(t=>t.account===account && t.token_id===asset).reduce((n,t)=>n+exactUnits(t.amount),0n);
    if(net<0n) total-=net;
  }
  return {total,confirmed};
}
export async function policySnapshot(d:Deployment,mirror:Mirror,pending:(confirmed:Set<string>)=>bigint):Promise<PolicySnapshot> {
  const facts=await readFacts(d,mirror);
  const [balance,allowed,day]=await Promise.all([mirror.balance(d.agentAccount!,d.spendAsset),mirror.call(facts.policy,POLICY_ABI,'allowedTokens',[d.spendAsset]),dailySpend(facts.events,d.agentAccount!,d.spendAsset,mirror)]);
  return {policyExists:true,paused:facts.paused,agentKeyActive:facts.keyState.agentKeyActive,hcsReady:true,identityRegistered:true,allowedTokens:allowed[0]?[d.spendAsset]:[],maxPerTx:facts.maxPerTx,maxPerDay:facts.maxPerDay,spentToday:day.total,pendingToday:pending(day.confirmed),balance};
}
export const ROUTER_ABI=new Interface(['function getAmountsOut(uint256,address[]) view returns(uint256[])','function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns(uint256[])']);
const FACTORY_ABI=new Interface(['function getPair(address,address) view returns(address)']);
export const FALLBACK={factory:'0.0.9959',assetIn:'0.0.1183558',assetOut:'0.0.15058',decimalsIn:'6',decimalsOut:'8'} as const;
/** A real testnet pool quote. It never authorizes or represents a swap. */
export async function fallbackQuote(d:Deployment,mirror:Mirror,amount:bigint) {
  if(amount<=0n) throw new AppError('INVALID_AMOUNT',400);
  const [source,target]=await Promise.all([mirror.token(FALLBACK.assetIn),mirror.token(FALLBACK.assetOut)]);
  if(source.deleted || target.deleted || source.decimals!==FALLBACK.decimalsIn || target.decimals!==FALLBACK.decimalsOut) throw new AppError('FALLBACK_TOKEN_MISMATCH');
  const path=[FALLBACK.assetIn,FALLBACK.assetOut].map(evmAddress);
  const pair=String((await mirror.call(evmAddress(FALLBACK.factory),FACTORY_ABI,'getPair',path))[0]);
  if(/^0x0{40}$/i.test(pair)) throw new AppError('FALLBACK_POOL_MISSING');
  const amounts=Array.from((await mirror.call(evmAddress(d.routerId),ROUTER_ABI,'getAmountsOut',[amount,path]))[0] as bigint[]);
  if(amounts.length!==2 || amounts[0]!==amount || amounts[1]<=0n) throw new AppError('FALLBACK_QUOTE_INVALID');
  return {network:'hedera:testnet',protocol:'SaucerSwap V1',mode:'read-only',router:d.routerId,factory:FALLBACK.factory,pair,assetIn:FALLBACK.assetIn,assetOut:FALLBACK.assetOut,decimalsIn:FALLBACK.decimalsIn,decimalsOut:FALLBACK.decimalsOut,amountIn:amount.toString(),amountOut:amounts[1].toString(),quotedAt:new Date().toISOString(),transactionSubmitted:false};
}
export async function quote(d:Deployment,mirror:Mirror,amount:bigint) {
  if(amount<=0n) throw new AppError('INVALID_AMOUNT',400);
  const path=[d.spendAsset,d.outputAsset].map(evmAddress);
  const result=await mirror.call(evmAddress(d.routerId),ROUTER_ABI,'getAmountsOut',[amount,path]).catch(error=>{
    if(error instanceof AppError && error.code==='CONTRACT_REVERT') throw new AppError('DEX_QUOTE_REVERTED');
    throw error;
  });
  const amounts=Array.from(result[0] as bigint[]);
  if(amounts.length!==2 || amounts[0]!==amount || amounts[1]<=0n) throw new AppError('DEX_NO_LIQUIDITY');
  return {network:'hedera:testnet',router:d.routerId,assetIn:d.spendAsset,assetOut:d.outputAsset,amountIn:amount.toString(),amountOut:amounts[1].toString(),readOnly:true,quotedAt:new Date().toISOString()};
}
