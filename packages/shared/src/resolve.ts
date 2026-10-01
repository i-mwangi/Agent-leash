import { Interface, getAddress } from 'ethers';
import { z } from 'zod';
import { Mirror, type MirrorAccount } from './mirror';
import { AppError, entityId, address } from './model';
import { IDENTITY_ABI, readFacts } from './sources';
import { normalizedPublic } from './keys';

/** ERC-8004 registries share these addresses on every chain, including Hedera testnet. */
export const IDENTITY_REGISTRY='0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const REPUTATION_REGISTRY='0x8004B663056A597Dffe9eCcC1965A193B7388713';
// Subset of the deployed ReputationRegistryUpgradeable ABI (implementation 0x16e0…da34).
export const REPUTATION_ABI=new Interface([
  'function getClients(uint256 agentId) view returns (address[])',
  'function getSummary(uint256 agentId,address[] clientAddresses,string tag1,string tag2) view returns (uint64 count,int128 summaryValue,uint8 summaryValueDecimals)',
  'function readAllFeedback(uint256 agentId,address[] clientAddresses,string tag1,string tag2,bool includeRevoked) view returns (address[] clients,uint64[] feedbackIndexes,int128[] values,uint8[] valueDecimals,string[] tag1s,string[] tag2s,bool[] revokedStatuses)',
  'function giveFeedback(uint256 agentId,int128 value,uint8 valueDecimals,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)',
]);

const MAX_CARD_BYTES=32768;
const cardSchema=z.object({
  name:z.string().min(1).max(80),
  hederaAccount:entityId,
  guardian:entityId,
  hcsTopic:entityId,
  uaid:z.string().min(1),
  policy:address,
  services:z.array(z.object({name:z.string(),endpoint:z.string()})).optional(),
}).passthrough();
export type AgentCard=z.infer<typeof cardSchema>;

/**
 * Decode an agent card URI without any network request. Only self-contained data URIs are read,
 * so resolving an arbitrary agent can never make this server fetch an attacker-chosen URL.
 */
export function parseCardUri(uri:string):{kind:'data';card:Record<string,unknown>}|{kind:'external';uri:string} {
  if(!uri.startsWith('data:application/json;base64,')) return {kind:'external',uri:uri.slice(0,200)};
  if(uri.length>MAX_CARD_BYTES) throw new AppError('CARD_TOO_LARGE',422);
  try { return {kind:'data',card:JSON.parse(Buffer.from(uri.split(',')[1],'base64').toString('utf8'))}; }
  catch { throw new AppError('CARD_INVALID',422); }
}

/** Format a fixed-point int128 feedback value, e.g. (8750, 2) → "87.5". */
export function formatFixed(value:bigint,decimals:number) {
  const negative=value<0n, abs=negative?-value:value, scale=10n**BigInt(decimals);
  const fraction=decimals?(abs%scale).toString().padStart(decimals,'0').replace(/0+$/,''):'';
  return `${negative?'-':''}${abs/scale}${fraction?`.${fraction}`:''}`;
}

async function accountIdForEvm(evm:string,mirror:Mirror) {
  return (await mirror.json<MirrorAccount>(`/api/v1/accounts/${getAddress(evm)}`).catch(()=>null))?.account??null;
}

/**
 * Every review an agent has received. The registry's summary needs an explicit reviewer list (its
 * Sybil guard); this reads all reviewers, so callers must judge who the reviewers are.
 */
export async function readReputation(agentId:bigint,mirror:Mirror) {
  const clients=Array.from((await mirror.call(REPUTATION_REGISTRY,REPUTATION_ABI,'getClients',[agentId]))[0] as string[]);
  if(!clients.length) return {count:0,average:null,reviews:[]};
  const [summary,all]=await Promise.all([
    mirror.call(REPUTATION_REGISTRY,REPUTATION_ABI,'getSummary',[agentId,clients,'','']),
    mirror.call(REPUTATION_REGISTRY,REPUTATION_ABI,'readAllFeedback',[agentId,clients,'','',false]),
  ]);
  const accounts=new Map(await Promise.all(clients.map(async c=>[c.toLowerCase(),await accountIdForEvm(c,mirror)] as const)));
  const reviews=Array.from(all[0] as string[]).map((client,i)=>({
    reviewer:client,
    reviewerAccount:accounts.get(client.toLowerCase())??null,
    value:formatFixed(BigInt(all[2][i]),Number(all[3][i])),
    tag1:String(all[4][i]),
    tag2:String(all[5][i]),
  }));
  return {count:Number(summary[0]),average:Number(summary[0])?formatFixed(BigInt(summary[1]),Number(summary[2])):null,reviews};
}

