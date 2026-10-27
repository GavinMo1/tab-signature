import test from 'node:test';
import assert from 'node:assert/strict';
import { grantRule } from '../extension/ui.js';

test('invalid domains never invoke permission prompt; valid refusal is explicit', async () => {
  let calls = 0, answer = false, last;
  globalThis.chrome = { permissions: { async request(value) { calls++; last = value; return answer; } } };
  try {
    for (const url of ['*', '*.example.com', 'https://*.example.com']) await assert.rejects(grantRule({ type: 'domain', url }));
    assert.equal(calls, 0);
    await assert.rejects(grantRule({ type: 'domain', url: 'example.com' }), /未获得/);
    assert.deepEqual(last.origins, ['http://example.com/*', 'https://example.com/*']);
    answer = true; await grantRule({ type: 'domain', url: 'example.com' }); assert.equal(calls, 2);
  } finally { delete globalThis.chrome; }
});
