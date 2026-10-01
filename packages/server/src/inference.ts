import { z } from 'zod';
import { AppError } from '../../shared/src/model';

/**
 * A paid LLM endpoint the agent sells over x402. It forwards one prompt to any OpenAI-compatible
 * chat completions API (OpenAI, Anthropic, Groq, OpenRouter and others) using the seller's own key.
 * Without configuration the route stays an unpaid 503; it never answers with a mock.
 */
export interface InferenceConfig { baseUrl:string; apiKey:string; model:string; price:string }
export const DEFAULT_INFERENCE_PRICE='10000'; // six decimals: 0.01 USDC
export const MAX_PROMPT_CHARS=4000;
const MAX_TOKENS=512;

export function inferenceConfig(env:Record<string,string|undefined>):InferenceConfig|null {
  const {INFERENCE_BASE_URL:base,INFERENCE_API_KEY:apiKey,INFERENCE_MODEL:model}=env;
  if(!base || !apiKey || !model) return null;
  let url:URL;
  try{url=new URL(base);}catch{throw new AppError('INFERENCE_BASE_URL_INVALID');}
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash) throw new AppError('INFERENCE_BASE_URL_INVALID');
  const price=env.INFERENCE_PRICE??DEFAULT_INFERENCE_PRICE;
  if(!/^[1-9]\d{0,6}$/.test(price)) throw new AppError('INFERENCE_PRICE_INVALID'); // at most 9.999999 USDC
  if(!/^[\w.:/-]{1,100}$/.test(model)) throw new AppError('INFERENCE_MODEL_INVALID');
  return {baseUrl:url.toString().replace(/\/+$/,''),apiKey,model,price};
}

export const inferenceRequest=z.object({prompt:z.string().trim().min(1).max(MAX_PROMPT_CHARS)}).strict();
const completion=z.object({
  model:z.string().optional(),
  choices:z.array(z.object({message:z.object({content:z.string().nullable()})})).min(1),
  usage:z.object({prompt_tokens:z.number().optional(),completion_tokens:z.number().optional()}).passthrough().optional(),
});

export async function complete(config:InferenceConfig,prompt:string,fetcher:typeof fetch=fetch) {
  let response:Response;
  try {
    response=await fetcher(`${config.baseUrl}/chat/completions`,{
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.apiKey}`},
      body:JSON.stringify({model:config.model,messages:[{role:'user',content:prompt}],max_tokens:MAX_TOKENS}),
      signal:AbortSignal.timeout(60_000),
    });
  } catch { throw new AppError('INFERENCE_UPSTREAM_UNAVAILABLE'); }
  // The provider's error body can echo request details; report only the status.
  if(!response.ok) throw new AppError(`INFERENCE_UPSTREAM_${response.status}`);
  const parsed=completion.safeParse(await response.json().catch(()=>null));
  if(!parsed.success || !parsed.data.choices[0].message.content) throw new AppError('INFERENCE_UPSTREAM_INVALID');
  return {model:parsed.data.model??config.model,answer:parsed.data.choices[0].message.content,usage:parsed.data.usage??null};
}
