import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadLiveServices, type LiveServices } from './live';
import { readDeployment } from '../../shared/src/files';
import { AppError } from '../../shared/src/model';
// auto (default): synthetic demo until this workspace has a complete, verified deployment.
const requested = process.env.APP_MODE ?? "auto";
if (!["demo", "testnet", "auto"].includes(requested))
  throw new Error("APP_MODE must be demo, testnet or auto");
if (process.env.AGENT_PRIVATE_KEY || process.env.GUARDIAN_PRIVATE_KEY || process.env.HEDERA_OPERATOR_KEY)
  throw new Error("Spend keys must not be present in the API runtime");
let mode = requested === "testnet" ? "testnet" : "demo";
let live: LiveServices | null = null;
/** Load and fully verify live sources; only then does the API serve testnet standing. */
async function activate() {
  const candidate = loadLiveServices();
  if (!candidate) throw new AppError('TESTNET_SOURCES_NOT_CONFIGURED');
  const facts = await candidate.ready(candidate.deployment.agentAccount ?? '') as { agreement?: unknown };
  // A browser setup is complete only once its guardian has approved the agreement.
  if (candidate.deployment.guardianMode === 'wallet' && !facts.agreement) throw new AppError('AGREEMENT_NOT_APPROVED');
  await candidate.payments.requirements();
  live = candidate; mode = "testnet";
}
const complete = () => { const d = readDeployment(); return !!(d?.agentAccount && d.hcsTopic && d.policyAddress && d.erc8004AgentId && d.uaid); };
if (requested === "testnet") await activate();
if (requested === "auto") {
  let lastError = '';
  const attempt = async () => {
    if (live || !complete()) return;
    try { await activate(); console.log('Accountable Agent API: deployment verified, now serving testnet'); }
    catch (error) {
      // Fail closed: keep serving demo (standing stays unpaid 503) and retry.
      const code = error instanceof AppError ? error.code : 'SOURCE_UNAVAILABLE';
      if (code !== lastError) console.error(`Accountable Agent API: testnet not active yet (${code})`);
      lastError = code;
    }
  };
  await attempt();
  setInterval(() => void attempt(), 15_000).unref();
}
serve({ fetch: createApp(() => mode, () => live).fetch, port: 3001, hostname: "127.0.0.1" });
console.log(`Accountable Agent API: http://127.0.0.1:3001 (${mode}${requested === 'auto' ? ', auto' : ''})`);
