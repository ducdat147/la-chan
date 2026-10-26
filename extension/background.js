// Lá Chắn — service worker.
//
// Responsibilities:
//  • enable/disable the static rulesets (one per filter list) according to settings
//  • dynamic rules: "pause on this site", regex filters, the user's own network filters
//  • element hiding: answer content/cosmetic.js and inject CSS with origin USER
//  • register MAIN-world scriptlets, the click guard and the YouTube helper
//  • close advertising pop-ups, element picker, context menu, badge/icon

import { parseFilterList, compileNetworkRules, serializeCosmetic, PRIORITY } from './lib/filter-parser.js';
import { CosmeticEngine, hideCssEach } from './lib/cosmetic-engine.js';
import { PopupMatcher } from './lib/popup-matcher.js';
import { hostnameFromURL, hostnameMatchesAny, toASCIIHostname } from './lib/hosts.js';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  lists: {}, // listId → boolean (missing = list default)
  allowlist: [], // hostnames where blocking is paused
  popupBlocker: true,
  clickGuard: true, // block click-hijacking overlays and tab-under redirects
  contextMenu: true,
  showBadge: true,
});

const ICONS_ON = { 16: '/icons/icon-16.png', 32: '/icons/icon-32.png' };
const ICONS_OFF = { 16: '/icons/icon-off-16.png', 32: '/icons/icon-off-32.png' };
const CONTEXT_MENU_ID = 'lachan-block-element';

/* --------------------------------------------------------------- utilities */

const jsonCache = new Map();
function loadJson(path) {
  let p = jsonCache.get(path);
  if (!p) {
    p = fetch(chrome.runtime.getURL(path)).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    });
    p.catch(() => jsonCache.delete(path));
    jsonCache.set(path, p);
  }
  return p;
}

const getMeta = () => loadJson('filters/meta.json');

// Serialises everything that mutates settings / rules so syncs never interleave.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** Normalises "https://www.Example.com/x" or "www.example.com" → "example.com". */
function siteKey(input) {
  let host = input;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) host = hostnameFromURL(input);
  host = toASCIIHostname(host || '');
  if (!host) return null;
  return host.startsWith('www.') ? host.slice(4) : host;
}

/* ---------------------------------------------------------------- settings */

let settingsCache = null;

async function getSettings() {
  if (!settingsCache) {
    const { settings } = await chrome.storage.local.get('settings');
    settingsCache = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    settingsCache.lists = { ...(settingsCache.lists || {}) };
    settingsCache.allowlist = [...new Set((settingsCache.allowlist || []).map(siteKey).filter(Boolean))].sort();
  }
  return settingsCache;
}

async function saveSettings(patch) {
  const current = await getSettings();
  settingsCache = { ...current, ...patch };
  await chrome.storage.local.set({ settings: settingsCache });
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) settingsCache = null;
});

async function enabledListIds() {
  const [meta, s] = await Promise.all([getMeta(), getSettings()]);
  return meta.lists.filter((l) => (s.lists[l.id] ?? l.defaultEnabled)).map((l) => l.id);
}

function isPaused(settings, host) {
  return !!host && hostnameMatchesAny(host, settings.allowlist);
}

/* ------------------------------------------------------------ user filters */

let userCompiled = null;
let userVersion = 0;

async function getUserFiltersText() {
  const { userFilters } = await chrome.storage.local.get('userFilters');
  return typeof userFilters === 'string' ? userFilters : '';
}

function compileUserFilters(text) {
  const parsed = parseFilterList(text);
  const net = compileNetworkRules(parsed.network);
  return {
    rules: net.rules.map(({ id, ...rest }) => rest),
    regexRules: net.regexRules,
    cosmetic: serializeCosmetic(parsed.cosmetic),
    popups: parsed.popups,
    stats: parsed.stats,
  };
}

async function getUserCompiled() {
  if (!userCompiled) userCompiled = compileUserFilters(await getUserFiltersText());
  return userCompiled;
}

/* -------------------------------------------------- engines (lazy, cached) */

let engineState = { key: '', promise: null };

