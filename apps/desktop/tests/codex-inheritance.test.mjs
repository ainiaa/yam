import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
// Author: Jeff.Liu.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import {isLaunchDefaults} from '../src/project-config.ts';
import {createLaunchTemplate,encodeLaunchTemplates,decodeLaunchTemplates,projectLaunchFields} from '../src/launch-templates.ts';
const fields={adapter:'codex',mode:'interactive',extra_args:'',prompt:null,command:null};
const id=()=> '12345678-1234-4234-8234-123456789012';
for(const image_mode of ['native','gateway_api'])test(`Codex template preserves ${image_mode} without session storage identity`,()=>{
 const input={...fields,codex:{image_mode,context:'0123456789abcdef0123456789abcdef'}};
 const picked=projectLaunchFields(input);
 assert.deepEqual(picked.codex,{image_mode});
 const template=createLaunchTemplate('Codex',input,id);
 assert.deepEqual(decodeLaunchTemplates(encodeLaunchTemplates([template]))[0].codex,{image_mode});
 assert.equal(JSON.stringify(template).includes('0123456789abcdef'),false);
});
test('Codex image options reject invalid modes, extra properties and other CLIs',()=>{
 assert.equal(isLaunchDefaults(fields),true);
 assert.equal(isLaunchDefaults({...fields,codex:{image_mode:'native'}}),true);
 for(const codex of [{image_mode:'unknown'},{image_mode:'native',extra:true},null,{}])assert.equal(isLaunchDefaults({...fields,codex}),false);
 assert.equal(isLaunchDefaults({...fields,adapter:'claude',codex:{image_mode:'native'}}),false);
});
test('New session offers native default and optional gateway images only for Codex gateways',()=>{
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 assert.match(app,/aria-label="Image generation"/);
 assert.match(app,/<option value="native">Codex default/);
 assert.match(app,/<option value="gateway_api">Gateway image API/);
 assert.match(app,/formAdapter===['"]codex['"]&&formLaunch.provider/);
 assert.match(app,/formLaunch.codex\?\.image_mode\?\?"native"/);
 assert.match(app,/<dt>Image generation<\/dt>/);
});
