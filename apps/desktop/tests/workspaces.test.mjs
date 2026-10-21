import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupProjects,
  isProjects,
  projectName,
  readPreference,
} from "../src/workspaces.ts";

test("existing sessions group by full directory, preserving distinct projects with the same name", () => {
  const sessions = [
    { summary: { cwd: "/work/api/" }, id: "one" },
    { summary: { cwd: "/work/api" }, id: "two" },
    { summary: { cwd: "/other/api" }, id: "three" },
  ];
  const projects = groupProjects(
    [
      { path: "/work/api", name: "Backend" },
      { path: "/work/ui", name: "Frontend" },
    ],
    sessions,
  );
  assert.equal(projects.length, 3);
  assert.equal(projects[0].name, "Backend");
  assert.deepEqual(
    projects[0].sessions.map((session) => session.id),
    ["one", "two"],
  );
  assert.deepEqual(projects[1].sessions, []);
  assert.equal(projects[2].name, "api");
  assert.equal(projects[2].sessions[0].id, "three");
});

test("directory labels support POSIX roots and Windows paths", () => {
  assert.equal(projectName("/"), "/");
  assert.equal(projectName("/work/app/"), "app");
  assert.equal(projectName("C:\\work\\app\\"), "app");
});

test("invalid or inaccessible stored preferences fall back without breaking startup", () => {
  const previous = globalThis.localStorage;
  try {
    for (const stored of ["{", "null", '[{"path":3,"name":"x"}]']) {
      globalThis.localStorage = { getItem: () => stored };
      assert.deepEqual(readPreference("projects", [], isProjects), []);
    }
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("unavailable");
      },
    };
    assert.deepEqual(readPreference("projects", [], isProjects), []);
    globalThis.localStorage = {
      getItem: () => '[{"path":"/work/app","name":"App"}]',
    };
    assert.deepEqual(readPreference("projects", [], isProjects), [
      { path: "/work/app", name: "App" },
    ]);
  } finally {
    globalThis.localStorage = previous;
  }
});

test('session titles trim whitespace and reject empty or oversized names', async () => {
 const { validateSessionTitle, matchesStatus } = await import('../src/workspaces.ts');
 assert.equal(validateSessionTitle('  My task  '), 'My task');
 assert.throws(() => validateSessionTitle('  '));
 assert.throws(() => validateSessionTitle('x'.repeat(201)));
 assert.equal(matchesStatus('running', 'active'), true);
 assert.equal(matchesStatus('failed', 'active'), false);
 assert.equal(matchesStatus('needs_attention', 'attention'), true);
 assert.equal(matchesStatus('succeeded', 'all'), true);
});

test('directory selection validates chosen paths and preserves cancellation', async () => {
 const { selectProjectDirectory } = await import('../src/workspaces.ts');
 const checks = [];
 assert.equal(await selectProjectDirectory(async () => null, async p => checks.push(p)), null);
 assert.deepEqual(checks, []);
 assert.equal(await selectProjectDirectory(async () => '/valid/path', async p => checks.push(p)), '/valid/path');
 assert.deepEqual(checks, ['/valid/path']);
 await assert.rejects(selectProjectDirectory(async () => '/missing', async () => { throw Error('missing'); }));
 await assert.rejects(selectProjectDirectory(async () => { throw Error('picker failed'); }, async () => {}));
});

test("status filters match exact terminal states and both attention states", async () => {
 const {matchesStatus} = await import('../src/workspaces.ts');
 assert.equal(matchesStatus('starting','active'),true);
 assert.equal(matchesStatus('failed','attention'),true);
 assert.equal(matchesStatus('running','attention'),false);
 assert.equal(matchesStatus('succeeded','succeeded'),true);
 assert.equal(matchesStatus('stopped','succeeded'),false);
});

test('project rename validates trimmed Unicode code points without changing legacy labels',async()=>{const {validateProjectName}=await import('../src/workspaces.ts');assert.equal(validateProjectName('  工作 API  '),'工作 API');assert.equal(validateProjectName('😀'.repeat(200)),'😀'.repeat(200));for(const value of ['', ' ', '😀'.repeat(201),null])assert.throws(()=>validateProjectName(value));assert.equal(projectName('/work/api'),'api');});

// Author: Jeff.Liu. Adjacent saved-array exchange, using the production module.
test('project adjacent move preserves objects/group order and rejects ambiguous identity',async()=>{const {moveProjectAdjacent,groupProjects}=await import('../src/workspaces.ts');const a={path:'/a',name:'Same'},b={path:'/b',name:'Same'},c={path:'/c',name:'C'},rows=[a,b,c];const next=moveProjectAdjacent(rows,'/b','up');assert.deepEqual(next,[b,a,c]);assert.deepEqual(rows,[a,b,c]);assert.equal(next[0],b);assert.deepEqual(moveProjectAdjacent(rows,'/b','down'),[a,c,b]);const sessions=[{summary:{cwd:'/a'},id:1},{summary:{cwd:'/a'},id:2},{summary:{cwd:'/derived'},id:3}];assert.deepEqual(groupProjects(next,sessions).map(x=>x.path),['/b','/a','/c','/derived']);assert.deepEqual(groupProjects(next,sessions)[1].sessions,sessions.slice(0,2));for(const [items,path,direction] of [[rows,'/a','up'],[rows,'/c','down'],[rows,'/a','bad'],[rows,'/missing','down'],[rows,'/a/','down'],[[a,{path:'/a/',name:'duplicate'}],'/a','down'],[[], '/', 'up'],[[a],'/a','down']])assert.equal(moveProjectAdjacent(items,path,direction),items);});