async function getCosmeticEngine() {
  const ids = await enabledListIds();
  const user = await getUserCompiled();
  const key = `${ids.join(',')}|${userVersion}`;
  if (engineState.key !== key || !engineState.promise) {
    engineState = {
      key,
      promise: (async () => {
        const datasets = await Promise.all(ids.map((id) => loadJson(`filters/${id}.cosmetic.json`)));
        const engine = new CosmeticEngine(datasets);
        engine.add(user.cosmetic, { user: true });
        return engine;
      })(),
    };
    engineState.promise.catch(() => { engineState = { key: '', promise: null }; });
  }
  return engineState.promise;
}

let popupState = { key: '', promise: null };

async function getPopupMatcher() {
  const ids = await enabledListIds();
  const user = await getUserCompiled();
  const key = `${ids.join(',')}|${userVersion}`;
  if (popupState.key !== key || !popupState.promise) {
    popupState = {
      key,
      promise: (async () => {
        const extras = await Promise.all(ids.map((id) => loadJson(`filters/${id}.extra.json`)));
        return new PopupMatcher([...extras.map((e) => e.popups || []), user.popups]);
      })(),
    };
    popupState.promise.catch(() => { popupState = { key: '', promise: null }; });
  }
  return popupState.promise;
}

function invalidateEngines() {
  engineState = { key: '', promise: null };
  popupState = { key: '', promise: null };
}

/* -------------------------------------------------------- static rulesets */

async function syncRulesets() {
  const [meta, s] = await Promise.all([getMeta(), getSettings()]);
  const ids = await enabledListIds();
  const want = new Set(s.enabled ? ids : []);
  const current = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
  const enable = meta.lists.map((l) => l.id).filter((id) => want.has(id) && !current.has(id));
  const disable = [...current].filter((id) => !want.has(id));
  let error = '';
  if (enable.length || disable.length) {
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: enable, disableRulesetIds: disable });
    } catch (err) {
      // Usually the global static-rule budget: enable lists one by one, in priority order.
      error = String(err && err.message ? err.message : err);
      if (disable.length) await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: disable }).catch(() => {});
      for (const id of enable) {
        await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [id] }).catch(() => {});
      }
    }
  }
  await chrome.storage.session.set({ rulesetError: error });
}

/* ---------------------------------------------------------- dynamic rules */

const regexSupport = new Map();
async function regexSupported(regex, caseSensitive) {
  const key = `${caseSensitive ? 1 : 0}${regex}`;
  if (!regexSupport.has(key)) {
    let ok = false;
    try {
      const r = await chrome.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive: !!caseSensitive });
      ok = !!r.isSupported;
    } catch {
      ok = false;
    }
    regexSupport.set(key, ok);
  }
  return regexSupport.get(key);
}

// id → { kind: 'allow'|'block', listId } — lets the popup classify matched dynamic rules.
let dynamicRuleInfo = new Map();

async function syncDynamicRules() {
  const s = await getSettings();
  const rules = [];
  const info = new Map();
  let failed = [];
  if (s.enabled) {
    const push = (proto, listId) => {
      const id = rules.length + 1;
      rules.push({ id, priority: proto.priority, action: proto.action, condition: proto.condition });
      const t = proto.action.type;
      info.set(id, { kind: t === 'allow' || t === 'allowAllRequests' ? 'allow' : 'block', listId });
    };
    if (s.allowlist.length) {
      push({
        priority: PRIORITY.SITE_ALLOWLIST,
        action: { type: 'allowAllRequests' },
        condition: { requestDomains: s.allowlist, resourceTypes: ['main_frame'] },
      }, 'allowlist');
    }
    const ids = await enabledListIds();
    for (const listId of ids) {
      const extra = await loadJson(`filters/${listId}.extra.json`);
      for (const r of extra.regexRules || []) {
        if (await regexSupported(r.condition.regexFilter, r.condition.isUrlFilterCaseSensitive)) push(r, listId);
      }
    }
    const user = await getUserCompiled();
    for (const r of user.rules) push(r, 'user');
    for (const r of user.regexRules) {
      if (await regexSupported(r.condition.regexFilter, r.condition.isUrlFilterCaseSensitive)) push(r, 'user');
      else failed.push({ filter: `/${r.condition.regexFilter}/`, error: 'Chrome không hỗ trợ biểu thức chính quy này' });
    }
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
  } catch {
    // One invalid rule rejects the whole batch: add them one by one and report the bad ones.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds }).catch(() => {});
    for (const rule of rules) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
      } catch (err) {
        info.delete(rule.id);
        failed.push({ filter: JSON.stringify(rule.condition), error: String(err.message || err) });
      }
    }
  }
  dynamicRuleInfo = info;
  await chrome.storage.session.set({ dynamicRuleInfo: [...info], dynamicFailures: failed });
  return failed;
}

