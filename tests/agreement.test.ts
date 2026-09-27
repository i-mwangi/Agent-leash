import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { agreementHash, canonicalAgreement, signAgreement, verifyAgreement, type Agreement } from '../packages/shared/src/agreement';
import { signStanding, verifyStanding, type StandingV2Message } from '../packages/shared/src/standing';
import golden from './fixtures/uaid.json';

const guardian=new Wallet('0x'+'1'.padStart(64,'0'));
const attestor=new Wallet('0x'+'2'.padStart(64,'0'));
const policy='0x0000000000000000000000000000000000000125';
const agreement:Agreement={version:1,scope:'client-enforced',agentAccount:'0.0.123',guardianAccount:'0.0.124',policyContract:policy,spendAsset:'0.0.429274',maxPerTx:'1000000',maxPerDay:'5000000'};

describe('guardian-approved technical policy record',()=>{
  it('pins canonical bytes, digest and guardian signature',async()=>{
    expect(canonicalAgreement(agreement)).toBe('{"version":1,"scope":"client-enforced","agentAccount":"0.0.123","guardianAccount":"0.0.124","policyContract":"0x0000000000000000000000000000000000000125","spendAsset":"0.0.429274","maxPerTx":"1000000","maxPerDay":"5000000"}');
    expect(agreementHash(agreement)).toBe('0x5d1a9cd255225096746006f3d58205a71e540185fe4a87ebcade96beee5545d7');
    const signed=await signAgreement(agreement,guardian);
    expect(signed.signature).toBe('0x8d6b8b4ae96270bf3d4ad668e2e94a6125ac1f7cbd165e5c0d67e315b073e750228a147d13dc75942f44312a5d1d0ea48c485ead0a5d944f19728f669f9466eb1c');
    expect(verifyAgreement(signed,guardian.address)).toEqual(signed);
    expect(()=>verifyAgreement({...signed,agreement:{...agreement,maxPerTx:'1000001'}},guardian.address)).toThrow('HASH_MISMATCH');
    expect(()=>verifyAgreement(signed,attestor.address)).toThrow('GUARDIAN_MISMATCH');
    expect(()=>canonicalAgreement({...agreement,approvedCounterparties:[]} as Agreement)).toThrow();
  });
  it('binds a versioned standing signature to the HCS agreement digest',async()=>{
    const message:StandingV2Message={publicId:'agent:1',hederaAccount:agreement.agentAccount,erc8004AgentId:'1',uaid:golden.uaid,paused:false,agentKeyActive:true,maxPerTx:agreement.maxPerTx,maxPerDay:agreement.maxPerDay,hcsTopic:'0.0.456',hashscanAccount:'https://hashscan.io/testnet/account/0.0.123',issuedAt:1700000000,expiresAt:1700000120,agreementHash:agreementHash(agreement),agreementVersion:1};
    const signed=await signStanding(message,policy,attestor);
    expect(signed.domain.version).toBe('2');
    expect(verifyStanding(signed,attestor.address,policy,agreement.agentAccount,1700000001,{hash:message.agreementHash,version:1})).toEqual(message);
    expect(()=>verifyStanding(signed,attestor.address,policy,agreement.agentAccount,1700000001,{hash:'0x'+'0'.repeat(64),version:1})).toThrow('AGREEMENT_MISMATCH');
    expect(()=>verifyStanding({...signed,message:{...message,agreementVersion:2}},attestor.address,policy,agreement.agentAccount,1700000001)).toThrow('SIGNER_MISMATCH');
    const {agreementHash:_,agreementVersion:__,...v1}=message;
    const legacy=await signStanding(v1,policy,attestor);
    expect(()=>verifyStanding(legacy,attestor.address,policy,agreement.agentAccount,1700000001,{hash:message.agreementHash,version:1})).toThrow('AGREEMENT_MISMATCH');
  });
});
