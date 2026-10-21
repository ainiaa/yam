// Author: Jeff.Liu. Action menus dismiss conventionally; ordinary disclosure sections stay open.
export function installActionMenus(document:Document):()=>void{
 const opened=()=>Array.from(document.querySelectorAll<HTMLDetailsElement>('details.toolbar-more[open]'));
 const outside=(event:Event)=>{for(const menu of opened())if(!menu.contains(event.target as Node))menu.open=false;};
 const toggle=(event:Event)=>{const target=event.target as HTMLDetailsElement;if(target.matches?.('details.toolbar-more')&&target.open)for(const menu of opened())if(menu!==target)menu.open=false;};
 const click=(event:Event)=>{const button=(event.target as Element)?.closest?.('button');if(!button||button.disabled||button.getAttribute?.("role")==="combobox")return;const menu=button.closest<HTMLDetailsElement>('details.toolbar-more');if(menu)menu.open=false;};
 const change=(event:Event)=>{const target=event.target as HTMLSelectElement;if(target.tagName==='SELECT'){const menu=target.closest<HTMLDetailsElement>('details.toolbar-more');if(menu)menu.open=false;}};
 const key=(event:KeyboardEvent)=>{if(event.key!=='Escape'||event.defaultPrevented)return;const menus=opened(),menu=menus[menus.length-1];if(menu){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector<HTMLElement>('summary')?.focus();}};
 document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside);document.addEventListener('toggle',toggle,true);document.addEventListener('click',click);document.addEventListener('change',change);document.addEventListener('keydown',key);
 return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside);document.removeEventListener('toggle',toggle,true);document.removeEventListener('click',click);document.removeEventListener('change',change);document.removeEventListener('keydown',key);};
}