async function getDynamicRuleInfo() {
  if (dynamicRuleInfo.size === 0) {
    const { dynamicRuleInfo: stored } = await chrome.storage.session.get('dynamicRuleInfo');
    if (Array.isArray(stored)) dynamicRuleInfo = new Map(stored);
  }
  return dynamicRuleInfo;
}

/* ---------------------------------------------- registered content scripts */

async function syncContentScripts() {
  const [meta, s] = await Promise.all([getMeta(), getSettings()]);
  const ids = new Set(await enabledListIds());
  const exclude = s.allowlist.map((h) => `*://*.${h}/*`);
  const wanted = [];
  if (s.enabled) {
    for (const list of meta.lists) {
      if (!ids.has(list.id) || !list.scriptletHosts || list.scriptletHosts.length === 0) continue;
      wanted.push({
        id: `scriptlets-${list.id}`,
        js: [`scriptlets/${list.id}.js`],
        matches: list.scriptletHosts.map((h) => `*://*.${h}/*`),
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        persistAcrossSessions: true,
      });
    }
    if (s.clickGuard) {
      wanted.push({
        id: 'click-guard',
        js: ['content/click-guard.js'],
        matches: ['<all_urls>'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        matchOriginAsFallback: true,
        persistAcrossSessions: true,
      });
    }
    if (ids.has('youtube')) {
      wanted.push({
        id: 'youtube-helper',
        js: ['content/youtube.js'],
        matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://*.youtubekids.com/*'],
        runAt: 'document_start',
        allFrames: true,
        persistAcrossSessions: true,
      });
    }
  }
  if (exclude.length) for (const cs of wanted) cs.excludeMatches = exclude;

  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: existing.map((c) => c.id) }).catch(() => {});
  }
  for (const cs of wanted) {
    try {
      await chrome.scripting.registerContentScripts([cs]);
    } catch (err) {
      console.warn('Lá Chắn: không đăng ký được', cs.id, err);
    }
  }
}

/* ----------------------------------------------------------- UI plumbing */

async function syncContextMenu() {
  const s = await getSettings();
  await chrome.contextMenus.removeAll();
  if (s.contextMenu && s.enabled) {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Chặn phần tử này…',
      contexts: ['page', 'frame', 'link', 'image', 'video', 'audio', 'selection'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  }
}

async function updateIcon(tabId, url) {
  const s = await getSettings();
  const off = !s.enabled || isPaused(s, hostnameFromURL(url || ''));
  try {
    await chrome.action.setIcon({ tabId, path: off ? ICONS_OFF : ICONS_ON });
  } catch { /* tab closed */ }
}

async function refreshAllIcons() {
  const s = await getSettings();
  await chrome.action.setIcon({ path: s.enabled ? ICONS_ON : ICONS_OFF }).catch(() => {});
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => updateIcon(t.id, t.url)));
}

