import { Key, KeyList, PrivateKey, PublicKey } from '@hiero-ledger/sdk';
import { proto } from '@hiero-ledger/proto';
import { SigningKey, getBytes, keccak256 } from 'ethers';
import { AppError, type Deployment } from './model';
import type { MirrorKey } from './mirror';
export function privateKey(text:string) { return PrivateKey.fromStringECDSA(text.trim().replace(/^0x/,'')); }
export function normalizedPublic(text:string) { return PublicKey.fromStringECDSA(text.replace(/^0x/,'')).toStringRaw().toLowerCase(); }
export function assertDistinctKeys(keys:string[]) {
  const normalized = keys.map(normalizedPublic);
  if(new Set(normalized).size!==normalized.length) throw new AppError('KEY_ROLES_MUST_BE_DISTINCT');
}
export function checkDeploymentKeys(d:Deployment) { assertDistinctKeys([d.operatorPublicKey,d.guardianPublicKey,d.agentPublicKey,d.attestationPublicKey]); }
export function decodeMirrorKey(key:MirrorKey):Key {
  if(key._type==='ECDSA_SECP256K1') return PublicKey.fromStringECDSA(key.key);
  if(key._type==='ED25519') return PublicKey.fromStringED25519(key.key);
  if(key._type==='ProtobufEncoded') return Key._fromProtobufKey(proto.Key.decode(Buffer.from(key.key,'hex')));
  throw new AppError('UNSUPPORTED_ACCOUNT_KEY');
}
export function accountKeyState(key:MirrorKey, agent:string, guardian:string) {
  const decoded=decodeMirrorKey(key);
  const expectedAgent=normalizedPublic(agent), expectedGuardian=normalizedPublic(guardian);
  if(decoded instanceof PublicKey && decoded.toStringRaw()===expectedGuardian) return {agentKeyActive:false,threshold:1,keys:[expectedGuardian]};
  if(!(decoded instanceof KeyList) || decoded.threshold!==1) throw new AppError('ACCOUNT_KEY_THRESHOLD_MISMATCH');
  const keys=decoded.toArray().map(k=>k instanceof PublicKey ? k.toStringRaw() : 'unsupported');
  if(keys.length!==2 || !keys.includes(expectedAgent) || !keys.includes(expectedGuardian)) throw new AppError('ACCOUNT_KEY_LIST_MISMATCH');
  return {agentKeyActive:true,threshold:1,keys};
}
/** signWith receives the transaction body, which Hedera ECDSA hashes once with keccak256. */
export function rawDigestSigner(key:PrivateKey) {
  const signer=new SigningKey('0x'+key.toStringRaw());
  return async (body:Uint8Array) => {
    const signature=signer.sign(keccak256(body));
    return getBytes(signature.r+signature.s.slice(2));
  };
}
