import {t} from "./i18n";
// Author: Jeff.Liu. Preserve the native change event while sharing one accessible menu.
import {useEffect,useId,useImperativeHandle,useLayoutEffect,useRef,useState,type KeyboardEvent,type Ref,type SelectHTMLAttributes} from "react";
import {createPortal} from "react-dom";
import {nextSelectIndex,typeaheadSelectIndex,selectMenuGeometry,type SelectOption} from "./select-options";

type Props=Omit<SelectHTMLAttributes<HTMLSelectElement>,"ref"|"multiple"|"size">&{ref?:Ref<HTMLButtonElement>;searchLabel?:string;"data-tab-drop-block"?:boolean};
export function Select({ref,children,style,className,searchLabel,...props}:Props) {
 const native=useRef<HTMLSelectElement>(null),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
 const search=useRef<HTMLInputElement>(null),results=useRef<HTMLDivElement>(null),revealRequested=useRef(false);
 const id=useId(),[open,setOpen]=useState(false),[activeValue,setActiveValue]=useState<string|null>(null),[query,setQuery]=useState("");
 const [snapshot,setSnapshot]=useState<{options:SelectOption[];value:string;label:string;disabled:boolean}>({options:[],value:"",label:"",disabled:!!props.disabled});
 const [geometry,setGeometry]=useState<ReturnType<typeof selectMenuGeometry>|null>(null);
 const typed=useRef({text:"",at:0});
 useImperativeHandle(ref,()=>trigger.current!,[]);
 useLayoutEffect(()=>{
  const select=native.current;if(!select)return;
  const next={options:Array.from(select.options,option=>{
   const group=option.parentElement?.tagName==="OPTGROUP"?option.parentElement as HTMLOptGroupElement:null;
   return {value:option.value,label:option.label,disabled:option.disabled||!!group?.disabled,group:group?.label,detail:option.dataset.detail,search:option.dataset.search};
  }),value:select.value,label:select.selectedOptions[0]?.label??"",disabled:select.matches(":disabled")};
  setSnapshot(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);
  if(next.disabled)setOpen(false);
 });
 const options=snapshot.options;
 function matches(text:string){
  const tokens=text.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return options.flatMap((option,index)=>{
   const searchable=[option.label,option.value,option.group,option.detail,option.search].join(" ").toLowerCase();
   return tokens.every(token=>searchable.includes(token))?[{option,index}]:[];
  });
 }
 const rows=open?matches(query):[];
 const active=rows.find(row=>row.option.value===activeValue&&!row.option.disabled)?.index??-1;
 const placed=geometry!==null;
 function reveal(index:number){
  const list=searchLabel?results.current:menu.current;
  const choice=list?.querySelector<HTMLElement>(`[data-index="${index}"]`);if(!choice||!list)return;
  const bounds=list.getBoundingClientRect(),rect=choice.getBoundingClientRect();
  if(rect.top<bounds.top)list.scrollTop-=bounds.top-rect.top;else if(rect.bottom>bounds.bottom)list.scrollTop+=rect.bottom-bounds.bottom;
 }
 useLayoutEffect(()=>{if(open&&placed&&revealRequested.current){revealRequested.current=false;reveal(active);}},[open,placed,active,query]);
 useLayoutEffect(()=>{if(open&&placed&&searchLabel)search.current?.focus({preventScroll:true});},[open,placed,searchLabel]);
 useEffect(()=>{
  if(!open)return;
  const place=()=>{const rect=trigger.current?.getBoundingClientRect();if(!rect||rect.bottom<0||rect.top>window.innerHeight){setOpen(false);return;}setGeometry(selectMenuGeometry(rect,window.innerWidth,window.innerHeight,searchLabel?360:180));};
  const reposition=(event:Event)=>{if(event.target===window||!menu.current?.contains(event.target as Node))place();};
  const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!trigger.current?.contains(target)&&!menu.current?.contains(target))setOpen(false);};
  place();document.addEventListener("pointerdown",outside,true);window.addEventListener("resize",place);window.addEventListener("scroll",reposition,true);
  return()=>{document.removeEventListener("pointerdown",outside,true);window.removeEventListener("resize",place);window.removeEventListener("scroll",reposition,true);};
 },[open,searchLabel]);
 function activate(index:number){
  if(index===active){reveal(index);return;}
  revealRequested.current=true;setActiveValue(options[index]?.value??null);
 }
 function begin(){
  if(!native.current||native.current.matches(":disabled"))return;
  trigger.current?.focus({preventScroll:true});
  typed.current={text:"",at:0};const selected=native.current.selectedIndex;
  const index=options[selected]&&!options[selected].disabled?selected:nextSelectIndex(options,-1,"first");
  revealRequested.current=true;setQuery("");setActiveValue(options[index]?.value??null);setOpen(true);
 }
 function pick(index:number){
  const select=native.current,value=options[index]?.value;
  const option=select&&Array.from(select.options).find(item=>item.value===value);
  if(!select||select.matches(":disabled")||!option||option.disabled||option.parentElement?.tagName==="OPTGROUP"&&(option.parentElement as HTMLOptGroupElement).disabled)return;
  if(select.value!==option.value){select.value=option.value;select.dispatchEvent(new Event("change",{bubbles:true}));}setOpen(false);trigger.current?.focus({preventScroll:true});
 }
 function navigate(event:KeyboardEvent<HTMLButtonElement|HTMLInputElement>){
  const direction=event.key==="ArrowDown"?"next":event.key==="ArrowUp"?"previous":event.key==="Home"?"first":"last";
  event.preventDefault();event.stopPropagation();
  if(!open){begin();return;}
  const index=nextSelectIndex(rows.map(row=>row.option),rows.findIndex(row=>row.index===active),direction);
  activate(rows[index]?.index??-1);
 }
 const selected=options.find(option=>option.value===snapshot.value);
 const selectedDetail=selected?.detail?[selected.group,selected.detail].filter(Boolean).join(" · "):"";
 const groups: {label?:string;rows:typeof rows}[]=[];
 for(const row of rows){
  let group=groups[groups.length-1];
  if(!group||group.label!==row.option.group){group={label:row.option.group,rows:[]};groups.push(group);}
  group.rows.push(row);
 }
 const choices=<>{groups.map(group=>{
  const items=group.rows.map(({option,index})=><button type="button" key={option.value} id={`${id}-${index}`} data-index={index} data-active={index===active} role="option" tabIndex={-1} aria-selected={snapshot.value===option.value} disabled={option.disabled} title={searchLabel?[option.label,option.detail].filter(Boolean).join(" · "):undefined}
    onMouseDown={event=>event.preventDefault()} onPointerMove={searchLabel?undefined:()=>{if(!option.disabled)setActiveValue(option.value);}} onClick={()=>pick(index)}>
     {option.detail?<span className="unified-select-model-label"><span>{option.label}</span><small>{option.detail}</small></span>:<span>{option.label}</span>}
     {snapshot.value===option.value&&<span aria-hidden="true">✓</span>}</button>);
  return group.label?<div key={group.rows[0].index} role="group" aria-label={group.label} className="unified-select-group"><div className="unified-select-group-heading" aria-hidden="true">{group.label}</div>{items}</div>:items;
 })}
   {!rows.length&&<span className="unified-select-empty">{query.trim()?t("No matching models"):t("No options available")}</span>}</>;
 return <span className={`unified-select ${className??""}`} style={style}>
  <button ref={trigger} id={props.id} type="button" role="combobox" className="unified-select-trigger" disabled={snapshot.disabled} autoFocus={props.autoFocus}
   aria-label={props["aria-label"]} aria-labelledby={props["aria-labelledby"]} aria-describedby={props["aria-describedby"]} title={props.title??(searchLabel&&selected?.group&&!selectedDetail?snapshot.label:undefined)}
   data-tab-drop-block={props["data-tab-drop-block"]} aria-haspopup="listbox" aria-controls={id} aria-expanded={open} aria-activedescendant={open&&active>=0?`${id}-${active}`:undefined}
   onBlur={event=>{if(!menu.current?.contains(event.relatedTarget as Node|null)&&(!searchLabel||event.relatedTarget))setOpen(false);}}
   onClick={()=>open?setOpen(false):begin()}
   onKeyDown={event=>{
    if(event.nativeEvent.isComposing||event.keyCode===229)return;
    if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){
     navigate(event);
    }else if(event.key==="Enter"||event.key===" "){event.preventDefault();event.stopPropagation();if(open)pick(active);else begin();}
    else if(event.key==="Escape"&&open){event.preventDefault();event.stopPropagation();setOpen(false);}
    else if(event.key==="Tab")setOpen(false);
    else if(!searchLabel&&event.key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey){
     event.preventDefault();const now=Date.now(),last=typed.current,text=now-last.at>700?event.key:last.text+event.key;
     typed.current={text,at:now};const query=Array.from(text).every(char=>char.toLowerCase()===event.key.toLowerCase())?event.key:text;
     const next=typeaheadSelectIndex(options,open?active:native.current?.selectedIndex??-1,query);if(open)activate(next);else if(next>=0)pick(next);
    }
   }}>{selectedDetail?<span className="unified-select-model-label" title={`${snapshot.label} · ${selectedDetail}`}><span>{snapshot.label}</span><small>{selectedDetail}</small></span>:<span>{snapshot.label}</span>}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor"/></svg></button>
  <select {...props} id={undefined} autoFocus={false} ref={native} hidden tabIndex={-1} aria-hidden="true">{children}</select>
  {open&&geometry&&createPortal(<div ref={menu} id={searchLabel?undefined:id} className={`unified-select-menu${searchLabel?" unified-select-searchable":""}`} role={searchLabel?undefined:"listbox"} aria-label={searchLabel?undefined:props["aria-label"]} style={geometry}>
   {searchLabel?<><input ref={search} type="search" className="unified-select-search" role="combobox" aria-label={searchLabel} placeholder={searchLabel} aria-expanded="true" aria-autocomplete="list" aria-controls={id} aria-activedescendant={active>=0?`${id}-${active}`:undefined}
    value={query} onChange={event=>{const value=event.target.value;revealRequested.current=true;setQuery(value);setActiveValue(matches(value).find(row=>!row.option.disabled)?.option.value??null);}}
    onBlur={event=>{if(event.relatedTarget&&!menu.current?.contains(event.relatedTarget as Node)&&event.relatedTarget!==trigger.current)setOpen(false);}}
    onKeyDown={event=>{
     if(event.nativeEvent.isComposing||event.keyCode===229)return;
     if(event.key==="ArrowDown"||event.key==="ArrowUp"){navigate(event);return;}
     if(event.key==="Enter"||event.key==="Escape"){
      event.preventDefault();event.stopPropagation();
      if(event.key==="Enter")pick(active);else{setOpen(false);trigger.current?.focus({preventScroll:true});}
     }else if(event.key==="Tab"){
      trigger.current?.focus({preventScroll:true});
      setOpen(false);
     }
    }}/><div ref={results} id={id} className="unified-select-results" role="listbox" aria-label={props["aria-label"]}>{choices}</div></>:choices}
  </div>,trigger.current?.closest("dialog[open]")??document.body)}
 </span>;
}
