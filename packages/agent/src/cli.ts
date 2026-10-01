import { setup, register, guardianAction, initialize, adoptExisting, configureDex, fundDex, fundAgent, setStandingUrl } from './setup';
import { reconcilePause } from './reconcile';
import { readDeployment, DATA, atomicJson } from '../../shared/src/files';
import { compileVaultTerms, vaultTermsHash } from '../../shared/src/vaultTerms';
import { approveVaultTerms, deployVault, vaultStatus, allowVaultRecipients, guardianVaultAction, recoverVault, fundVault, vaultSpend } from './vault';
import { Mirror } from '../../shared/src/mirror';
import { fallbackQuote, readFacts, quote } from '../../shared/src/sources';
import { spend } from './spend';
import { cancelSchedule, listSchedules, reconcileSchedules, scheduleSwap } from './schedule';
import { payStanding } from './payment';
import { startMcp } from './mcp';
import { onboard, prepareAgreement, approveAgreement } from './agreement';
import { feedbackInput, giveFeedback } from './feedback';
import { resolveAgent } from '../../shared/src/resolve';
import { AppError, jsonSafe, uint } from '../../shared/src/model';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [command,...args]=process.argv.slice(2);
async function main(){
  if(command==='onboard') return onboard();
  if(command==='draft-agreement') return prepareAgreement();
  if(command==='approve-agreement') return approveAgreement();
  if(command==='draft-vault-terms') {
    if(!args[0]) throw new AppError('TERMS_FILE_REQUIRED',400);
    const d=readDeployment();
    if(!d?.agentAccount || !d.guardianId) throw new AppError('SETUP_REQUIRED');
    const terms=compileVaultTerms(readFileSync(resolve(args[0]),'utf8'));
    const context={network:'hedera:testnet' as const,agentAccount:d.agentAccount,guardianAccount:d.guardianId};
    const hash=vaultTermsHash(terms,context);
    const draft=resolve(DATA,'vault-terms-draft.json');
    atomicJson(draft,{context,terms,hash});
    return {draft,context,terms,hash,note:'Review this local draft. It does not deploy or fund a vault.'};
  }
  if(command==='approve-vault-terms') return approveVaultTerms();
  if(command==='deploy-vault') return deployVault();
  if(command==='vault-status') return vaultStatus();
  if(command==='allow-vault-recipients') return allowVaultRecipients();
  if(command==='vault-pause') return guardianVaultAction('pause');
  if(command==='vault-unpause') return guardianVaultAction('unpause');
  if(command==='vault-revoke') return guardianVaultAction('revoke');
  if(command==='vault-recover') return recoverVault();
  if(command==='fund-vault') return fundVault(BigInt(uint.parse(args[0])));
  if(command==='vault-spend') {if(!args[0]) throw new AppError('RECIPIENT_REQUIRED',400);return vaultSpend(args[0],BigInt(uint.parse(args[1])));}
  if(command==='init') return initialize();
  if(command==='adopt') {if(!args[0]) throw new AppError('PUBLIC_DEPLOYMENT_FILE_REQUIRED',400);return adoptExisting(args[0]);}
  if(command==='setup') return setup();
  if(command==='register') return register();
  if(command==='pause'||command==='unpause'||command==='revoke'||command==='restore') return guardianAction(command);
  if(command==='reconcile-pause') {if(!args[0]) throw new AppError('TRANSACTION_ID_REQUIRED',400);return reconcilePause(args[0]);}
  if(command==='configure-dex') return configureDex();
  if(command==='fund-dex') return fundDex(BigInt(uint.parse(args[0])));
  if(command==='fund-agent') return fundAgent(BigInt(uint.parse(args[0])));
  if(command==='caps') return guardianAction('caps',[BigInt(uint.parse(args[0])),BigInt(uint.parse(args[1]))]);
  if(command==='evidence') return JSON.parse(readFileSync(resolve(DATA,'evidence.json'),'utf8'));
  if(command==='set-standing-url') return setStandingUrl(args[0]??'');
  if(command==='lookup') return resolveAgent(feedbackInput(args[0]??'','0').agentId);
  if(command==='give-feedback') return giveFeedback(args[0]??'',args[1]??'',args[2]);
  const d=readDeployment();if(!d) throw new AppError('SETUP_REQUIRED');
  if(command==='status') return readFacts(d,new Mirror());
  if(command==='quote') return quote(d,new Mirror(),BigInt(uint.parse(args[0])));
  if(command==='quote-fallback') return fallbackQuote(d,new Mirror(),BigInt(uint.parse(args[0])));
  if(command==='spend') return spend(BigInt(uint.parse(args[0])));
  if(command==='pay-standing') return payStanding();
  if(command==='schedule-swap') {if(!args[1]) throw new AppError('EXECUTE_AT_REQUIRED',400);return scheduleSwap(BigInt(uint.parse(args[0])),args[1]);}
  if(command==='schedules') {await reconcileSchedules();return listSchedules();}
  if(command==='cancel-schedule') return cancelSchedule(args[0]??'');
  throw new AppError('USAGE: set-standing-url HTTPS_URL | lookup AGENT_ID | give-feedback AGENT_ID SCORE [TAG] | onboard | draft-agreement | approve-agreement | draft-vault-terms FILE | approve-vault-terms | deploy-vault | vault-status | allow-vault-recipients | fund-vault TINYBARS | vault-spend RECIPIENT TINYBARS | vault-pause | vault-unpause | vault-revoke | vault-recover | init | adopt PUBLIC_DEPLOYMENT_JSON | setup | register | status | pay-standing | quote AMOUNT | quote-fallback AMOUNT | spend AMOUNT | schedule-swap AMOUNT ISO_TIME | schedules | cancel-schedule SCHEDULE_ID | pause | reconcile-pause TXID | unpause | caps TX DAY | revoke | restore | configure-dex | fund-dex TINYBARS | fund-agent TINYBARS | evidence',400);
}
if(command==='mcp') startMcp().catch(()=>{console.error('MCP_START_FAILED');process.exitCode=1;});
else main().then(result=>console.log(JSON.stringify(jsonSafe(result),null,2))).catch(error=>{console.error(error instanceof AppError?error.code:error instanceof Error?error.message:'COMMAND_FAILED');process.exitCode=1;});
