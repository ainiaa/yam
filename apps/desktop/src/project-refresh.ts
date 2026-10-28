// Author: Jeff.Liu. One bounded read at a time; inactive panels dispose their watcher.
export function watchProjectRefresh(action:()=>Promise<unknown>,visible=()=>typeof document!=="undefined"&&document.visibilityState!=="hidden"&&document.hasFocus(),clock:{setTimeout:(fn:()=>void,delay:number)=>unknown;clearTimeout:(id:any)=>void}=globalThis):()=>void{
 let stopped=false,timer:unknown;
 const schedule=()=>{timer=clock.setTimeout(async()=>{try{if(!stopped&&visible())await action();}catch{/* The next interval retries; controllers retain their own error state. */}finally{if(!stopped)schedule();}},5000);};
 schedule();return()=>{stopped=true;clock.clearTimeout(timer);};
}