async function setupBadge() {
  const s = await getSettings();
  await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: s.showBadge });
  await chrome.action.setBadgeBackgroundColor({ color: '#0F6B5C' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
}

async function fullSync() {
  await syncRulesets();
  await syncDynamicRules();
  await syncContentScripts();
  await syncContextMenu();
  await refreshAllIcons();
}

/* ------------------------------------------------------------ CSS helpers */

function frameTarget(sender) {
  const target = { tabId: sender.tab.id };
  if (sender.documentId) target.documentIds = [sender.documentId];
  else target.frameIds = [sender.frameId || 0];
  return target;
}

async function insertCss(target, css) {
  if (!css) return;
  try {
    await chrome.scripting.insertCSS({ target, css, origin: 'USER' });
  } catch { /* frame went away or is not scriptable */ }
}

/** Hostname the content script runs in (about:blank frames inherit their creator). */
function frameHostname(sender) {
  return hostnameFromURL(sender.url || '') || hostnameFromURL(sender.origin || '');
}

/* ------------------------------------------------------- message handlers */

async function onCosmeticInit(sender) {
  const s = await getSettings();
  if (!s.enabled || !sender.tab) return { enabled: false };
  const pageHost = hostnameFromURL(sender.tab.url || '') || frameHostname(sender);
  if (isPaused(s, pageHost)) return { enabled: false };
  const host = frameHostname(sender);
  if (!host) return { enabled: false };
  const engine = await getCosmeticEngine();
  const res = engine.lookup(host);
  if (res.elemhide) return { enabled: false };
  await insertCss(frameTarget(sender), res.css);
  return { enabled: true, generic: res.generic, procedural: res.procedural };
}

async function onCosmeticGeneric(msg, sender) {
  if (!sender.tab) return { count: 0 };
  const host = frameHostname(sender);
  if (!host) return { count: 0 };
  const engine = await getCosmeticEngine();
  const classes = Array.isArray(msg.classes) ? msg.classes.slice(0, 5000) : [];
  const ids = Array.isArray(msg.ids) ? msg.ids.slice(0, 5000) : [];
  const selectors = engine.matchGeneric(host, classes, ids);
  if (selectors.length) await insertCss(frameTarget(sender), `${selectors.join(',\n')}\n{display:none!important}`);
  return { count: selectors.length };
}

async function getTabState(tabId) {
  const [s, meta] = await Promise.all([getSettings(), getMeta()]);
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch { /* closed */ }
  const url = tab ? tab.url || tab.pendingUrl || '' : '';
  const host = hostnameFromURL(url);
  const state = {
    tabId,
    url,
    host,
    site: host ? siteKey(host) : null,
    supported: !!host && !/^https:\/\/chromewebstore\.google\.com\//.test(url) && !/^https:\/\/chrome\.google\.com\/webstore/.test(url),
    enabled: s.enabled,
    paused: isPaused(s, host),
    pausedBy: host ? s.allowlist.filter((a) => hostnameMatchesAny(host, [a])) : [],
    counts: { ads: 0, privacy: 0, annoyances: 0, total: 0 },
  };

  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
    const lists = new Map(meta.lists.map((l) => [l.id, l]));
    const dyn = await getDynamicRuleInfo();
    for (const m of rulesMatchedInfo) {
      const { ruleId, rulesetId } = m.rule;
      let category = null;
      if (rulesetId === '_dynamic' || rulesetId === '_session') {
        const info = dyn.get(ruleId);
        if (!info || info.kind === 'allow') continue;
        category = info.listId === 'user' ? 'ads' : lists.get(info.listId)?.category || 'ads';
      } else {
        const list = lists.get(rulesetId);
        if (!list || ruleId <= list.allowMaxId) continue;
        category = list.category;
      }
      state.counts[category] = (state.counts[category] || 0) + 1;
      state.counts.total++;
    }
  } catch {
    // Quota exceeded or tab gone — the badge counter below still gives a total.
  }
  // Chrome's own per-tab counter (the number on the toolbar icon) can be ahead of
  // getMatchedRules; never show less than what the icon shows.
  if (s.showBadge) {
    const n = parseInt(await chrome.action.getBadgeText({ tabId }).catch(() => ''), 10);
    if (Number.isFinite(n) && n > state.counts.total) {
      state.counts.ads += n - state.counts.total;
      state.counts.total = n;
    }
  }
  return state;
}

async function setSitePaused(site, paused) {
  const key = siteKey(site);
  if (!key) return getSettings();
  const s = await getSettings();
  const set = new Set(s.allowlist);
  if (paused) {
    set.add(key);
  } else {
    // Remove the entry and any parent entry that covers this host.
    for (const a of [...set]) if (a === key || hostnameMatchesAny(key, [a])) set.delete(a);
  }
  await saveSettings({ allowlist: [...set].sort() });
  await syncDynamicRules();
  await syncContentScripts();
  await refreshAllIcons();
  return getSettings();
}

