import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Assert the real launch form wiring before exercising the component.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
import {ProviderGatewayController,gatewayOrigin,filterCatalogModels} from '../src/provider-catalog.ts';

const raw=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const source=ts.createSourceFile('App.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);

test('R1A launch form exposes the explicit gateway check with the current endpoint and key reference',()=>{
 const entries=[];
 function visit(node){if((ts.isJsxSelfClosingElement(node)||ts.isJsxOpeningElement(node))&&node.tagName.getText(source)==='ProviderCatalog')entries.push(node);ts.forEachChild(node,visit);}
 visit(source);
 assert.equal(entries.length,1,'the provider connection must expose its gateway check');
 const attributes=new Map(entries[0].attributes.properties.map(item=>[item.name?.getText(source),item.initializer?.expression?.getText(source)]));
 assert.equal(attributes.get('endpoint'),'formLaunch.provider.base_url');
 assert.equal(attributes.get('model'),'formLaunch.provider.model');
 assert.equal(attributes.get('apiKeyEnv'),'formLaunch.provider.api_key_env');
 assert.equal(attributes.get('invoke'),'invoke');
 assert.equal(attributes.get('onSelect'),'model=>changeProviderFields({model})');
 assert.match(entries[0].parent.getText(source),/formLaunch\.provider/);
});

function fixture() {
 const raw=readFileSync(new URL('../src/ProviderCatalog.tsx',import.meta.url),'utf8');
 const file=ts.createSourceFile('ProviderCatalog.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const body=file.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getText(file).replace(/^export /,'')).join('\n');
 const js=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText;
 const values=[],effects=[],listeners=new Map();let index=0,pending=[],tree,updates=0;const focuses=[];
 const dialog={addEventListener:(name,callback)=>listeners.set(name,callback),removeEventListener:(name,callback)=>{if(listeners.get(name)===callback)listeners.delete(name);}};
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 const useRef=initial=>{const at=index++;return values[at]??(values[at]={current:initial});};
 const useState=initial=>{const at=index++;if(!(at in values))values[at]=initial;return [values[at],next=>{updates++;values[at]=typeof next==='function'?next(values[at]):next;}];};
 const useEffect=(fn,deps)=>{const at=index++;if(!effects[at]||deps.some((value,i)=>value!==effects[at].deps[i]))pending.push(()=>{effects[at]?.cleanup?.();effects[at]={deps,cleanup:fn()};});};
 const render=new Function('React','useRef','useState','useEffect','ProviderGatewayController','gatewayOrigin','filterCatalogModels','useId','EditableCombo',js+';return ProviderCatalog;')(React,useRef,useState,useEffect,ProviderGatewayController,gatewayOrigin,filterCatalogModels,()=> 'test-model','combo');
 const calls=[],selected=[];let finish,query;
 const props={endpoint:'http://localhost:3425/v1',model:'manual/model',apiKeyEnv:null,onSelect:id=>selected.push(id),invoke:async(name,args)=>{calls.push([name,args]);if(['check_provider_gateway','load_provider_models'].includes(name)){query=args;return new Promise(resolve=>finish=resolve);}return null;}};
 const nodes=node=>[node,...(node?.props?.children??[]).flatMap(child=>child&&typeof child==='object'?nodes(child):[])];
 const refresh=(flush=true)=>{index=0;tree=render(props);for(const node of nodes(tree))if(node.props?.ref)node.props.ref.current={closest:()=>dialog,focus(){focuses.push(node.props['aria-label']);},querySelector(){return null;}};if(flush){const batch=pending;pending=[];batch.forEach(fn=>fn());}};
 refresh();
 return {props,calls,selected,focuses,refresh,nodes:()=>nodes(tree),button:label=>nodes(tree).find(node=>node.type==='button'&&node.props.children.join('')===label),close:()=>listeners.get('close')?.(),cleanup:()=>effects.forEach(effect=>effect?.cleanup?.()),resolve:()=>finish({query_token:query.queryToken,status:'identified',http_status:200,version:'0.1.fixture'}),resolveModels:(models=[{id:'provider/model-1',display_name:'First',owned_by:'fixture'},{id:'provider/model-2',display_name:'Second',owned_by:null}])=>finish({query_token:query.queryToken,status:'loaded',http_status:200,models}),get updates(){return updates;},get text(){return nodes(tree).flatMap(node=>node.props?.children??[]).filter(value=>typeof value==='string').join(' ');}};
}

test('one model input offers loaded IDs and labels without replacing the manual model',async()=>{const f=fixture();const field=()=>f.nodes().find(n=>n.props?.['aria-label']==='Provider model');assert.equal(field().props.value,'manual/model');f.button('Load gateway models').props.onClick();f.resolveModels();await new Promise(setImmediate);f.refresh();assert.equal(f.nodes().filter(n=>n.props?.['aria-label']==='Provider model').length,1);assert.equal(field().type,'combo');assert.deepEqual(field().props.options,['provider/model-1','provider/model-2']);assert.match(field().props.labels['provider/model-1'],/First.*fixture/);assert.deepEqual(f.selected,[]);field().props.onChange({target:{value:'provider/model-2'}});assert.deepEqual(f.selected,['provider/model-2']);f.cleanup();});
test('model input supports custom IDs and rejects retained callbacks after scope changes',async()=>{const f=fixture();f.button('Load gateway models').props.onClick();f.resolveModels();await new Promise(setImmediate);f.refresh();const field=f.nodes().find(n=>n.props?.['aria-label']==='Provider model');field.props.onChange({target:{value:'my/model'}});assert.deepEqual(f.selected,['my/model']);f.props.apiKeyEnv='OTHER';f.refresh(false);field.props.onChange({target:{value:'provider/model-1'}});assert.deepEqual(f.selected,['my/model']);f.refresh();f.button('Load gateway models').props.onClick();f.resolveModels([]);await new Promise(setImmediate);f.refresh();assert.match(f.text,/No models returned/);assert.equal(f.nodes().filter(n=>n.props?.['aria-label']==='Provider model').length,1);f.cleanup();});

test('R1A actual component checks only after a click and shows sanitized accessible identity',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.button('Check Magpie identity').props.disabled,false);
 f.button('Check Magpie identity').props.onClick();f.refresh();assert.equal(f.calls.length,1);assert.equal(f.button('Check Magpie identity').props.disabled,true);assert.ok(f.nodes().some(node=>node.props?.role==='status'));
 f.resolve();await new Promise(resolve=>setImmediate(resolve));f.refresh();assert.match(f.text,/Magpie 0.1.fixture identified/);assert.ok(f.nodes().some(node=>node.props?.className==='connection-result success'));assert.match(f.text,/upstream authentication, billing and model availability remain unverified/);f.cleanup();
});

