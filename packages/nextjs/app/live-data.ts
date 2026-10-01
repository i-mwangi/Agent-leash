import { z } from 'zod';

const raw=z.string().regex(/^\d+$/);
const snapshotSchema=z.object({balance:raw,spentToday:raw,maxPerTx:raw,maxPerDay:raw});
const factsSchema=z.object({keyState:z.object({agentKeyActive:z.boolean()}),paused:z.boolean(),agreement:z.object({hash:z.string(),version:z.number()}).optional()});
const statusSchema=z.object({liveAdaptersReady:z.boolean(),milestones:z.array(z.object({name:z.string(),ready:z.boolean()}))});
const tokenSchema=z.object({id:z.string(),symbol:z.string().max(16),decimals:z.number().int().min(0).max(18)});
export type Snapshot=z.infer<typeof snapshotSchema>;
export type SpendToken=z.infer<typeof tokenSchema>;
export type LiveRead={snapshot:Snapshot;token:SpendToken|null;facts:z.infer<typeof factsSchema>;status:z.infer<typeof statusSchema>};

/** Format raw smallest units with the token's mirror-reported decimals, e.g. 1000000 → "1". */
export function tokenAmount(raw:string,decimals:number) {
  const value=BigInt(raw),scale=10n**BigInt(decimals);
  const whole=(value/scale).toLocaleString('en-US');
  const fraction=decimals?(value%scale).toString().padStart(decimals,'0').replace(/0+$/,''):'';
  return fraction?`${whole}.${fraction}`:whole;
}
/** "0.5" with 6 decimals → 500000n. Refuses more decimals than the token has rather than rounding. */
export function toUnits(text:string,decimals:number):bigint|null {
  const match = /^(\d{1,20})(?:\.(\d+))?$/.exec(text.trim());
  if (!match || (match[2] ?? "").length > decimals) return null;
  const value = BigInt(match[1] + (match[2] ?? "").padEnd(decimals, "0"));
  return value > 0n ? value : null;
}
export type ReadState={value:LiveRead|null;loading:boolean;error:string|null};

/** A refresh invalidates old readings immediately; obsolete responses cannot restore them. */
export function createLiveReader(update:(state:ReadState)=>void, fetcher:typeof fetch=fetch) {
  let generation=0;
  let controller:AbortController|undefined;
  return {
    async refresh() {
      const current=++generation;
      controller?.abort();
      controller=new AbortController();
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(20_000)]);
      update({value:null,loading:true,error:null});
      try {
        const read=async(path:string)=>{
          const response=await fetcher(path,{signal,cache:'no-store'});
          if(!response.ok) throw new Error('LIVE_READ_UNAVAILABLE');
          return response.json();
        };
        const [facts,status,metrics]=await Promise.all([read('/api/agent/status'),read('/api/status'),read('/api/policy/snapshot')]);
        const token=tokenSchema.safeParse(metrics.token);
        const value={facts:factsSchema.parse(facts),status:statusSchema.parse(status),snapshot:snapshotSchema.parse(metrics.snapshot),token:token.success?token.data:null};
        if(current===generation) update({value,loading:false,error:null});
      } catch {
        if(current===generation) update({value:null,loading:false,error:'Live data unavailable. Check the API and refresh.'});
      }
    },
    dispose() { ++generation;controller?.abort(); },
  };
}
