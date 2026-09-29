import { describe,it,expect,vi } from 'vitest';
import { Wallet,getBytes,ZeroHash,ZeroAddress,Interface } from 'ethers';
import { readVaultReport,type VaultRecord } from '../packages/shared/src/vaultSource';
import { compileVaultTerms,vaultTermsHash } from '../packages/shared/src/vaultTerms';
import { Mirror } from '../packages/shared/src/mirror';
import { evmAddress,type Deployment } from '../packages/shared/src/model';
import { signStanding,verifyStanding,type StandingV3Message } from '../packages/shared/src/standing';
import { createApp } from '../packages/server/src/app';
import type { LiveServices } from '../packages/server/src/live';
import { planVaultAction,confirmVaultTransaction } from '../packages/nextjs/app/vault-wallet-actions';
import golden from './fixtures/uaid.json';

const guardian=new Wallet('0x'+'1'.padStart(64,'0'));
const d={agentAccount:'0.0.3',guardianId:'0.0.2'} as Deployment;
const context={network:'hedera:testnet' as const,agentAccount:'0.0.3',guardianAccount:'0.0.2'};
const terms=compileVaultTerms(`No more than 1 HBAR per transaction and 5 HBAR per UTC day; only to ${guardian.address}.`);
const hash=vaultTermsHash(terms,context);
async function fixture() {
  const record:VaultRecord={context,terms,hash,signature:await guardian.signMessage(getBytes(hash)),contractId:'0.0.4',contractAddress:evmAddress('0.0.4')};
  const mirror=new Mirror();
  const chain:Record<string,unknown[]>={guardian:[guardian.address],agent:[ZeroAddress],paused:[true],maxPerTx:[100000000n],maxPerDay:[500000000n],agreementHash:[hash],recipients:[[guardian.address]],spentByUtcDay:[0n]};
  vi.spyOn(mirror,'call').mockImplementation(async(_address,_abi,method)=>chain[method] as never);
  vi.spyOn(mirror,'account').mockImplementation(async(id)=>({account:id,deleted:false,evm_address:guardian.address,key:{_type:'ECDSA_SECP256K1',key:''},balance:{balance:2000000,tokens:[]}}));
  return {record,mirror,chain};
}
describe('vault standing source',()=>{
  it('verifies signed approval and complete rules while reporting paused and revoked state',async()=>{
    const {record,mirror}=await fixture();
    expect(await readVaultReport(d,mirror,record)).toMatchObject({termsHash:hash,paused:true,agent:ZeroAddress,balanceTinybars:'2000000',allowedRecipients:[guardian.address]});
    expect(await readVaultReport(d,mirror,null)).toBeNull();
  });
  it('fails closed for drift, another agent, invalid signature, unsafe balance and mirror failure',async()=>{
    for(const change of ['recipients','agent','signature','balance','offline']) {
      const {record,mirror,chain}=await fixture();
      if(change==='recipients')chain.recipients=[[guardian.address,evmAddress('0.0.9')]];
      if(change==='agent')chain.agent=[evmAddress('0.0.9')];
      if(change==='signature')record.signature='0x00';
      if(change==='balance')vi.mocked(mirror.account).mockResolvedValue({deleted:false,evm_address:guardian.address,balance:{balance:Number.MAX_SAFE_INTEGER+1,tokens:[]}} as never);
      if(change==='offline')vi.mocked(mirror.call).mockRejectedValue(new Error('offline'));
      await expect(readVaultReport(d,mirror,record)).rejects.toThrow();
    }
  });
  it('refuses to issue or settle a payment when the configured vault is unverified',async()=>{
    const requirements=vi.fn(),accept=vi.fn();
    const services={deployment:d,ready:async()=>{throw new Error('VAULT_POLICY_MISMATCH');},payments:{requirements,accept}} as unknown as LiveServices;
    const app=createApp('testnet',()=>services);
    for(const headers of [new Headers(),new Headers({'PAYMENT-SIGNATURE':'not-a-payment'})]) {
      const response=await app.request('/standing/0.0.3',{headers});
      expect(response.status).toBe(503);expect(await response.json()).toMatchObject({paymentRequired:false});
    }
    expect(requirements).not.toHaveBeenCalled();expect(accept).not.toHaveBeenCalled();
  });
});
describe('version 3 signed vault report',()=>{
  it('binds all vault fields, checks expected deployment, links and downgrade rejection',async()=>{
    const {record,mirror}=await fixture();const vault=(await readVaultReport(d,mirror,record))!;
    const now=Math.floor(Date.now()/1000),policy=evmAddress('0.0.5');
    const message:StandingV3Message={publicId:'agent:1',hederaAccount:'0.0.3',erc8004AgentId:'1',uaid:golden.uaid,paused:false,agentKeyActive:true,maxPerTx:'10',maxPerDay:'100',hcsTopic:'0.0.6',hashscanAccount:'https://hashscan.io/testnet/account/0.0.3',issuedAt:now,expiresAt:now+120,agreementHash:ZeroHash,agreementVersion:0,vault};
    const report=await signStanding(message,policy,guardian);
    expect(report.domain.version).toBe('3');
    expect(verifyStanding(report,guardian.address,policy,'0.0.3',now,undefined,vault)).toEqual(message);
    for(const patch of [{paused:false},{balanceTinybars:'999'},{allowedRecipients:[evmAddress('0.0.9')]},{maxPerTxTinybars:'999'},{agent:evmAddress('0.0.9')}]) {
      expect(()=>verifyStanding({...report,message:{...message,vault:{...vault,...patch}}},guardian.address,policy,'0.0.3',now)).toThrow('SIGNER_MISMATCH');
    }
    expect(()=>verifyStanding({...report,links:{...report.links,vault:'https://example.com'}},guardian.address,policy,'0.0.3',now)).toThrow('LINK_MISMATCH');
    expect(()=>verifyStanding(report,guardian.address,policy,'0.0.3',now,undefined,{...vault,contractAddress:evmAddress('0.0.9')})).toThrow('VAULT_MISMATCH');
    const {vault:_,agreementHash:__,agreementVersion:___,...v1}=message;
    const legacy=await signStanding(v1,policy,guardian);
    expect(()=>verifyStanding(legacy,guardian.address,policy,'0.0.3',now,undefined,vault)).toThrow('VAULT_MISMATCH');
  });
});
describe('browser vault transaction boundary',()=>{
  it('requires the guardian, recovery pause and an active revoke target',async()=>{
    const {record,mirror}=await fixture();const vault=(await readVaultReport(d,mirror,record))!;
    expect(()=>planVaultAction(vault,'unpause','0.0.2','0.0.9')).toThrow('guardian');
    expect(()=>planVaultAction({...vault,paused:false},'recover','0.0.2','0.0.2')).toThrow('Pause');
    expect(()=>planVaultAction(vault,'revoke','0.0.2','0.0.2')).toThrow('already revoked');
    const planned=planVaultAction(vault,'recover','0.0.2','0.0.2');
    const abi=new Interface(['function recover(address)']);
    expect(abi.decodeFunctionData('recover',planned.data)[0]).toBe(guardian.address);
  });
  it('confirms exact payer, target and calldata; never treats missing receipts as success',async()=>{
    const {record,mirror}=await fixture();const vault=(await readVaultReport(d,mirror,record))!;
    const request=planVaultAction(vault,'unpause','0.0.2','0.0.2');
    const txId='0.0.2@1700000000.000000001';
    const result={contract_id:'0.0.4',function_parameters:request.data.slice(2),error_message:null};
    const transaction={transaction_id:'0.0.2-1700000000-000000001',nonce:0,result:'SUCCESS',name:'CONTRACTCALL',entity_id:'0.0.4'};
    const fetcher=vi.fn(async(url)=>new Response(JSON.stringify(String(url).includes('/transactions/')?{transactions:[transaction]}:result))) as typeof fetch;
    expect(await confirmVaultTransaction(request,txId,fetcher)).toBe(true);
    result.function_parameters='deadbeef';await expect(confirmVaultTransaction(request,txId,fetcher)).rejects.toThrow('evidence mismatch');
    await expect(confirmVaultTransaction(request,txId.replace('0.0.2','0.0.9'),fetcher)).rejects.toThrow('payer mismatch');
    expect(await confirmVaultTransaction(request,txId,async()=>new Response('',{status:404}))).toBe(false);
  });
});
