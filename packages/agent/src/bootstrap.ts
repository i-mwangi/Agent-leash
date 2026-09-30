// Runs before `npm run dev`: create missing local role keys so browser setup needs no terminal step.
// Existing files are never modified. Keys are written to ignored files and never printed.
import { PrivateKey } from '@hiero-ledger/sdk';
import { Wallet } from 'ethers';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../../shared/src/files';
import { createSecretFile } from './runtime';

// Scaffold-HBAR prints its own fixed banner; this is the project's, shown on every `npm run dev`.
const BANNER=[
  "                          _        _    _                         _",
  "  __ _ __ __ ___ _  _ _ _| |_ __ _| |__| |___   __ _ __ _ ___ _ _| |_",
  " / _` / _/ _/ _ \\ || | ' \\  _/ _` | '_ \\ / -_) / _` / _` / -_) ' \\  _|",
  " \\__,_\\__\\__\\___/\\_,_|_||_\\__\\__,_|_.__/_\\___| \\__,_\\__, \\___|_||_\\__|",
  "                                                    |___/",
];
const color=process.stdout.isTTY && !process.env.NO_COLOR;
const green=(text:string)=>color?`\x1b[32m${text}\x1b[0m`:text;
console.log(`\n${green(BANNER.join('\n'))}`);
console.log('  Guardian-controlled AI agents on Hedera testnet');
console.log('  Dashboard http://localhost:3000  ·  set up your agent under Create agent\n');

const created:string[]=[];
function ensure(role:'operator'|'agent'|'server',contents:()=>string) {
  if(existsSync(resolve(ROOT,`.env.${role}`))) return;
  createSecretFile(role,contents());
  created.push(`.env.${role}`);
}
ensure('operator',()=>[
  'HEDERA_NETWORK=testnet',
  '# Generated setup account key. The browser setup asks the guardian wallet to fund an account for it.',
  '# To use your own funded testnet account instead, replace the key and set HEDERA_OPERATOR_ID.',
  `HEDERA_OPERATOR_KEY=${PrivateKey.generateECDSA().toStringRaw()}`,
  '',
].join('\n'));
ensure('agent',()=>`AGENT_PRIVATE_KEY=${PrivateKey.generateECDSA().toStringRaw()}\n`);
ensure('server',()=>`ATTESTATION_PRIVATE_KEY=${Wallet.createRandom().privateKey}\n`);
if(created.length) console.log(`Created local key files (ignored by git): ${created.join(', ')}`);

// Setup deploys the policy from compiled bytecode; compile once if this checkout has not been built.
if(!existsSync(resolve(ROOT,'packages/contracts/artifacts/contracts/PolicyRegistry.sol/PolicyRegistry.json'))) {
  console.log('Compiling contracts for browser setup…');
  execSync('npm run build -w @accountable/contracts',{cwd:ROOT,stdio:'inherit'});
}
