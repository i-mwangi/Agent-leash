import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { z } from 'zod';
import { ROOT } from '../../shared/src/files';
import { AppError } from '../../shared/src/model';
import { PROVIDERS, apiKeySchema, baseUrlOf, complete, inferenceConfig, modelSchema, priceSchema, providerSchema, type InferenceConfig } from '../../shared/src/inference';

/**
 * The seller's LLM provider settings, entered in the dashboard and kept in the ignored `.env.server`
 * next to the attestation key. The key is written once and never returned, logged or sent back.
 */
const KEYS=['INFERENCE_PROVIDER','INFERENCE_API_KEY','INFERENCE_MODEL','INFERENCE_BASE_URL','INFERENCE_PRICE'];
const envPath=(root:string)=>resolve(root,'.env.server');

export const settingsInput=z.object({
  provider:providerSchema,
  apiKey:apiKeySchema.optional(),
  model:modelSchema,
  baseUrl:z.string().max(300).optional(),
  price:priceSchema,
}).strict();

function readEnv(root:string) {
  const path=envPath(root);
  if(!existsSync(path)) throw new AppError('MISSING_SERVER_ENV');
  const text=readFileSync(path,'utf8');
  return {path,text,env:parse(text)};
}

/** What the dashboard may see: everything except the key itself. */
export function readInferenceSettings(root=ROOT) {
  const {env}=readEnv(root);
  let config:InferenceConfig|null=null,error:string|null=null;
  try{config=inferenceConfig(env);}catch(reason){error=reason instanceof AppError?reason.code:'INFERENCE_SETTINGS_INVALID';}
  return {
    configured:!!config,error,keySet:!!env.INFERENCE_API_KEY,
    provider:config?.provider??env.INFERENCE_PROVIDER??null,model:config?.model??env.INFERENCE_MODEL??null,
    baseUrl:config?.baseUrl??null,price:config?.price??env.INFERENCE_PRICE??null,
    providers:Object.entries(PROVIDERS).map(([id,p])=>({id,label:p.label,defaultModel:p.defaultModel})),
  };
}

function writeEnv(path:string,text:string,values:Record<string,string>) {
  // Keep every other line (the attestation key, APP_MODE) exactly as it was.
  const kept=text.split(/\r?\n/).filter(line=>!KEYS.some(key=>line.startsWith(`${key}=`))).join('\n').replace(/\n*$/,'\n');
  const added=Object.entries(values).map(([key,value])=>`${key}=${value}\n`).join('');
  const temporary=`${path}.tmp`;
  writeFileSync(temporary,kept+added,{mode:0o600});
  renameSync(temporary,path);
}

export function saveInferenceSettings(input:unknown,root=ROOT) {
  const parsed=settingsInput.safeParse(input);
  if(!parsed.success) throw new AppError('INFERENCE_SETTINGS_INVALID',400);
  const s=parsed.data;
  const {path,text,env}=readEnv(root);
  // Keeping the saved key is allowed only for the same provider; a key never moves between providers.
  const apiKey=s.apiKey??(env.INFERENCE_PROVIDER===s.provider?env.INFERENCE_API_KEY:undefined);
  if(!apiKey) throw new AppError('INFERENCE_API_KEY_REQUIRED',400);
  const values:Record<string,string>={INFERENCE_PROVIDER:s.provider,INFERENCE_API_KEY:apiKey,INFERENCE_MODEL:s.model,INFERENCE_PRICE:s.price};
  if(s.provider==='openai-compatible') values.INFERENCE_BASE_URL=baseUrlOf(s.baseUrl??'');
  inferenceConfig(values); // validate the complete set before writing
  writeEnv(path,text,values);
  return readInferenceSettings(root);
}

export function clearInferenceSettings(root=ROOT) {
  const {path,text}=readEnv(root);
  writeEnv(path,text,{});
  return readInferenceSettings(root);
}

/** One short request with the saved settings, so the seller knows the key works before selling. */
export async function testInferenceSettings(root=ROOT,run:typeof complete=complete) {
  const config=inferenceConfig(readEnv(root).env);
  if(!config) throw new AppError('INFERENCE_NOT_CONFIGURED',409);
  const provider=PROVIDERS[config.provider].label;
  try {
    const result=await run(config,'Reply with one short sentence confirming you are ready to answer paid requests.',undefined,{detail:true});
    return {ok:true as const,provider,model:config.model,answer:result.answer.slice(0,300),usage:result.usage};
  } catch(error) {
    // Shown only to the seller in the local dashboard, so the provider's reason is useful here.
    if(!(error instanceof AppError) || !error.code.startsWith('INFERENCE_UPSTREAM')) throw error;
    return {ok:false as const,provider,model:config.model,error:error.code,providerMessage:(error as AppError&{providerMessage?:string|null}).providerMessage??null};
  }
}
