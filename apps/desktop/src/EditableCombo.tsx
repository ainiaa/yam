import {t} from "./i18n";
// Author: Jeff.Liu. Keep editable drafts and suggestions in one field; validate at the settings boundary.
import {useEffect,useId,useLayoutEffect,useRef,useState,type ChangeEvent,type InputHTMLAttributes} from 'react';
import {createPortal} from 'react-dom';
import {selectMenuGeometry} from './select-options';
type Props=Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'type'|'size'>&{value:string;options:readonly string[];labels?:Readonly<Record<string,string>>;onChange:(event:ChangeEvent<HTMLInputElement>)=>void};
export function EditableCombo({value,options,labels,onChange,disabled,...props}:Props){
 const root=useRef<HTMLSpanElement>(null),input=useRef<HTMLInputElement>(null),menu=useRef<HTMLDivElement>(null);
 const id=useId(),[open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState(0);
 const [geometry,setGeometry]=useState<ReturnType<typeof selectMenuGeometry>|null>(null);
 const words=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
 const filtered=options.filter(option=>words.every(word=>(option+' '+(labels?.[option]??'')).toLocaleLowerCase().includes(word)));
 const index=Math.max(0,Math.min(active,filtered.length-1));
 function begin(){if(disabled||input.current?.matches(":disabled"))return;setQuery('');setActive(Math.max(0,options.indexOf(value)));setOpen(true);input.current?.focus();}
 function pick(choice:string){if(disabled||input.current?.matches(":disabled")||!options.includes(choice))return;onChange({target:{value:choice},currentTarget:{value:choice}} as ChangeEvent<HTMLInputElement>);setOpen(false);input.current?.focus();}
 useLayoutEffect(()=>{if(disabled||input.current?.matches(":disabled"))setOpen(false);});
 useEffect(()=>{
  if(!open)return;
  const place=()=>{const rect=root.current?.getBoundingClientRect();if(!rect||rect.bottom<0||rect.top>window.innerHeight){setOpen(false);return;}setGeometry(selectMenuGeometry(rect,window.innerWidth,window.innerHeight));};
  const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!root.current?.contains(target)&&!menu.current?.contains(target))setOpen(false);};
  place();document.addEventListener('pointerdown',outside,true);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
  return()=>{document.removeEventListener('pointerdown',outside,true);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
 },[open]);
 useLayoutEffect(()=>{if(open)menu.current?.querySelector('[data-active="true"]')?.scrollIntoView({block:'nearest'});},[open,index,query]);
 return <span className="editable-combo" ref={root} onBlur={event=>{if(!root.current?.contains(event.relatedTarget as Node|null)&&!menu.current?.contains(event.relatedTarget as Node|null))setOpen(false);}}>
  <input {...props} ref={input} disabled={disabled} value={value} type="text" autoComplete="off" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-controls={id} aria-expanded={open} aria-activedescendant={open&&filtered.length?`${id}-${index}`:undefined}
   onChange={event=>{onChange(event);setQuery(event.target.value);setActive(0);setOpen(true);}}
   onKeyDown={event=>{
    if(event.nativeEvent.isComposing||event.keyCode===229)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopPropagation();if(!open)begin();else setActive(Math.max(0,Math.min(filtered.length-1,index+(event.key==='ArrowDown'?1:-1))));}
    else if(event.key==='Enter'&&open){event.preventDefault();event.stopPropagation();if(filtered[index])pick(filtered[index]);else setOpen(false);}
    else if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setOpen(false);}
    else if(event.key==='Tab')setOpen(false);
   }}/>
  <button type="button" className="editable-combo-arrow" tabIndex={-1} aria-label={t("Show suggestions")} aria-controls={id} aria-expanded={open} disabled={disabled} onMouseDown={event=>event.preventDefault()} onClick={()=>open?setOpen(false):begin()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor"/></svg></button>
  {open&&geometry&&createPortal(<div className="unified-select-menu" ref={menu} id={id} role="listbox" aria-label={t("{{value0}} suggestions", {value0:props['aria-label']??t('Field')})} style={geometry}>
   {filtered.map((choice,i)=><button type="button" key={choice} id={`${id}-${i}`} role="option" aria-selected={value===choice} data-active={i===index} tabIndex={-1} onMouseDown={event=>event.preventDefault()} onPointerMove={()=>setActive(i)} onClick={()=>pick(choice)}>{labels?.[choice]?<>{labels[choice]}<small>{choice}</small></>:choice}</button>)}
   {!filtered.length&&<span className="unified-select-empty" role="status">{t("No preset matches. Your custom value is kept.")}</span>}
  </div>,input.current?.closest('dialog[open]')??document.body)}
 </span>;
}
