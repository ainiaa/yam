// Author: Jeff.Liu. Reuse the normal layout validator for portable, inert snapshots.
import {terminalLayoutRoot,terminalLeaves,terminalTabs,layoutFromRoot,type TerminalLayoutState,type TerminalLayoutNode} from './terminal-layout.ts';
import {encodeTerminalLayout,decodeTerminalLayout} from './terminal-layout-persistence.ts';
export type ProjectBackupLayout={root:TerminalLayoutNode;focused:number};
export type RestoredProjectBackup={project:string;ids:Record<string,string>;titles:Record<string,string>;layout:ProjectBackupLayout|null};
export type ProjectBackupPreview={fingerprint:string;project:string;sessions:{id:string;title:string;status:string;has_log:boolean}[];layout:ProjectBackupLayout|null};
export function projectBackupLayout(layout:TerminalLayoutState,ids:ReadonlySet<string>):ProjectBackupLayout{
 function filter(node:TerminalLayoutNode):TerminalLayoutNode{if(node.kind==='split')return{...node,first:filter(node.first),second:filter(node.second)};const tabs=terminalTabs(node).filter(id=>ids.has(id));return{kind:'pane',paneId:node.paneId,sessionId:tabs.includes(node.sessionId!)?node.sessionId:tabs[0]??null,tabs};}
 return{root:filter(terminalLayoutRoot(layout)),focused:layout.focused};
}
export function restoredProjectLayout(value:unknown):TerminalLayoutState{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!('root'in value)||!('focused'in value)||!Number.isSafeInteger(value.focused))throw Error('Invalid restored layout');
 const v=value as ProjectBackupLayout,leaves=terminalLeaves(v.root);if(v.focused<0||v.focused>=leaves.length)throw Error('Invalid restored layout');
 const layout=layoutFromRoot(v.root,leaves[v.focused].paneId);const checked=decodeTerminalLayout(encodeTerminalLayout(layout));if(checked.warning)throw Error('Invalid restored layout');return checked.layout;
}
