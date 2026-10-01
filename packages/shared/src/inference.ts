import { APICallError, createGateway, generateText, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { AppError } from './model';

/**
 * Paid LLM inference the agent sells over x402, through the AI SDK. The seller picks a provider and
 * enters its key in the dashboard; the local agent runtime stores it in the ignored `.env.server`,
 * which only the API reads. Unconfigured, the route is an unpaid 503; it never answers with a mock.
 */
export const PROVIDERS={
  gateway:{label:'Vercel AI Gateway',defaultModel:'moonshotai/kimi-k3'},
  openai:{label:'OpenAI',defaultModel:'gpt-4o-mini'},
  anthropic:{label:'Anthropic',defaultModel:'claude-haiku-4-5'},
  google:{label:'Google Gemini',defaultModel:'gemini-2.5-flash'},
  'openai-compatible':{label:'OpenAI-compatible (custom base URL)',defaultModel:''},
} as const;
export type Provider=keyof typeof PROVIDERS;
export const providerSchema=z.enum(Object.keys(PROVIDERS) as [Provider,...Provider[]]);
export interface InferenceConfig { provider:Provider; apiKey:string; model:string; baseUrl?:string; price:string }
export const DEFAULT_INFERENCE_PRICE='10000'; // six decimals: 0.01 USDC
export const MAX_PROMPT_CHARS=4000;
const MAX_OUTPUT_TOKENS=512;

export const apiKeySchema=z.string().regex(/^[\x21-\x7e]{8,512}$/,'API key must be 8-512 printable characters without spaces');
export const modelSchema=z.string().regex(/^[\w.:/@-]{1,100}$/);
export const priceSchema=z.string().regex(/^[1-9]\d{0,6}$/); // at most 9.999999 USDC
export function baseUrlOf(value:string) {
  let url:URL;
  try{url=new URL(value);}catch{throw new AppError('INFERENCE_BASE_URL_INVALID',400);}
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash) throw new AppError('INFERENCE_BASE_URL_INVALID',400);
  return url.toString().replace(/\/+$/,'');
}

/** Read the seller's settings from `.env.server` variables; null when inference is not configured. */
export function inferenceConfig(env:Record<string,string|undefined>):InferenceConfig|null {
  const {INFERENCE_API_KEY:apiKey,INFERENCE_MODEL:model,INFERENCE_BASE_URL:base}=env;
  // Earlier versions configured only a base URL; treat that as an OpenAI-compatible provider.
  const provider=env.INFERENCE_PROVIDER??(base?'openai-compatible':undefined);
  if(!provider || !apiKey || !model) return null;
  const parsedProvider=providerSchema.safeParse(provider);
  if(!parsedProvider.success) throw new AppError('INFERENCE_PROVIDER_INVALID');
  if(!apiKeySchema.safeParse(apiKey).success) throw new AppError('INFERENCE_API_KEY_INVALID');
  if(!modelSchema.safeParse(model).success) throw new AppError('INFERENCE_MODEL_INVALID');
  const price=env.INFERENCE_PRICE??DEFAULT_INFERENCE_PRICE;
  if(!priceSchema.safeParse(price).success) throw new AppError('INFERENCE_PRICE_INVALID');
  if(parsedProvider.data==='openai-compatible' && !base) throw new AppError('INFERENCE_BASE_URL_INVALID');
  return {provider:parsedProvider.data,apiKey,model,price,...(parsedProvider.data==='openai-compatible'?{baseUrl:baseUrlOf(base!)}:{})};
}

export function languageModel(config:InferenceConfig):LanguageModel {
  switch(config.provider) {
    case 'gateway': return createGateway({apiKey:config.apiKey})(config.model);
    case 'openai': return createOpenAI({apiKey:config.apiKey})(config.model);
    case 'anthropic': return createAnthropic({apiKey:config.apiKey})(config.model);
    case 'google': return createGoogleGenerativeAI({apiKey:config.apiKey})(config.model);
    case 'openai-compatible': return createOpenAI({apiKey:config.apiKey,baseURL:config.baseUrl}).chat(config.model);
  }
}

export const inferenceRequest=z.object({prompt:z.string().trim().min(1).max(MAX_PROMPT_CHARS)}).strict();

type Generate=(options:{model:LanguageModel;prompt:string;maxOutputTokens:number;abortSignal:AbortSignal;maxRetries:number})=>Promise<{text:string;usage?:{inputTokens?:number;outputTokens?:number}}>;
/** A provider failure as an HTTP status and the provider's own one-line message. */
export function providerFailure(error:unknown) {
  const e=error as {statusCode?:unknown;message?:unknown};
  const status=APICallError.isInstance(error)||typeof e?.statusCode==='number'?Number(e.statusCode)||null:null;
  return {status,message:typeof e?.message==='string'?e.message.split(/\r?\n/)[0].slice(0,300):null};
}

/**
 * With `detail`, the provider's message is kept for the seller's own Test in the local dashboard.
 * Buyers of paid requests only ever see the HTTP status: provider errors can echo request details.
 */
export async function complete(config:InferenceConfig,prompt:string,generate:Generate=generateText as unknown as Generate,{detail=false}:{detail?:boolean}={}) {
  let result;
  try {
    result=await generate({model:languageModel(config),prompt,maxOutputTokens:MAX_OUTPUT_TOKENS,abortSignal:AbortSignal.timeout(60_000),maxRetries:1});
  } catch(error) {
    const failure=providerFailure(error);
    const code=failure.status?`INFERENCE_UPSTREAM_${failure.status}`:'INFERENCE_UPSTREAM_UNAVAILABLE';
    throw detail?Object.assign(new AppError(code),{providerMessage:failure.message}):new AppError(code);
  }
  if(!result.text) throw new AppError('INFERENCE_UPSTREAM_INVALID');
  return {provider:config.provider,model:config.model,answer:result.text,usage:{inputTokens:result.usage?.inputTokens??null,outputTokens:result.usage?.outputTokens??null}};
}
