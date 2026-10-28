import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as core from '../extension/core.js';
const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.ok(predicate(), 'condition did not settle');
};
function harness(raw = []) {
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, fire(...args) { for (const fn of this.listeners) fn(...args); } });
  const store = initial => ({ data: initial, writes: 0,
    async get(key) { return { [key]: structuredClone(this.data[key]) }; },
    async set(value) { this.writes++; Object.assign(this.data, structuredClone(value)); }, async remove(key) { delete this.data[key]; }
  });
  const applied = [], tabs = new Map([[1, { id: 1, url: 'https://example.com/a', title: '原始' }]]);
  let sender = async (id, message) => { if (message.type === 'apply') applied.push({ id, ...message }); return { ok: true, url: tabs.get(id).url }; };
  const chrome = {
    storage: { local: store({ rules: structuredClone(raw) }), session: store({}) },
    runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`, onMessage: event(), onInstalled: event(), onStartup: event() },
    tabs: { async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return { ...tabs.get(id) }; }, async query() { return [...tabs.values()]; }, sendMessage: (...args) => sender(...args), onUpdated: event(), onRemoved: event(), onActivated: event() },
    permissions: { async contains() { return true; }, async getAll() { return { origins: [] }; }, onAdded: event(), onRemoved: event() },
    scripting: { async getRegisteredContentScripts() { return []; }, async unregisterContentScripts() {}, async registerContentScripts() {}, async executeScript() {} },
    webNavigation: { onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() }
  };
  // Shorten only deadlines in this isolated harness; no implementation timing changes.
  const context = vm.createContext({ ...core, chrome, crypto: webcrypto, TextEncoder, setTimeout: (fn, delay) => setTimeout(fn, Math.min(delay, 30)), clearTimeout, console: { warn() {} } });
  vm.runInContext(source, context);
  const request = message => new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, { id: 'test', url: 'chrome-extension://test/rules.html' }, resolve));
  const mutation = async (type, index, extra = {}) => { const snapshot = await request({ type: 'listRules' }); return request({ type, index, revision: snapshot.revision, ...extra }); };
  const idle = () => vm.runInContext('activeSyncs === 0 && syncQueue.length === 0 && pendingSync.size === 0 && tabLanes.size === 0', context);
  return { chrome, tabs, applied, request, mutation, context, idle, send: fn => { sender = fn; } };
}
const rule = { id: 'old', url: 'https://example.com/a', name: 'OLD', enabled: true };
test('first permission grant finishes staged rename with no popup completion message', async () => {
  const h = harness(); let permitted = false;
  h.chrome.permissions.contains = async () => permitted;
  const staged = await h.request({ type: 'prepareRename', tabId: 1, url: rule.url, name: '第一次输入', token: 'one' });
  assert.equal(staged.pending, true); assert.equal(h.chrome.storage.session.data['tab:1'], undefined);
  permitted = true; h.chrome.permissions.onAdded.fire();
  await waitFor(() => h.chrome.storage.session.data['tab:1']?.manual === '第一次输入'); await waitFor(h.idle);
  assert.equal(h.applied.at(-1).name, '第一次输入');
  assert.equal(h.chrome.storage.session.data['renameDraft:1'], undefined);
});
test('permission arriving before draft storage still applies once; denial, navigation and expiry cannot rename later', async () => {
  const granted = harness();
  await granted.request({ type: 'prepareRename', tabId: 1, url: rule.url, name: '已授权竞态', token: 'early' });
  assert.equal(granted.chrome.storage.session.data['tab:1'].manual, '已授权竞态');
  for (const mode of ['deny', 'navigate', 'expire', 'close']) {
    const h = harness(); let permitted = false; h.chrome.permissions.contains = async () => permitted;
    await h.request({ type: 'prepareRename', tabId: 1, url: rule.url, name: '不能应用', token: mode });
    if (mode === 'deny') await h.request({ type: 'cancelRename', tabId: 1, token: mode });
    if (mode === 'navigate') h.tabs.get(1).url = 'https://example.com/new';
    if (mode === 'expire') h.chrome.storage.session.data['renameDraft:1'].created = Date.now() - 121000;
    if (mode === 'close') { h.tabs.delete(1); h.chrome.tabs.onRemoved.fire(1); }
    permitted = true; h.chrome.permissions.onAdded.fire();
    await new Promise(resolve => setTimeout(resolve, 40)); await waitFor(h.idle);
    assert.equal(h.chrome.storage.session.data['tab:1']?.manual, undefined, mode);
    assert.equal(h.chrome.storage.session.data['renameDraft:1'], undefined, mode);
  }
});
test('running synchronization reruns latest edit, disable, delete, priority and URL updates', async () => {
  for (const action of ['edit', 'disable', 'delete', 'priority', 'navigate']) {
    const h = harness([rule, { ...rule, id: 'second', type: 'prefix', url: 'https://example.com/', name: 'SECOND' }]);
    let release, started = false;
    h.send(async (id, message) => {
      if (!started) { started = true; await new Promise(resolve => { release = resolve; }); }
      h.applied.push({ id, ...message }); return { ok: true };
    });
    h.chrome.tabs.onUpdated.fire(1, { status: 'complete' }); await waitFor(() => release);
    if (action === 'edit') await h.mutation('saveRule', 0, { rule: { ...rule, name: 'NEW' } });
    if (action === 'disable') await h.mutation('setRuleEnabled', 0, { enabled: false });
    if (action === 'delete') await h.mutation('deleteRule', 0);
    if (action === 'priority') await h.mutation('moveRule', 1, { direction: -1 });
    if (action === 'navigate') { h.tabs.get(1).url = 'https://other.example.org/'; h.chrome.tabs.onUpdated.fire(1, { url: h.tabs.get(1).url }); }
    release(); await waitFor(h.idle);
    const expected = action === 'edit' ? 'NEW' : action === 'navigate' ? null : 'SECOND';
    assert.equal(h.applied.at(-1).name, expected, action);
  }
});
test('frozen rule changes resume without navigation, including fresh worker state', async () => {
  const h = harness([rule]); h.tabs.get(1).frozen = true;
  await h.mutation('saveRule', 0, { rule: { ...rule, name: 'NEW' } }); await waitFor(h.idle); assert.equal(h.applied.length, 0);
  h.tabs.get(1).frozen = false; h.chrome.tabs.onUpdated.fire(1, { frozen: false });
  await waitFor(h.idle); assert.equal(h.applied.at(-1).name, 'NEW');
  vm.runInContext('deferredTabs.clear()', h.context); h.applied.length = 0;
  h.chrome.tabs.onActivated.fire({ tabId: 1 }); await waitFor(() => h.applied.length > 0); await waitFor(h.idle);
});
test('background concurrency is bounded, closed tabs are not requeued, failures release slots', async () => {
  const h = harness([rule]); for (let i = 2; i <= 8; i++) h.tabs.set(i, { ...h.tabs.get(1), id: i });
  const releases = []; let active = 0, peak = 0;
  h.send(async (id, message) => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => releases.push(resolve)); active--;
    return { ok: true };
  });
  h.chrome.runtime.onStartup.fire(); await waitFor(() => releases.length === 3);
  h.chrome.tabs.onUpdated.fire(1, { status: 'complete' }); h.tabs.delete(1); h.chrome.tabs.onRemoved.fire(1);
  // Let timed-out first requests fail and let all remaining work finish/reject.
  while (!h.idle()) { releases.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.equal(vm.runInContext('dirtySync.size + deferredTabs.size + closingTabs.size', h.context), 0);
});
test('raw malformed rows preserve bytes on read; single-row repair/disable/delete and stale rejection', async () => {
  const raw = [{ ...rule, id: 'dup' }, { ...rule, id: 'dup' }, null, 3, { type: 'domain', url: '*', name: 'bad', enabled: true }];
  const h = harness(raw), snapshot = await h.request({ type: 'listRules' });
  assert.equal(snapshot.ok, true); assert.equal(h.chrome.storage.local.writes, 0);
  await h.mutation('setRuleEnabled', 4, { enabled: false });
  assert.deepEqual(h.chrome.storage.local.data.rules[4], { ...raw[4], enabled: false });
  const stale = await h.request({ type: 'deleteRule', index: 0, revision: snapshot.revision }); assert.equal(stale.ok, false);
  const repaired = await h.mutation('saveRule', 1, { rule: { url: 'https://example.com/new', name: '修正', enabled: false } });
  assert.equal(repaired.ok, true); assert.notEqual(repaired.rule.id, 'dup');
  assert.deepEqual(h.chrome.storage.local.data.rules[0], raw[0]);
  await h.mutation('deleteRule', 2); assert.equal(h.chrome.storage.local.data.rules[2], 3);
  assert.deepEqual(h.chrome.storage.local.data.rules[0], raw[0]);
  assert.equal((await h.mutation('setRuleEnabled', 2, { enabled: false })).ok, false);
  const primitive = await h.mutation('saveRule', 2, { rule: { url: 'https://example.com/fixed', name: '修正数字', enabled: false } }); assert.equal(primitive.ok, true);
  const nonArray = harness({ broken: true }); assert.equal((await nonArray.request({ type: 'listRules' })).ok, false);
  assert.deepEqual(nonArray.chrome.storage.local.data.rules, { broken: true });
  await waitFor(h.idle);
});
