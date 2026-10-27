(() => {
  if (globalThis.__tabRenamer) return;
  let original = document.title;
  let desired = null;
  let currentURL = location.href;
  let timer = null;
  let alive = true;
  let observedHead = null;
  let lastSequence = -1;
  function retire() {
    alive = false; desired = null; stop();
    removeEventListener('pageshow', request);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
    delete globalThis.__tabRenamer;
  }
  function contextAlive() {
    if (!alive) return false;
    try { if (chrome.runtime?.id) return true; } catch {}
    retire();
    return false;
  }
  const headObserver = new MutationObserver(records => {
    if (!contextAlive()) return;
    if (records.some(r => r.target.nodeName === 'TITLE' || r.target.parentNode?.nodeName === 'TITLE' ||
      (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].some(n => n.nodeName === 'TITLE')))) schedule();
  });
  const rootObserver = new MutationObserver(() => {
    if (!contextAlive()) return;
    if (document.documentElement) rootObserver.observe(document.documentElement, { childList: true });
    watchHead(); schedule();
  });
  function watchHead() {
    if (!contextAlive()) return;
    if (observedHead === document.head) return;
    headObserver.disconnect(); observedHead = document.head;
    if (observedHead && desired !== null) headObserver.observe(observedHead, { subtree: true, childList: true, characterData: true });
  }
  function start() {
    if (!contextAlive()) return;
    watchHead();
    // Only direct document/root children: ordinary body mutations are not observed.
    rootObserver.observe(document, { childList: true });
    if (document.documentElement) rootObserver.observe(document.documentElement, { childList: true });
  }
  function stop() {
    headObserver.disconnect(); rootObserver.disconnect(); observedHead = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function title(value) {
    if (!contextAlive()) return;
    if (document.title === value || !document.documentElement) return;
    // Do not enqueue our own title writes as observer work.
    headObserver.disconnect();
    document.title = value;
    observedHead = null;
    if (desired !== null) watchHead();
  }
  function schedule() {
    if (!contextAlive()) return;
    if (!alive || desired === null || timer !== null) return;
    // Yield even when the website fights the custom title. One pending timer,
    // at most 20 corrective writes per second, no microtask feedback loop.
    timer = setTimeout(refresh, 50);
  }
  function refresh() {
    timer = null;
    if (!contextAlive() || desired === null) return;
    if (currentURL !== location.href) {
      const previous = desired;
      currentURL = location.href;
      desired = null; stop();
      if (document.title !== previous) original = document.title;
      else title(original);
      request();
      return;
    }
    if (document.title !== desired) { original = document.title; title(desired); }
  }
  function request() {
    if (!contextAlive()) return;
    // An invalidated context can throw synchronously, before returning a Promise.
    // Promise.catch alone cannot catch that failure.
    try { Promise.resolve(chrome.runtime.sendMessage({ type: 'ready' })).catch(retire); }
    catch { retire(); }
  }
  function onMessage(message, sender, reply) {
    if (!contextAlive() || sender.id !== chrome.runtime.id) return;
    if (message.type === 'inspect') { reply({ original, url: location.href }); return; }
    if (message.type !== 'apply' || message.url !== location.href) return;
    if (!Number.isSafeInteger(message.sequence) || message.sequence < lastSequence) { reply({ ok: false, stale: true }); return; }
    lastSequence = message.sequence;
    if (desired === null || document.title !== desired) original = document.title;
    currentURL = location.href;
    stop();
    desired = message.name ?? null;
    title(desired ?? original);
    if (desired !== null) start();
    reply({ ok: true, original, url: currentURL });
  }
  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.__tabRenamer = true;
  addEventListener('pageshow', request);
  request();
})();
