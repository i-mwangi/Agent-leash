import { AccountCreateTransaction, AccountUpdateTransaction, ContractCreateTransaction, ContractExecuteTransaction, ContractId, FileCreateTransaction, FileAppendTransaction, Hbar, KeyList, PrivateKey, PublicKey, TopicCreateTransaction, TopicMessageSubmitTransaction, TokenAssociateTransaction } from '@hiero-ledger/sdk';
import { AbiCoder, Wallet, getBytes } from 'ethers';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, DATA, readDeployment, saveDeployment } from '../../shared/src/files';
import { AppError, evmAddress, type Deployment, type ProfileEvent } from '../../shared/src/model';
import { Mirror } from '../../shared/src/mirror';
import { Store } from '../../shared/src/store';
import { accountKeyState, checkDeploymentKeys, normalizedPublic } from '../../shared/src/keys';
import { createUaid, agentData } from '../../shared/src/uaid';
import { POLICY_ABI, IDENTITY_ABI, cardUri } from '../../shared/src/sources';
import { clientFor, roleEnv, roleKey, nativeOperation, createSecretFile } from './runtime';

export async function initialize() {
  const operatorEnv=roleEnv('operator');
  if(operatorEnv.HEDERA_NETWORK!=='testnet') throw new AppError('TESTNET_ONLY');
  const operator=roleKey('operator');
  const info=await new Mirror().account(operatorEnv.HEDERA_OPERATOR_ID);
  if(info.deleted || info.key._type!=='ECDSA_SECP256K1' || normalizedPublic(info.key.key)!==operator.publicKey.toStringRaw()) throw new AppError('OPERATOR_ACCOUNT_KEY_MISMATCH');
  let d=readDeployment();
  if(d) {checkDeploymentKeys(d); if(d.operatorId!==info.account || d.operatorPublicKey!==operator.publicKey.toStringRaw()) throw new AppError('EXISTING_DEPLOYMENT_OPERATOR_MISMATCH'); return d;}
  for(const role of ['agent','guardian'] as const) if(!existsSync(resolve(ROOT,`.env.${role}`))) createSecretFile(role,`${role.toUpperCase()}_PRIVATE_KEY=${PrivateKey.generateECDSA().toStringRaw()}\n`);
  if(!existsSync(resolve(ROOT,'.env.server'))) createSecretFile('server',`APP_MODE=testnet\nATTESTATION_PRIVATE_KEY=${Wallet.createRandom().privateKey}\n`);
  const agent=roleKey('agent'),guardian=roleKey('guardian'),attestation=new Wallet(roleEnv('server').ATTESTATION_PRIVATE_KEY);
  d={version:1,network:'testnet',name:'Atlas',operatorId:info.account,operatorPublicKey:operator.publicKey.toStringRaw(),agentPublicKey:agent.publicKey.toStringRaw(),guardianPublicKey:guardian.publicKey.toStringRaw(),attestationPublicKey:attestation.signingKey.compressedPublicKey.slice(2),attestationAddress:attestation.address,registry:'0x8004A818BFB912233c491871b3d84c89A494BD9e',standingBaseUrl:'http://localhost:3001',routerId:'0.0.19264',spendAsset:'0.0.429274',outputAsset:'0.0.15058'};
  checkDeploymentKeys(d); saveDeployment(d); return d;
}
export async function publish(d:Deployment,type:ProfileEvent['type'],payload:Record<string,unknown>,role:'operator'|'guardian'|'agent',name:string,store:Store) {
  if(!d.agentAccount || !d.hcsTopic) throw new AppError('HCS_NOT_READY');
  const event:ProfileEvent={v:1,type,ts:new Date().toISOString(),agentAccount:d.agentAccount,payload};
  const content=JSON.stringify(event);
  if(Buffer.byteLength(content)>1024) throw new AppError('HCS_MESSAGE_TOO_LARGE');
  const payer=role==='operator'?d.operatorId:role==='guardian'?d.guardianId!:d.agentAccount;
  const client=clientFor(payer,roleKey(role));
  try{return await nativeOperation(name,new TopicMessageSubmitTransaction().setTopicId(d.hcsTopic).setMessage(content),client,store);}finally{client.close();}
}
export async function setup() {
  const d=await initialize(); const store=new Store(resolve(DATA,'operator.sqlite'));
  const mirror=new Mirror(); const operator=roleKey('operator'); const client=clientFor(d.operatorId,operator);
  try { return await store.exclusive('setup',async()=>{
    if(!d.guardianId) {
      const guardian=roleKey('guardian');
      const created=await nativeOperation('create-guardian',new AccountCreateTransaction().setKeyWithoutAlias(guardian.publicKey).setAlias(guardian.publicKey.toEvmAddress()).setInitialBalance(new Hbar(10)).setMaxAutomaticTokenAssociations(5),client,store,[guardian]);
      d.guardianId=created.accountId!; saveDeployment(d);
    }
    if(!d.agentAccount) {
      const created=await nativeOperation('create-agent',new AccountCreateTransaction().setKeyWithoutAlias(new KeyList([PublicKey.fromStringECDSA(d.agentPublicKey),PublicKey.fromStringECDSA(d.guardianPublicKey)],1)).setInitialBalance(new Hbar(10)).setMaxAutomaticTokenAssociations(5),client,store);
      d.agentAccount=created.accountId!; saveDeployment(d);
    }
    const account=await mirror.account(d.agentAccount);
    accountKeyState(account.key,d.agentPublicKey,d.guardianPublicKey);
    if(!d.hcsTopic) {
      const created=await nativeOperation('create-topic',new TopicCreateTransaction().setTopicMemo('Accountable Agent v1').setAdminKey(PublicKey.fromStringECDSA(d.guardianPublicKey)).setSubmitKey(new KeyList([operator.publicKey,PublicKey.fromStringECDSA(d.guardianPublicKey),PublicKey.fromStringECDSA(d.agentPublicKey)],1)),client,store,[roleKey('guardian')]);
      d.hcsTopic=created.topicId!; saveDeployment(d);
    }
    await publish(d,'created',{guardian:d.guardianId,agentPublicKey:d.agentPublicKey},'operator','hcs-created',store);
    d.uaid=createUaid(agentData(d.name,d.agentAccount));saveDeployment(d);
    await publish(d,'uaid',{uaid:d.uaid},'operator','hcs-uaid',store);
    if(!d.policyAddress) {
      const artifact=JSON.parse(readFileSync(resolve(ROOT,'packages/contracts/artifacts/contracts/PolicyRegistry.sol/PolicyRegistry.json'),'utf8')) as {bytecode:string};
      const bytecode=artifact.bytecode.replace(/^0x/,'');
      // Hedera ContractCreateTransaction decodes hex text from the bytecode file.
      const file=await nativeOperation('policy-bytecode-hex-file',new FileCreateTransaction().setKeys([operator.publicKey]).setContents(bytecode.slice(0,2048)),client,store);
      for(let offset=2048;offset<bytecode.length;offset+=2048) await nativeOperation(`policy-bytecode-hex-${offset}`,new FileAppendTransaction().setFileId(file.fileId!).setContents(bytecode.slice(offset,offset+2048)),client,store);
      const guardianAccount=await mirror.account(d.guardianId);
      const args=AbiCoder.defaultAbiCoder().encode(['address','string','uint256','uint256'],[guardianAccount.evm_address,d.agentAccount,1_000_000n,5_000_000n]);
      const policy=await nativeOperation('deploy-policy',new ContractCreateTransaction().setBytecodeFileId(file.fileId!).setGas(1_500_000).setConstructorParameters(getBytes(args)),client,store);
      d.policyContractId=policy.contractId!;d.policyAddress=evmAddress(policy.contractId!);saveDeployment(d);
    }
    const guardianClient=clientFor(d.guardianId,roleKey('guardian'));
    try { await nativeOperation('policy-allow-usdc',new ContractExecuteTransaction().setContractId(d.policyContractId!).setGas(300000).setFunctionParameters(getBytes(POLICY_ABI.encodeFunctionData('setAllowedTokens',[[d.spendAsset],true]))),guardianClient,store); }finally{guardianClient.close();}
    await publish(d,'policy',{address:d.policyAddress},'operator','hcs-policy',store);
    const agentClient=clientFor(d.agentAccount,roleKey('agent'));
    try {
      for(const token of [d.spendAsset,d.outputAsset]) {
        const associations=await mirror.json<{tokens:{token_id:string}[]}>(`/api/v1/accounts/${d.agentAccount}/tokens?token.id=${token}`);
        if(!associations.tokens.some(t=>t.token_id===token)) await nativeOperation('associate-'+token,new TokenAssociateTransaction().setAccountId(d.agentAccount).setTokenIds([token]),agentClient,store);
      }
    } finally{agentClient.close();}
    console.log('Account, profile, UAID and policy configured.'); return d;
  });}finally{client.close();store.close();}
}
export async function register() {
  const d=readDeployment(); if(!d?.hcsTopic || !d.uaid || !d.policyAddress || !d.agentAccount) throw new AppError('SETUP_REQUIRED');
  const events=await new Mirror().events(d.hcsTopic);
  if(!events.some(e=>e.type==='uaid' && e.payload.uaid===d.uaid && e.publisher===d.operatorId)) throw new AppError('HCS_UAID_MISSING');
  const store=new Store(resolve(DATA,'operator.sqlite')); const client=clientFor(d.operatorId,roleKey('operator'));
  try {return await store.exclusive('register',async()=>{
    if(!d.erc8004AgentId) {
      const result=await nativeOperation('erc8004-register',new ContractExecuteTransaction().setContractId(ContractId.fromEvmAddress(0,0,d.registry)).setGas(2_000_000).setFunctionParameters(getBytes(IDENTITY_ABI.encodeFunctionData('register',[cardUri(d)]))),client,store,[],true);
      let returnData=result.returnData;
      if(!returnData) {const record=await new Mirror().json<{call_result:string}>(`/api/v1/contracts/results/${result.txId.replace('@','-').replace(/\.(\d{9})$/,'-$1')}`); returnData='0x'+record.call_result.replace(/^0x/,'');}
      d.erc8004AgentId=IDENTITY_ABI.decodeFunctionResult('register',returnData)[0].toString();saveDeployment(d);
    }
    await nativeOperation('erc8004-card-update',new ContractExecuteTransaction().setContractId(ContractId.fromEvmAddress(0,0,d.registry)).setGas(2_000_000).setFunctionParameters(getBytes(IDENTITY_ABI.encodeFunctionData('setAgentURI',[d.erc8004AgentId,cardUri(d)]))),client,store);
    await publish(d,'registered',{agentId:d.erc8004AgentId,registry:d.registry},'operator','hcs-registered',store);
    return d;
  });}finally{client.close();store.close();}
}
export async function guardianAction(action:'pause'|'unpause'|'revoke'|'caps',caps?:[bigint,bigint]) {
  const d=readDeployment();if(!d?.agentAccount || !d.guardianId || !d.policyContractId) throw new AppError('SETUP_REQUIRED');
  const key=roleKey('guardian');if(key.publicKey.toStringRaw()!==d.guardianPublicKey) throw new AppError('GUARDIAN_KEY_MISMATCH');
  const client=clientFor(d.guardianId,key);const store=new Store(resolve(DATA,'guardian.sqlite'));const name=`${action}-${Date.now()}`;
  try{return await store.exclusive('guardian-action',async()=>{
    if(action==='revoke') {
      const result=await nativeOperation(name,new AccountUpdateTransaction().setAccountId(d.agentAccount!).setKey(key.publicKey),client,store,[key]);
      await publish(d,'rotated',{agentKeyActive:false,transactionId:result.txId},'guardian',name+'-hcs',store);return result;
    }
    const method=action==='caps'?'setCaps':action;
    const result=await nativeOperation(name,new ContractExecuteTransaction().setContractId(d.policyContractId!).setGas(300000).setFunctionParameters(getBytes(POLICY_ABI.encodeFunctionData(method,caps??[]))),client,store);
    await publish(d,action==='caps'?'policy':action==='pause'?'paused':'unpaused',{address:d.policyAddress,transactionId:result.txId},'guardian',name+'-hcs',store);return result;
  });}finally{client.close();store.close();}
}
