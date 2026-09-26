import { describe,it,expect,vi } from 'vitest';
import { AccountId, PrivateKey, KeyList, TransferTransaction, TransactionId } from '@hiero-ledger/sdk';
import { Wallet, getBytes, keccak256, recoverAddress } from 'ethers';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { canonicalAgent,createUaid } from '../packages/shared/src/uaid';
import { assertDistinctKeys,accountKeyState,rawDigestSigner } from '../packages/shared/src/keys';
import { Mirror,mirrorTxId,verifyTransfer } from '../packages/shared/src/mirror';
import { Store } from '../packages/shared/src/store';
import { Payments,type Facilitator } from '../packages/server/src/x402';
import { signStanding,verifyStanding,STANDING_TYPES,type StandingMessage } from '../packages/shared/src/standing';
import { proto } from '@hiero-ledger/proto';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentMcp } from '../packages/agent/src/mcp';
import { fallbackQuote } from '../packages/shared/src/sources';
import type { Deployment } from '../packages/shared/src/model';
import golden from './fixtures/uaid.json';
const testKey=(n:number)=>PrivateKey.fromStringECDSA(n.toString(16).padStart(64,'0'));
describe('identity and signing',()=>{
  it('matches the independently generated HOL SDK golden vector',()=>{
    expect(canonicalAgent(golden.input)).toBe(golden.canonicalJson);expect(createUaid(golden.input)).toBe(golden.uaid);
  });
  it('recognizes only the intended threshold and guardian-only revocation',()=>{
    const a=testKey(1).publicKey,b=testKey(2).publicKey;
    const mirrorKey=(threshold:number)=>({_type:'ProtobufEncoded',key:Buffer.from(proto.Key.encode(new KeyList([a,b],threshold)._toProtobufKey()).finish()).toString('hex')});
    expect(accountKeyState(mirrorKey(1),a.toStringRaw(),b.toStringRaw()).agentKeyActive).toBe(true);
    expect(()=>accountKeyState(mirrorKey(2),a.toStringRaw(),b.toStringRaw())).toThrow('THRESHOLD');
    expect(accountKeyState({_type:'ECDSA_SECP256K1',key:b.toStringRaw()},a.toStringRaw(),b.toStringRaw()).agentKeyActive).toBe(false);
    expect(()=>assertDistinctKeys([a.toStringRaw(),a.toStringDer()])).toThrow('DISTINCT');
  });
  it('signs the raw transaction digest without a personal-message prefix or double hash',async()=>{
    const key=testKey(1), body=new Uint8Array([1,2,3]);
    const bytes=await rawDigestSigner(key)(body);
    expect(Buffer.from(bytes).toString('hex')).toBe(Buffer.from(key.sign(body)).toString('hex'));
    const wallet=new Wallet('0x'+key.toStringRaw());
    expect([27,28].some(v=>recoverAddress(keccak256(body),{r:'0x'+Buffer.from(bytes.slice(0,32)).toString('hex'),s:'0x'+Buffer.from(bytes.slice(32)).toString('hex'),v})===wallet.address)).toBe(true);
  });
  it('verifies reports offline with a pinned signer, policy, subject and expiry',async()=>{
    const wallet=new Wallet('0x'+'1'.padStart(64,'0'));
    const message:StandingMessage={publicId:'agent:1',hederaAccount:'0.0.123',erc8004AgentId:'1',uaid:golden.uaid,paused:false,agentKeyActive:true,maxPerTx:'10',maxPerDay:'100',hcsTopic:'0.0.456',hashscanAccount:'https://hashscan.io/testnet/account/0.0.123',issuedAt:1700000000,expiresAt:1700000120};
    const policy='0x'+'2'.padStart(40,'0'); const signed=await signStanding(message,policy,wallet);
    expect(signed.signature).toBe('0x73f2a806f1319a2fae3ef98fa0f71ba4b4ff1de5b3055474831f0e635ead2fae2d9c2287b8246472966d3239e9070690eb1d3cf54519e3bc8b0210ca2ae46a261c');
    expect(STANDING_TYPES.Standing).toHaveLength(12);
    expect(verifyStanding(signed,wallet.address,policy,'0.0.123',1700000001)).toEqual(message);
    expect(()=>verifyStanding(signed,wallet.address,policy,'0.0.123',1700000120)).toThrow('EXPIRED');
    expect(()=>verifyStanding({...signed,message:{...message,maxPerTx:'999'}},wallet.address,policy,'0.0.123',1700000001)).toThrow('SIGNER');
    expect(()=>verifyStanding(signed,wallet.address,policy,'0.0.124',1700000001)).toThrow('SUBJECT');
  });
});
describe('settlement and durable reservations',()=>{
  it('confirms contract HTS transfers from child nonces and rejects failed children',async()=>{
    const id='0.0.5-123-400000000';
    const rows=[{transaction_id:id,result:'SUCCESS',consensus_timestamp:'123.4',nonce:0,name:'CONTRACTCALL',entity_id:'0.0.9',token_transfers:[]},{transaction_id:id,result:'SUCCESS',consensus_timestamp:'123.5',nonce:1,name:'CRYPTOTRANSFER',token_transfers:[{token_id:'0.0.7',account:'0.0.8',amount:10}]}];
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({transactions:rows}),{status:200}));
    const mirror=new Mirror(fetcher as unknown as typeof fetch);
    expect((await mirror.contractTransfers(id)).transfers).toEqual(rows[1].token_transfers);
    rows[1].result='FAIL';
    await expect(mirror.contractTransfers(id)).rejects.toThrow('CONTRACT_CHILD_FAILED');
  });
  it('normalizes IDs and rejects unsafe or mismatched settlement',()=>{
    expect(mirrorTxId('0.0.5@123.4')).toBe('0.0.5-123-400000000');
    const tx={transaction_id:'0.0.5-123-400000000',result:'SUCCESS',consensus_timestamp:'123.4',token_transfers:[{token_id:'0.0.429274',account:'0.0.6',amount:1000},{token_id:'0.0.429274',account:'0.0.7',amount:-1000}]};
    const expected={txId:'0.0.5@123.4',asset:'0.0.429274',payTo:'0.0.6',payer:'0.0.7',amount:1000n};
    expect(()=>verifyTransfer(tx,expected)).not.toThrow();
    expect(()=>verifyTransfer({...tx,result:'FAIL_INVALID'},expected)).toThrow();
    expect(()=>verifyTransfer(tx,{...expected,payTo:'0.0.8'})).toThrow();
    expect(()=>verifyTransfer(tx,{...expected,amount:1n})).toThrow();
  });
  it('keeps uncertain spends reserved across days and disallows concurrent signing',async()=>{
    const store=new Store(':memory:');store.reserve('tx','0.0.1',10n,'2020-01-01');
    expect(store.outstanding('0.0.1',new Set())).toBe(10n);
    await store.exclusive('spend',async()=>expect(store.exclusive('spend',async()=>{})).rejects.toThrow('IN_PROGRESS'));
    store.updateSpend('tx','failed');expect(store.outstanding('0.0.1',new Set())).toBe(0n);store.close();
  });
  it('verifies facilitator settlement independently and returns the same report on retry',async()=>{
    const store=new Store(':memory:'),mirror=new Mirror();
    const tx=new TransferTransaction().addTokenTransfer('0.0.429274','0.0.7',-1000).addTokenTransfer('0.0.429274','0.0.6',1000).setTransactionId(TransactionId.generate('0.0.5')).setNodeAccountIds([AccountId.fromString('0.0.3')]).freeze();
    await tx.sign(testKey(1));
    const id=tx.transactionId!.toString();
    const confirmed={transaction_id:mirrorTxId(id),result:'SUCCESS',consensus_timestamp:'1700000000.000000000',token_transfers:[{token_id:'0.0.429274',account:'0.0.6',amount:1000},{token_id:'0.0.429274',account:'0.0.7',amount:-1000}]};
    vi.spyOn(mirror,'waitTransaction').mockResolvedValue(confirmed);
    const facilitator:Facilitator={getSupported:vi.fn(),verify:vi.fn(async()=>({isValid:true,payer:'0.0.7'})),settle:vi.fn(async()=>({success:true,transaction:id,network:'hedera:testnet' as const,payer:'0.0.7'}))};
    const payments=new Payments(mirror,store,'0.0.6',facilitator);
    const requirements={scheme:'exact',network:'hedera:testnet' as const,asset:'0.0.429274',amount:'1000',payTo:'0.0.6',maxTimeoutSeconds:120,extra:{feePayer:'0.0.5'}};
    const header=encodePaymentSignatureHeader({x402Version:2,accepted:requirements,payload:{transaction:Buffer.from(tx.toBytes()).toString('base64')}});
    const build=vi.fn(async()=>({signed:'report'}));
    const response=await payments.accept(header,requirements,'agent',build);
    expect(await payments.accept(header,requirements,'agent',build)).toEqual(response);
    expect(build).toHaveBeenCalledTimes(1);expect(facilitator.settle).toHaveBeenCalledTimes(1);
    await expect(payments.accept(header,requirements,'other-agent',build)).rejects.toThrow('REPLAY');store.close();
  });
  it('compares SDK and raw signer output on an actual frozen transaction',async()=>{
    const tx=new TransferTransaction().addHbarTransfer('0.0.3',-1).addHbarTransfer('0.0.4',1).setTransactionId(TransactionId.generate('0.0.3')).setNodeAccountIds([AccountId.fromString('0.0.3')]).freeze();
    const encoded=tx.toBytes();expect(getBytes(encoded).length).toBeGreaterThan(0);
    await tx.signWith(testKey(1).publicKey,rawDigestSigner(testKey(1)));
    expect(tx.toBytes().length).toBeGreaterThan(encoded.length);
  });
});
describe('agent tools and DEX fallback',()=>{
  it('exposes the three guide tools over MCP without loading spend keys',async()=>{
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    const server=createAgentMcp(),client=new McpClient({name:'test',version:'1'});
    await server.connect(serverTransport);await client.connect(clientTransport);
    expect((await client.listTools()).tools.map(t=>t.name).sort()).toEqual(['check_policy','link_account','record_outcome']);
    await client.close();await server.close();
  });
  it('labels a verified pool quote read-only and rejects wrong token decimals',async()=>{
    const d={routerId:'0.0.19264'} as Deployment;
    const mirror={token:vi.fn(async(id:string)=>({deleted:false,decimals:id==='0.0.1183558'?'6':'8'})),call:vi.fn(async(_address:string,_abi:unknown,method:string)=>method==='getPair'?['0x'+'1'.repeat(40)]:[[1000000n,1809179n]])} as unknown as Mirror;
    const result=await fallbackQuote(d,mirror,1000000n);
    expect(result).toMatchObject({mode:'read-only',amountOut:'1809179',transactionSubmitted:false});
    expect(mirror.call).toHaveBeenCalledTimes(2);
    vi.mocked(mirror.token).mockResolvedValue({deleted:false,decimals:'3'} as never);
    await expect(fallbackQuote(d,mirror,1000000n)).rejects.toThrow('FALLBACK_TOKEN_MISMATCH');
  });
});
