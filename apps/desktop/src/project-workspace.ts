// Author: Jeff.Liu.
const bounded=(width:number)=>Math.max(360,Math.min(900,Math.round(width)));
export function workspaceWidth(raw:string|null):number{
 try{const value=JSON.parse(raw??'null');return typeof value==='number'&&Number.isFinite(value)?bounded(value):560;}catch{return 560;}
}
export function resizeWorkspace(width:number,start:number,current:number):number{return Number.isFinite(current)?bounded(width+start-current):width;}
