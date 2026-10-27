import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as core from '../extension/core.js';

test('unresponsive content and script injection cannot block reads, rule saves or another tab', async () => {
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const storage = () => {
    const data = {};
    return {
      async get(key) { return { [key]: data[key] }; },
      async set(value) { Object.assign(data, value); },
      async remove(key) { delete data[key]; }
    };
  };
  const pages = { 1: { id: 1, url: 'https://example.com/slow', title: '慢页面' }, 2: { id: 2, url: 'https://example.com/fast', title: '快页面' } };
  const injections = [];
  const never = () => new Promise(() => {});
  const chrome = {
    storage: { local: storage(), session: storage() },
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, onMessage: event(), onInstalled: event(), onStartup: event() },
    tabs: {
      async get(id) { return pages[id]; }, async query() { return Object.values(pages); },
      sendMessage(id, message) { return id === 1 ? never() : Promise.resolve({ ok: true, url: pages[id].url, original: pages[id].title }); },
      onUpdated: event(), onRemoved: event(), onActivated: event()
    },
    permissions: { async contains() { return true; }, async getAll() { return { origins: ['https://example.com/*'] }; }, onAdded: event(), onRemoved: event() },
    scripting: { executeScript(options) { injections.push(options.target.tabId); return never(); }, async getRegisteredContentScripts() { return []; }, async registerContentScripts() {}, async unregisterContentScripts() {} },
    webNavigation: { onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() }
  };
  const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
  vm.runInNewContext(source, { ...core, chrome, crypto: webcrypto, TextEncoder, console, setTimeout, clearTimeout });
  const handler = chrome.runtime.onMessage.listeners[0];
  const request = message => new Promise(resolve => handler(message, { id: 'extension', url: 'chrome-extension://extension/popup.html' }, resolve));
  await chrome.storage.session.set({ 'tab:1': { url: pages[1].url, manual: '慢页面手动名称' } });
  chrome.tabs.onUpdated.listeners[0](1, { status: 'complete' });
  const started = performance.now();
  const read = await request({ type: 'getTab', tabId: 1 });
  assert.equal(read.ok, true); assert.equal(read.name, '慢页面手动名称');
  assert.ok(performance.now() - started < 500, 'read only waits for the optional 100ms inspection');
  const editStarted = performance.now();
  const snapshot = await request({ type: 'listRules' });
  const saved = await request({ type: 'saveRule', revision: snapshot.revision, index: null, rule: { url: 'https://example.com/fast', name: '快速规则' } });
  assert.equal(saved.ok, true);
  const renamed = await request({ type: 'rename', tabId: 2, url: pages[2].url, name: '快速改名' });
  assert.equal(renamed.ok, true); assert.equal(renamed.name, '快速改名');
  assert.ok(performance.now() - editStarted < 500, 'writes on unrelated tabs do not await the hung tab');
  const reads = [];
  chrome.tabs.sendMessage = async (id, message) => { reads.push(id); throw new Error('No agent'); };
  pages[3] = { id: 3, url: 'https://example.com/unused', title: '未命中' };
  pages[4] = { id: 4, url: 'https://example.com/fast', title: '休眠', discarded: true };
  chrome.tabs.onUpdated.listeners[0](3, { status: 'complete' });
  chrome.tabs.onUpdated.listeners[0](4, { status: 'complete' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reads.includes(4), false, 'discarded tab receives no content messages');
  assert.equal(injections.includes(3), false, 'unmatched page is not injected');
  assert.equal(injections.includes(4), false, 'discarded matching page is not injected');
});
