import { setup, register, guardianAction, initialize } from './setup';
import { readDeployment, DATA } from '../../shared/src/files';
import { Mirror } from '../../shared/src/mirror';
import { readFacts, quote } from '../../shared/src/sources';
import { spend } from './spend';
import { payStanding } from './payment';
import { AppError, jsonSafe, uint } from '../../shared/src/model';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [command,...args]=process.argv.slice(2);
async function main(){
  if(command==='init') return initialize();
  if(command==='setup') return setup();
  if(command==='register') return register();
  if(command==='pause'||command==='unpause'||command==='revoke') return guardianAction(command);
  if(command==='caps') return guardianAction('caps',[BigInt(uint.parse(args[0])),BigInt(uint.parse(args[1]))]);
  if(command==='evidence') return JSON.parse(readFileSync(resolve(DATA,'evidence.json'),'utf8'));
  const d=readDeployment();if(!d) throw new AppError('SETUP_REQUIRED');
  if(command==='status') return readFacts(d,new Mirror());
  if(command==='quote') return quote(d,new Mirror(),BigInt(uint.parse(args[0])));
  if(command==='spend') return spend(BigInt(uint.parse(args[0])));
  if(command==='pay-standing') return payStanding();
  throw new AppError('USAGE: init | setup | register | status | pay-standing | quote AMOUNT | spend AMOUNT | pause | unpause | caps TX DAY | revoke | evidence',400);
}
main().then(result=>console.log(JSON.stringify(jsonSafe(result),null,2))).catch(error=>{console.error(error instanceof AppError?error.code:error instanceof Error?error.message:'COMMAND_FAILED');process.exitCode=1;});