test('project adjacent move follows existing root Windows trailing path identity',async()=>{const {moveProjectAdjacent}=await import('../src/workspaces.ts');for(const path of ['/','C:\\work\\api\\','/work/api/']){const first={path,name:'Same'},last={path:'/different',name:'Same'},rows=[first,last];assert.deepEqual(moveProjectAdjacent(rows,path,'down'),[last,first]);assert.equal(moveProjectAdjacent(rows,path,'up'),rows);} });

// Author: Jeff.Liu. Optional saved project pin and stable group boundaries.
test('project pin validates explicit boolean while legacy remains readable and groups pinned first',async()=>{const w=await import('../src/workspaces.ts'),a={path:'/a',name:'A'},b={path:'/b',name:'B',pinned:true};assert.equal(w.isProjects([a,b]),true);for(const pinned of [null,'true',1,undefined])assert.equal(w.isProjects([{...a,pinned}]),false);const sessions=[{summary:{cwd:'/derived'}}];assert.deepEqual(w.groupProjects([a,b],sessions).map(p=>p.path),['/b','/a','/derived']);assert.equal(w.moveProjectAdjacent([b,a],'/a','up').map(p=>p.path).join(','),'/b,/a');});
test('project pin toggle enters pinned tail and unpin stable ordinary group without old-position metadata',async()=>{const w=await import('../src/workspaces.ts'),a={path:'/a',name:'A'},b={path:'/b',name:'B',pinned:true},c={path:'/c',name:'C'},rows=[a,b,c];const pinned=w.setProjectPinned(rows,'/c',true);assert.deepEqual(pinned.map(p=>p.path),['/b','/c','/a']);assert.equal(pinned[0],b);assert.equal(pinned[2],a);assert.equal(pinned[1].pinned,true);assert.deepEqual(w.setProjectPinned(pinned,'/b',false).map(p=>p.path),['/c','/b','/a']);for(const [path,desired] of [['/missing',true],['/a/',true],['/a',false],['/a','true']])assert.equal(w.setProjectPinned(rows,path,desired),rows);assert.equal(w.setProjectPinned([a,{...a,path:'/a/'}],'/a',true).length,2);assert.deepEqual(rows,[a,b,c]);});

test('B01 appearance rejects invalid own fields and accepts fixed legacy enums',async()=>{const w=await import('../src/workspaces.ts');for(const field of ['color','icon'])for(const value of [null,undefined,'toString','url(x)',false])assert.equal(w.isProjects([{path:'/a',name:'A',[field]:value}]),false,field+String(value));assert.equal(w.isProjects([{path:'/a',name:'A',color:'blue',icon:'terminal'}]),true);});

test('B01d fixed colors and icon whitelist never use prototype display values',async()=>{const w=await import('../src/workspaces.ts');for(const [key,hex] of Object.entries({blue:'#60a5fa',green:'#4ade80',orange:'#fb923c',purple:'#c084fc',red:'#f87171',gray:'#9ca3af'})){assert.equal(w.projectColor(key),hex);assert.equal(w.isProjects([{path:'/a',name:'A',color:key}]),true);}for(const value of ['constructor','__proto__',null,undefined,'red;display:none'])assert.equal(w.projectColor(value),'currentColor');for(const icon of ['folder','terminal','play'])assert.equal(w.validProjectIcon(icon),true);});

// Author: Jeff.Liu. Drop at the target group index, preserving other slots and object identity.
test('project drag target moves both directions and retains interleaved pin groups',async()=>{
 const {moveProjectToTarget:move}=await import('../src/workspaces.ts');assert.equal(typeof move,'function');
 for(const pinned of [true,false]){
  const a={path:'/a',name:'Same',pinned,color:'blue'},b={path:'/b',name:'Same',pinned,icon:'terminal'},c={path:'/c',name:'C',pinned},other={path:'/other',name:'Other',pinned:!pinned},rows=[a,other,b,c];
  const down=move(rows,'/a','/c'),up=move(rows,'/c','/a');assert.deepEqual(down,[b,other,c,a]);assert.deepEqual(up,[c,other,a,b]);assert.equal(down[1],other);assert.equal(down[3],a);assert.equal(up[0],c);assert.deepEqual(rows,[a,other,b,c]);assert.deepEqual(move(rows,'/a','/b'),[b,other,a,c]);
 }
});
test('project drag target invalid identities self and pin fences retain exact array',async()=>{
 const {moveProjectToTarget:move}=await import('../src/workspaces.ts');assert.equal(typeof move,'function');const a={path:'/a',name:'A'},b={path:'/b',name:'B'},rows=[a,b];
 for(const [items,from,to] of [[rows,'/a','/a'],[rows,'/missing','/b'],[rows,'/a','/missing'],[rows,'/a/','/b'],[rows,'/a','/b/'],[[a,{...a,path:'/a/'},b],'/a','/b'],[[a,b,{...b,path:'/b/'}],'/a','/b'],[[a,{...b,pinned:true}],'/a','/b'],[[], '/a','/b']])assert.equal(move(items,from,to),items);
 for(const path of ['/','C:\\work\\api\\','/work/api/']){const first={path,name:'Root'},items=[first,b];assert.deepEqual(move(items,path,'/b'),[b,first]);}
});
