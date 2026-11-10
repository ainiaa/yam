// Author: Jeff.Liu. Neutral state for legacy callback seams; dedicated session-actions tests exercise persistence.
import {initialRoutingPolicy,routingPolicyArgs} from '../../src/routing-policies.ts';
import {defaultTerminalTitle} from '../../src/workspaces.ts';
import {isSessionPreferenceKey,loadSessionNames,readSessionName} from '../../src/session-actions.ts';
import {readLastConnection,rememberConnection} from '../../src/saved-connections.ts';
export function sessionActionBindings(){return {readLastConnection,rememberConnection,localStorage:{getItem:()=>null},initialRoutingPolicy,routingPolicyArgs,launchWorkspace:null,setLaunchWorkspace(){},defaultTerminalTitle,terminalSettingsRef:{current:{fontFamily:'Menlo',fontSize:13,theme:'app'}},sessionCopy:null,copyName:'',sessionCopyIntent:{current:0},setSessionCopy(){},setCopyName(){},setRoutingPolicySelection(){},setRoutingPolicyLibrary(){},loadRoutingPolicyLibrary(){return {rows:[],error:null};},ordinaryLaunchSnapshot:{current:undefined},saveSessionLaunchSettings(){},isSessionPreferenceKey,loadSessionNames,readSessionName};}
