import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = await mkdtemp(path.join(tmpdir(), 'tab-signature-package-'));
const extracted = path.join(scratch, 'unpacked');
const zip = path.join(root, `dist/tab-signature-v${JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8')).version}.zip`);
const quote = value => `'${value.replaceAll("'", "''")}'`;
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(extracted)}`]);
async function files(directory, relative = '') {
  const result = [];
  for (const item of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, item.name);
    if (item.isDirectory()) result.push(...await files(directory, name)); else result.push(name);
  }
  return result.sort();
}
const source = path.join(root, 'extension');
const sourceFiles = await files(source);
assert.deepEqual(await files(extracted), [...sourceFiles, 'README.md'].sort());
for (const name of sourceFiles) assert.deepEqual(await readFile(path.join(source, name)), await readFile(path.join(extracted, name)), `${name} must match source exactly`);
const manifest = JSON.parse(await readFile(path.join(extracted, 'manifest.json'), 'utf8'));
assert.equal(manifest.host_permissions, undefined);
assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
const context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
  executablePath: process.env.TAB_SIGNATURE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
});
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extracted });
  const rules = await context.newPage(); await rules.goto(`chrome-extension://${id}/rules.html`);
  await rules.waitForFunction(() => document.querySelector('#count').textContent === '0');
  const permissions = await rules.evaluate(() => chrome.permissions.getAll());
  assert.deepEqual(permissions.origins, []);
  assert.deepEqual(await rules.evaluate(() => chrome.storage.local.get()), {});
  const internal = await context.newPage(); await internal.goto('chrome://version');
  const tab = await rules.evaluate(async () => (await chrome.tabs.query({ url: 'chrome://version/' }))[0]);
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tab.id}`);
  await popup.waitForFunction(() => document.querySelector('#mode').textContent === '此页面不可用');
  assert.equal(await popup.locator('#save').isDisabled(), true);
  await writeFile(path.join(root, 'test-results/package-report.json'), JSON.stringify({ passed: true, browser: context.browser().version(), runtimeFilesMatch: sourceFiles.length, noPregrantedHosts: true, noStoredData: true, cleanRulesPageLoads: true, restrictedPopupLoads: true, zip, bytes: (await readFile(zip)).length }, null, 2));
  console.log('PASS ZIP contents match all 14 runtime files; untouched package loads in Chrome with no site grants or stored data.');
} finally { await context.close(); }