export type Resolution=Awaited<ReturnType<typeof resolveAgent>>;

/**
 * Look up any agent by ERC-8004 ID and verify it the same way paid standing verifies this one:
 * the registry card, the HCS records published by its registry owner and guardian, the 1-of-2
 * account key, the policy contract and any guardian-approved agreement. Read-only.
 */
export async function resolveAgent(agentId:bigint,mirror=new Mirror()) {
  if(agentId<=0n) throw new AppError('INVALID_AGENT_ID',400);
  const [owner,uri]=await Promise.all([
    mirror.call(IDENTITY_REGISTRY,IDENTITY_ABI,'ownerOf',[agentId]),
    mirror.call(IDENTITY_REGISTRY,IDENTITY_ABI,'tokenURI',[agentId]),
  ]).catch(error=>{throw error instanceof AppError && error.code==='CONTRACT_REVERT'?new AppError('AGENT_NOT_FOUND',404):error;});
  const ownerEvm=String(owner[0]);
  const [ownerAccount,reputation]=await Promise.all([accountIdForEvm(ownerEvm,mirror),readReputation(agentId,mirror)]);
  const base={agentId:agentId.toString(),registry:IDENTITY_REGISTRY,owner:{evm:ownerEvm,account:ownerAccount},reputation};
  const parsed=parseCardUri(String(uri[0]));
  if(parsed.kind==='external') return {...base,status:'external-card' as const,cardUri:parsed.uri,reason:'The card is hosted at a URL; it is not fetched or verified here.'};
  const card=cardSchema.safeParse(parsed.card);
  if(!card.success) return {...base,status:'not-accountable' as const,name:typeof parsed.card.name==='string'?parsed.card.name:null,reason:'The card lacks the account, guardian, HCS topic, UAID and policy this template verifies.'};
  const c=card.data;
  const summary={...base,name:c.name,account:c.hederaAccount,guardian:c.guardian,hcsTopic:c.hcsTopic,uaid:c.uaid,policy:c.policy,standing:c.services?.find(s=>s.name==='standing')?.endpoint??null};
  try {
    if(!ownerAccount) throw new AppError('REGISTRY_OWNER_UNKNOWN');
    const guardian=await mirror.account(c.guardian);
    if(guardian.deleted || guardian.key._type!=='ECDSA_SECP256K1') throw new AppError('GUARDIAN_ACCOUNT_INVALID');
    // The agent key comes from the creation record the registry owner published to the topic.
    const events=await mirror.events(c.hcsTopic,{identityPublishers:[ownerAccount,c.guardian],agentAccount:c.hederaAccount});
    const created=events.filter(e=>e.type==='created' && e.publisher===ownerAccount).at(-1);
    const agentPublicKey=String(created?.payload.agentPublicKey??'');
    if(!/^(02|03)[\da-fA-F]{64}$/.test(agentPublicKey)) throw new AppError('HCS_NOT_READY');
    const facts=await readFacts({name:c.name,operatorId:ownerAccount,guardianId:c.guardian,guardianPublicKey:normalizedPublic(guardian.key.key),agentAccount:c.hederaAccount,agentPublicKey,hcsTopic:c.hcsTopic,policyAddress:c.policy,erc8004AgentId:agentId.toString(),uaid:c.uaid,registry:IDENTITY_REGISTRY},mirror);
    return {...summary,status:'verified' as const,agentKeyActive:facts.keyState.agentKeyActive,paused:facts.paused,maxPerTx:facts.maxPerTx.toString(),maxPerDay:facts.maxPerDay.toString(),agreement:facts.agreement??null};
  } catch(error) {
    // Fail closed: a card that cannot be fully verified is reported as such, never as trusted.
    return {...summary,status:'unverified' as const,reason:error instanceof AppError?error.code:'SOURCE_UNAVAILABLE'};
  }
}
