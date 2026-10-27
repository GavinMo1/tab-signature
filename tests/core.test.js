import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeURL, supported, originPattern, cleanName, chooseTitle, saveRule, normalizeRule, ruleOrigins, matchesRule, moveRule } from '../extension/core.js';

test('URL matching is canonical and exact, with query and fragment preserved', () => {
  assert.equal(normalizeURL(' HTTPS://Example.com:443 '), 'https://example.com/');
  assert.equal(originPattern('http://localhost:8000/a'), 'http://localhost/*');
  for (const url of ['chrome://settings', 'file:///a', 'not a url', 'https://u:p@example.com']) assert.throws(() => normalizeURL(url));
  assert.equal(supported('https://chromewebstore.google.com/detail/x'), false);
  assert.equal(supported('https://chrome.google.com/webstore/detail/x'), false);
  const rules = [{ id: 'a', url: 'https://example.com/?a=1&b=2#one', name: 'A', enabled: true }];
  assert.equal(chooseTitle(rules[0].url, null, rules).name, 'A');
  for (const url of ['https://example.com/?b=2&a=1#one', 'https://example.com/?a=1&b=2#two', 'https://example.com/?a=2&b=2#one']) assert.equal(chooseTitle(url, null, rules).name, null);
});
test('prefix supports Aliyun pages without matching misleading hosts', () => {
  const rule = { ...normalizeRule({ type: 'prefix', url: 'https://flow.aliyun.com/' }), enabled: true, name: '流水线' };
  for (const url of ['https://flow.aliyun.com/', 'https://flow.aliyun.com/pipelines/123?x=1#run']) assert.equal(matchesRule(url, rule), true);
  for (const url of ['https://flow.aliyun.com.evil.org/', 'http://flow.aliyun.com/', 'https://other.aliyun.com/']) assert.equal(matchesRule(url, rule), false);
  assert.equal(matchesRule('https://example.com/abc-two', { type: 'prefix', url: 'https://example.com/abc' }), true);
});
test('domain matches exact hostname on both protocols, not subdomains or suffixes', () => {
  const rule = normalizeRule({ type: 'domain', url: 'FLOW.ALIYUN.COM' });
  assert.equal(rule.url, 'flow.aliyun.com');
  for (const url of ['https://flow.aliyun.com/a', 'http://flow.aliyun.com:8080/x']) assert.equal(matchesRule(url, rule), true);
  for (const url of ['https://sub.flow.aliyun.com/', 'https://flow.aliyun.com.evil.org/']) assert.equal(matchesRule(url, rule), false);
  assert.deepEqual(ruleOrigins(rule), ['http://flow.aliyun.com/*', 'https://flow.aliyun.com/*']);
  assert.throws(() => normalizeRule({ type: 'domain', url: 'https://example.com/path' }));
  assert.throws(() => normalizeRule({ type: 'domain', url: 'example.com:8080' }));
});
test('wildcards are anchored with literal regex characters and restricted origins', () => {
  const rule = normalizeRule({ type: 'wildcard', url: 'https://example.com/projects/*/builds?env=prod*#run' });
  assert.equal(matchesRule('https://example.com/projects/abc/builds?env=prod&n=2#run', rule), true);
  assert.equal(matchesRule('https://example.com/projects//builds?env=prod#run', rule), true);
  for (const url of ['https://example.com/projects/a/buildsXenv=prod#run', 'https://evil.com/projects/a/builds?env=prod#run', 'https://example.com/projects/a/builds?env=prod#run-extra']) assert.equal(matchesRule(url, rule), false);
  assert.deepEqual(ruleOrigins(rule), ['https://example.com/*']);
  for (const url of ['https://*.example.com/*', 'https://example.com/a']) assert.throws(() => normalizeRule({ type: 'wildcard', url }));
  assert.throws(() => normalizeRule({ type: 'prefix', url: 'https://example.com/*' }));
});
test('legacy exact rules keep behavior; edits retain priority and moving changes winner', () => {
  let rules = [{ id: 'old', url: 'https://example.com/a', name: '旧规则', enabled: true }];
  rules = saveRule(rules, { type: 'prefix', url: 'https://example.com/', name: '前缀' });
  assert.equal(chooseTitle('https://example.com/a', null, rules).name, '旧规则');
  rules = saveRule(rules, { ...rules[0], name: '已编辑' });
  assert.equal(rules[0].id, 'old');
  rules = moveRule(rules, rules[1].id, -1);
  assert.equal(chooseTitle('https://example.com/a', null, rules).name, '前缀');
  assert.equal(chooseTitle('https://example.com/a', { url: 'https://example.com/a', manual: '手动' }, rules).name, '手动');
  assert.equal(chooseTitle('https://example.com/a', { url: 'https://example.com/a', ignored: true }, rules).name, null);
  assert.deepEqual(moveRule(rules, rules[0].id, -1), rules);
  assert.throws(() => moveRule(rules, 'missing', 1));
  assert.throws(() => moveRule(rules, rules[0].id, 5));
});
test('names are plain text and count visible graphemes, including composite emoji', () => {
  assert.equal(cleanName('  退款\n排查 👩‍💻  '), '退款 排查 👩‍💻');
  assert.equal(cleanName('👨‍👩‍👧‍👦'.repeat(80)), '👨‍👩‍👧‍👦'.repeat(80));
  assert.throws(() => cleanName('a'.repeat(81)));
  assert.throws(() => cleanName(' \n '));
  assert.equal(cleanName('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
});
test('manual then ignored then enabled rule; navigation invalidates per-tab state', () => {
  const url = 'https://example.com/';
  const rules = [{ id: 'a', url, name: '默认', enabled: true }];
  assert.deepEqual(chooseTitle(url, { url, manual: '手动', ignored: true }, rules), { mode: 'manual', name: '手动' });
  assert.deepEqual(chooseTitle(url, { url, ignored: true }, rules), { mode: 'ignored', name: null });
  assert.equal(chooseTitle(url, { url: url + 'other', manual: '旧名' }, rules).name, '默认');
  assert.equal(chooseTitle(url, null, [{ ...rules[0], enabled: false }]).name, null);
});
test('rule CRUD rejects canonical duplicates, stale edits and unsupported sites', () => {
  const one = saveRule([], { url: 'https://EXAMPLE.com', name: ' 后台 ' });
  assert.equal(one[0].name, '后台');
  assert.throws(() => saveRule(one, { url: 'https://example.com:443/', name: '重复' }), /已有规则/);
  assert.throws(() => saveRule(one, { id: 'missing', url: 'https://x.com/', name: 'a' }), /已被删除/);
  assert.throws(() => saveRule([], { url: 'https://chromewebstore.google.com/', name: 'a' }));
  const changed = saveRule(one, { ...one[0], name: '订单', enabled: false });
  assert.equal(changed.length, 1); assert.equal(changed[0].enabled, false); assert.equal(changed[0].id, one[0].id);
});
