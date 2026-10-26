#!/usr/bin/env node
// Builds the filter data shipped with the extension:
//   extension/rules/<list>.json              static declarativeNetRequest rulesets
//   extension/filters/<list>.cosmetic.json   element-hiding data
//   extension/filters/<list>.extra.json      regex rules (validated at runtime) + popup filters
//   extension/scriptlets/<list>.js           MAIN-world scriptlets for the list's hosts
//   extension/filters/meta.json              list metadata + counts
// and keeps manifest.json's rule_resources in sync with tools/lists.mjs.
//
// Usage: pnpm build               (download fresh lists, fall back to tools/.cache)
//        pnpm build:offline       (use tools/.cache only)

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseCss } from 'css-what';
import { RE2 } from 're2-wasm';
import {
  parseFilterList, compileNetworkRules, serializeCosmetic, serializeScriptlets, RESOURCE_TYPES,
} from '../extension/lib/filter-parser.js';
import { LISTS } from './lists.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const CACHE = path.join(ROOT, 'tools', '.cache');
const OFFLINE = process.argv.includes('--offline');

/* ------------------------------------------------------------------ fetching */

function looksLikeFilterList(text) {
  if (text.length < 200) return false;
  const head = text.slice(0, 4000);
  return /^\s*\[Adblock/m.test(head) || /^!/m.test(head) || /##/.test(head) || /^\|\|/m.test(head);
}

async function download(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(45_000),
    headers: { 'user-agent': 'LaChan-FilterBuilder/1.0 (+https://github.com/)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!looksLikeFilterList(text)) throw new Error('nội dung không giống danh sách bộ lọc');
  return text;
}

async function loadSource(source) {
  if (source.file) {
    return { text: await fs.readFile(path.join(ROOT, source.file), 'utf8'), from: source.file };
  }
  const cachePath = path.join(CACHE, source.cache);
  if (!OFFLINE) {
    for (const url of source.urls) {
      try {
        const text = await download(url);
        await fs.mkdir(CACHE, { recursive: true });
        await fs.writeFile(cachePath, text);
        return { text, from: url };
      } catch (err) {
        console.warn(`    ! ${url}: ${err.message}`);
      }
    }
  }
  if (existsSync(cachePath)) {
    return { text: await fs.readFile(cachePath, 'utf8'), from: `cache:${source.cache}` };
  }
  return null;
}

/** Keeps only the lines an "extra" source is allowed to contribute. */
function pickLines(text, pick) {
  if (pick !== 'scriptlets-and-styles') return text;
  return text.split(/\r?\n/).filter((line) => (
    /#@?#\+js\(/.test(line) || (/#@?#/.test(line) && /:(?:style|remove)\(/.test(line))
  )).join('\n');
}

function listVersion(text) {
  const m = /^!\s*Version:\s*(.+)$/m.exec(text) || /^!\s*Last modified:\s*(.+)$/m.exec(text);
  return m ? m[1].trim() : '';
}

/* ---------------------------------------------------------------- validation */

const PSEUDO_CLASSES = new Set([
  'active', 'any-link', 'autofill', 'blank', 'checked', 'default', 'defined', 'dir', 'disabled',
  'empty', 'enabled', 'first', 'first-child', 'first-of-type', 'focus', 'focus-visible',
  'focus-within', 'fullscreen', 'has', 'host', 'hover', 'in-range', 'indeterminate', 'invalid',
  'is', 'lang', 'last-child', 'last-of-type', 'link', 'modal', 'not', 'nth-child',
  'nth-last-child', 'nth-last-of-type', 'nth-of-type', 'only-child', 'only-of-type', 'optional',
  'out-of-range', 'paused', 'picture-in-picture', 'placeholder-shown', 'playing', 'popover-open',
  'read-only', 'read-write', 'required', 'root', 'scope', 'target', 'user-invalid', 'user-valid',
  'valid', 'visited', 'where', '-webkit-any', '-webkit-any-link', '-webkit-autofill', 'open',
  'state', 'muted', 'volume-locked', 'buffering', 'stalled', 'seeking',
]);
const PSEUDO_ELEMENTS = new Set([
  'after', 'before', 'first-letter', 'first-line', 'marker', 'placeholder', 'selection',
  'backdrop', 'file-selector-button', '-webkit-scrollbar', '-webkit-scrollbar-thumb',
  '-webkit-scrollbar-track', '-webkit-input-placeholder', 'cue',
]);

function validSequence(seq, insideHas) {
  for (const tok of seq) {
    if (tok.type === 'pseudo') {
      if (!PSEUDO_CLASSES.has(tok.name)) return false;
      if (tok.name === 'has' && insideHas) return false;
      if (Array.isArray(tok.data)) {
        const nested = insideHas || tok.name === 'has';
        if (!tok.data.every((s) => validSequence(s, nested))) return false;
      }
    } else if (tok.type === 'pseudo-element') {
      if (insideHas || !PSEUDO_ELEMENTS.has(tok.name)) return false;
    } else if (tok.type === 'attribute' && tok.namespace) {
      return false;
    }
  }
  return true;
}

const selectorCache = new Map();
function isValidSelector(selector) {
  let ok = selectorCache.get(selector);
  if (ok !== undefined) return ok;
  ok = false;
  if (!/[{}]/.test(selector) && !/^\s*[>+~]/.test(selector)) {
    try {
      ok = parseCss(selector).every((seq) => validSequence(seq, false));
    } catch {
      ok = false;
    }
  }
  selectorCache.set(selector, ok);
  return ok;
}

/** Validates the CSS pieces embedded in a procedural plan. */
function isValidPlan(plan) {
  for (const [op, arg] of plan.t) {
    if (op === 'css' || op === 'matches') {
      const sel = /^\s*[>+~]/.test(arg) ? `:scope ${arg}` : arg;
      if (!isValidSelector(sel)) return false;
    } else if (op === 'spath') {
      if (!isValidSelector(`:scope${arg}`)) return false;
    } else if (op === 'upward' && typeof arg === 'string') {
      if (!isValidSelector(arg)) return false;
    } else if ((op === 'has' || op === 'not') && !isValidPlan(arg)) {
      return false;
    }
  }
  return true;
}

const ASCII_DOMAIN = /^[a-z0-9.\-_]+$/;
const DOMAIN_KEYS = ['initiatorDomains', 'excludedInitiatorDomains', 'requestDomains', 'excludedRequestDomains'];
const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other']);
const TYPES = new Set(RESOURCE_TYPES);
const CONDITION_KEYS = new Set([
  'urlFilter', 'regexFilter', 'isUrlFilterCaseSensitive', 'initiatorDomains', 'excludedInitiatorDomains',
  'requestDomains', 'excludedRequestDomains', 'resourceTypes', 'excludedResourceTypes',
  'requestMethods', 'excludedRequestMethods', 'domainType',
]);

/** Mirrors the checks Chrome runs when indexing a static ruleset. Returns an error string or null. */
function ruleError(rule, ids) {
  if (!Number.isInteger(rule.id) || rule.id < 1) return 'bad id';
  if (ids.has(rule.id)) return 'duplicate id';
  if (!Number.isInteger(rule.priority) || rule.priority < 1) return 'bad priority';
  const c = rule.condition;
  for (const key of Object.keys(c)) if (!CONDITION_KEYS.has(key)) return `unknown key ${key}`;
  if (c.regexFilter !== undefined) return 'regex in static ruleset';
  if (c.urlFilter !== undefined) {
    if (typeof c.urlFilter !== 'string' || c.urlFilter === '') return 'empty urlFilter';
    if (/[^\x00-\x7f]/.test(c.urlFilter)) return 'non-ascii urlFilter';
    if (c.urlFilter.startsWith('||*')) return 'urlFilter starts with ||*';
  }
  for (const key of DOMAIN_KEYS) {
    if (c[key] === undefined) continue;
    if (!Array.isArray(c[key]) || c[key].length === 0) return `empty ${key}`;
    for (const d of c[key]) if (typeof d !== 'string' || !ASCII_DOMAIN.test(d)) return `bad domain in ${key}: ${d}`;
  }
  if (c.resourceTypes !== undefined && c.excludedResourceTypes !== undefined) return 'both resourceTypes and excludedResourceTypes';
  for (const key of ['resourceTypes', 'excludedResourceTypes']) {
    if (c[key] === undefined) continue;
    if (!Array.isArray(c[key]) || (key === 'resourceTypes' && c[key].length === 0)) return `empty ${key}`;
    for (const t of c[key]) if (!TYPES.has(t)) return `bad type ${t}`;
  }
  if (c.excludedResourceTypes && RESOURCE_TYPES.every((t) => c.excludedResourceTypes.includes(t))) return 'no applicable types';
  for (const key of ['requestMethods', 'excludedRequestMethods']) {
    if (c[key] === undefined) continue;
    if (!Array.isArray(c[key]) || c[key].length === 0) return `empty ${key}`;
    for (const m of c[key]) if (!METHODS.has(m)) return `bad method ${m}`;
  }
  if (c.domainType !== undefined && c.domainType !== 'firstParty' && c.domainType !== 'thirdParty') return 'bad domainType';
  const a = rule.action;
  switch (a.type) {
    case 'block':
    case 'allow':
      break;
    case 'allowAllRequests':
      if (!c.resourceTypes || c.resourceTypes.some((t) => t !== 'main_frame' && t !== 'sub_frame')) {
        return 'allowAllRequests needs main_frame/sub_frame';
      }
      break;
    case 'redirect': {
      const p = a.redirect && a.redirect.extensionPath;
      if (typeof p !== 'string' || !p.startsWith('/')) return 'bad redirect';
      if (!existsSync(path.join(EXT, p))) return `missing redirect resource ${p}`;
      break;
    }
    default:
      return `bad action ${a.type}`;
  }
  return null;
}

function isRe2Compatible(source) {
  try {
    new RE2(source, 'u'); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------- output */

async function writeJson(rel, data) {
  const file = path.join(EXT, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
  return (await fs.stat(file)).size;
}

async function writeScriptlets(listId, serialized) {
  const file = path.join(EXT, 'scriptlets', `${listId}.js`);
  const hosts = Object.keys(serialized.data).filter((h) => h !== '*').sort();
  if (hosts.length === 0) {
    if (existsSync(file)) await fs.rm(file);
    return [];
  }
  const lib = await fs.readFile(path.join(ROOT, 'tools', 'scriptlet-lib.js'), 'utf8');
  const fn = lib.slice(lib.indexOf('function lachanScriptlets'));
  const code = [
    `// Generated by tools/build-filters.mjs from the "${listId}" filter list — do not edit.`,
    '(function () {',
    `  const DATA = ${JSON.stringify(serialized.data)};`,
    `  const EXCEPTIONS = ${JSON.stringify(serialized.exceptions)};`,
    `  (${fn.trim()})(DATA, EXCEPTIONS);`,
    '})();',
    '',
  ].join('\n');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, code);
  return hosts;
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/* --------------------------------------------------------------------- main */

async function buildList(list, previous) {
  console.log(`\n▸ ${list.title} (${list.id})`);
  const parts = [];
  const sourcesUsed = [];
  let version = '';
  let missingRequired = false;
  for (const source of list.sources) {
    const loaded = await loadSource(source);
    if (!loaded) {
      console.warn(`    ! không tải được nguồn ${source.cache || source.file}`);
      if (!source.pick) missingRequired = true;
      continue;
    }
    sourcesUsed.push(loaded.from);
    if (!version) version = listVersion(loaded.text);
    parts.push(source.pick ? pickLines(loaded.text, source.pick) : loaded.text);
    console.log(`    nguồn: ${loaded.from}`);
  }
  if (missingRequired) {
    // Never replace a working list with an empty one (offline, blocked mirror…).
    if (previous && existsSync(path.join(EXT, 'rules', `${list.id}.json`))) {
      console.warn(`    ! giữ nguyên bản đã build trước đó (${previous.version || 'không rõ phiên bản'})`);
      return previous;
    }
    console.warn('    ! chưa có bản nào trước đó — tạo dữ liệu rỗng để tiện ích vẫn nạp được');
  }

  const parsed = parseFilterList(parts.join('\n'));
  const { rules, regexRules, allowMaxId } = compileNetworkRules(parsed.network);

  const ids = new Set();
  const validRules = [];
  const ruleErrors = {};
  for (const rule of rules) {
    const err = ruleError(rule, ids);
    if (err) {
      ruleErrors[err] = (ruleErrors[err] || 0) + 1;
      continue;
    }
    ids.add(rule.id);
    validRules.push(rule);
  }
  // Re-number densely if anything was dropped (allow rules stay first).
  let maxAllowId = 0;
  validRules.forEach((r, i) => {
    const wasAllow = r.id <= allowMaxId;
    r.id = i + 1;
    if (wasAllow) maxAllowId = r.id;
  });

  const goodRegex = regexRules.filter((r) => isRe2Compatible(r.condition.regexFilter));

  let droppedSelectors = 0;
  const validate = (sel) => {
    const ok = isValidSelector(sel);
    if (!ok) {
      droppedSelectors++;
      if (process.env.DEBUG_SELECTORS) console.log(`      selector lỗi: ${sel}`);
    }
    return ok;
  };
  const cosmetic = serializeCosmetic(parsed.cosmetic, { validateSelector: validate });
  for (const [host, plans] of Object.entries(cosmetic.procedural)) {
    const kept = plans.filter((p) => {
      const ok = isValidPlan(p);
      if (!ok) droppedSelectors++;
      return ok;
    });
    if (kept.length) cosmetic.procedural[host] = kept;
    else delete cosmetic.procedural[host];
  }

  const scriptlets = serializeScriptlets(parsed.scriptlets, parsed.scriptletExceptions);
  const scriptletHosts = await writeScriptlets(list.id, scriptlets);

  const sizes = {
    rules: await writeJson(`rules/${list.id}.json`, validRules),
    cosmetic: await writeJson(`filters/${list.id}.cosmetic.json`, cosmetic),
    extra: await writeJson(`filters/${list.id}.extra.json`, { regexRules: goodRegex, popups: parsed.popups }),
  };

  const s = parsed.stats;
  console.log(`    luật mạng: ${validRules.length} (từ ${s.network} bộ lọc) · regex: ${goodRegex.length}/${regexRules.length} · pop-up: ${parsed.popups.length}`);
  console.log(`    ẩn phần tử: ${s.cosmetic} (procedural ${s.procedural}) · loại bỏ selector lỗi: ${droppedSelectors} · scriptlet: ${s.scriptlets} trên ${scriptletHosts.length} tên miền`);
  console.log(`    kích thước: rules ${kb(sizes.rules)}, cosmetic ${kb(sizes.cosmetic)}, extra ${kb(sizes.extra)}`);
  if (Object.keys(ruleErrors).length) console.warn('    ! luật bị loại khi kiểm tra:', ruleErrors);
  const skipped = Object.entries(s.skippedReasons).sort((a, b) => b[1] - a[1]);
  if (skipped.length) console.log(`    bỏ qua (không hỗ trợ): ${skipped.map(([k, v]) => `${k}×${v}`).join(', ')}`);

  return {
    id: list.id,
    title: list.title,
    category: list.category,
    description: list.description,
    defaultEnabled: list.defaultEnabled,
    homepage: list.homepage,
    license: list.license,
    version,
    sources: sourcesUsed,
    counts: {
      filters: s.network + s.cosmetic + s.scriptlets,
      networkRules: validRules.length,
      regexRules: goodRegex.length,
      popupFilters: parsed.popups.length,
      cosmetic: s.cosmetic,
      procedural: s.procedural,
      scriptlets: s.scriptlets,
    },
    allowMaxId: maxAllowId,
    scriptletHosts,
  };
}

async function main() {
  const started = Date.now();
  console.log(`Lá Chắn — build bộ lọc${OFFLINE ? ' (offline)' : ''}`);
  let previousMeta = null;
  try {
    previousMeta = JSON.parse(await fs.readFile(path.join(EXT, 'filters', 'meta.json'), 'utf8'));
  } catch { /* first build */ }
  const meta = { builtAt: new Date().toISOString(), lists: [] };
  for (const list of LISTS) {
    const previous = previousMeta && previousMeta.lists.find((l) => l.id === list.id);
    meta.lists.push(await buildList(list, previous));
  }
  await writeJson('filters/meta.json', meta);

  // Keep manifest.json in sync with the list set.
  const manifestPath = path.join(EXT, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.declarative_net_request = {
    rule_resources: LISTS.map((l) => ({ id: l.id, enabled: l.defaultEnabled, path: `rules/${l.id}.json` })),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const total = meta.lists.reduce((n, l) => n + (l.defaultEnabled ? l.counts.networkRules : 0), 0);
  console.log(`\n✓ Xong sau ${((Date.now() - started) / 1000).toFixed(1)} giây. Luật mạng bật mặc định: ${total} (Chrome đảm bảo tối thiểu 30.000).`);
  console.log('  Mở chrome://extensions và bấm ⟳ (Tải lại) trên Lá Chắn để dùng bộ lọc mới.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
