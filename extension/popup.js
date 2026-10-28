import { cleanName, matchesRule, inspectRules } from './core.js';
import { request, grant, status, normalizeNamePaste } from './ui.js';
const $ = selector => document.querySelector(selector);
let tabId, current;
let phase = 'loading', working = false;
function controls() {
  for (const selector of ['#name', '#save', '#restore', '#use-rule', '#add-rule']) $(selector).disabled = phase !== 'ready' || working || !current?.supported || !!current?.unavailable;
  $('#retry').hidden = phase !== 'error';
}
normalizeNamePaste($('#name'));
const modeLabels = { original: '网页原标题', manual: '手动命名', rule: '网址规则', ignored: '已暂时忽略规则' };
function paint(data, updateInput = true) {
  current = data;
  $('#mode').textContent = data.supported ? (!data.permitted ? '需要网站授权' : data.unavailable ? '此页面不可用' : modeLabels[data.mode]) : '此页面不可用';
  $('#host').textContent = data.url ? new URL(data.url).hostname : '';
  $('#original').textContent = data.original || data.title || '网页尚未提供标题';
  $('#original').title = data.original || data.title || '';
  if (updateInput) $('#name').value = data.draftName || data.name || '';
  controls();
  $('#use-rule').hidden = !data.supported || data.mode === 'rule' || !inspectRules(data.rules || []).some(r => !r.invalid && r.enabled && matchesRule(data.url, r));
  if (!data.supported) status(data.reason, true);
  else if (data.unavailable) status('Chrome 无法修改此页面（例如内置 PDF 阅读器）。普通网页请刷新后重试。', true);
  else if (data.mode === 'ignored') status('此标签页已暂时忽略自动规则，刷新也会保留。');
  else if (!data.permitted) status('首次保存时，Chrome 会请求此网站的访问权限。');
  else if (data.mode === 'rule') status('正在使用网址规则。手动保存可单独覆盖此标签页。');
}
async function action(type, name) {
  if (phase !== 'ready' || working || !current?.supported || current.unavailable) return;
  working = true; controls();
  try {
  let result;
  if (type === 'rename' && !current.permitted) {
    const token = crypto.randomUUID();
    // Send the intent before requesting permission, without awaiting anything:
    // the request retains the click's user gesture, and the background owns saving
    // even if Chrome destroys this popup while showing the native prompt.
    const prepared = request({ type: 'prepareRename', tabId, url: current.url, name, token });
    const permission = grant(current.url);
    const [staged, granted] = await Promise.allSettled([prepared, permission]);
    if (granted.status === 'rejected') {
      await request({ type: 'cancelRename', tabId, token }).catch(() => {});
      throw granted.reason;
    }
    if (staged.status === 'rejected') throw staged.reason;
    result = await request({ type: 'finishRename', tabId, token });
  } else {
    await grant(current.url);
    result = await request({ type, tabId, url: current.url, name });
  }
  paint({ ...current, ...result });
  status(type === 'rename' ? '名称已保存' : type === 'restore' ? '已恢复网页标题，此标签页暂时忽略自动规则。' : '已使用网址规则');
  } finally { working = false; controls(); }
}
$('#rename-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (phase !== 'ready' || working) return;
  try {
    const name = cleanName($('#name').value);
    await action('rename', name);
  } catch (error) { status(error.message, true); }
  finally { controls(); }
});
for (const [id, type] of [['#restore', 'restore'], ['#use-rule', 'useRule']]) {
  $(id).addEventListener('click', async () => {
    try { await action(type); } catch (error) { status(error.message, true); }
    finally { controls(); }
  });
}
$('#manage').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#add-rule').addEventListener('click', () => {
  if (phase !== 'ready' || working || !current?.supported) return;
  chrome.tabs.create({ url: chrome.runtime.getURL(`rules.html?url=${encodeURIComponent(current.url)}&name=${encodeURIComponent($('#name').value || '')}`) });
});
addEventListener('keydown', event => { if (event.key === 'Escape') window.close(); });
async function load() {
  phase = 'loading'; controls(); $('#mode').textContent = '正在读取'; status('');
try {
  // A tabId is accepted only on extension pages, useful when opening the popup as a full tab.
  const provided = new URL(location.href).searchParams.get('tabId');
  tabId = provided ? Number(provided) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  const data = await request({ type: 'getTab', tabId }); phase = 'ready'; paint(data);
  if (current.supported) { $('#name').focus(); $('#name').select(); }
} catch (error) {
  phase = 'error'; current = null;
  $('#mode').textContent = '读取失败';
  status(error.message, true);
  controls();
}
}
$('#retry').addEventListener('click', () => { if (phase !== 'loading') load(); });
await load();
