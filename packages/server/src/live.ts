import { Wallet } from 'ethers';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { DATA, ROOT, readDeployment } from '../../shared/src/files';
import { Mirror } from '../../shared/src/mirror';
import { Store } from '../../shared/src/store';
import { AppError, type Deployment } from '../../shared/src/model';
import { checkDeploymentKeys, normalizedPublic } from '../../shared/src/keys';
import { readFacts, resolvePublicId } from '../../shared/src/sources';
import { signStanding } from '../../shared/src/standing';
import { Payments } from './x402';
export interface LiveServices { deployment:Deployment; mirror:Mirror; payments:Payments; report:(id:string)=>Promise<unknown>; ready:(id:string)=>Promise<unknown> }
export function loadLiveServices():LiveServices|null {
  const d=readDeployment();
  const path=resolve(ROOT,'.env.server');
  if(!d || !existsSync(path)) return null;
  const env=parse(readFileSync(path));
  if(env.AGENT_PRIVATE_KEY || env.GUARDIAN_PRIVATE_KEY || env.HEDERA_OPERATOR_KEY) throw new AppError('SERVER_SPEND_KEY_PRESENT');
  if(!env.ATTESTATION_PRIVATE_KEY) return null;
  checkDeploymentKeys(d);
  const wallet=new Wallet(env.ATTESTATION_PRIVATE_KEY);
  if(normalizedPublic(wallet.signingKey.compressedPublicKey)!==d.attestationPublicKey || wallet.address.toLowerCase()!==d.attestationAddress.toLowerCase()) throw new AppError('ATTESTATION_KEY_MISMATCH');
  const mirror=new Mirror();
  const payments=new Payments(mirror,new Store(resolve(DATA,'server.sqlite')),d.operatorId);
  const ready=async(id:string)=>{if(!resolvePublicId(d,id)) throw new AppError('AGENT_NOT_FOUND',404); return readFacts(d,mirror);};
  return {deployment:d,mirror,payments,ready,report:async(id:string)=>{
    const facts=await ready(id); const issuedAt=Math.floor(Date.now()/1000);
    return signStanding({publicId:`eip155:296:${d.registry}:${d.erc8004AgentId}`,hederaAccount:d.agentAccount!,erc8004AgentId:d.erc8004AgentId!,uaid:d.uaid!,paused:facts.paused,agentKeyActive:facts.keyState.agentKeyActive,maxPerTx:facts.maxPerTx.toString(),maxPerDay:facts.maxPerDay.toString(),hcsTopic:d.hcsTopic!,hashscanAccount:`https://hashscan.io/testnet/account/${d.agentAccount}`,issuedAt,expiresAt:issuedAt+120},facts.policy,wallet);
  }};
}