test('R1A actual component clears results before effects on selection changes and cancels on dialog close',async()=>{
 const f=fixture();f.button('Check Magpie identity').props.onClick();f.resolve();await new Promise(resolve=>setImmediate(resolve));f.refresh();assert.match(f.text,/Magpie/);
 f.props.apiKeyEnv='NEW_REFERENCE';f.refresh(false);assert.doesNotMatch(f.text,/Magpie 0\.1\.fixture identified/);f.refresh();
 f.button('Check Magpie identity').props.onClick();f.close();assert.equal(f.calls.at(-1)[0],'cancel_provider_gateway');f.resolve();await new Promise(resolve=>setImmediate(resolve));f.refresh();assert.doesNotMatch(f.text,/Magpie 0\.1\.fixture identified/);f.cleanup();
});

test('R1A actual component unmount cancels and late replies never update state',async()=>{
 const f=fixture();f.button('Check Magpie identity').props.onClick();f.cleanup();const before=f.updates;
 assert.equal(f.calls.at(-1)[0],'cancel_provider_gateway');f.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.updates,before);
 const unsupported=fixture();unsupported.props.endpoint='https://example.com/v1';unsupported.refresh();assert.equal(unsupported.button('Check Magpie identity').props.disabled,true);assert.equal(unsupported.calls.length,0);unsupported.cleanup();
});

test('gateway failures have an accessible red error result',async()=>{
 const f=fixture();f.button('Load gateway models').props.onClick();f.resolveModels([{id:'invalid model'}]);await new Promise(resolve=>setImmediate(resolve));f.refresh();
 assert.ok(f.nodes().some(node=>node.props?.role==='alert'&&node.props?.className==='connection-result error'));assert.match(f.text,/unsupported response/);f.cleanup();
});

test('non-Magpie presets retain port/catalog checks without a false Magpie identity failure',()=>{
 const f=fixture();f.props.identityCheck=false;f.refresh();assert.equal(f.button('Check Magpie identity'),undefined);assert.ok(f.button('Load gateway models'));assert.equal(f.calls.length,0);f.cleanup();
});

test('reload, close and unmount reject stale model callbacks',async()=>{const f=fixture();f.button('Load gateway models').props.onClick();f.resolveModels();await new Promise(setImmediate);f.refresh();const stale=f.nodes().find(n=>n.props?.['aria-label']==='Provider model');f.button('Load gateway models').props.onClick();f.refresh();stale.props.onChange({target:{value:'provider/model-1'}});assert.deepEqual(f.selected,[]);f.resolveModels();await new Promise(setImmediate);f.refresh();stale.props.onChange({target:{value:'provider/model-1'}});assert.deepEqual(f.selected,[]);const fresh=f.nodes().find(n=>n.props?.['aria-label']==='Provider model');f.close();fresh.props.onChange({target:{value:'provider/model-1'}});assert.deepEqual(f.selected,[]);f.cleanup();});