async function setAllowlist(list) {
  const clean = [...new Set((Array.isArray(list) ? list : []).map(siteKey).filter(Boolean))].sort();
  await saveSettings({ allowlist: clean });
  await syncDynamicRules();
  await syncContentScripts();
  await refreshAllIcons();
  return clean;
}

async function setEnabled(enabled) {
  await saveSettings({ enabled: !!enabled });
  await fullSync();
}

async function setListEnabled(id, enabled) {
  const s = await getSettings();
  await saveSettings({ lists: { ...s.lists, [id]: !!enabled } });
  invalidateEngines();
  await syncRulesets();
  await syncDynamicRules();
  await syncContentScripts();
}

async function setUserFilters(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n');
  await chrome.storage.local.set({ userFilters: clean });
  userCompiled = compileUserFilters(clean);
  userVersion++;
  invalidateEngines();
  const failed = await syncDynamicRules();
  const st = userCompiled.stats;
  return {
    network: userCompiled.rules.length + userCompiled.regexRules.length,
    cosmetic: st.cosmetic,
    popup: st.popup,
    skipped: st.networkSkipped + st.cosmeticSkipped + st.scriptletsSkipped,
    skippedSamples: st.skippedSamples,
    failed,
  };
}

async function addUserFilter(line) {
  const text = (await getUserFiltersText()).replace(/\s+$/, '');
  const lines = text ? text.split('\n') : [];
  if (!lines.includes(line)) lines.push(line);
  return setUserFilters(`${lines.join('\n')}\n`);
}

async function startPicker(tabId, frameId = 0, fromContextMenu = false) {
  const target = { tabId, frameIds: [frameId] };
  await chrome.scripting.executeScript({
    target,
    func: (mode) => { globalThis.__lachanPickerMode = mode; },
    args: [fromContextMenu ? 'context' : 'pick'],
  });
  await chrome.scripting.executeScript({ target, files: ['content/picker.js'] });
}

async function onPickerSave(msg, sender) {
  const host = frameHostname(sender);
  const selector = typeof msg.selector === 'string' ? msg.selector.trim() : '';
  if (!host || !selector || /[{}]/.test(selector) || selector.length > 2000) return { ok: false };
  const site = host.startsWith('www.') ? host.slice(4) : host;
  const report = await addUserFilter(`${site}##${selector}`);
  await insertCss(frameTarget(sender), hideCssEach([selector]));
  return { ok: true, report };
}

async function getOptionsState() {
  const [meta, s] = await Promise.all([getMeta(), getSettings()]);
  const ids = new Set(await enabledListIds());
  const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
  const available = await chrome.declarativeNetRequest.getAvailableStaticRuleCount().catch(() => null);
  const { rulesetError, dynamicFailures } = await chrome.storage.session.get(['rulesetError', 'dynamicFailures']);
  const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
  return {
    settings: s,
    builtAt: meta.builtAt,
    lists: meta.lists.map((l) => ({
      id: l.id,
      title: l.title,
      category: l.category,
      description: l.description,
      homepage: l.homepage,
      license: l.license,
      version: l.version,
      counts: l.counts,
      enabled: ids.has(l.id),
      active: enabledRulesets.includes(l.id),
    })),
    userFilters: await getUserFiltersText(),
    availableStaticRules: available,
    dynamicRuleCount: dynamic.length,
    rulesetError: rulesetError || '',
    dynamicFailures: dynamicFailures || [],
    version: chrome.runtime.getManifest().version,
  };
}

