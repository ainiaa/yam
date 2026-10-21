// Author: Jeff.Liu. Legacy wiring fixtures inspect the English projection of constant JSX labels.
// Runtime/dynamic translations are kept; bilingual tests read the unmodified production source.
export function englishUiSource(source){
 if(typeof source!=='string')return source;
 source=source.replace(/^import \{t\} from ["']\.\/i18n["'];?\s*\n/gm,'');
 const literal='("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\')';
 source=source.replace(new RegExp('(title|aria-label|placeholder|alt)=\\{t\\('+literal+'\\)\\}','g'),(_m,attr,value)=>attr+'='+JSON.stringify(value[0]==='"'?JSON.parse(value):value.slice(1,-1)));
 source=source.replace(new RegExp('\\{t\\('+literal+'\\)\\}','g'),(_m,value)=>value[0]==='"'?JSON.parse(value):value.slice(1,-1));
 source=source.replace(/\{(" "\+)?t\(("(?:[^"\\]|\\.)*")\)(\+" ")?\}/g,(_m,before,value,after)=>(before?' ':'')+JSON.parse(value)+(after?' ':''));
 return source;
}
export function englishUiRead(read,...args){const result=read(...args);return /\.tsx(?:$|\?)/.test(String(args[0]))?englishUiSource(result):result;}
export async function englishUiReadAsync(read,...args){const result=await read(...args);return /\.tsx(?:$|\?)/.test(String(args[0]))?englishUiSource(result):result;}
