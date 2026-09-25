import { Hono } from "hono";
import { checkPolicy, type PolicySnapshot } from "../../agent/src/policyClient";
import type { LiveServices } from './live';
import { AppError, uint, jsonSafe } from '../../shared/src/model';
import { readDeployment } from '../../shared/src/files';
import { quote, policySnapshot } from '../../shared/src/sources';

export const demoPolicy: PolicySnapshot = {
  policyExists: true,
  paused: false,
  agentKeyActive: true,
  hcsReady: true,
  identityRegistered: true,
  allowedTokens: ["0.0.429274"],
  maxPerTx: 1_000_000n,
  maxPerDay: 5_000_000n,
  spentToday: 1_200_000n,
  pendingToday: 0n,
  balance: 8_000_000n,
};
export function createApp(mode = "demo", services:()=>LiveServices|null=()=>null) {
  const app = new Hono();
  app.onError((error,c)=>c.json({error:error instanceof AppError?error.code:'SOURCE_UNAVAILABLE',paymentRequired:false},error instanceof AppError?error.status:503));
  app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
  app.get("/health", (c) =>
    c.json({ ok: true, mode, network: "testnet", liveAdaptersReady: false }),
  );
  app.get("/status", (c) =>
    c.json({
      mode,
      liveAdaptersReady: false,
      milestones: [
        { name: "Local policy engine", ready: true },
        { name: "Guardian policy contract", ready: true },
        { name: "Hedera account and HCS registration", ready: false },
        { name: "x402 settlement and signed standing", ready: false },
        { name: "SaucerSwap execution", ready: false },
      ],
    }),
  );
  app.post("/demo/policy/preview", async (c) => {
    if (mode !== "demo") return c.json({ error: "DEMO_DISABLED" }, 404);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "INVALID_JSON" }, 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.amount !== "string" ||
      !/^\d{1,30}$/.test(body.amount) ||
      typeof body.asset !== "string" ||
      typeof body.paused !== "boolean" ||
      typeof body.agentKeyActive !== "boolean"
    ) {
      return c.json({ error: "INVALID_REQUEST" }, 400);
    }
    const state = {
      ...demoPolicy,
      paused: body.paused,
      agentKeyActive: body.agentKeyActive,
    };
    return c.json({
      ...checkPolicy(state, body.asset, BigInt(body.amount)),
      demo: true,
      transactionSubmitted: false,
    });
  });
  app.get('/deployment',c=>c.json({deployment:readDeployment(),configured:!!services(),mode}));
  app.get('/agent/status',async c=>{
    const live=services();if(!live) throw new AppError('SOURCES_NOT_CONFIGURED');
    const facts=await live.ready(live.deployment.agentAccount??'');
    return c.json(jsonSafe(facts));
  });
  app.post('/policy/preview',async c=>{
    const live=services();if(!live) throw new AppError('SOURCES_NOT_CONFIGURED');
    const {amount}=await c.req.json(); const parsed=uint.safeParse(amount);
    if(!parsed.success) throw new AppError('INVALID_AMOUNT',400);
    // Dashboard is advisory; only the isolated agent runtime can reserve and sign.
    const snapshot=await policySnapshot(live.deployment,live.mirror,()=>0n);
    return c.json({...checkPolicy(snapshot,live.deployment.spendAsset,BigInt(parsed.data)),advisory:true,transactionSubmitted:false,snapshot:jsonSafe(snapshot)});
  });
  app.get('/dex/quote',async c=>{
    const live=services();if(!live) throw new AppError('SOURCES_NOT_CONFIGURED');
    const parsed=uint.safeParse(c.req.query('amount')); if(!parsed.success) throw new AppError('INVALID_AMOUNT',400);
    return c.json(await quote(live.deployment,live.mirror,BigInt(parsed.data)));
  });
  app.get('/.well-known/agent-card.json',async c=>{
    const live=services();if(!live) throw new AppError('SOURCES_NOT_CONFIGURED');
    const facts=await live.ready(live.deployment.agentAccount??'') as {card:unknown};return c.json(jsonSafe(facts.card));
  });
  app.get('/standing/:id',async c=>{
    const live=services();if(!live) throw new AppError('SOURCES_NOT_CONFIGURED');
    const id=c.req.param('id'); await live.ready(id);
    const requirements=await live.payments.requirements();
    const canonicalUrl=`${live.deployment.standingBaseUrl}/standing/${live.deployment.agentAccount}`;
    const header=c.req.header('PAYMENT-SIGNATURE');
    if(!header) {const challenge=live.payments.challenge(requirements,canonicalUrl);c.header('PAYMENT-REQUIRED',challenge.header);return c.json(challenge.body,402);}
    const result=await live.payments.accept(header,requirements,live.deployment.agentAccount!,()=>live.report(id));
    c.header('PAYMENT-RESPONSE',result.responseHeader);return c.json(jsonSafe(result.body));
  });
  return app;
}
