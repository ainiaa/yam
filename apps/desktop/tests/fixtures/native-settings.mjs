// Author: Jeff.Liu. Execute the actual guarded dispatcher, including cross-window routing.
import {readFileSync} from 'node:fs';import ts from 'typescript';import {dispatchNativeMenu} from '../../src/native-menu.ts';import {updaterBusy} from '../../src/updater.ts';
export function nativeSettings(bindings={}){
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression;
 function visit(n){if(ts.isBinaryExpression(n)&&n.left.getText(source)==='nativeMenuHandler.current')expression=n.right;ts.forEachChild(n,visit);}visit(source);
 const calls=[],values={document:{querySelector:()=>null},dispatchNativeMenu,updaterBusy,isMainWindow:true,setTerminalSettingsOpen:v=>calls.push(['settings',v]),setTerminalProfilesOpen:v=>calls.push(['profiles',v]),setKeyboardShortcutsOpen:v=>calls.push(['keyboard-shortcuts',v]),setPasteSettingsOpen:v=>calls.push(['paste-settings',v]),setUpdaterOpen:v=>calls.push(['updates',v]),updaterController:{current:{snapshot:null}},openMainSettings:target=>calls.push(['main',target]),...bindings};
 const run=new Function(...Object.keys(values),ts.transpileModule('const run='+expression.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return run;')(...Object.values(values));return {calls,run};
}
