import { originPattern, ruleOrigins } from './core.js';
export async function request(message) {
  let timer;
  const response = await Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('插件响应超时，请重新打开弹窗；若刚更新插件，请先在扩展管理页重新加载')), 8000); })
  ]).finally(() => clearTimeout(timer));
  if (!response?.ok) throw new Error(response?.error || '插件暂时无法响应，请重新打开后再试');
  return response;
}
export async function grant(url) {
  // Must be invoked directly by the click/submit handler, before other async work.
  const granted = await chrome.permissions.request({ origins: [originPattern(url)] });
  if (!granted) throw new Error('未获得网站访问权限。允许后才能在刷新时保留名称。');
}
export async function grantRule(rule) {
  const granted = await chrome.permissions.request({ origins: ruleOrigins(rule) });
  if (!granted) throw new Error('未获得匹配网站的访问权限，规则未启用');
}
export function status(text, error = false) {
  const node = document.querySelector('#status');
  node.textContent = text;
  node.classList.toggle('error', error);
}
export function busy(form, value) {
  for (const node of form.querySelectorAll('button, input')) node.disabled = value;
}
export function normalizeNamePaste(input) {
  input.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text || !/[\r\n\u2028\u2029]/.test(text)) return;
    event.preventDefault();
    input.setRangeText(text.replace(/[\r\n\u2028\u2029]+/g, ' '), input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
