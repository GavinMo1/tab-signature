import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = await mkdtemp(path.join(tmpdir(), 'tab-signature-resource-'));
const extension = path.join(scratch, 'extension');
await cp(path.join(root, 'extension'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>网页标题</title></head><body><main></main></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.TAB_SIGNATURE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  const browserCDP = await context.browser().newBrowserCDPSession();
  const { id } = await browserCDP.send('Extensions.loadUnpacked', { path: extension });
  let ui = await context.newPage(); await ui.goto(`chrome-extension://${id}/rules.html`);
  const request = async message => {
    if (message.type === 'saveRule') {
      const snapshot = await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'listRules' }));
      message = { ...message, revision: snapshot.revision, index: null };
    }
    const result = await ui.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(result.ok, true, result.error); return result;
  };
  const page = await context.newPage(); await page.goto(`${base}/live`);
  const sleeping = await context.newPage(); await sleeping.goto(`${base}/sleeping`);
  const tabID = async url => ui.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, url);
  const sleepingId = await tabID(sleeping.url());
  await ui.bringToFront();
  const discarded = await ui.evaluate(id => chrome.tabs.discard(id), sleepingId);
  assert.equal(discarded.discarded, true);
  await request({ type: 'saveRule', rule: { type: 'prefix', url: `${base}/`, name: '统一命名' } });
  await page.waitForFunction(() => document.title === '统一命名');
  // A read and a full synchronization must not revive the discarded matching tab.
  await request({ type: 'getTab', tabId: discarded.id });
  assert.equal(await ui.evaluate(async id => (await chrome.tabs.get(id)).discarded, discarded.id), true);
  const cdp = await context.newCDPSession(page);
  const reloadExceptions = [];
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', event => reloadExceptions.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  await cdp.send('Performance.enable');
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };
  const before = await heap();
  await page.evaluate(() => {
    window.counterWrites = 0; window.heartbeats = 0;
    window.heartbeatTimer = setInterval(() => window.heartbeats++, 10);
    // A website observer that immediately rejects every extension title write.
    window.fightingObserver = new MutationObserver(() => {
      if (document.title !== '网站坚持的标题') {
        window.counterWrites++; document.title = '网站坚持的标题';
      }
    });
    window.fightingObserver.observe(document.querySelector('title'), { childList: true, subtree: true, characterData: true });
    document.title = '网站坚持的标题';
    // Busy body changes should not be observed by the extension at all.
    const main = document.querySelector('main');
    for (let i = 0; i < 5000; i++) { const node = document.createElement('span'); node.textContent = i; main.append(node); node.remove(); }
  });
  await ui.waitForTimeout(2100);
  const first = await heap();
  await ui.waitForTimeout(2100);
  const second = await heap();
  const activity = await page.evaluate(() => ({ writes: window.counterWrites, heartbeats: window.heartbeats }));
  assert.ok(activity.writes > 0 && activity.writes <= 100, `corrections should be limited, got ${activity.writes}`);
  assert.ok(activity.heartbeats > 100, 'page event loop remains responsive during a title observer conflict');
  assert.ok(second - first < 2 * 1024 * 1024, 'retained JS heap must not grow by multiple MB during the second stress interval');
  await page.evaluate(() => { window.fightingObserver.disconnect(); clearInterval(window.heartbeatTimer); });
  await page.waitForFunction(() => document.title === '统一命名');
  // Keep the web document alive while actually reloading the extension. This
  // invalidates its old isolated world while observers/timers can still be queued.
  await ui.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 0); });
  await page.evaluate(() => { document.title = '重载期间网站标题'; });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const head = document.head;
    const replacement = document.createElement('head');
    replacement.innerHTML = '<title>重载后替换标题</title>';
    head.replaceWith(replacement);
    dispatchEvent(new Event('pageshow'));
  });
  await page.waitForTimeout(200);
  assert.equal(await page.title(), '重载后替换标题', 'invalidated old agent stops rewriting titles');
  assert.deepEqual(reloadExceptions, [], 'extension reload with live title/head callbacks produces no uncaught exception');
  const report = {
    browser: context.browser().version(), passed: true, discardedMatchingTabStayedDiscarded: true, extensionReloadWithLivePageNoUncaughtErrors: true,
    observerConflictMilliseconds: 4200, websiteCounterWrites: activity.writes, pageHeartbeats: activity.heartbeats,
    jsHeapBytes: { before, firstInterval: first, secondInterval: second, retainedGrowthSecondInterval: second - first },
    scope: 'Isolated synthetic stress test; JS heap samples are not total Chrome RAM and cannot identify a past spike in the user profile.'
  };
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/resource-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { if (context) await context.close(); server.close(); }
