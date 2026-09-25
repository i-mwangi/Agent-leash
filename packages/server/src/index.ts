import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadLiveServices, type LiveServices } from './live';
import { readDeployment } from '../../shared/src/files';
const mode = process.env.APP_MODE ?? "demo";
if (!["demo", "testnet"].includes(mode))
  throw new Error("APP_MODE must be demo or testnet");
if (process.env.AGENT_PRIVATE_KEY || process.env.GUARDIAN_PRIVATE_KEY || process.env.HEDERA_OPERATOR_KEY)
  throw new Error("Spend keys must not be present in the API runtime");
let cached:LiveServices|null=null;let fingerprint='';
function services(){const next=JSON.stringify(readDeployment());if(!cached || next!==fingerprint){cached?.payments.store.close();cached=loadLiveServices();fingerprint=next;}return cached;}
serve({ fetch: createApp(mode,services).fetch, port: 3001, hostname: "127.0.0.1" });
console.log(`Accountable Agent API: http://127.0.0.1:3001 (${mode})`);
