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