const HANDLERS = {
  'cosmetic:init': (msg, sender) => onCosmeticInit(sender),
  'cosmetic:generic': (msg, sender) => onCosmeticGeneric(msg, sender),
  'picker:save': (msg, sender) => serialized(() => onPickerSave(msg, sender)),
  'popup:state': (msg) => getTabState(msg.tabId),
  'popup:setSitePaused': (msg) => serialized(() => setSitePaused(msg.site, msg.paused)),
  'popup:startPicker': (msg) => startPicker(msg.tabId).then(() => ({ ok: true })),
  'settings:setEnabled': (msg) => serialized(() => setEnabled(msg.enabled)).then(() => ({ ok: true })),
  'options:state': () => getOptionsState(),
  'options:setList': (msg) => serialized(() => setListEnabled(msg.id, msg.enabled)).then(getOptionsState),
  'options:setAllowlist': (msg) => serialized(() => setAllowlist(msg.allowlist)),
  'options:setUserFilters': (msg) => serialized(() => setUserFilters(msg.text)),
  'options:setOption': (msg) => serialized(async () => {
    if (!['popupBlocker', 'clickGuard', 'contextMenu', 'showBadge'].includes(msg.key)) return { ok: false };
    await saveSettings({ [msg.key]: !!msg.value });
    if (msg.key === 'clickGuard') await syncContentScripts();
    if (msg.key === 'contextMenu') await syncContextMenu();
    if (msg.key === 'showBadge') await setupBadge();
    return { ok: true };
  }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.type];
  if (!handler) return false;
  // Only our own pages may change settings; content scripts can only use cosmetic/picker messages.
  const fromExtensionPage = sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
  if (!fromExtensionPage && !/^(cosmetic|picker):/.test(msg.type)) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((res) => sendResponse(res), (err) => {
      console.error('Lá Chắn:', msg.type, err);
      sendResponse({ error: String(err && err.message ? err.message : err) });
    });
  return true;
});

/* --------------------------------------------------------- pop-up blocker */

const pendingPopups = new Map(); // tabId → { sourceUrl, until }

async function sourceUrlOf(details) {
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId: details.sourceTabId, frameId: details.sourceFrameId });
    if (frame && frame.url && hostnameFromURL(frame.url)) return frame.url;
  } catch { /* ignore */ }
  try {
    const tab = await chrome.tabs.get(details.sourceTabId);
    return tab.url || '';
  } catch {
    return '';
  }
}

async function maybeClosePopup(tabId, url, sourceUrl) {
  const matcher = await getPopupMatcher();
  if (matcher.size === 0 || !matcher.matches(url, sourceUrl)) return false;
  pendingPopups.delete(tabId);
  await chrome.tabs.remove(tabId).catch(() => {});
  return true;
}

chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  const s = await getSettings();
  if (!s.enabled || !s.popupBlocker) return;
  const sourceUrl = await sourceUrlOf(details);
  let pageUrl = sourceUrl;
  try {
    pageUrl = (await chrome.tabs.get(details.sourceTabId)).url || sourceUrl;
  } catch { /* ignore */ }
  if (isPaused(s, hostnameFromURL(pageUrl))) return;
  if (hostnameFromURL(details.url)) {
    if (await maybeClosePopup(details.tabId, details.url, sourceUrl)) return;
  }
  // about:blank pop-ups usually navigate to the real ad a moment later.
  pendingPopups.set(details.tabId, { sourceUrl, until: Date.now() + 6000 });
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  const p = pendingPopups.get(details.tabId);
  if (!p) return;
  if (Date.now() > p.until) {
    pendingPopups.delete(details.tabId);
    return;
  }
  maybeClosePopup(details.tabId, details.url, p.sourceUrl);
});

chrome.tabs.onRemoved.addListener((tabId) => pendingPopups.delete(tabId));

/* ---------------------------------------------------------- tabs & icons */

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading') updateIcon(tabId, tab.url);
});

/* -------------------------------------------------------- context menu */

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab || tab.id === undefined) return;
  startPicker(tab.id, info.frameId || 0, true).catch((err) => console.warn('Lá Chắn: picker', err));
});

/* ----------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener((details) => {
  serialized(async () => {
    await setupBadge();
    await fullSync();
    if (details.reason === 'install') {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#chao-mung') });
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  serialized(async () => {
    await setupBadge();
    await syncRulesets();
    await syncContextMenu();
    await refreshAllIcons();
  });
});
