import { normalizeURL, supported, originPattern, cleanName, chooseTitle, normalizeRule, ruleOrigins, inspectRules, ruleRevision } from './core.js';

// Serialize rule edits; page work has independent lanes so a slow tab cannot block the UI.
let lane = Promise.resolve();
function ordered(task) {
  const next = lane.then(task);
  lane = next.catch(error => console.warn('签名:', error.message));
  return next;
}
const tabLanes = new Map();
const pendingSync = new Set();
const runningSync = new Set();
const dirtySync = new Set();
const deferredTabs = new Set();
const closingTabs = new Set();
const syncQueue = [];
let activeSyncs = 0;
function inTab(id, task) {
  const next = (tabLanes.get(id) || Promise.resolve()).then(task);
  const settled = next.catch(error => console.warn('签名:', error.message));
  tabLanes.set(id, settled);
  settled.finally(() => { if (tabLanes.get(id) === settled) tabLanes.delete(id); });
  return next;
}
function deadline(promise, milliseconds, message = '页面暂时没有响应，请刷新网页后重试') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]).finally(() => clearTimeout(timer));
}
function scheduleSync(id) {
  if (closingTabs.has(id)) return;
  if (pendingSync.has(id)) { if (runningSync.has(id)) dirtySync.add(id); return; }
  pendingSync.add(id);
  syncQueue.push(id);
  drainSyncs();
}
function drainSyncs() {
  while (activeSyncs < 3 && syncQueue.length) {
    const id = syncQueue.shift();
    if (closingTabs.has(id)) { pendingSync.delete(id); closingTabs.delete(id); continue; }
    activeSyncs++;
    runningSync.add(id);
    inTab(id, () => sync(id)).catch(() => {}).finally(() => {
      pendingSync.delete(id);
      runningSync.delete(id);
      activeSyncs--;
      if (dirtySync.delete(id) && !closingTabs.has(id)) scheduleSync(id);
      if (closingTabs.has(id)) closingTabs.delete(id);
      drainSyncs();
    });
  }
}
const key = id => `tab:${id}`;
const draftKey = id => `renameDraft:${id}`;
async function renameDraft(id, url) {
  const draft = (await chrome.storage.session.get(draftKey(id)))[draftKey(id)];
  if (!draft) return null;
  if (draft.url !== url || Date.now() - draft.created > 120000) {
    await chrome.storage.session.remove(draftKey(id)); return null;
  }
  return draft;
}
async function finishRename(id, token) {
  const tab = await chrome.tabs.get(id), draft = await renameDraft(id, tab.url);
  if (!draft || draft.token !== token) return null;
  if (!await allowed(draft.url)) return null;
  const result = await uiMessage({ type: 'rename', tabId: id, url: draft.url, name: draft.name });
  await chrome.storage.session.remove(draftKey(id));
  return result;
}
async function resumeRenames() {
  for (const tab of await chrome.tabs.query({})) {
    const draft = await renameDraft(tab.id, tab.url);
    if (draft && await allowed(draft.url)) {
      inTab(tab.id, () => finishRename(tab.id, draft.token)).catch(() => {});
    }
  }
}
async function rules() {
  const value = (await chrome.storage.local.get('rules')).rules;
  const raw = value === undefined ? [] : value;
  inspectRules(raw); return raw;
}
let sequenceLane = Promise.resolve();
function applicationSequence() {
  const next = sequenceLane.then(async () => {
    const previous = (await chrome.storage.session.get('applySequence')).applySequence || 0;
    const sequence = previous + 1;
    await chrome.storage.session.set({ applySequence: sequence }); return sequence;
  });
  sequenceLane = next.catch(() => {}); return next;
}
async function state(id) { return (await chrome.storage.session.get(key(id)))[key(id)]; }
async function allowed(url) { return supported(url) && chrome.permissions.contains({ origins: [originPattern(url)] }); }
async function send(id, message) {
  return deadline(chrome.tabs.sendMessage(id, message, { frameId: 0 }), 1000);
}
async function sync(id, strict = false) {
  const tab = await chrome.tabs.get(id);
  // Never wake discarded/frozen pages merely to rename them. They resync on load.
  if (tab.discarded || tab.frozen) {
    deferredTabs.add(id);
    if (strict) throw new Error('此标签页正在休眠，请切换到该页面后再改名');
    return { deferred: true };
  }
  deferredTabs.delete(id);
  if (!supported(tab.url)) { await chrome.storage.session.remove(key(id)); return { supported: false }; }
  const url = normalizeURL(tab.url);
  let saved = await state(id);
  if (saved && saved.url !== url) { await chrome.storage.session.remove(key(id)); saved = undefined; }
  const permitted = await allowed(url);
  const selection = chooseTitle(url, saved, await rules());
  const sequence = await applicationSequence();
  const apply = { type: 'apply', url, name: selection.name, sequence };
  if (!permitted) {
    try { await send(id, { ...apply, name: null }); } catch {}
    if (strict) throw new Error('需要此网站的访问权限，请重新授权后再试');
    return { supported: true, permitted: false, url, ...selection, name: null };
  }
  let result;
  try {
    result = await send(id, apply);
  } catch {
    // No name to apply and no existing agent: there is nothing to restore.
    if (selection.name === null && !strict) return { supported: true, permitted: true, url, ...selection };
    try {
      await deadline(chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] }), 1500);
      result = await send(id, apply);
    } catch (error) {
      if (strict) throw new Error('此页面无法修改标题（例如 PDF 或受限页面）。普通网页请刷新后重试。');
      return { supported: true, permitted: true, unavailable: true, url, ...selection };
    }
  }
  if (!result?.ok && strict) throw new Error('页面已跳转，请重新打开弹窗再试');
  return { supported: true, permitted: true, url, ...selection, original: result?.original, applied: !!result?.ok };
}
async function syncAll() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) scheduleSync(tab.id);
}
async function readTab(id) {
  const tab = await chrome.tabs.get(id);
  if (!supported(tab.url)) return { supported: false, title: tab.title, reason: 'Chrome 不允许修改此页面。请在普通 http / https 网页中使用。' };
  const url = normalizeURL(tab.url);
  const [saved, list, permitted] = await Promise.all([state(id), rules(), allowed(url)]);
  // A snapshot must never require a responsive page or script injection.
  // Original title is supplementary and gets a short, independent deadline.
  let original;
  if (permitted && !tab.discarded && !tab.frozen && chooseTitle(url, saved, list).name) {
    try {
      const details = await deadline(chrome.tabs.sendMessage(id, { type: 'inspect' }, { frameId: 0 }), 100);
      if (details?.url === url) original = details.original;
    } catch {}
  }
  const draft = await renameDraft(id, url);
  return { supported: true, permitted, url, ...chooseTitle(url, saved, list), title: tab.title, original, rules: list, draftName: draft?.name };
}
async function registerSites() {
  const permissions = await chrome.permissions.getAll();
  const matches = (permissions.origins || []).filter(p => /^https?:\/\//.test(p));
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map(s => s.id) });
  if (matches.length) await chrome.scripting.registerContentScripts([{
    id: 'named-sites', matches, js: ['content.js'], runAt: 'document_start', persistAcrossSessions: true
  }]);
}
async function uiMessage(message) {
  if (message.type === 'prepareRename') {
    const tab = await chrome.tabs.get(message.tabId);
    if (!supported(tab.url) || normalizeURL(tab.url) !== message.url) throw new Error('页面已跳转，请重新打开弹窗再试');
    const draft = { token: message.token, url: message.url, name: cleanName(message.name), created: Date.now() };
    if (typeof draft.token !== 'string' || !draft.token) throw new Error('无效的保存请求');
    await chrome.storage.session.set({ [draftKey(tab.id)]: draft });
    // Permission may already have arrived while this message was being stored.
    const result = await finishRename(tab.id, draft.token);
    return { pending: !result, ...result };
  }
  if (message.type === 'finishRename') {
    const result = await finishRename(message.tabId, message.token);
    return result || await readTab(message.tabId);
  }
  if (message.type === 'cancelRename') {
    const tab = await chrome.tabs.get(message.tabId), draft = await renameDraft(tab.id, tab.url);
    if (draft?.token === message.token) await chrome.storage.session.remove(draftKey(tab.id));
    return {};
  }
  if (message.type === 'listRules') {
    const list = await rules();
    const revision = await ruleRevision(list);
    return { revision, rules: await Promise.all(inspectRules(list).map(async r => ({ ...r, rowKey: `${revision}:${r.index}`, permitted: !r.invalid && await chrome.permissions.contains({ origins: ruleOrigins(r) }) }))) };
  }
  if (['saveRule', 'moveRule', 'deleteRule', 'setRuleEnabled'].includes(message.type)) {
    const raw = await rules(), revision = await ruleRevision(raw), rows = inspectRules(raw);
    if (message.revision !== revision) throw new Error('规则已在其他页面更新，请重新读取列表后再操作；编辑草稿已保留');
    const creating = message.type === 'saveRule' && message.index === null;
    const index = message.index;
    if (!creating && (!Number.isInteger(index) || index < 0 || index >= raw.length)) throw new Error('规则定位已失效，请重新读取');
    const next = [...raw]; let rule, targetIndex = index;
    if (message.type === 'saveRule') {
      const normalized = normalizeRule(message.rule), name = cleanName(message.rule.name);
      if (rows.some(r => !r.invalid && r.index !== index && (r.type || 'exact') === normalized.type && r.url === normalized.url)) throw new Error('这个匹配条件已有规则，请编辑已有规则');
      const oldId = !creating && rows[index].id;
      const unique = oldId && rows.filter(r => r.id === oldId).length === 1;
      let id = unique ? oldId : crypto.randomUUID();
      while (rows.some(r => r.id === id && r.index !== index)) id = crypto.randomUUID();
      rule = { id, ...normalized, name, enabled: message.rule.enabled !== false };
      if (rule.enabled && !await chrome.permissions.contains({ origins: ruleOrigins(rule) })) throw new Error('请先允许访问规则对应的网站');
      if (creating) { targetIndex = next.length; next.push(rule); } else next[index] = rule;
    } else if (message.type === 'setRuleEnabled') {
      if (!rows[index].object || typeof message.enabled !== 'boolean') throw new Error('此记录需要先修正');
      if (message.enabled) {
        if (rows[index].invalid) throw new Error('规则条件无效，请先编辑修正');
        if (!await chrome.permissions.contains({ origins: ruleOrigins(raw[index]) })) throw new Error('请先允许访问规则对应的网站');
      }
      next[index] = { ...raw[index], enabled: message.enabled }; rule = next[index];
    } else if (message.type === 'deleteRule') { next.splice(index, 1); targetIndex = Math.min(index, next.length - 1); }
    else {
      if (![-1, 1].includes(message.direction)) throw new Error('无效的排序方向');
      targetIndex = index + message.direction;
      if (targetIndex < 0 || targetIndex >= next.length) throw new Error('规则已经位于边界');
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    }
    await chrome.storage.local.set({ rules: next });
    await syncAll();
    return { rule, index: targetIndex, revision: await ruleRevision(next) };
  }
  const tab = await chrome.tabs.get(message.tabId);
  if (!supported(tab.url)) throw new Error('Chrome 不允许修改此页面');
  const url = normalizeURL(tab.url);
  if (url !== message.url) throw new Error('页面已跳转，请重新打开弹窗再试');
  if (!await allowed(url)) throw new Error('未获得网站访问权限，请重新授权');
  if (!['rename', 'restore', 'useRule'].includes(message.type)) throw new Error('未知操作');
  const previous = await state(tab.id);
  const next = message.type === 'rename' ? { url, manual: cleanName(message.name) }
    : message.type === 'restore' ? { url, ignored: true } : { url };
  await chrome.storage.session.set({ [key(tab.id)]: next });
  try { return await sync(tab.id, true); }
  catch (error) {
    if (previous) await chrome.storage.session.set({ [key(tab.id)]: previous });
    else await chrome.storage.session.remove(key(tab.id));
    scheduleSync(tab.id);
    throw error;
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const isUI = !sender.tab && sender.url?.startsWith(chrome.runtime.getURL(''));
  const isExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  if (message.type === 'ready' && sender.tab && sender.frameId === 0 && !isExtensionPage) {
    scheduleSync(sender.tab.id);
    reply({ ok: true });
  } else if (isUI || isExtensionPage) {
    const operation = message.type === 'getTab' ? readTab(message.tabId)
      : message.type === 'listRules' ? uiMessage(message)
      : ['rename', 'restore', 'useRule', 'prepareRename', 'finishRename', 'cancelRename'].includes(message.type) ? inTab(message.tabId, () => uiMessage(message))
      : ordered(() => uiMessage(message));
    operation.then(result => reply({ ok: true, ...result }), error => reply({ ok: false, error: error.message }));
  } else return;
  return true;
});
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.url) inTab(id, () => renameDraft(id, info.url)).catch(() => {});
  if (info.url || info.status === 'complete' || info.frozen === false || info.discarded === false) scheduleSync(id);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  // Also works after worker restart when the deferred set has been lost.
  chrome.tabs.get(tabId).then(tab => { if (!tab.frozen && !tab.discarded) scheduleSync(tabId); }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(id => {
  closingTabs.add(id); deferredTabs.delete(id); dirtySync.delete(id);
  inTab(id, async () => { await chrome.storage.session.remove(key(id)); await chrome.storage.session.remove(draftKey(id)); }).finally(() => {
    if (!pendingSync.has(id)) closingTabs.delete(id);
  }).catch(() => {});
});
for (const event of [chrome.webNavigation.onHistoryStateUpdated, chrome.webNavigation.onReferenceFragmentUpdated]) {
  event.addListener(details => { if (details.frameId === 0) scheduleSync(details.tabId); });
}
chrome.permissions.onAdded.addListener(() => ordered(async () => { await registerSites(); await resumeRenames(); await syncAll(); }));
chrome.permissions.onRemoved.addListener(() => ordered(async () => { await registerSites(); await syncAll(); }));
chrome.runtime.onInstalled.addListener(() => ordered(async () => { await registerSites(); await syncAll(); }));
chrome.runtime.onStartup.addListener(() => ordered(async () => { await registerSites(); await syncAll(); }));
