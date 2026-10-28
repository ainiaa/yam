import {currentAppTerminalPalette} from "./app-themes.ts";
export type TerminalSettings = {fontFamily:string;fontSize:number;theme:"app"|"dark"|"light"|"solarized"|"system"};
export const defaultTerminalSettings:TerminalSettings={fontFamily:"SFMono-Regular, Menlo, Consolas, monospace",fontSize:13,theme:"app"};
const themes={
 dark:{background:"#202020",foreground:"#e5e5e5",cursor:"#e5e5e5",selectionBackground:"#484848",black:"#202020",brightBlack:"#969696",green:"#83c99a",brightGreen:"#a3dfb5",red:"#e06c75",yellow:"#e5c07b",blue:"#61afef",magenta:"#c678dd",cyan:"#56b6c2",white:"#d5d5d5",brightRed:"#f08a92",brightYellow:"#f2d49a",brightBlue:"#8bc6f4",brightMagenta:"#d9a0e8",brightCyan:"#7acbd3",brightWhite:"#ffffff",cursorAccent:"#202020",selectionForeground:"#e5e5e5",selectionInactiveBackground:"#484848"},
 light:{background:"#fafafa",foreground:"#242424",cursor:"#242424",selectionBackground:"#c8d9ec",black:"#242424",brightBlack:"#666666",green:"#26753b",brightGreen:"#338c47",red:"#a12635",yellow:"#806000",blue:"#245a9b",magenta:"#80358f",cyan:"#176b75",white:"#555555",brightRed:"#b52b3b",brightYellow:"#927000",brightBlue:"#326db3",brightMagenta:"#9743a8",brightCyan:"#23808a",brightWhite:"#242424",cursorAccent:"#fafafa",selectionForeground:"#242424",selectionInactiveBackground:"#c8d9ec"},
 solarized:{background:"#002b36",foreground:"#839496",cursor:"#93a1a1",selectionBackground:"#073642",black:"#073642",brightBlack:"#586e75",green:"#859900",brightGreen:"#b7c36c",red:"#dc322f",yellow:"#b58900",blue:"#268bd2",magenta:"#d33682",cyan:"#2aa198",white:"#eee8d5",brightRed:"#cb4b16",brightYellow:"#657b83",brightBlue:"#839496",brightMagenta:"#6c71c4",brightCyan:"#93a1a1",brightWhite:"#fdf6e3",cursorAccent:"#002b36",selectionForeground:"#839496",selectionInactiveBackground:"#073642"},
};
export function isTerminalSettings(value:unknown):value is TerminalSettings {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 return Reflect.ownKeys(v).length===3&&Reflect.ownKeys(v).every(key=>key==="fontFamily"||key==="fontSize"||key==="theme")&&typeof v.fontFamily==="string"&&v.fontFamily.trim().length>0&&v.fontFamily.length<=200&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v.fontFamily)&&typeof v.fontSize==="number"&&Number.isInteger(v.fontSize)&&v.fontSize>=10&&v.fontSize<=24&&typeof v.theme==="string"&&["app","dark","light","solarized","system"].includes(v.theme);
}
export type TerminalZoomAction="larger"|"smaller"|"reset";
export function zoomTerminalSettings(settings:TerminalSettings,action:TerminalZoomAction):TerminalSettings {
 if(!isTerminalSettings(settings))throw Error("Invalid terminal preferences");
 if(!["larger","smaller","reset"].includes(action))throw Error("Invalid terminal zoom");
 return {...settings,fontSize:action==="reset"?defaultTerminalSettings.fontSize:Math.max(10,Math.min(24,settings.fontSize+(action==="larger"?1:-1)))};
}
export function terminalZoomShortcut(event:Pick<KeyboardEvent,"key"|"metaKey"|"ctrlKey"|"shiftKey"|"altKey"|"isComposing"|"repeat">,mac:boolean):TerminalZoomAction|null {
 if(event.isComposing||event.repeat||event.altKey||!(mac?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey))return null;
 if(event.key==="="||event.key==="+")return "larger";
 if(event.shiftKey)return null;
 return event.key==="-"?"smaller":event.key==="0"?"reset":null;
}
export function loadTerminalSettings(read:()=>string|null):{settings:TerminalSettings;error:string|null} {
 const fallback=()=>({...defaultTerminalSettings});
 try{const raw=read();if(raw===null)return{settings:fallback(),error:null};const value:unknown=JSON.parse(raw);if(isTerminalSettings(value))return{settings:{...value},error:null};}
 catch{return{settings:fallback(),error:"Terminal preferences unavailable. Using defaults."};}
 return{settings:fallback(),error:"Invalid terminal preferences. Using defaults."};
}
export function saveTerminalSettings(settings:TerminalSettings,write:(value:string)=>void):void {
 if(!isTerminalSettings(settings))throw Error("Invalid terminal preferences");write(JSON.stringify(settings));
}
export function terminalOptions(settings:TerminalSettings,systemTheme:"dark"|"light"="dark"){
 if(!isTerminalSettings(settings))throw Error("Invalid terminal preferences");
 return{fontFamily:settings.fontFamily,fontSize:settings.fontSize,theme:settings.theme==="app"?currentAppTerminalPalette():{...themes[settings.theme==="system"?(systemTheme==="light"?"light":"dark"):settings.theme]}};
}
export function applyTerminalSettings<T extends {instance:{options:{fontFamily?:string;fontSize?:number;theme?:object}};fit:{fit():void};viewportRevision:number}>(settings:TerminalSettings,views:readonly T[],sync:(view:T)=>void):void {
 const options=terminalOptions(settings);
 for(const view of views){view.instance.options.fontFamily=options.fontFamily;view.instance.options.fontSize=options.fontSize;view.instance.options.theme={...options.theme};view.viewportRevision++;view.fit.fit();sync(view);}
}

export type TerminalResizeView={instance:{cols:number;rows:number};cursor:number|null;resizePending?:{cols:number;rows:number}|null;resizing?:boolean;disposed?:boolean;writable?:boolean;dirty?:boolean;frameInstance?:string|null;lifecycleRevision?:number};
export async function queueTerminalResize(view:TerminalResizeView,resize:(cols:number,rows:number)=>Promise<unknown>,error:(reason:unknown)=>void):Promise<void>{
 if(view.disposed||!view.writable||view.cursor===null||view.instance.cols<=0||view.instance.rows<=0)return;
 view.resizePending={cols:view.instance.cols,rows:view.instance.rows};if(view.resizing)return;
 const owner=view.frameInstance,lifecycle=view.lifecycleRevision;
 const attached=()=>!view.disposed&&view.writable===true&&view.cursor!==null&&view.frameInstance===owner&&view.lifecycleRevision===lifecycle;
 view.resizing=true;
 try{while(view.resizePending&&attached()){const next=view.resizePending;view.resizePending=null;try{await resize(next.cols,next.rows);if(attached())view.dirty=true;}catch(reason){if(attached())error(reason);}}}
 finally{view.resizing=false;if(!attached())view.resizePending=null;}
}
