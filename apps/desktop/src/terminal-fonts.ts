// Author: Jeff.Liu. Discovery augments presets; it never rewrites a custom font stack.
export const fontPresets=["SFMono-Regular","Menlo","Monaco","Consolas","monospace"];
export async function terminalFontCatalog(invoke:(name:string)=>Promise<unknown>):Promise<{fonts:string[];error:string|null}>{
 try{
  const value=await invoke("list_terminal_fonts");
  if(!Array.isArray(value)||value.length>8192||!value.every(font=>typeof font==="string"&&font.trim().length>0&&font.length<=200&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(font)))throw Error("Invalid font catalog");
  return {fonts:[...new Set([...fontPresets,...value])].sort((a,b)=>a.localeCompare(b)),error:null};
 }catch{return {fonts:[...fontPresets],error:"Installed fonts are unavailable. Presets and custom font names still work."};}
}
