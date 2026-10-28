// Author: Jeff.Liu. Action menus dismiss conventionally; ordinary disclosure sections stay open.
export function installActionMenus(document:Document):()=>void{
 const opened=()=>Array.from(document.querySelectorAll<HTMLDetailsElement>('details.toolbar-more[open]'));
 const outside=(event:Event)=>{for(const menu of opened())if(!menu.contains(event.target as Node))menu.open=false;};
 const toggle=(event:Event)=>{const target=event.target as HTMLDetailsElement;if(target.matches?.('details.toolbar-more')&&target.open)for(const menu of opened())if(menu!==target)menu.open=false;};
 const click=(event:Event)=>{const button=(event.target as Element)?.closest?.('button');if(!button||button.disabled||button.getAttribute?.("role")==="combobox")return;const menu=button.closest<HTMLDetailsElement>('details.toolbar-more');if(menu)menu.open=false;};
 const change=(event:Event)=>{const target=event.target as HTMLSelectElement;if(target.tagName==='SELECT'){const menu=target.closest<HTMLDetailsElement>('details.toolbar-more');if(menu)menu.open=false;}};
 const key=(event:KeyboardEvent)=>{
  if(event.defaultPrevented||event.isComposing||event.keyCode===229)return;
  if(event.key==='Escape'){
   const menus=opened(),menu=menus[menus.length-1];
   if(menu){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector<HTMLElement>('summary')?.focus();}
   return;
  }
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||event.metaKey||event.ctrlKey||event.altKey)return;
  const target=event.target as HTMLElement|null;
  if(!target||target.closest('input,textarea,select,[contenteditable=true],[role=combobox]'))return;
  const menu=target.closest<HTMLDetailsElement>('details.toolbar-more');if(!menu)return;
  const summary=menu.querySelector<HTMLElement>('summary'),fromSummary=target===summary;
  if(!fromSummary&&(!menu.open||!target.closest('button')))return;
  if(fromSummary)menu.open=true;
  const items=Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter(button=>!button.disabled&&button.getClientRects().length>0);
  if(!items.length)return;
  event.preventDefault();event.stopPropagation();
  const index=items.indexOf(document.activeElement as HTMLButtonElement),last=items.length-1;
  const next=event.key==='Home'?0:event.key==='End'?last:index<0?(event.key==='ArrowUp'?last:0):(index+(event.key==='ArrowDown'?1:items.length-1))%items.length;
  items[next].focus();
 };

 document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside);document.addEventListener('toggle',toggle,true);document.addEventListener('click',click);document.addEventListener('change',change);document.addEventListener('keydown',key);
 return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside);document.removeEventListener('toggle',toggle,true);document.removeEventListener('click',click);document.removeEventListener('change',change);document.removeEventListener('keydown',key);};
}
