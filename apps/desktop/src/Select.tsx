import {t} from "./i18n";
// Author: Jeff.Liu. Preserve the native change event while sharing one accessible menu.
import {useEffect,useId,useImperativeHandle,useLayoutEffect,useRef,useState,type Ref,type SelectHTMLAttributes} from "react";
import {createPortal} from "react-dom";
import {nextSelectIndex,typeaheadSelectIndex,selectMenuGeometry,type SelectOption} from "./select-options";

type Props=Omit<SelectHTMLAttributes<HTMLSelectElement>,"ref"|"multiple"|"size">&{ref?:Ref<HTMLButtonElement>;"data-tab-drop-block"?:boolean};
export function Select({ref,children,style,className,...props}:Props) {
 const native=useRef<HTMLSelectElement>(null),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
 const id=useId(),[open,setOpen]=useState(false),[active,setActive]=useState(-1);
 const [snapshot,setSnapshot]=useState<{options:SelectOption[];label:string;disabled:boolean}>({options:[],label:"",disabled:!!props.disabled});
 const [geometry,setGeometry]=useState<ReturnType<typeof selectMenuGeometry>|null>(null);
 const typed=useRef({text:"",at:0});
 useImperativeHandle(ref,()=>trigger.current!,[]);
 useLayoutEffect(()=>{
  const select=native.current;if(!select)return;
  const next={options:Array.from(select.options,option=>({value:option.value,label:option.label,disabled:option.disabled||option.parentElement?.tagName==="OPTGROUP"&&(option.parentElement as HTMLOptGroupElement).disabled})),label:select.selectedOptions[0]?.label??"",disabled:select.matches(":disabled")};
  setSnapshot(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);
  if(next.disabled)setOpen(false);
 });
 const options=snapshot.options;
 function reveal(index:number){
  const choice=menu.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);if(!choice||!menu.current)return;
  const bounds=menu.current.getBoundingClientRect(),rect=choice.getBoundingClientRect();
  if(rect.top<bounds.top)menu.current.scrollTop-=bounds.top-rect.top;else if(rect.bottom>bounds.bottom)menu.current.scrollTop+=rect.bottom-bounds.bottom;
 }
 useLayoutEffect(()=>{if(open)reveal(active);},[open,active,geometry]);
 useEffect(()=>{
  if(!open)return;
  const place=()=>{const rect=trigger.current?.getBoundingClientRect();if(!rect||rect.bottom<0||rect.top>window.innerHeight){setOpen(false);return;}setGeometry(selectMenuGeometry(rect,window.innerWidth,window.innerHeight));};
  const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!trigger.current?.contains(target)&&!menu.current?.contains(target))setOpen(false);};
  place();document.addEventListener("pointerdown",outside,true);window.addEventListener("resize",place);window.addEventListener("scroll",place,true);
  return()=>{document.removeEventListener("pointerdown",outside,true);window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true);};
 },[open]);
 useEffect(()=>{if(open)setActive(index=>options[index]?.disabled||!options[index]?nextSelectIndex(options,-1,"first"):index);},[options,open]);
 function begin(){
  if(!native.current||native.current.matches(":disabled"))return;
  typed.current={text:"",at:0};const selected=native.current.selectedIndex;
  setActive(options[selected]&&!options[selected].disabled?selected:nextSelectIndex(options,-1,"first"));setOpen(true);
 }
 function pick(index:number){
  const select=native.current,option=select?.options[index];
  if(!select||select.matches(":disabled")||!option||option.disabled||option.parentElement?.tagName==="OPTGROUP"&&(option.parentElement as HTMLOptGroupElement).disabled)return;
  if(select.value!==option.value){select.value=option.value;select.dispatchEvent(new Event("change",{bubbles:true}));}setOpen(false);trigger.current?.focus();
 }
 return <span className={`unified-select ${className??""}`} style={style}>
  <button ref={trigger} id={props.id} type="button" role="combobox" className="unified-select-trigger" disabled={snapshot.disabled} autoFocus={props.autoFocus}
   aria-label={props["aria-label"]} aria-labelledby={props["aria-labelledby"]} aria-describedby={props["aria-describedby"]} title={props.title}
   data-tab-drop-block={props["data-tab-drop-block"]} aria-haspopup="listbox" aria-controls={id} aria-expanded={open} aria-activedescendant={open&&active>=0?`${id}-${active}`:undefined}
   onBlur={event=>{if(!menu.current?.contains(event.relatedTarget as Node|null))setOpen(false);}}
   onClick={()=>open?setOpen(false):begin()}
   onKeyDown={event=>{
    if(event.nativeEvent.isComposing||event.keyCode===229)return;
    if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){
     event.preventDefault();event.stopPropagation();if(!open){begin();return;}
     setActive(nextSelectIndex(options,active,event.key==="ArrowDown"?"next":event.key==="ArrowUp"?"previous":event.key==="Home"?"first":"last"));
    }else if(event.key==="Enter"||event.key===" "){event.preventDefault();event.stopPropagation();if(open)pick(active);else begin();}
    else if(event.key==="Escape"&&open){event.preventDefault();event.stopPropagation();setOpen(false);}
    else if(event.key==="Tab")setOpen(false);
    else if(event.key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey){
     event.preventDefault();const now=Date.now(),last=typed.current,text=now-last.at>700?event.key:last.text+event.key;
     typed.current={text,at:now};const query=Array.from(text).every(char=>char.toLowerCase()===event.key.toLowerCase())?event.key:text;
     const next=typeaheadSelectIndex(options,open?active:native.current?.selectedIndex??-1,query);if(open)setActive(next);else if(next>=0)pick(next);
    }
   }}><span>{snapshot.label}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor"/></svg></button>
  <select {...props} id={undefined} autoFocus={false} ref={native} hidden tabIndex={-1} aria-hidden="true">{children}</select>
  {open&&geometry&&createPortal(<div ref={menu} id={id} className="unified-select-menu" role="listbox" aria-label={props["aria-label"]} style={geometry}>
   {options.map((option,index)=><button type="button" key={option.value} id={`${id}-${index}`} data-index={index} data-active={index===active} role="option" tabIndex={-1} aria-selected={native.current?.value===option.value} disabled={option.disabled}
    onMouseDown={event=>event.preventDefault()} onPointerMove={()=>{if(!option.disabled)setActive(index);}} onClick={()=>pick(index)}><span>{option.label}</span>{native.current?.value===option.value&&<span aria-hidden="true">✓</span>}</button>)}
   {!options.length&&<span className="unified-select-empty">{t("No options available")}</span>}
  </div>,trigger.current?.closest("dialog[open]")??document.body)}
 </span>;
}
