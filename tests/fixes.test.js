import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../extension/core.js';
import { execFileSync } from 'node:child_process';

function reference(text, pattern) {
  let row = Array(text.length + 1).fill(false); row[0] = true;
  for (const token of pattern) {
    const next = Array(text.length + 1).fill(false);
    next[0] = token === '*' && row[0];
    for (let j = 1; j <= text.length; j++) next[j] = token === '*' ? row[j] || next[j - 1] : row[j - 1] && token === text[j - 1];
    row = next;
  }
  return row[text.length];
}
function words(alphabet, depth) {
  const all = ['']; let level = [''];
  for (let i = 0; i < depth; i++) { level = level.flatMap(w => alphabet.map(a => w + a)); all.push(...level); }
  return all;
}
test('glob agrees with independent DP for all short patterns and inputs', () => {
  for (const pattern of words(['a', 'b', '*'], 5)) for (const text of words(['a', 'b'], 5)) {
    assert.equal(core.globMatch(text, pattern), reference(text, pattern), `${pattern} vs ${text}`);
  }
});
test('long adversarial glob has linear work bound', () => {
  for (const [text, pattern] of [['a'.repeat(100000), '*a'.repeat(500) + 'b'], ['a'.repeat(100000) + 'b', '*' + 'a'.repeat(1000) + 'b*']]) {
    const work = { steps: 0 }; core.globMatch(text, pattern, work);
    assert.ok(work.steps < 10 * (text.length + pattern.length), String(work.steps));
  }
});
test('reported multi-star URL cannot block an isolated process past its deadline', () => {
  const moduleURL = new URL('../extension/core.js', import.meta.url).href;
  const code = `import { chooseTitle } from ${JSON.stringify(moduleURL)}; const base='https://example.com/'; const result=chooseTitle(base+'a'.repeat(100000),null,[{id:'stress',type:'wildcard',url:base+'*a'.repeat(500)+'b',name:'x',enabled:true}]); if(result.name!==null) process.exit(1);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 3000, stdio: 'pipe' });
});
test('domain stars fail before permission calculation, valid hosts remain supported', () => {
  for (const value of ['*', '*.example.com', 'https://*.example.com', '%2A.example.com']) {
    assert.throws(() => core.normalizeRule({ type: 'domain', url: value }));
    assert.throws(() => core.ruleOrigins({ type: 'domain', url: value }));
  }
  for (const value of ['localhost', '127.0.0.1', '[::1]', '例子.测试']) assert.ok(core.normalizeRule({ type: 'domain', url: value }).url);
});
test('bad legacy rows are isolated without rewriting, unique valid IDs survive', () => {
  const raw = [null, 7, { id: 'dup', url: 'https://example.com/', name: 'a', enabled: true }, { id: 'dup', url: 'https://example.com/', name: 'b', enabled: true },
    { id: 'star', type: 'domain', url: '*', name: 'bad', enabled: true }, { id: 'ok', url: 'https://example.com/', name: 'good', enabled: true }];
  const copy = structuredClone(raw), rows = core.inspectRules(raw);
  assert.deepEqual(raw, copy);
  assert.ok(rows.slice(0, 5).every(r => r.invalid));
  assert.equal(core.chooseTitle('https://example.com/', null, raw).name, 'good');
  assert.throws(() => core.inspectRules({}), /格式/);
});
