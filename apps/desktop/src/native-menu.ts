import {t} from "./i18n.ts";
// Author: Jeff.Liu. The web shortcut router remains the single authority for remappable shortcuts.
import {shortcutHint,type AppShortcuts} from './app-shortcuts.ts';
export const nativeMenuTitles={appearance:'Language and appearance',new:'New session','second-window':'Second terminal window',project:'Add project folder',ssh:'Connect SSH',hide:'Hide active tab',reopen:'Reopen last hidden tab',sidebar:'Toggle sidebar',palette:'Command palette',find:'Find in terminal',larger:'Larger terminal text',smaller:'Smaller terminal text',reset:'Reset terminal text size','split-horizontal':'Split right','split-vertical':'Split down',zoom:'Maximize / restore pane',previous:'Previous session',attention:'Next attention',logs:'Search saved logs',settings:'Terminal settings',profiles:'Terminal profiles','keyboard-shortcuts':'Keyboard shortcuts',updates:'Check for updates','paste-settings':'Paste settings','system-entry':'System entry','directory-reporting':'Zsh directory reporting','command-reporting':'Zsh command status reporting','launch-settings':'Launch templates and defaults'} as const;
export type NativeMenuAction=keyof typeof nativeMenuTitles;
export function dispatchNativeMenu(value:unknown,actions:Partial<Record<NativeMenuAction,()=>unknown>>,blocked:boolean):boolean{
 if(blocked||typeof value!=='string'||!Object.prototype.hasOwnProperty.call(nativeMenuTitles,value)||!Object.prototype.hasOwnProperty.call(actions,value))return false;
 const action=actions[value as NativeMenuAction];if(typeof action!=='function')return false;action();return true;
}
export function nativeMenuLabels(bindings:AppShortcuts,mac:boolean):Record<NativeMenuAction,string>{
 const labels=Object.fromEntries(Object.entries(nativeMenuTitles).map(([id,title])=>[id,t(title)])) as Record<NativeMenuAction,string>;
 for(const [action,key] of [['new','terminal'],['palette','palette'],['split-horizontal','split-horizontal'],['split-vertical','split-vertical'],['previous','previous'],['attention','attention']] as const){const hint=shortcutHint(bindings[key],mac);if(hint)labels[action]+=' · '+hint;}
 return labels;
}
