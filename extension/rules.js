import { normalizeURL, normalizeRule, cleanName, ruleLabels } from './core.js';
import { request, grantRule, status, normalizeNamePaste } from './ui.js';
const $ = selector => document.querySelector(selector);
let list = [], revision = null, editing = null, deleting = null, saving = false, readGeneration = 0;
let focusVersion = 0;
document.addEventListener('focusin', () => focusVersion++);
normalizeNamePaste($('#rule-name'));
const matchHelp = {
  exact: ['https://example.com/dashboard', '精确匹配，包含路径、? 后的参数和 # 后的内容。'],
  prefix: ['https://flow.aliyun.com/', '匹配以此完整网址开头的页面。例如此地址及其所有下级页面。'],
  domain: ['flow.aliyun.com', '匹配该域名的 http / https 页面及所有端口，不包含子域名，不允许 *。'],
  wildcard: ['https://example.com/projects/*/builds*', '* 匹配零个或多个任意字符；协议和域名必须明确，? 等其他字符按字面匹配。']
};
function updateMatchUI() {
  const type = $('#match-type').value;
  $('#url-label').textContent = ruleLabels[type]; $('#url').placeholder = matchHelp[type][0]; $('#match-help').textContent = matchHelp[type][1];
}
$('#match-type').addEventListener('change', updateMatchUI);
function reset() {
  editing = null; $('#rule-form').reset(); $('#enabled').checked = true; updateMatchUI();
  $('#editor-heading').textContent = '新建网址规则'; $('#cancel-edit').hidden = true; $('#save-rule').textContent = '保存规则';
}
function edit(rule) {
  editing = { revision, index: rule.index };
  $('#url').value = rule.url; $('#rule-name').value = rule.name; $('#enabled').checked = rule.enabled;
  $('#match-type').value = Object.hasOwn(ruleLabels, rule.type) ? rule.type : 'exact'; updateMatchUI();
  $('#editor-heading').textContent = rule.invalid ? '修正规则' : '编辑网址规则'; $('#cancel-edit').hidden = false;
  $('#save-rule').textContent = '保存修改'; $('#url').focus(); window.scrollTo({ top: 0, behavior: 'smooth' });
}
function element(tag, className, text) { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; }
function captureFocus() {
  const node = document.activeElement;
  if (!node?.dataset.action || !node.closest('.rule-row')) return null;
  const index = Number(node.closest('.rule-row').dataset.index), rule = list.find(r => r.index === index);
  return { index, id: rule?.invalid ? null : rule?.id, action: node.dataset.action, version: focusVersion, revision };
}
function restoreFocus(focus) {
  if (!focus || focus.version !== focusVersion) return;
  let row;
  if (focus.accepted) row = $(`#rules [data-index="${focus.index}"]`);
  else if (focus.id) row = [...document.querySelectorAll('.rule-row')].find(node => list.find(r => r.index === Number(node.dataset.index))?.id === focus.id);
  else if (focus.revision === revision) row = $(`#rules [data-index="${focus.index}"]`);
  const button = row && ([...row.querySelectorAll('button')].find(n => n.dataset.action === focus.action && !n.disabled) ||
    [...row.querySelectorAll('.move-button')].find(n => !n.disabled) || row.querySelector('[data-action="edit"]'));
  if (button) button.focus();
  else if (!list.length) $('#url').focus();
  else $('#rules').focus();
}
async function load(focus = captureFocus()) {
  const generation = ++readGeneration;
  const data = await request({ type: 'listRules' });
  if (generation !== readGeneration) return;
  list = data.rules; revision = data.revision; render(); restoreFocus(focus);
}
function button(label, action, handler, className = 'text-button') {
  const node = element('button', className, label); node.dataset.action = action;
  node.addEventListener('click', handler); return node;
}
async function mutate(message, focus, permission) {
  if (saving) return;
  saving = true; ++readGeneration;
  try {
    if (permission) await permission;
    const result = await request(message);
    if (focus) focus = { ...focus, accepted: true, index: result.index };
    await load(focus);
    status('规则已更新，匹配页面将在可用时应用'); return result;
  } catch (error) { status(error.message, true); await load(focus).catch(() => {}); }
  finally { saving = false; }
}
function render() {
  $('#rules').replaceChildren(); $('#count').textContent = list.length;
  $('#save-rule').disabled = !revision;
  const query = $('#search').value.trim().toLocaleLowerCase();
  const visible = list.filter(r => `${r.name} ${r.url}`.toLocaleLowerCase().includes(query));
  $('#empty').hidden = list.length > 0;
  if (list.length && !visible.length) $('#rules').append(element('p', 'no-results', '没有匹配的规则，试试其他关键词。'));
  for (const rule of visible) {
    const row = element('article', `rule-row${rule.enabled ? '' : ' paused'}`, ''); row.dataset.index = rule.index;
    const locator = { revision, index: rule.index };
    if (rule.object) {
      const toggle = button('', 'toggle', () => {
        if (saving) return;
        const focus = captureFocus();
        const permission = !rule.enabled && !rule.invalid ? grantRule(rule) : null;
        mutate({ type: 'setRuleEnabled', ...locator, enabled: !rule.enabled }, focus, permission);
      }, 'switch');
      toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(rule.enabled));
      toggle.setAttribute('aria-label', `${rule.enabled ? '停用' : '启用'}规则：${rule.name}`);
      toggle.disabled = rule.invalid && !rule.enabled;
      row.append(toggle);
    }
    const content = element('div', 'rule-content', '');
    content.append(element('h3', '', rule.name), element('p', 'rule-url', `${ruleLabels[rule.type] || '未知方式'}：${rule.url || '无有效条件'}`));
    if (rule.invalid) content.append(element('p', 'error rule-url', `旧条件无效：${rule.reason}。可编辑修正；如不再需要，请在 Chrome 扩展详情收回网站权限。`));
    else if (rule.enabled && !rule.permitted) content.append(button('需要网站授权 · 点击授权', 'permission', () => {
      if (saving) return;
      mutate({ type: 'setRuleEnabled', ...locator, enabled: true }, captureFocus(), grantRule(rule));
    }, 'permission-button'));
    const buttons = element('div', 'row-actions', '');
    for (const [direction, label] of [[-1, '上移'], [1, '下移']]) {
      const move = button(label, direction < 0 ? 'up' : 'down', () => {
        if (!saving) mutate({ type: 'moveRule', ...locator, direction }, captureFocus());
      }, 'text-button move-button');
      move.disabled = direction < 0 ? rule.index === 0 : rule.index === list.length - 1;
      move.setAttribute('aria-label', `${label}规则：${rule.name}`); buttons.append(move);
    }
    const change = button(rule.invalid ? '修正' : '编辑', 'edit', () => { if (!saving) edit(rule); });
    change.setAttribute('aria-label', `编辑规则：${rule.name}`);
    const remove = button('删除', 'delete', () => {
      if (saving) return;
      deleting = { ...locator, focus: captureFocus() }; $('#delete-name').textContent = rule.name;
      $('#delete-dialog').returnValue = ''; $('#delete-dialog').showModal();
    }, 'text-button delete-button');
    remove.setAttribute('aria-label', `删除规则：${rule.name}`);
    buttons.append(change, remove); row.append(content, buttons); $('#rules').append(row);
  }
}
$('#rule-form').addEventListener('submit', async event => {
  event.preventDefault(); if (saving || !revision) return;
  try {
    const rule = { ...normalizeRule({ type: $('#match-type').value, url: $('#url').value }), name: cleanName($('#rule-name').value), enabled: $('#enabled').checked };
    const locator = editing || { revision, index: null };
    const permission = rule.enabled ? grantRule(rule) : null;
    $('#save-rule').disabled = true;
    const result = await mutate({ type: 'saveRule', ...locator, rule }, null, permission);
    if (result) { reset(); status('规则已保存，匹配页面将在可用时应用'); }
  } catch (error) { status(error.message, true); }
  finally { $('#save-rule').disabled = !revision; }
});
$('#cancel-edit').addEventListener('click', () => { if (!saving) { reset(); status(''); } });
$('#search').addEventListener('input', () => { render(); });
$('#delete-dialog').addEventListener('close', async () => {
  if ($('#delete-dialog').returnValue !== 'delete' || !deleting || saving) return;
  const target = deleting; deleting = null;
  // Closing a dialog restores its trigger focus; capture that current generation.
  const focus = captureFocus() || { ...target.focus, version: focusVersion };
  const result = await mutate({ type: 'deleteRule', revision: target.revision, index: target.index }, focus);
  if (result && editing?.revision === target.revision && editing.index === target.index) reset();
});
function refresh() { if (!saving) load().catch(error => status(error.message, true)); }
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.rules) refresh(); });
chrome.permissions.onAdded.addListener(refresh); chrome.permissions.onRemoved.addListener(refresh);
try {
  await load();
  const params = new URL(location.href).searchParams;
  if (params.has('url')) {
    const url = normalizeURL(params.get('url')); const existing = list.find(r => !r.invalid && r.type === 'exact' && r.url === url);
    if (existing) edit(existing); else { $('#url').value = url; $('#rule-name').value = params.get('name') || ''; $('#rule-name').focus(); }
    history.replaceState(null, '', location.pathname);
  }
} catch (error) { revision = null; $('#save-rule').disabled = true; status(error.message, true); }
