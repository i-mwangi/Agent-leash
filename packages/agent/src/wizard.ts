import { KeyList, PublicKey } from '@hiero-ledger/sdk';
import { Wallet } from 'ethers';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DATA, ROOT, atomicJson, readDeployment, saveDeployment } from '../../shared/src/files';
import { AppError, entityId, publicKey, type Deployment } from '../../shared/src/model';
import { Mirror, type MirrorKey } from '../../shared/src/mirror';
import { checkDeploymentKeys, decodeMirrorKey, normalizedPublic } from '../../shared/src/keys';
import { FALLBACK, readFacts } from '../../shared/src/sources';
import { agreementHash, walletAgreementPayload } from '../../shared/src/agreement';
import { register, setup } from './setup';
import { currentTerms } from './agreement';
import { roleEnv, roleKey } from './runtime';

/** HBAR the guardian sends to the generated setup account; a measured testnet setup used 28.7. */
export const SETUP_FUNDING_TINYBARS=4_500_000_000n;
export const TOPIC_MEMO='Accountable Agent v1';
const SETUP=resolve(DATA,'setup.json');
const setupSchema=z.object({guardianId:entityId,guardianPublicKey:publicKey}).strict();

export type Stage='connect'|'fund'|'topic'|'allow'|'agreement'|'done'|'cli';
export interface Progress {
  stage:Stage;
  guardianId?:string;
  operatorId?:string;
  operatorPublicKey:string;
  agentPublicKey:string;
  fundingTinybars:string;
  deployment?:Pick<Deployment,'agentAccount'|'guardianId'|'hcsTopic'|'policyContractId'|'policyAddress'|'erc8004AgentId'|'uaid'|'spendAsset'>;
  topic?:{memo:string;adminKey:string;submitKeys:string[];threshold:number};
  allow?:{policyContractId:string;spendAsset:string};
  agreement?:{message:string;hash:string;terms:Record<string,unknown>};
}

function localKeys() {
  return {operatorPublicKey:roleKey('operator').publicKey.toStringRaw(),agentPublicKey:roleKey('agent').publicKey.toStringRaw(),attestation:new Wallet(roleEnv('server').ATTESTATION_PRIVATE_KEY)};
}
function publicView(d:Deployment):Progress['deployment'] {
  return {agentAccount:d.agentAccount,guardianId:d.guardianId,hcsTopic:d.hcsTopic,policyContractId:d.policyContractId,policyAddress:d.policyAddress,erc8004AgentId:d.erc8004AgentId,uaid:d.uaid,spendAsset:d.spendAsset};
}
function readSetup() { return existsSync(SETUP)?setupSchema.parse(JSON.parse(readFileSync(SETUP,'utf8'))):null; }

/** Record the connected wallet as guardian after checking it can sign as a distinct ECDSA key. */
export async function chooseGuardian(accountId:string,mirror=new Mirror()) {
  const existing=readDeployment()??null;
  if(existing) throw new AppError('DEPLOYMENT_ALREADY_CONFIGURED',409);
  const account=await mirror.account(entityId.parse(accountId));
  if(account.deleted || account.key._type!=='ECDSA_SECP256K1') throw new AppError('GUARDIAN_MUST_BE_ACTIVE_ECDSA',422);
  const guardianPublicKey=normalizedPublic(account.key.key);
  const {operatorPublicKey,agentPublicKey,attestation}=localKeys();
  const attestationPublicKey=attestation.signingKey.compressedPublicKey.slice(2);
  if([operatorPublicKey,agentPublicKey,attestationPublicKey].map(normalizedPublic).includes(guardianPublicKey)) throw new AppError('KEY_ROLES_MUST_BE_DISTINCT',422);
  atomicJson(SETUP,{guardianId:account.account,guardianPublicKey});
  return {guardianId:account.account};
}

/** The generated setup key has no account until the guardian funds one; find it by its key. */
export async function findSetupAccount(operatorPublicKey:string,mirror:Mirror) {
  const page=await mirror.json<{accounts:{account:string;deleted:boolean;key:MirrorKey|null}[]}>(`/api/v1/accounts?account.publickey=${operatorPublicKey}&balance=false&limit=25&order=asc`);
  const match=page.accounts.find(a=>!a.deleted && a.key?._type==='ECDSA_SECP256K1' && normalizedPublic(a.key.key)===normalizedPublic(operatorPublicKey));
  return match?.account;
}

function operatorIdFromEnv() { const id=roleEnv('operator').HEDERA_OPERATOR_ID; return id?entityId.parse(id.trim()):undefined; }
/** Add the discovered account ID to the generated key file without rewriting the key. */
function recordOperatorId(id:string) {
  const path=resolve(ROOT,'.env.operator');
  const text=readFileSync(path,'utf8');
  if(/^HEDERA_OPERATOR_ID=\S/m.test(text)) return;
  writeFileSync(path,text.replace(/^HEDERA_OPERATOR_ID=.*$/m,'').replace(/\n*$/,'\n')+`HEDERA_OPERATOR_ID=${id}\n`,{mode:0o600});
}

