import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { DATA, atomicJson, readDeployment } from '../../shared/src/files';
import { AppError, entityId, jsonSafe, publicKey, uint } from '../../shared/src/model';
import { Mirror, exactUnits, mirrorTxId } from '../../shared/src/mirror';
import { Store } from '../../shared/src/store';
import { readFacts, policySnapshot } from '../../shared/src/sources';
import { checkPolicy } from './policyClient';
import { publish } from './setup';
import { roleKey } from './runtime';

function deployment(){const d=readDeployment();if(!d?.agentAccount) throw new AppError('SETUP_REQUIRED');return d;}
function answer(value:unknown){return {content:[{type:'text' as const,text:JSON.stringify(jsonSafe(value))}]};}
function toolError(error:unknown){return {content:[{type:'text' as const,text:error instanceof AppError?error.code:'SOURCE_UNAVAILABLE'}],isError:true};}

export function createAgentMcp() {
  const server=new McpServer({name:'accountable-agent',version:'0.1.0'});
  server.registerTool('link_account',{description:'Verify and locally bind the deployed 1-of-2 agent account and its two public keys.',inputSchema:{accountId:entityId,agentPublicKey:publicKey,guardianPublicKey:publicKey}},async args=>{
    try {
      const d=deployment();
      if(args.accountId!==d.agentAccount || args.agentPublicKey!==d.agentPublicKey || args.guardianPublicKey!==d.guardianPublicKey) throw new AppError('ACCOUNT_BINDING_MISMATCH');
      const facts=await readFacts(d,new Mirror());
      if(!facts.keyState.agentKeyActive) throw new AppError('AGENT_KEY_INACTIVE');
      const binding={network:'hedera:testnet',accountId:d.agentAccount,guardianId:d.guardianId,agentPublicKey:d.agentPublicKey,guardianPublicKey:d.guardianPublicKey,verifiedAt:new Date().toISOString()};
      atomicJson(resolve(DATA,'linked-account.json'),binding);
      return answer(binding);
    }catch(error){return toolError(error);}
  });
  server.registerTool('check_policy',{description:'Read authoritative account, identity, HCS, policy and balance sources; no transaction is signed.',inputSchema:{amount:uint}},async({amount})=>{
    const store=new Store(resolve(DATA,'agent.sqlite'));
    try {
      const d=deployment();const snapshot=await policySnapshot(d,new Mirror(),confirmed=>store.outstanding(d.spendAsset,confirmed));
      return answer({decision:checkPolicy(snapshot,d.spendAsset,BigInt(amount)),snapshot,asset:d.spendAsset,advisory:true});
    }catch(error){return toolError(error);}finally{store.close();}
  });
  server.registerTool('record_outcome',{description:'Publish an agent-signed HCS fill after independently verifying a transaction, or record a failed attempt.',inputSchema:{transactionId:z.string().min(1),status:z.enum(['success','failed']),amount:uint,reason:z.string().max(120).optional()}},async({transactionId,status,amount,reason})=>{
    const store=new Store(resolve(DATA,'agent.sqlite'));
    try {
      const d=deployment();if(!d.hcsTopic) throw new AppError('HCS_NOT_READY');
      if(roleKey('agent').publicKey.toStringRaw()!==d.agentPublicKey) throw new AppError('AGENT_KEY_MISMATCH');
      const mirror=new Mirror(),tx=await mirror.transaction(transactionId);
      const id=mirrorTxId(transactionId),raw=BigInt(amount);
      if(status==='success') {
        const {transfers}=await mirror.contractTransfers(id);
        const net=transfers.filter(t=>t.account===d.agentAccount && t.token_id===d.spendAsset).reduce((n,t)=>n+exactUnits(t.amount),0n);
        const output=transfers.filter(t=>t.account===d.agentAccount && t.token_id===d.outputAsset).reduce((n,t)=>n+exactUnits(t.amount),0n);
        if(tx.result!=='SUCCESS' || tx.name!=='CONTRACTCALL' || tx.entity_id!==d.routerId || raw<=0n || net!==-raw || output<=0n) throw new AppError('FILL_PROOF_INVALID');
      } else if(tx.result==='SUCCESS') throw new AppError('FAILED_OUTCOME_CONFLICT');
      const events=await mirror.events(d.hcsTopic);
      if(events.some(e=>e.type==='fill' && e.payload.transactionId===transactionId && e.payload.status===status)) return answer({alreadyRecorded:true,transactionId});
      const result=await publish(d,'fill',{status,transactionId,amount,asset:d.spendAsset,...(reason?{reason}:{})},'agent',`outcome-${id}-${status}`,store);
      return answer({transactionId,recordId:result.txId,status});
    }catch(error){return toolError(error);}finally{store.close();}
  });
  return server;
}
export async function startMcp(){await createAgentMcp().connect(new StdioServerTransport());}
