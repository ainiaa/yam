// Author: Jeff.Liu. No session identifiers, paths, prompts or CLI output enter timing reports.
export type StartupTimings={create_ms:number[];view_ready_ms:number[]};
export function startupTimings(entries:readonly Pick<PerformanceEntry,'name'|'duration'>[]):StartupTimings{
 const durations=(name:string)=>entries.filter(e=>e.name===name&&Number.isFinite(e.duration)&&e.duration>=0&&e.duration<=3600000).slice(-32).map(e=>Math.round(e.duration));
 return {create_ms:durations('yam.start.create'),view_ready_ms:durations('yam.start.frame')};
}
export function timingPercentile(samples:readonly number[],percentile:number){if(!samples.length)return null;const sorted=[...samples].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*percentile)-1))];}
