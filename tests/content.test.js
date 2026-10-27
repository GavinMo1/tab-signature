import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
function fixture() {
  const observers = [], events = new Map(), timers = new Map(), listeners = new Set();
  let invalid = false, throwOnSend = false, nextTimer = 0, sends = 0;
  class Observer {
    constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const runtime = {
    get id() { if (invalid) throw new Error('Extension context invalidated.'); return 'extension'; },
    sendMessage() { sends++; if (throwOnSend) throw new Error('Extension context invalidated.'); return Promise.resolve({ ok: true }); },
    onMessage: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } }
  };
  const document = { title: '原始标题', head: {}, documentElement: {} };
  const context = vm.createContext({ chrome: { runtime }, document, location: { href: 'https://example.com/' }, MutationObserver: Observer,
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(source, context);
  function apply() { [...listeners][0]({ type: 'apply', url: 'https://example.com/', name: '自定义标题', sequence: 1 }, { id: 'extension' }, () => {}); }
  return { observers, events, timers, listeners, document, context, apply, invalidate: () => { invalid = true; }, breakSend: () => { throwOnSend = true; }, sends: () => sends };
}
test('invalidation before a queued title timer disposes observers and never writes title again', () => {
  const f = fixture(); f.apply();
  f.document.title = '网站更新';
  f.observers[0].callback([{ target: { nodeName: 'TITLE' }, type: 'characterData' }]);
  const callback = [...f.timers.values()][0]; assert.ok(callback);
  f.invalidate(); assert.doesNotThrow(callback);
  assert.equal(f.document.title, '网站更新');
  assert.ok(f.observers.every(o => !o.connected));
  assert.equal(f.events.size, 0); assert.equal(f.listeners.size, 0);
  assert.equal(f.context.__tabRenamer, undefined);
});
test('invalidation during root/head callbacks cleans up rather than throwing', () => {
  for (const index of [0, 1]) {
    const f = fixture(); f.apply(); f.invalidate();
    assert.doesNotThrow(() => f.observers[index].callback([{ target: { nodeName: 'TITLE' } }]));
    assert.ok(f.observers.every(o => !o.connected));
    assert.equal(f.listeners.size, 0);
  }
});
test('synchronous sendMessage exception is caught even while runtime.id still exists', () => {
  const f = fixture(); f.apply(); f.breakSend();
  assert.doesNotThrow(() => f.events.get('pageshow')());
  assert.ok(f.observers.every(o => !o.connected));
  assert.equal(f.listeners.size, 0); assert.equal(f.events.size, 0);
});
test('late older apply cannot overwrite a newer application on the same URL', () => {
  const f = fixture(); f.apply();
  const handler = [...f.listeners][0];
  handler({ type: 'apply', url: 'https://example.com/', name: '最新名称', sequence: 3 }, { id: 'extension' }, () => {});
  let result;
  handler({ type: 'apply', url: 'https://example.com/', name: '迟到旧名', sequence: 2 }, { id: 'extension' }, value => { result = value; });
  assert.equal(f.document.title, '最新名称'); assert.equal(result.stale, true);
});
