// Vercel AI Gateway with the AI SDK: `npm run example:ai-gateway`.
// The key is read from .env.local (AI_GATEWAY_API_KEY), which git ignores. If it is not set there, the
// example uses a Vercel AI Gateway key saved from the dashboard's Pay services page (.env.server).
import { createGateway, generateText } from 'ai';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';

const read=(file:string)=>existsSync(file)?parse(readFileSync(file)):{};
const local=read('.env.local'),server=read('.env.server');
const apiKey=local.AI_GATEWAY_API_KEY||(server.INFERENCE_PROVIDER==='gateway'?server.INFERENCE_API_KEY:undefined);
if(!apiKey) {
  console.error('No AI Gateway key: set AI_GATEWAY_API_KEY in .env.local, or save a Vercel AI Gateway key on the Pay services page.');
  process.exit(1);
}

const { text, usage } = await generateText({
  model: createGateway({ apiKey })('moonshotai/kimi-k3'),
  prompt: 'Invent a new holiday and describe its traditions.',
});
console.log(text);
console.error(`\n(${usage.inputTokens ?? '?'} input tokens, ${usage.outputTokens ?? '?'} output tokens)`);
