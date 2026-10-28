// Author: Jeff.Liu. Neutral state for legacy callback seams; dedicated session-actions tests exercise persistence.
import {defaultTerminalTitle} from '../../src/workspaces.ts';
import {isSessionPreferenceKey,loadSessionNames,readSessionName} from '../../src/session-actions.ts';
export function sessionActionBindings(){return {defaultTerminalTitle,terminalSettingsRef:{current:{fontFamily:'Menlo',fontSize:13,theme:'app'}},sessionCopy:null,copyName:'',sessionCopyIntent:{current:0},setSessionCopy(){},setCopyName(){},ordinaryLaunchSnapshot:{current:undefined},saveSessionLaunchSettings(){},isSessionPreferenceKey,loadSessionNames,readSessionName};}
