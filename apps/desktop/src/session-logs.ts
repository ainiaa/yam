export class LatestLogRequest {
 private revision = 0;
 cancel() { this.revision++; }
 async run<T>(load: () => Promise<T>): Promise<T | undefined> {
  const revision = ++this.revision;
  try {
   const value = await load();
   return revision === this.revision ? value : undefined;
  } catch (error) {
   if (revision === this.revision) throw error;
   return undefined;
  }
 }
}

export type LogHit = {session_id:string;cwd:string;offset:number;column:number;text:string};
export type LogSearchPage = {hits:LogHit[];has_more:boolean;complete:boolean;issues:string[]};
