import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Wallet } from 'ethers';
import { DATA, atomicJson, readDeployment } from '../../shared/src/files';
import { AppError, type Deployment } from '../../shared/src/model';
import { Mirror } from '../../shared/src/mirror';
import { POLICY_ABI, readFacts } from '../../shared/src/sources';
import { agreementHash, agreementSchema, canonicalAgreement, signAgreement, verifyAgreement, type Agreement } from '../../shared/src/agreement';
import { Store } from '../../shared/src/store';
import { publish, register, setup } from './setup';
import { roleKey } from './runtime';

export const AGREEMENT_DRAFT=resolve(DATA,'agreement-draft.json');
function identity(d:Deployment) {
  return {agentAccount:d.agentAccount,guardianAccount:d.guardianId,hcsTopic:d.hcsTopic,erc8004AgentId:d.erc8004AgentId,policyContract:d.policyAddress,accountLink:`https://hashscan.io/testnet/account/${d.agentAccount}`,topicLink:`https://hashscan.io/testnet/topic/${d.hcsTopic}`};
}

function terms(d:Deployment,facts:Awaited<ReturnType<typeof readFacts>>,version:number):Agreement {
  return agreementSchema.parse({version,scope:'client-enforced',agentAccount:d.agentAccount,guardianAccount:d.guardianId,policyContract:d.policyAddress,spendAsset:d.spendAsset,maxPerTx:facts.maxPerTx.toString(),maxPerDay:facts.maxPerDay.toString()});
}
export async function currentTerms() {
  const d=readDeployment();
  if(!d?.agentAccount || !d.guardianId || !d.policyAddress || !d.hcsTopic || !d.erc8004AgentId) throw new AppError('SETUP_REQUIRED');
  const mirror=new Mirror();
  const facts=await readFacts(d,mirror,false);
  const allowed=await mirror.call(facts.policy,POLICY_ABI,'allowedTokens',[d.spendAsset]);
  if(!allowed[0]) throw new AppError('AGREEMENT_ASSET_NOT_ALLOWED');
  const previous=facts.agreement;
  const sameVersion=terms(d,facts,previous?.version??1);
  const approved=Boolean(previous && previous.hash===agreementHash(sameVersion));
  const agreement=approved?sameVersion:terms(d,facts,previous?previous.version+1:1);
  return {d,mirror,facts,agreement,approved};
}

/** Builds a reviewable draft; it never signs or submits anything. */
export async function prepareAgreement() {
  const {d,agreement,approved}=await currentTerms();
  if(approved) return {...identity(d),approved:true,hash:agreementHash(agreement),version:agreement.version};
  if(existsSync(AGREEMENT_DRAFT)) {
    const existing=agreementSchema.parse(JSON.parse(readFileSync(AGREEMENT_DRAFT,'utf8')));
    if(canonicalAgreement(existing)!==canonicalAgreement(agreement)) throw new AppError('AGREEMENT_DRAFT_STALE');
  } else atomicJson(AGREEMENT_DRAFT,agreement);
  return {...identity(d),approved:false,draft:AGREEMENT_DRAFT,hash:agreementHash(agreement),version:agreement.version,next:'Review the draft, then run npm run agent -- approve-agreement'};
}

/** Explicit guardian approval; the signed policy record is published to HCS. */
export async function approveAgreement() {
  if(!existsSync(AGREEMENT_DRAFT)) throw new AppError('AGREEMENT_DRAFT_MISSING');
  const reviewed=agreementSchema.parse(JSON.parse(readFileSync(AGREEMENT_DRAFT,'utf8')));
  const {d,mirror,agreement,approved}=await currentTerms();
  if(approved) return {alreadyApproved:true,hash:agreementHash(agreement),version:agreement.version};
  if(canonicalAgreement(reviewed)!==canonicalAgreement(agreement)) throw new AppError('AGREEMENT_DRAFT_STALE');
  if(d.guardianMode==='wallet') throw new AppError('GUARDIAN_WALLET_APPROVES_IN_BROWSER');
  const key=roleKey('guardian');
  if(key.publicKey.toStringRaw()!==d.guardianPublicKey) throw new AppError('GUARDIAN_KEY_MISMATCH');
  const wallet=new Wallet('0x'+key.toStringRaw());
  const guardian=await mirror.account(d.guardianId!);
  if(wallet.address.toLowerCase()!==guardian.evm_address.toLowerCase()) throw new AppError('GUARDIAN_ACCOUNT_KEY_MISMATCH');
  const signed=verifyAgreement(await signAgreement(reviewed,wallet),wallet.address);
  const store=new Store(resolve(DATA,'guardian.sqlite'));
  try {
    return await store.exclusive('agreement-approval',async()=>{
      const result=await publish(d,'agreement',signed,'guardian',`agreement-${reviewed.version}-${signed.hash.slice(2,14)}`,store);
      return {transactionId:result.txId,hash:signed.hash,version:reviewed.version,topic:d.hcsTopic,hashscan:`https://hashscan.io/testnet/transaction/${encodeURIComponent(result.txId)}`};
    });
  } finally {store.close();}
}

/** Resumable account → profile → registry flow. Human approval is a separate explicit step. */
export async function onboard() {
  await setup();
  await register();
  return prepareAgreement();
}
