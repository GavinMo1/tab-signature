import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'test-results'); await mkdir(output, { recursive: true });
const checks = [], errors = [];
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>管理后台</title></head><body><h1>测试后台</h1><p>用于隔离验证，不涉及用户数据。</p></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const url = `${base}/orders?a=1#main`;
const scratch = await mkdtemp(path.join(tmpdir(), 'tab-signature-'));
const extension = path.join(scratch, 'extension'); await cp(path.join(root, 'extension'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
// Only the fixture host is pre-authorized, to avoid the native permission dialog in automation.
manifest.host_permissions = ['http://127.0.0.1/*', 'https://127.0.0.1/*'];
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const executablePath = process.env.TAB_SIGNATURE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
async function launch() {
  const context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath, headless: true, viewport: { width: 1280, height: 960 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: extension });
  return context;
}
let context;
try {
  context = await launch();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${id}/rules.html`);
  ui.on('pageerror', error => errors.push(error.message));
  const message = async body => {
    if (['saveRule', 'deleteRule', 'moveRule', 'setRuleEnabled'].includes(body.type) && !body.revision) {
      const snapshot = await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'listRules' }));
      body = { ...body, revision: snapshot.revision, index: body.id || body.rule?.id ? snapshot.rules.find(r => r.id === (body.id || body.rule.id))?.index : null };
    }
    const result = await ui.evaluate(body => chrome.runtime.sendMessage(body), body);
    assert.equal(result.ok, true, result.error); return result;
  };
  const title = async (page, expected) => {
    try { await page.waitForFunction(expected => document.title === expected, expected, { timeout: 12000 }); }
    catch (error) { console.error({ url: page.url(), expected, actual: await page.title() }); throw error; }
    assert.equal(await page.title(), expected);
  };
  const tabId = async page => (await ui.evaluate(async pageURL => (await chrome.tabs.query({})).filter(t => t.url === pageURL).map(t => t.id), page.url())).at(-1);
  const first = await context.newPage(); await first.goto(url); const one = await tabId(first);
  const second = await context.newPage(); await second.goto(url); const two = await tabId(second);
  const permissionPopup = await context.newPage();
  await permissionPopup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => {
      const result = await send(message);
      return message.type === 'getTab' ? { ...result, permitted: false } : result;
    };
    // Model Chrome destroying an action popup during its native permission prompt.
    chrome.permissions.request = () => new Promise(() => {});
  });
  await permissionPopup.goto(`chrome-extension://${id}/popup.html?tabId=${one}`);
  await permissionPopup.locator('#name').fill('首次授权无需重输'); await permissionPopup.locator('#save').click();
  await permissionPopup.close();
  await title(first, '首次授权无需重输');
  await message({ type: 'useRule', tabId: one, url });
  await title(first, '管理后台');
  pass('submitted rename survives popup destruction during a simulated pending permission prompt');
  const loadingPopup = await context.newPage();
  loadingPopup.on('pageerror', error => errors.push(error.message));
  await loadingPopup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime); let first = true;
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'getTab' && first) { first = false; await new Promise(resolve => setTimeout(resolve, 300)); throw new Error('模拟读取失败'); }
      return send(message);
    };
  });
  await loadingPopup.goto(`chrome-extension://${id}/popup.html?tabId=${one}`);
  assert.equal(await loadingPopup.locator('#add-rule').isDisabled(), true);
  await loadingPopup.locator('#rename-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await loadingPopup.waitForFunction(() => document.querySelector('#mode').textContent === '读取失败');
  await loadingPopup.locator('#retry').click(); await loadingPopup.locator('#name').waitFor({ state: 'visible' });
  await loadingPopup.waitForFunction(() => !document.querySelector('#name').disabled);
  await loadingPopup.close(); pass('loading controls reject early submission; failed read retries successfully without page errors');
  const popup = await context.newPage();
  popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${one}`);
  await popup.locator('#name').fill('退款排查 👩‍💻'); await popup.locator('#save').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent === '名称已保存');
  await title(first, '退款排查 👩‍💻'); await title(second, '管理后台'); pass('popup saves a Unicode name; same-URL tabs are independent');
  await popup.reload(); await popup.waitForFunction(() => document.querySelector('#name').value === '退款排查 👩‍💻');
  assert.equal(await popup.locator('#name').evaluate(n => n === document.activeElement), true); pass('popup refills and focuses existing name');
  await popup.locator('#name').fill('   '); await popup.locator('#save').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('请输入'));
  await title(first, '退款排查 👩‍💻');
  await popup.locator('#name').fill('名'.repeat(81)); await popup.locator('#save').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('80'));
  assert.equal(await popup.locator('#name').inputValue(), '名'.repeat(81));
  pass('invalid input is rejected without changing title or losing the entered text');
  await popup.locator('#name').fill('');
  await popup.locator('#name').evaluate(input => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', '退款\n排查');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  assert.equal(await popup.locator('#name').inputValue(), '退款 排查');
  pass('multiline paste becomes spaces before the text input can strip line breaks');
  await first.reload(); await title(first, '退款排查 👩‍💻');
  const cdp = await context.newCDPSession(first); await cdp.send('Page.reload', { ignoreCache: true });
  await first.waitForLoadState('load'); await title(first, '退款排查 👩‍💻'); pass('normal and cache-bypassing reload preserve manual name');
  await first.evaluate(() => { document.title = '新消息 (5)'; }); await title(first, '退款排查 👩‍💻');
  await first.evaluate(() => new Promise(resolve => {
    let counter = 0;
    const interval = setInterval(() => {
      document.title = `轮询标题 ${++counter}`;
      if (counter === 30) { clearInterval(interval); resolve(); }
    }, 10);
  })); await title(first, '退款排查 👩‍💻'); pass('repeated website title updates do not break the name lock');
  await first.evaluate(() => {
    document.head.querySelectorAll('title').forEach(n => n.remove());
    const title = document.createElement('title'); title.textContent = '替换后的标题'; document.head.append(title);
  }); await title(first, '退款排查 👩‍💻');
  await popup.locator('#restore').click(); await title(first, '替换后的标题');
  await first.evaluate(() => { document.title = '网站继续更新'; }); await title(first, '网站继续更新'); pass('dynamic updates and title-node replacement stay locked; restore releases latest website title');
  await message({ type: 'useRule', tabId: one, url });
  // Use the actual rules editor, not a stand-in UI.
  await ui.locator('#url').fill(url); await ui.locator('#rule-name').fill('订单后台'); await ui.locator('#save-rule').click();
  await ui.waitForFunction(() => document.querySelector('#status').textContent.includes('规则已保存'));
  await title(first, '订单后台'); await title(second, '订单后台');
  const rule = (await message({ type: 'listRules' })).rules[0];
  const third = await context.newPage(); await third.goto(url); await title(third, '订单后台'); pass('rule editor saves and applies to existing and newly opened matching tabs');
  await message({ type: 'rename', tabId: one, url, name: '单独排查' });
  await ui.locator('.rule-row .text-button').filter({ hasText: '编辑' }).click();
  await ui.locator('#rule-name').fill('订单工作台'); await ui.locator('#save-rule').click();
  await title(second, '订单工作台'); await title(first, '单独排查'); pass('editing a rule updates auto-named tabs without overriding manual names');
  await ui.locator('.switch').click(); await title(second, '管理后台'); await title(first, '单独排查');
  await ui.locator('.switch').click(); await title(second, '订单工作台'); pass('rule disable and enable restore and reapply names');
  await message({ type: 'restore', tabId: two, url }); await title(second, '管理后台');
  await second.reload(); await title(second, '管理后台');
  await message({ type: 'saveRule', rule: { ...rule, name: '规则更新' } });
  await title(second, '管理后台'); await title(third, '规则更新');
  await message({ type: 'useRule', tabId: two, url }); await title(second, '规则更新'); pass('restore ignores rules across refresh and rule changes; use-rule resumes');
  await first.evaluate(() => history.pushState({}, '', '/orders?a=2#main')); await title(first, '网站继续更新');
  await first.evaluate(() => history.back()); await title(first, '规则更新');
  await message({ type: 'rename', tabId: one, url, name: '临时' });
  await first.evaluate(() => { location.hash = 'other'; }); await title(first, '网站继续更新'); pass('query, hash and back navigation clear manual names and rematch exact rules');
  await first.goto(`${base}/different`); await message({ type: 'rename', tabId: one, url: first.url(), name: '另页' });
  await first.goto(`${base.replace('127.0.0.1', 'localhost')}/different`); await title(first, '管理后台');
  const denied = await ui.evaluate(body => chrome.runtime.sendMessage(body), { type: 'rename', tabId: one, url: first.url(), name: '不应成功' });
  assert.equal(denied.ok, false); assert.match(denied.error, /权限/); pass('cross-host navigation clears manual name; ungranted host cannot report success');
  const duplicatePromise = context.waitForEvent('page');
  await message({ type: 'rename', tabId: two, url, name: '原标签手动名' });
  await ui.evaluate(id => chrome.tabs.duplicate(id), two);
  const duplicate = await duplicatePromise; await duplicate.waitForLoadState(); await title(duplicate, '规则更新'); pass('duplicated tab matches rule and does not inherit manual name');
  const moved = await ui.evaluate(tabId => chrome.windows.create({ tabId }), two);
  await title(second, '原标签手动名');
  assert.ok(moved.id); pass('moving to another window preserves manual name');
  await ui.evaluate(async id => chrome.tabs.remove(id), two);
  const fresh = await context.newPage(); await fresh.goto(url); await title(fresh, '规则更新');
  assert.equal(await ui.evaluate(async id => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`], two), undefined); pass('closed tab state is removed; reopen uses rule only');
  const nextURL = `${base}/new-rule`;
  await message({ type: 'saveRule', rule: { ...rule, url: nextURL, name: '新页面名' } });
  await title(fresh, '管理后台'); const nextPage = await context.newPage(); await nextPage.goto(nextURL); await title(nextPage, '新页面名');
  pass('editing rule URL releases old pages and applies to new pages');
  const duplicateRule = await ui.evaluate(async rule => { const snapshot = await chrome.runtime.sendMessage({ type: 'listRules' }); return chrome.runtime.sendMessage({ type: 'saveRule', rule, index: null, revision: snapshot.revision }); }, { url: nextURL, name: '重复' });
  assert.equal(duplicateRule.ok, false); assert.match(duplicateRule.error, /已有规则/);
  await ui.locator('#url').fill(`${base}/literal`); await ui.locator('#rule-name').fill('<img src=x onerror=alert(1)>');
  await ui.locator('#save-rule').click(); await ui.waitForFunction(() => document.querySelectorAll('.rule-row').length === 2);
  assert.equal(await ui.locator('.rule-row img').count(), 0); pass('canonical duplicate rejection and HTML-as-text rendering');
  await ui.locator('#search').fill('不存在'); assert.equal(await ui.locator('.rule-row').count(), 0);
  await ui.locator('#search').fill('新页面名'); assert.equal(await ui.locator('.rule-row').count(), 1);
  await ui.locator('.delete-button').click(); await ui.locator('dialog button[value=cancel]').click(); assert.equal(await ui.locator('.rule-row').count(), 1);
  await ui.locator('.delete-button').click(); await ui.locator('dialog button[value=delete]').click(); await title(nextPage, '管理后台');
  await ui.locator('#search').fill(''); pass('search, delete confirmation/cancel and deletion release current titles');
  const literalRule = (await message({ type: 'listRules' })).rules[0];
  await message({ type: 'saveRule', rule: { ...literalRule, name: '测试环境 · 对照配置' } });
  await ui.waitForFunction(() => document.querySelector('.rule-row h3')?.textContent === '测试环境 · 对照配置');
  const blocked = await context.newPage(); await blocked.goto('chrome://version'); const blockedId = await tabId(blocked);
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${blockedId}`);
  await popup.waitForFunction(() => document.querySelector('#mode').textContent === '此页面不可用');
  assert.equal(await popup.locator('#save').isDisabled(), true); pass('Chrome internal pages show a clear unavailable state');
  // Explicit worker stop verifies session-backed state survives worker lifecycle changes.
  const freshId = await tabId(fresh);
  await message({ type: 'rename', tabId: freshId, url, name: '后台重启保留' }); await title(fresh, '后台重启保留');
  const workerCDP = await context.newCDPSession(ui);
  const versions = new Map();
  workerCDP.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions) versions.set(version.versionId, version); });
  await workerCDP.send('ServiceWorker.enable');
  for (let attempt = 0; attempt < 50 && ![...versions.values()].some(v => v.scriptURL === worker.url()); attempt++) await ui.waitForTimeout(20);
  const version = [...versions.values()].find(v => v.scriptURL === worker.url());
  assert.ok(version, 'extension worker version must be observed before stopping it');
  await workerCDP.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  for (let attempt = 0; attempt < 50 && versions.get(version.versionId).runningStatus !== 'stopped'; attempt++) await ui.waitForTimeout(20);
  assert.equal(versions.get(version.versionId).runningStatus, 'stopped', 'extension worker really stopped');
  await fresh.reload(); await title(fresh, '后台重启保留'); pass('service-worker stop and restart preserve live tab session state');
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${freshId}`);
  await popup.waitForFunction(() => document.querySelector('#name').value === '后台重启保留');
  // Explicitly exercise Enter submitting the real form.
  await popup.locator('#name').fill('回车保存'); await popup.locator('#name').press('Enter');
  await title(fresh, '回车保存'); pass('Enter saves the name from the actual popup form');
  await message({ type: 'rename', tabId: freshId, url, name: '后台重启保留' });
  // Create the new match types through the actual editor.
  const flexible = await context.newPage(); await flexible.goto(`${base}/pipelines/123/runs?env=test`);
  await ui.locator('#match-type').selectOption('prefix');
  await ui.locator('#url').fill(`${base}/pipelines/`); await ui.locator('#rule-name').fill('流水线');
  await ui.locator('#save-rule').click(); await title(flexible, '流水线');
  await flexible.goto(`${base}/pipelines/456`); await title(flexible, '流水线');
  await flexible.goto(`${base}/other`); await title(flexible, '管理后台');
  pass('prefix editor names multiple descendant URLs and releases outside-prefix pages');
  await ui.locator('#match-type').selectOption('wildcard');
  await ui.locator('#url').fill(`${base}/projects/*/runs*`); await ui.locator('#rule-name').fill('项目运行');
  await ui.locator('#save-rule').click();
  await flexible.goto(`${base}/projects/42/runs?env=prod`); await title(flexible, '项目运行');
  await flexible.goto(`${base}/projects/42/settings`); await title(flexible, '管理后台');
  pass('wildcard editor matches path and query while excluding nonmatching pages');
  await ui.locator('#match-type').selectOption('domain');
  await ui.locator('#url').fill('127.0.0.1'); await ui.locator('#rule-name').fill('本站');
  await ui.locator('#save-rule').click(); await title(flexible, '本站');
  await flexible.goto(`${base}/pipelines/456`); await title(flexible, '流水线');
  const domainRow = ui.locator('.rule-row').filter({ has: ui.locator('h3', { hasText: /^本站$/ }) });
  for (let index = 0; index < 3; index++) {
    await domainRow.locator('.move-button').filter({ hasText: '上移' }).click();
    await ui.waitForFunction(expected => [...document.querySelectorAll('.rule-row h3')].findIndex(n => n.textContent === '本站') === expected, 2 - index);
  }
  await title(flexible, '本站'); await title(fresh, '后台重启保留');
  await domainRow.locator('.text-button').filter({ hasText: /^编辑$/ }).click();
  await ui.locator('#rule-name').fill('全站'); await ui.locator('#save-rule').click(); await title(flexible, '全站');
  assert.equal(await ui.locator('.rule-row h3').first().textContent(), '全站');
  pass('domain rules apply across paths; UI priority ordering changes winner and editing preserves order');
  const renamedDomainRow = ui.locator('.rule-row').filter({ has: ui.locator('h3', { hasText: /^全站$/ }) });
  await renamedDomainRow.locator('[data-action=down]').focus(); await ui.keyboard.press('Enter');
  await ui.waitForFunction(() => document.activeElement?.dataset.action === 'down' && document.activeElement?.closest('.rule-row')?.dataset.index === '1');
  await ui.keyboard.press('Enter');
  await ui.waitForFunction(() => document.activeElement?.dataset.action === 'down' && document.activeElement?.closest('.rule-row')?.dataset.index === '2');
  await renamedDomainRow.locator('[data-action=up]').focus(); await ui.keyboard.press('Enter');
  await ui.waitForFunction(() => document.activeElement?.dataset.action === 'up' && document.activeElement?.closest('.rule-row')?.dataset.index === '1');
  await ui.keyboard.press('Enter');
  await ui.waitForFunction(() => document.activeElement?.dataset.action === 'down' && document.activeElement?.closest('.rule-row')?.dataset.index === '0');
  await renamedDomainRow.locator('.switch').focus(); await ui.keyboard.press('Enter');
  await ui.waitForFunction(() => document.activeElement?.dataset.action === 'toggle' && document.activeElement.getAttribute('aria-checked') === 'false');
  await ui.keyboard.press('Enter'); await title(flexible, '全站');
  await ui.locator('#search').focus(); await ui.locator('#search').fill('全站');
  assert.equal(await ui.locator('#search').evaluate(n => n === document.activeElement), true); await ui.locator('#search').fill('');
  pass('keyboard reorder including boundaries and enable toggles retains focus; search does not steal focus');
  const flexId = await tabId(flexible);
  await message({ type: 'restore', tabId: flexId, url: flexible.url() }); await title(flexible, '管理后台');
  await flexible.reload(); await title(flexible, '管理后台');
  const flexiblePopup = await context.newPage(); await flexiblePopup.goto(`chrome-extension://${id}/popup.html?tabId=${flexId}`);
  await flexiblePopup.locator('#use-rule').waitFor({ state: 'visible' }); await flexiblePopup.locator('#use-rule').click(); await title(flexible, '全站');
  await flexiblePopup.close();
  pass('restore and popup use-rule also work with broad matching rules');
  for (const entry of (await message({ type: 'listRules' })).rules.filter(r => ['prefix', 'wildcard', 'domain'].includes(r.type))) await message({ type: 'deleteRule', id: entry.id });
  await title(flexible, '管理后台');
  const legacyURL = `${base}/legacy`;
  await ui.evaluate(async url => {
    const { rules } = await chrome.storage.local.get('rules');
    await chrome.storage.local.set({ rules: [...rules, { id: 'legacy-v1', url, name: '旧版规则', enabled: true }] });
  }, legacyURL);
  await flexible.goto(legacyURL); await title(flexible, '旧版规则');
  await flexible.goto(`${legacyURL}/child`); await title(flexible, '管理后台');
  const legacyRow = ui.locator('.rule-row').filter({ hasText: '旧版规则' });
  await legacyRow.locator('.text-button').filter({ hasText: /^编辑$/ }).click();
  assert.equal(await ui.locator('#match-type').inputValue(), 'exact');
  await ui.locator('#rule-name').fill('旧版规则已编辑'); await ui.locator('#save-rule').click();
  await flexible.goto(legacyURL); await title(flexible, '旧版规则已编辑');
  await message({ type: 'deleteRule', id: 'legacy-v1' });
  pass('stored v1.0 rules without match type retain exact behavior and remain editable');
  const freezeURL = `${base}/freeze-rule`;
  const freezingPage = await context.newPage(); await freezingPage.goto(freezeURL);
  const realFreezeId = await tabId(freezingPage);
  const freezeRule = await message({ type: 'saveRule', rule: { url: freezeURL, name: '冻结旧名称' } });
  await title(freezingPage, '冻结旧名称');
  const discardsPage = await context.newPage(); await discardsPage.goto('chrome://chrome-urls/');
  await discardsPage.getByRole('button', { name: 'Enable internal debugging pages' }).click();
  await discardsPage.goto('chrome://discards/');
  await discardsPage.getByRole('row').filter({ hasText: freezeURL }).getByText('[Freeze]', { exact: true }).click();
  await ui.waitForFunction(async id => (await chrome.tabs.get(id)).frozen === true, realFreezeId);
  await message({ type: 'saveRule', rule: { ...freezeRule.rule, name: '解冻最新名称' } });
  await freezingPage.bringToFront();
  await title(freezingPage, '解冻最新名称');
  await message({ type: 'deleteRule', id: freezeRule.rule.id }); await freezingPage.close(); await discardsPage.close();
  pass('real Chrome frozen tab applies updated rule on unfreeze without navigation');
  // A frozen renderer cannot answer content messages. Neither it nor other queued
  // page work may hold the popup's read operation hostage.
  const frozen = await context.newPage(); await frozen.goto(`${base}/frozen`);
  const frozenId = await tabId(frozen);
  await message({ type: 'rename', tabId: frozenId, url: frozen.url(), name: '冻结前名称' });
  const frozenCDP = await context.newCDPSession(frozen);
  await frozenCDP.send('Page.setWebLifecycleState', { state: 'frozen' });
  const freezingRule = await message({ type: 'saveRule', rule: { url: frozen.url(), name: '冻结页规则' } });
  const started = performance.now();
  const frozenRead = await message({ type: 'getTab', tabId: frozenId });
  assert.equal(frozenRead.name, '冻结前名称');
  const readMilliseconds = Math.round(performance.now() - started);
  assert.ok(readMilliseconds < 1500, `frozen tab state read took ${readMilliseconds}ms`);
  const fastPopup = await context.newPage();
  const popupStarted = performance.now();
  await fastPopup.goto(`chrome-extension://${id}/popup.html?tabId=${frozenId}`);
  await fastPopup.waitForFunction(() => document.querySelector('#mode').textContent === '手动命名', { timeout: 1500 });
  const popupMilliseconds = Math.round(performance.now() - popupStarted);
  assert.ok(popupMilliseconds < 1500, `frozen page popup took ${popupMilliseconds}ms`);
  const otherStarted = performance.now();
  await message({ type: 'rename', tabId: freshId, url, name: '其他页面仍可保存' });
  await title(fresh, '其他页面仍可保存');
  assert.ok(performance.now() - otherStarted < 1500, 'a frozen tab must not block another tab saving');
  console.log(`TIMING frozen read=${readMilliseconds}ms popup=${popupMilliseconds}ms`);
  await frozenCDP.send('Page.setWebLifecycleState', { state: 'active' });
  await fastPopup.close(); await frozen.close();
  await message({ type: 'deleteRule', id: freezingRule.rule.id });
  await message({ type: 'rename', tabId: freshId, url, name: '后台重启保留' });
  pass('frozen page popup reads under 1.5s; slow sync cannot block other tabs or edits');
  const preservedRules = await ui.evaluate(async () => (await chrome.storage.local.get('rules')).rules);
  const badFixtures = [
    { id: 'duplicate', url: `${base}/bad-one`, name: '重复一', enabled: true },
    { id: 'duplicate', url: `${base}/bad-two`, name: '重复二', enabled: true },
    null, { id: 'star-domain', type: 'domain', url: '*', name: '错误域名', enabled: true }
  ];
  await ui.evaluate(async rules => chrome.storage.local.set({ rules }), badFixtures);
  await ui.waitForFunction(() => document.querySelectorAll('.rule-row').length === 4);
  assert.deepEqual(await ui.evaluate(async () => (await chrome.storage.local.get('rules')).rules), badFixtures);
  await ui.locator('[data-index="3"] .switch').click();
  await ui.waitForFunction(() => document.querySelector('[data-index="3"] .switch')?.getAttribute('aria-checked') === 'false');
  await ui.locator('[data-index="2"] [data-action=edit]').click();
  await ui.locator('#url').fill(`${base}/fixed-null`); await ui.locator('#rule-name').fill('空记录修正'); await ui.locator('#save-rule').click();
  await ui.waitForFunction(() => document.querySelector('[data-index="2"] h3')?.textContent === '空记录修正');
  const repairedRows = await ui.evaluate(async () => (await chrome.storage.local.get('rules')).rules);
  assert.deepEqual(repairedRows.slice(0, 2), badFixtures.slice(0, 2));
  assert.equal(repairedRows[2].enabled, false); assert.equal(repairedRows[3].enabled, false);
  await ui.locator('[data-index="0"] [data-action=edit]').click();
  await ui.locator('#rule-name').fill('我的草稿');
  await ui.evaluate(async () => {
    const { rules } = await chrome.storage.local.get('rules'); rules[1].name = '其他窗口更新'; await chrome.storage.local.set({ rules });
  });
  await ui.waitForFunction(() => document.querySelector('[data-index="1"] h3')?.textContent === '其他窗口更新');
  await ui.locator('#save-rule').click();
  await ui.waitForFunction(() => document.querySelector('#status').textContent.includes('其他页面更新'));
  assert.equal(await ui.locator('#rule-name').inputValue(), '我的草稿');
  assert.equal((await ui.evaluate(async () => (await chrome.storage.local.get('rules')).rules))[0].name, '重复一');
  await ui.locator('#cancel-edit').click();
  await ui.evaluate(async rules => chrome.storage.local.set({ rules }), preservedRules);
  await ui.waitForFunction(() => document.querySelectorAll('.rule-row').length === 1);
  pass('legacy malformed rows stay intact until explicit repair; stale editing is rejected and draft retained');
  // Screenshot real extension pages; prefill the popup for a representative state.
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${freshId}`);
  await popup.waitForFunction(() => document.querySelector('#name').value === '后台重启保留');
  await popup.setViewportSize({ width: 380, height: 550 }); await popup.screenshot({ path: path.join(output, 'popup.png') });
  await ui.screenshot({ path: path.join(output, 'rules.png'), fullPage: true });
  await ui.setViewportSize({ width: 390, height: 844 });
  assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await ui.screenshot({ path: path.join(output, 'rules-mobile.png'), fullPage: true }); pass('popup and rules screenshots; narrow rules page has no horizontal overflow');
  // Stop retaining state through a real browser restart, but keep persistent rules.
  const persisted = await message({ type: 'saveRule', rule: { url, name: '重启后的默认名' } });
  assert.ok(persisted.rule.id);
  await context.close(); context = await launch();
  const restart = await context.newPage(); await restart.goto(url); await title(restart, '重启后的默认名'); pass('browser restart retains rules but does not revive manual names');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'browser-report.json'), JSON.stringify({ passed: checks.length, checks, errors, browser: context.browser()?.version(), testHostPreauthorized: true, scratch }, null, 2));
  console.log(`Completed ${checks.length} browser checks. Artifacts: ${output}`);
} finally { if (context) await context.close(); server.close(); }
