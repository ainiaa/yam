// Author: Jeff.Liu. One palette drives app surfaces and opt-in terminal views.
import {isAppPreferences,defaultAppPreferences,type AppPreferences,type AppTheme} from './app-preferences.ts';
export type ResolvedTheme=Exclude<AppTheme,'system'>;
function palette(background:string,sidebar:string,surface:string,text:string,muted:string,accent:string,red:string,green:string,yellow:string,ansi:readonly string[]){
 return {background,sidebar,surface,text,muted,accent,red,green,yellow,terminal:{background,foreground:text,cursor:text,cursorAccent:background,selectionBackground:accent+'55',selectionInactiveBackground:accent+'33',selectionForeground:text,black:ansi[0],red:ansi[1],green:ansi[2],yellow:ansi[3],blue:ansi[4],magenta:ansi[5],cyan:ansi[6],white:ansi[7],brightBlack:muted,brightRed:ansi[1],brightGreen:ansi[2],brightYellow:ansi[3],brightBlue:ansi[4],brightMagenta:ansi[5],brightCyan:ansi[6],brightWhite:text}};
}
export const appThemes={
 dark:palette('#1d1d20','#202023','#28282e','#dedee5','#a1a1ad','#87adf0','#f29898','#83c99a','#e8bd75',['#202020','#e06c75','#83c99a','#e5c07b','#61afef','#c678dd','#56b6c2','#d5d5d5']),
 light:palette('#fafafa','#f0f0f3','#ffffff','#24242a','#62626e','#245a9b','#a12635','#26753b','#806000',['#242424','#a12635','#26753b','#806000','#245a9b','#80358f','#176b75','#555555']),
 mocha:palette('#1e1e2e','#181825','#313244','#cdd6f4','#a6adc8','#cba6f7','#f38ba8','#a6e3a1','#f9e2af',['#45475a','#f38ba8','#a6e3a1','#f9e2af','#89b4fa','#f5c2e7','#94e2d5','#bac2de']),
 nord:palette('#2e3440','#272d38','#3b4252','#eceff4','#b0bbcf','#88c0d0','#bf616a','#a3be8c','#ebcb8b',['#3b4252','#bf616a','#a3be8c','#ebcb8b','#81a1c1','#b48ead','#88c0d0','#e5e9f0']),
} as const;
export function resolveTheme(theme:AppTheme,dark:boolean):ResolvedTheme{return theme==='system'?(dark?'dark':'light'):theme;}
let current:ResolvedTheme='dark';
export function currentAppTerminalPalette(){return {...appThemes[current].terminal};}
export function applyAppTerminalTheme(views:readonly {disposed?:boolean;appearance:{theme:string};instance:{options:{theme?:object}}}[],theme:ResolvedTheme){
 current=theme;for(const view of views)if(!view.disposed&&view.appearance.theme==='app')view.instance.options.theme={...appThemes[theme].terminal};
}
export function backgroundObjectUrl(raw:string):string {
 if(!isAppPreferences({...defaultAppPreferences,background:raw}))throw Error('Invalid background image');
 const comma=raw.indexOf(','),mime=raw.slice(5,raw.indexOf(';'));
 const data=Uint8Array.from(atob(raw.slice(comma+1)),c=>c.charCodeAt(0));
 return URL.createObjectURL(new Blob([data],{type:mime}));
}
let backgroundResource:{raw:string|null;url:string|null}={raw:null,url:null};
function documentBackground(raw:string|null):string|null {
 if(raw!==backgroundResource.raw){const url=raw?backgroundObjectUrl(raw):null;if(backgroundResource.url)URL.revokeObjectURL(backgroundResource.url);backgroundResource={raw,url};}
 return backgroundResource.url;
}
export function applyAppThemeDocument(preferences:AppPreferences,dark:boolean,root:HTMLElement):ResolvedTheme{
 const theme=resolveTheme(preferences.theme,dark),p=appThemes[theme];current=theme;
 root.dataset.appTheme=theme;root.style.colorScheme=theme==='light'?'light':'dark';
 for(const [key,value] of Object.entries({'background':p.background,'sidebar':p.sidebar,'surface':p.surface,'text':p.text,'muted':p.muted,'accent':p.accent,'error':p.red,'success':p.green,'warning':p.yellow,'hover':`color-mix(in srgb, ${p.text} 9%, ${p.background})`,'border':`color-mix(in srgb, ${p.text} 18%, transparent)`,'bg-hover':`color-mix(in srgb, ${p.accent} 22%, ${p.background})`,'on-accent':theme==='light'?'#ffffff':'#172032','shadow':theme==='light'?'#0002':'#0008','overlay':theme==='light'?'#0004':'#0009'}))root.style.setProperty('--'+key,value);
 const background=documentBackground(preferences.background);root.style.setProperty('--background-image',background?`url("${background}")`:'none');root.style.setProperty('--background-cover',(100-preferences.backgroundStrength)+'%');
 return theme;
}
