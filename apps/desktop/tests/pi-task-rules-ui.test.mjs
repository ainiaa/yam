// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {defaultRules,validateRules,rulesVersion} from '../src-tauri/pi/task-rules.mjs';

test('rule editor stages changes, applies explicitly, restores defaults locally and previews without applying',async()=>{
 const ast=ts.createSourceFile('PiTaskRules.tsx',readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='PiTaskRules');
 const slots=[];let i=0,saved=structuredClone(defaultRules),applies=0,previews=0,reject=false;
 const env={useState:value=>{const j=i++;if(!(j in slots))slots[j]=typeof value==='function'?value():value;return [slots[j],v=>slots[j]=typeof v==='function'?v(slots[j]):v];},useEffect:()=>{},validateRules,rulesVersion,defaultRules,t:s=>s,Select:'select',React:{createElement:(type,props,...children)=>({type,props:props??{},children})}};
 const code=ts.transpileModule(fn.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(env),code+';return PiTaskRules;')(...Object.values(env));
 const render=()=>{i=0;return component({rules:saved,disabled:false,onApply:async r=>{if(reject)throw Error('save rejected');applies++;saved=r;},onPreview:async()=>{previews++;return 'preview result';}});};
 const all=n=>!n||typeof n!=='object'?[]:[n,...n.children.flat(Infinity).flatMap(all)];
 const button=name=>all(render()).find(n=>n.type==='button'&&n.children.includes(name));
 const review=all(render()).find(n=>n.props['aria-label']==='Rule reasoning: review');
 assert.deepEqual(review.children.flat(Infinity).filter(n=>n?.type==='option').map(n=>n.props.value),['high','xhigh','max']);
 const description=all(render()).find(n=>n.props['aria-label']==='Rule description: transform');description.props.onChange({target:{value:'Translate supplied content only'}});
 assert.equal(applies,0);assert.equal(button('Apply task rules').props.disabled,false);
 await button('Apply task rules').props.onClick();assert.equal(applies,1);assert.equal(saved.rules[0].description,'Translate supplied content only');
 all(render()).find(n=>n.props['aria-label']==='Preview request').props.onChange({target:{value:'translate hello'}});
 await button('Try task rules').props.onClick();assert.equal(previews,1);assert.equal(applies,1);
 button('Restore default task rules').props.onClick();assert.equal(applies,1);assert.equal(button('Apply task rules').props.disabled,false);
 reject=true;await button('Apply task rules').props.onClick();assert.equal(applies,1);assert.equal(button('Apply task rules').props.disabled,false);assert.ok(all(render()).some(n=>n.props.role==='alert'&&n.children.includes('Error: save rejected')));
 saved=structuredClone(saved);saved.rules[1].model='strong';assert.equal(button('Apply task rules').props.disabled,true);
 button('Cancel rule changes').props.onClick();assert.equal(button('Apply task rules').props.disabled,true);
 all(render()).find(n=>n.props['aria-label']==='Fallback reasoning').props.onChange({target:{value:'max'}});reject=false;
 await button('Apply task rules').props.onClick();assert.equal(saved.fallback.effort,'max');
});
