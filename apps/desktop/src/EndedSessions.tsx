// Author: Jeff.Liu. Native disclosure visibility alone keeps every hidden row mounted.
import {useState,type ReactNode} from 'react';
export function EndedSessions({label,children}:{label:string;children:()=>ReactNode}){
 const [open,setOpen]=useState(false);
 return <details className="project-ended-sessions" onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}><summary>{label}</summary>{open?children():null}</details>;
}