function initializeWallet(operatorId:string,guardian:{guardianId:string;guardianPublicKey:string}):Deployment {
  if(roleEnv('operator').HEDERA_NETWORK!=='testnet') throw new AppError('TESTNET_ONLY');
  const {operatorPublicKey,agentPublicKey,attestation}=localKeys();
  const d:Deployment={version:1,network:'testnet',name:'Atlas',operatorId,operatorPublicKey,guardianId:guardian.guardianId,guardianPublicKey:guardian.guardianPublicKey,agentPublicKey,attestationPublicKey:attestation.signingKey.compressedPublicKey.slice(2),attestationAddress:attestation.address,registry:'0x8004A818BFB912233c491871b3d84c89A494BD9e',standingBaseUrl:'http://localhost:3001',routerId:'0.0.19264',spendAsset:FALLBACK.assetIn,outputAsset:FALLBACK.assetOut,guardianMode:'wallet'};
  checkDeploymentKeys(d); saveDeployment(d); return d;
}

export function expectedTopicKeys(d:Pick<Deployment,'operatorPublicKey'|'guardianPublicKey'|'agentPublicKey'>) {
  return {memo:TOPIC_MEMO,adminKey:normalizedPublic(d.guardianPublicKey),submitKeys:[d.operatorPublicKey,d.guardianPublicKey,d.agentPublicKey].map(normalizedPublic),threshold:1};
}
/** True when a mirror topic has exactly the guardian admin key and the 1-of-3 submit key list. */
export function topicMatches(topic:{memo:string;deleted?:boolean;admin_key:MirrorKey|null;submit_key:MirrorKey|null},expected:ReturnType<typeof expectedTopicKeys>) {
  if(topic.deleted || topic.memo!==expected.memo || !topic.admin_key || !topic.submit_key) return false;
  const admin=decodeMirrorKey(topic.admin_key),submit=decodeMirrorKey(topic.submit_key);
  if(!(admin instanceof PublicKey) || admin.toStringRaw()!==expected.adminKey) return false;
  if(!(submit instanceof KeyList) || submit.threshold!==expected.threshold) return false;
  const keys=submit.toArray().map(k=>k instanceof PublicKey?k.toStringRaw():'unsupported');
  return keys.length===expected.submitKeys.length && expected.submitKeys.every(k=>keys.includes(k));
}
/** Find a successful topic the guardian created for this workspace's exact keys. */
export async function findGuardianTopic(d:Deployment,mirror:Mirror) {
  const expected=expectedTopicKeys(d);
  const page=await mirror.json<{transactions:{transaction_id:string;entity_id:string|null;result:string}[]}>(`/api/v1/transactions?account.id=${d.guardianId}&transactiontype=CONSENSUSCREATETOPIC&result=success&limit=25&order=desc`);
  for(const tx of page.transactions) {
    if(!tx.transaction_id.startsWith(`${d.guardianId}-`) || !tx.entity_id) continue;
    const topic=await mirror.json<{memo:string;deleted:boolean;admin_key:MirrorKey|null;submit_key:MirrorKey|null}>(`/api/v1/topics/${tx.entity_id}`);
    if(topicMatches(topic,expected)) return tx.entity_id;
  }
  return undefined;
}

/**
 * Run every setup step that needs no wallet approval and report the next one that does.
 * Each on-chain write goes through the resumable operation store, so repeating this is safe.
 */
export async function advance(mirror=new Mirror()):Promise<Progress> {
  const {operatorPublicKey,agentPublicKey}=localKeys();
  const base={operatorPublicKey,agentPublicKey,fundingTinybars:SETUP_FUNDING_TINYBARS.toString()};
  let d=readDeployment();
  if(d && d.guardianMode!=='wallet') return {...base,stage:'cli',deployment:publicView(d)};
  const guardian=d?{guardianId:d.guardianId!,guardianPublicKey:d.guardianPublicKey}:readSetup();
  if(!guardian) return {...base,stage:'connect'};
  if(!d) {
    const operatorId=operatorIdFromEnv()??await findSetupAccount(operatorPublicKey,mirror);
    if(!operatorId) return {...base,stage:'fund',guardianId:guardian.guardianId};
    const operator=await mirror.account(operatorId);
    if(operator.deleted || operator.key._type!=='ECDSA_SECP256K1' || normalizedPublic(operator.key.key)!==operatorPublicKey) throw new AppError('OPERATOR_ACCOUNT_KEY_MISMATCH');
    recordOperatorId(operatorId);
    d=initializeWallet(operatorId,guardian);
  }
  const common={...base,guardianId:d.guardianId,operatorId:d.operatorId};
  if(!d.hcsTopic) {
    await setup(); // Creates the agent account, then stops for the guardian's topic.
    d=readDeployment()!;
    const topic=await findGuardianTopic(d,mirror);
    if(!topic) return {...common,stage:'topic',deployment:publicView(d),topic:expectedTopicKeys(d)};
    d.hcsTopic=topic; saveDeployment(d);
  }
  const configured=await setup();
  d=readDeployment()!;
  if(configured.waitingFor==='allow') return {...common,stage:'allow',deployment:publicView(d),allow:{policyContractId:d.policyContractId!,spendAsset:d.spendAsset}};
  await register();
  d=readDeployment()!;
  const {agreement,approved}=await currentTerms();
  if(!approved) {
    const payload=walletAgreementPayload(agreement);
    const message=JSON.stringify({v:1,type:'agreement',ts:new Date().toISOString(),agentAccount:d.agentAccount,payload});
    if(Buffer.byteLength(message)>1024) throw new AppError('HCS_MESSAGE_TOO_LARGE');
    return {...common,stage:'agreement',deployment:publicView(d),agreement:{message,hash:agreementHash(agreement),terms:agreement}};
  }
  await readFacts(d,mirror); // Full identity, policy and agreement verification before reporting done.
  return {...common,stage:'done',deployment:publicView(d)};
}
