import { z } from 'zod';

const raw=z.string().regex(/^\d+$/);
const snapshotSchema=z.object({balance:raw,spentToday:raw,maxPerTx:raw,maxPerDay:raw});
const factsSchema=z.object({keyState:z.object({agentKeyActive:z.boolean()}),paused:z.boolean(),agreement:z.object({hash:z.string(),version:z.number()}).optional()});
const statusSchema=z.object({liveAdaptersReady:z.boolean(),milestones:z.array(z.object({name:z.string(),ready:z.boolean()}))});
export type Snapshot=z.infer<typeof snapshotSchema>;
export type LiveRead={snapshot:Snapshot;facts:z.infer<typeof factsSchema>;status:z.infer<typeof statusSchema>};
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
        const value={facts:factsSchema.parse(facts),status:statusSchema.parse(status),snapshot:snapshotSchema.parse(metrics.snapshot)};
        if(current===generation) update({value,loading:false,error:null});
      } catch {
        if(current===generation) update({value:null,loading:false,error:'Live data unavailable. Check the API and refresh.'});
      }
    },
    dispose() { ++generation;controller?.abort(); },
  };
}
