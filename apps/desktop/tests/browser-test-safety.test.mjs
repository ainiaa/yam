// Author: Jeff.Liu. Verify browser launch policy without starting a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const files = ['header-layout.test.mjs', 'terminal-frame-browser.test.mjs', 'external-terminal-stream.test.mjs'];

test('browser tests require explicit opt-in even when a browser is installed or configured', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yam-browser-policy-'));
  try {
    const marker = join(directory, 'launches.jsonl');
    const preload = join(directory, 'sentinel.mjs');
    writeFileSync(preload, `
      import cp from 'node:child_process';
      import {appendFileSync} from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const original = cp.spawn;
      cp.spawn = function(program, args, options) {
        if (args?.includes('--headless')) {
          appendFileSync(${JSON.stringify(marker)}, JSON.stringify(args) + '\\n');
          return original(process.execPath, ['-e', 'process.exit(64)'], options);
        }
        return original(program, args, options);
      };
      syncBuiltinESMExports();
    `);
    const run = enabled => {
      const env = {...process.env, CHROME_BIN: process.execPath};
      delete env.NODE_TEST_CONTEXT;
      delete env.YAM_TEST_HEADLESS_CHROME;
      if (enabled !== undefined) env.YAM_TEST_HEADLESS_CHROME = enabled;
      return spawnSync(process.execPath, ['--import', preload, '--test', '--test-concurrency=1',
        ...files.map(name => fileURLToPath(new URL(name, import.meta.url)))],
      {env, encoding:'utf8', timeout:30000});
    };
    for (const value of [undefined, '0', 'true']) {
      const result = run(value);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(existsSync(marker), false, 'default tests must never launch Chrome');
    }
    // The sentinel substitutes Node for Chrome, so this positive control cannot open UI or a keychain.
    const enabled = run('1');
    assert.equal(enabled.status, 1, enabled.stdout + enabled.stderr);
    const launches = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(launches.length, files.length);
    const profiles = new Set();
    for (const args of launches) {
      assert.ok(args.includes('--use-mock-keychain'), 'isolated browser tests must not use the login keychain');
      assert.ok(args.includes('--disable-features=DialMediaRouteProvider'));
      assert.ok(!args.includes('--no-sandbox'));
      const profile = args.find(arg => arg.startsWith('--user-data-dir='));
      assert.match(profile, /yam-(header-layout|frame-render|stream-render)-[^/\\]+[/\\]profile$/);
      profiles.add(profile);
    }
    assert.equal(profiles.size, files.length, 'each browser test owns a fresh profile');
  } finally {
    rmSync(directory, {recursive:true, force:true});
  }
});
