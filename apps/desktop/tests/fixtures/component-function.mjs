// Author: Jeff.Liu. Isolated parent JSX fixtures retain their select token; Select itself has separate callback tests.
export function componentFunction(...args){return new Function(...args.slice(0,-1),'const Select="select",EditableCombo="input";'+args.at(-1));}

// Only compiled text is shared; callers still bind a fresh context for every scene.
export function cachedCompilation(compile){
 const cache=new Map();
 return source=>{
  if(!cache.has(source))cache.set(source,compile(source));
  return cache.get(source);
 };
}
