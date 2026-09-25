import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentSchema, type Deployment } from './model';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DATA = resolve(ROOT, '.accountable');
export function atomicJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
export function readDeployment(): Deployment | null {
  const path = resolve(DATA, 'deployment.json');
  return existsSync(path) ? deploymentSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : null;
}
export function saveDeployment(value: Deployment) { atomicJson(resolve(DATA, 'deployment.json'), deploymentSchema.parse(value)); }
