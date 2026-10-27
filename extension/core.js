export function normalizeURL(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请输入完整的 http:// 或 https:// 网址'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 http:// 和 https:// 网页');
  if (url.username || url.password) throw new Error('请使用不包含用户名和密码的网址');
  return url.href;
}
export function supported(value) {
  try {
    const url = new URL(normalizeURL(value));
    return !['chromewebstore.google.com'].includes(url.hostname) && !(url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'));
  } catch { return false; }
}
export function originPattern(value) {
  const url = new URL(normalizeURL(value));
  // Chrome match patterns do not scope ports. Permission covers this scheme and host on all ports.
  return `${url.protocol}//${url.hostname}/*`;
}
export function cleanName(value) {
  const name = String(value ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  if (!name) throw new Error('请输入标签页名称');
  if ([...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(name)].length > 80) throw new Error('名称最多 80 个字符（一个 emoji 计一个字符）');
  return name;
}
export function chooseTitle(url, state, rules) {
  if (state?.url === url && state.manual) return { mode: 'manual', name: state.manual };
  if (state?.url === url && state.ignored) return { mode: 'ignored', name: null };
  const rule = inspectRules(rules).find(r => !r.invalid && r.enabled && matchesRule(url, r));
  return rule ? { mode: 'rule', name: rule.name, ruleId: rule.id } : { mode: 'original', name: null };
}
export function saveRule(rules, input) {
  const { type, url } = normalizeRule(input);
  const name = cleanName(input.name);
  if (input.id && !rules.some(r => r.id === input.id)) throw new Error('这条规则已被删除，请刷新后重试');
  if (rules.some(r => (r.type || 'exact') === type && r.url === url && r.id !== input.id)) throw new Error('这个匹配条件已有规则，请编辑已有规则');
  const rule = { id: input.id || crypto.randomUUID(), type, url, name, enabled: input.enabled !== false };
  return input.id ? rules.map(r => r.id === rule.id ? rule : r) : [...rules, rule];
}
export const ruleLabels = { exact: '完整网址', prefix: '网址前缀', domain: '域名', wildcard: '通配符' };
export function normalizeRule(input) {
  const type = input.type || 'exact';
  if (!Object.hasOwn(ruleLabels, type)) throw new Error('请选择有效的匹配方式');
  let value = String(input.url || '').trim();
  if (type === 'domain') {
    if (value.includes('*')) throw new Error('域名不能包含 *，请填写明确的主机名');
    if (!value.includes('://')) value = `https://${value}`;
    const parsed = new URL(normalizeURL(value));
    if (parsed.hostname.includes('*')) throw new Error('域名不能包含 *');
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.port) throw new Error('域名只填写主机名，例如 flow.aliyun.com，不包含路径或端口');
    if (!supported(parsed.href)) throw new Error('Chrome 不允许修改扩展商店页面');
    return { type, url: parsed.hostname };
  }
  const url = normalizeURL(value);
  if (!supported(url)) throw new Error('Chrome 不允许修改扩展商店页面');
  const parsed = new URL(url);
  if (parsed.host.includes('*') || parsed.protocol.includes('*')) throw new Error('协议和域名必须明确填写；星号只能用于路径、参数或锚点');
  if (type !== 'wildcard' && url.includes('*')) throw new Error('如需使用 *，请选择通配符匹配');
  if (type === 'wildcard' && !url.includes('*')) throw new Error('通配符规则需包含 *，例如 https://example.com/projects/*/builds*');
  return { type, url };
}
export function ruleOrigins(rule) {
  const normalized = normalizeRule(rule);
  return normalized.type === 'domain' ? [`http://${normalized.url}/*`, `https://${normalized.url}/*`] : [originPattern(normalized.url)];
}
export function matchesRule(value, rule) {
  try {
    const url = normalizeURL(value), type = rule.type || 'exact';
    if (type === 'domain') return new URL(url).hostname === rule.url;
    if (type === 'prefix') return new URL(url).origin === new URL(rule.url).origin && url.startsWith(rule.url);
    if (type === 'wildcard') {
      return globMatch(url, rule.url);
    }
    return type === 'exact' && url === rule.url;
  } catch { return false; }
}
// Literal segments are consumed once. KMP bounds searches even for repetitive inputs.
export function globMatch(text, pattern, work) {
  const tick = () => { if (work) work.steps++; };
  const parts = pattern.split('*').filter(Boolean);
  if (!pattern.includes('*')) { if (work) work.steps += text.length + pattern.length; return text === pattern; }
  let start = 0, end = text.length;
  if (!pattern.startsWith('*') && parts.length) {
    const first = parts.shift(); if (work) work.steps += first.length;
    if (!text.startsWith(first)) return false; start = first.length;
  }
  if (!pattern.endsWith('*') && parts.length) {
    const last = parts.pop(); if (work) work.steps += last.length;
    if (!text.endsWith(last)) return false; end -= last.length;
  }
  if (start > end) return false;
  for (const part of parts) {
    const prefix = new Uint32Array(part.length);
    for (let i = 1, j = 0; i < part.length; i++) {
      tick(); while (j && part[i] !== part[j]) { tick(); j = prefix[j - 1]; }
      if (part[i] === part[j]) j++; prefix[i] = j;
    }
    let found = false;
    for (let i = start, j = 0; i < end; i++) {
      tick(); while (j && text[i] !== part[j]) { tick(); j = prefix[j - 1]; }
      if (text[i] === part[j]) j++;
      if (j === part.length) { start = i + 1; found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}
export function inspectRules(raw) {
  if (!Array.isArray(raw)) throw new Error('规则存储格式异常，请保留现有数据并联系维护者');
  const counts = new Map();
  for (const r of raw) if (r && typeof r === 'object' && typeof r.id === 'string') counts.set(r.id, (counts.get(r.id) || 0) + 1);
  return raw.map((r, index) => {
    const object = r !== null && typeof r === 'object' && !Array.isArray(r);
    const row = { id: object && typeof r.id === 'string' ? r.id : '', type: object && typeof r.type === 'string' ? r.type : 'exact',
      url: object && typeof r.url === 'string' ? r.url : '', name: object && typeof r.name === 'string' ? r.name : `异常记录 ${index + 1}`,
      enabled: object && r.enabled === true, index, object };
    try {
      if (!object || !row.id || counts.get(row.id) !== 1 || typeof r.url !== 'string' || typeof r.name !== 'string' || typeof r.enabled !== 'boolean') throw new Error('记录结构或 ID 异常');
      normalizeRule(r); cleanName(r.name);
      return { ...row, invalid: false };
    } catch (error) { return { ...row, invalid: true, reason: error.message }; }
  });
}
export async function ruleRevision(raw) {
  inspectRules(raw);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(raw)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function moveRule(rules, id, direction) {
  if (![-1, 1].includes(direction)) throw new Error('无效的排序方向');
  const next = [...rules], index = next.findIndex(r => r.id === id), target = index + direction;
  if (index < 0) throw new Error('这条规则已被删除，请刷新后重试');
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
