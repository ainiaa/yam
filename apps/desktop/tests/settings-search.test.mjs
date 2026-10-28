// Author: Jeff.Liu. Search is navigation only and does not change preferences.
import test from 'node:test';import assert from 'node:assert/strict';
import {matchesSettingsPage} from '../src/settings-search.ts';
test('settings search supports source language, translated label and whitespace',()=>{assert.equal(matchesSettingsPage('appearance','Appearance',' 主题 '),true);assert.equal(matchesSettingsPage('keyboard-shortcuts','Keyboard shortcuts','SHORTCUT'),true);assert.equal(matchesSettingsPage('updates','Updates','自动更新'),true);assert.equal(matchesSettingsPage('settings','Terminal',''),true);assert.equal(matchesSettingsPage('settings','Terminal','nonsense'),false);});

test('notification troubleshooting search finds the actual test-notification page',()=>{for(const query of ['通知','notification','troubleshooting'])assert.equal(matchesSettingsPage('support','Data and diagnostics',query),true);});
