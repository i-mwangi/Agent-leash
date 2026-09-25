import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadLiveServices } from './live';
const mode = process.env.APP_MODE ?? "demo";
if (!["demo", "testnet"].includes(mode))
  throw new Error("APP_MODE must be demo or testnet");
if (process.env.AGENT_PRIVATE_KEY || process.env.GUARDIAN_PRIVATE_KEY || process.env.HEDERA_OPERATOR_KEY)
  throw new Error("Spend keys must not be present in the API runtime");
const live=mode==='testnet'?loadLiveServices():null;
if(mode==='testnet') {
  if(!live) throw new Error('TESTNET_SOURCES_NOT_CONFIGURED');
  await live.ready(live.deployment.agentAccount??'');
  await live.payments.requirements();
}
serve({ fetch: createApp(mode,()=>live).fetch, port: 3001, hostname: "127.0.0.1" });
console.log(`Accountable Agent API: http://127.0.0.1:3001 (${mode})`);
