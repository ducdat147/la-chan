// Adblock Plus / uBlock Origin filter syntax → Chrome declarativeNetRequest rules,
// cosmetic (element hiding) data, scriptlet calls and popup filters.
//
// Shared by tools/build-filters.mjs (Node, at build time) and background.js
// (service worker, for the user's own filters). No DOM or Node APIs used here.

import { toASCIIHostname } from './hosts.js';
import {
  compileProcedural, hasProceduralOperator, normalizeExtendedSelector, planIsPlainCss, sanitizeStyle,
} from './procedural.js';

export const PRIORITY = Object.freeze({
  BLOCK: 1,
  REDIRECT: 2,
  ALLOW: 2,
  IMPORTANT_BLOCK: 3,
  IMPORTANT_REDIRECT: 4,
  SITE_ALLOWLIST: 100, // user "pause on this site" (dynamic rule)
});

export const RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
  'webbundle', 'other',
];
const NON_DOCUMENT_TYPES = RESOURCE_TYPES.filter((t) => t !== 'main_frame');

const TYPE_OPTIONS = {
  script: ['script'],
  image: ['image'],
  stylesheet: ['stylesheet'],
  css: ['stylesheet'],
  object: ['object'],
  'object-subrequest': ['object'],
  xmlhttprequest: ['xmlhttprequest'],
  xhr: ['xmlhttprequest'],
  subdocument: ['sub_frame'],
  frame: ['sub_frame'],
  ping: ['ping'],
  beacon: ['ping'],
  media: ['media'],
  font: ['font'],
  websocket: ['websocket'],
  webtransport: ['webtransport'],
  webbundle: ['webbundle'],
  other: ['other', 'csp_report'],
  document: ['main_frame'],
  doc: ['main_frame'],
};

const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other']);

// Neutered resources bundled in extension/resources (used by $redirect / $rewrite).
const REDIRECT_RESOURCES = {
  'noop.js': '/resources/noop.js',
  noopjs: '/resources/noop.js',
  'blank-js': '/resources/noop.js',
  'noop.txt': '/resources/noop.txt',
  nooptext: '/resources/noop.txt',
  'blank-text': '/resources/noop.txt',
  empty: '/resources/noop.txt',
  'noop.css': '/resources/noop.css',
  'blank-css': '/resources/noop.css',
  'noop.html': '/resources/noop.html',
  noopframe: '/resources/noop.html',
  'blank-html': '/resources/noop.html',
  'noop.json': '/resources/noop.json',
  noopjson: '/resources/noop.json',
  '1x1.gif': '/resources/1x1.gif',
  '1x1-transparent.gif': '/resources/1x1.gif',
  '1x1-transparent-gif': '/resources/1x1.gif',
  '2x2.png': '/resources/2x2.png',
  '2x2-transparent.png': '/resources/2x2.png',
  '2x2-transparent-png': '/resources/2x2.png',
  '3x2.png': '/resources/3x2.png',
  '3x2-transparent.png': '/resources/3x2.png',
  '3x2-transparent-png': '/resources/3x2.png',
  '32x32.png': '/resources/32x32.png',
  '32x32-transparent.png': '/resources/32x32.png',
  '32x32-transparent-png': '/resources/32x32.png',
  'noop-0.1s.mp3': '/resources/noop-0.1s.mp3',
  'noopmp3-0.1s': '/resources/noop-0.1s.mp3',
  'noop-0.5s.mp3': '/resources/noop-0.1s.mp3',
  'blank-mp3': '/resources/noop-0.1s.mp3',
};
// Video stubs we do not ship: such filters fall back to a plain block.
const BLOCK_INSTEAD_OF_REDIRECT = new Set(['noop-1s.mp4', 'noopmp4-1s', 'blank-mp4', 'mp4']);

export const SCRIPTLET_ALIASES = {
  'abort-current-script': 'abort-current-script',
  acs: 'abort-current-script',
  'abort-current-inline-script': 'abort-current-script',
  acis: 'abort-current-script',
  'abort-on-property-read': 'abort-on-property-read',
  aopr: 'abort-on-property-read',
  'abort-on-property-write': 'abort-on-property-write',
  aopw: 'abort-on-property-write',
  'addeventlistener-defuser': 'add-event-listener-defuser',
  'add-event-listener-defuser': 'add-event-listener-defuser',
  aeld: 'add-event-listener-defuser',
  'prevent-addeventlistener': 'add-event-listener-defuser',
  'set-constant': 'set-constant',
  set: 'set-constant',
  'no-settimeout-if': 'no-settimeout-if',
  nostif: 'no-settimeout-if',
  'prevent-settimeout': 'no-settimeout-if',
  'settimeout-defuser': 'no-settimeout-if',
  'no-setinterval-if': 'no-setinterval-if',
  nosiif: 'no-setinterval-if',
  'prevent-setinterval': 'no-setinterval-if',
  'setinterval-defuser': 'no-setinterval-if',
  'json-prune': 'json-prune',
  'no-window-open-if': 'no-window-open-if',
  nowoif: 'no-window-open-if',
  'prevent-window-open': 'no-window-open-if',
  'window.open-defuser': 'no-window-open-if',
  'remove-attr': 'remove-attr',
  ra: 'remove-attr',
  'remove-class': 'remove-class',
  rc: 'remove-class',
  'remove-node-text': 'remove-node-text',
  rmnt: 'remove-node-text',
  'no-fetch-if': 'no-fetch-if',
  'prevent-fetch': 'no-fetch-if',
  'no-xhr-if': 'no-xhr-if',
  'prevent-xhr': 'no-xhr-if',
  'set-session-storage-item': 'set-session-storage-item',
  'ss-item': 'set-session-storage-item',
  'set-local-storage-item': 'set-local-storage-item',
  'ls-item': 'set-local-storage-item',
  'noeval-if': 'noeval-if',
  'prevent-eval-if': 'noeval-if',
};

const COSMETIC_RE = /^([^\s/|^]*?)(#@?(?:\$\?|[?$%])?#)(.*)$/;
const NETWORK_OPTIONS_RE = /\$(~?[\w-]+(?:=[^,]*)?(?:,~?[\w-]+(?:=[^,]*)?)*)$/;
const PURE_HOST_RE = /^\|\|([a-z0-9](?:[a-z0-9\-_.]*[a-z0-9])?)\^?$/;
const PLAIN_SELECTOR_BAD = /[{}]|^\s*$|^[>+~]/;

/* ------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* ------------------------------------------------------------------------- */

function newStats() {
  return {
    lines: 0,
    comments: 0,
    network: 0,
    networkSkipped: 0,
    cosmetic: 0,
    cosmeticSkipped: 0,
    procedural: 0,
    scriptlets: 0,
    scriptletsSkipped: 0,
    popup: 0,
    skippedReasons: {},
    skippedSamples: [], // first few unusable lines, shown to the user for their own filters
  };
}

function skip(stats, kind, reason) {
  stats[kind] += 1;
  stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
  return null;
}

/** Parses "a.com|~b.com" (sep "|") or "a.com,~b.com" (sep ","). */
function parseDomainList(text, sep) {
  const include = [];
  const exclude = [];
  let entities = 0;
  let invalid = 0;
  for (let raw of text.split(sep)) {
    raw = raw.trim();
    if (raw === '') continue;
    let neg = false;
    if (raw.startsWith('~')) { neg = true; raw = raw.slice(1); }
    if (raw.startsWith('/') && raw.endsWith('/')) { invalid++; continue; } // regex domains: unsupported
    let host;
    if (raw.endsWith('.*')) {
      const base = toASCIIHostname(raw.slice(0, -2));
      host = base ? `${base}.*` : null;
      entities++;
    } else {
      host = toASCIIHostname(raw);
    }
    if (!host) { invalid++; continue; }
    (neg ? exclude : include).push(host);
  }
  return { include, exclude, entities, invalid };
}

function uniqueSorted(arr) {
  return [...new Set(arr)].sort();
}

/** "||x^$script,badfilter" → "||x^$script" (the filter a $badfilter line cancels). */
function stripBadfilter(line) {
  const m = NETWORK_OPTIONS_RE.exec(line);
  if (!m) return line;
  const opts = m[1].split(',').filter((o) => o.trim().toLowerCase() !== 'badfilter');
  return opts.length ? `${line.slice(0, m.index)}$${opts.join(',')}` : line.slice(0, m.index);
}

/** Converts an ABP URL pattern to a DNR urlFilter. Returns '' for "match everything", null if unusable. */
export function normalizeUrlPattern(pattern) {
  let p = pattern;
  if (p === '' || p === '*') return '';
  if (/\s/.test(p)) return null;
  if (p.startsWith('||*')) p = p.slice(2);
  // Collapse runs of "*" and drop redundant leading/trailing wildcards.
  p = p.replace(/\*{2,}/g, '*');
  while (p.startsWith('*') && p.length > 1 && !p.startsWith('*|')) p = p.slice(1);
  while (p.endsWith('*') && p.length > 1 && !p.endsWith('|*')) p = p.slice(0, -1);
  if (p === '' || p === '*') return '';
  if (p === '|' || p === '||' || p === '|*' || p === '||*') return null;

  if (p.startsWith('||')) {
    const m = /^\|\|([^/^:?*|]+)/.exec(p);
    if (!m) return null;
    let host = m[1].toLowerCase();
    if (/[^\x00-\x7f]/.test(host)) {
      const ascii = toASCIIHostname(host.replace(/\.$/, ''));
      if (!ascii) return null;
      host = host.endsWith('.') ? `${ascii}.` : ascii;
    }
    p = `||${host}${p.slice(2 + m[1].length)}`;
  }
  if (/[^\x00-\x7f]/.test(p)) {
    p = p.replace(/[^\x00-\x7f]+/g, (s) => encodeURIComponent(s));
  }
  if (p.startsWith('||*')) p = p.slice(2);
  return p;
}

/** ABP pattern → JavaScript RegExp source (used for popup filters evaluated in the worker). */
export function patternToRegExpSource(pattern) {
  let re = '';
  let i = 0;
  let end = pattern.length;
  if (pattern.startsWith('||')) {
    re = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#]*\\.)?';
    i = 2;
  } else if (pattern.startsWith('|')) {
    re = '^';
    i = 1;
  }
  let endAnchor = false;
  if (end > i && pattern.endsWith('|')) { endAnchor = true; end--; }
  for (; i < end; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '^') re += '(?:[^\\w\\-.%]|$)';
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  if (endAnchor) re += '$';
  return re;
}

/* ------------------------------------------------------------------------- */
/* Network filters                                                            */
/* ------------------------------------------------------------------------- */

function parseNetworkFilter(raw, stats) {
  let line = raw;
  let exception = false;
  if (line.startsWith('@@')) {
    exception = true;
    line = line.slice(2);
  }

  let regex = null;
  let pattern = line;
  let optionsText = '';

  const reMatch = /^\/(.+)\/(?:\$([^/]*))?$/.exec(line);
  if (reMatch && line.length > 2) {
    regex = reMatch[1];
    optionsText = reMatch[2] || '';
  } else {
    const m = NETWORK_OPTIONS_RE.exec(line);
    if (m) {
      pattern = line.slice(0, m.index);
      optionsText = m[1];
    }
  }

  const f = {
    raw,
    exception,
    regex,
    pattern: '',
    types: new Set(),
    negTypes: new Set(),
    party: null,
    initiator: { include: [], exclude: [] },
    request: { include: [], exclude: [] },
    methods: { include: [], exclude: [] },
    matchCase: false,
    important: false,
    redirect: null,
    blockInsteadOfRedirect: false,
    docException: false,
    elemhide: false,
    generichide: false,
    specifichide: false,
    popup: false,
    badfilter: false,
    cosmeticOnly: false,
  };

  if (optionsText !== '') {
    for (let opt of optionsText.split(',')) {
      opt = opt.trim();
      if (opt === '') continue;
      let value = null;
      const eq = opt.indexOf('=');
      let name = eq === -1 ? opt : opt.slice(0, eq);
      if (eq !== -1) value = opt.slice(eq + 1);
      name = name.toLowerCase();
      let neg = false;
      if (name.startsWith('~')) { neg = true; name = name.slice(1); }

      if (TYPE_OPTIONS[name] && !(exception && (name === 'document' || name === 'doc'))) {
        for (const t of TYPE_OPTIONS[name]) (neg ? f.negTypes : f.types).add(t);
        continue;
      }
      switch (name) {
        case 'document':
        case 'doc':
          // Exception filters only (block $document handled above).
          if (neg) return skip(stats, 'networkSkipped', 'negated-document-exception');
          f.docException = true;
          break;
        case 'third-party':
        case '3p':
        case 'strict3p':
          f.party = neg ? 'first' : 'third';
          break;
        case 'first-party':
        case '1p':
        case 'strict1p':
          f.party = neg ? 'third' : 'first';
          break;
        case 'domain':
        case 'from': {
          if (value === null) return skip(stats, 'networkSkipped', 'bad-domain-option');
          const d = parseDomainList(value, '|');
          const incPlain = d.include.filter((h) => !h.endsWith('.*'));
          if (d.include.length > 0 && incPlain.length === 0) {
            return skip(stats, 'networkSkipped', 'entity-domains');
          }
          if (d.invalid > 0 && d.include.length === 0 && d.exclude.length === 0) {
            return skip(stats, 'networkSkipped', 'bad-domain-option');
          }
          f.initiator.include.push(...incPlain);
          f.initiator.exclude.push(...d.exclude.filter((h) => !h.endsWith('.*')));
          break;
        }
        case 'to':
        case 'denyallow': {
          if (value === null) return skip(stats, 'networkSkipped', 'bad-to-option');
          const d = parseDomainList(value, '|');
          if (d.entities > 0) return skip(stats, 'networkSkipped', 'entity-domains');
          if (name === 'denyallow') {
            f.request.exclude.push(...d.include);
          } else {
            f.request.include.push(...d.include);
            f.request.exclude.push(...d.exclude);
          }
          break;
        }
        case 'method': {
          if (value === null) return skip(stats, 'networkSkipped', 'bad-method-option');
          for (let m of value.toLowerCase().split('|')) {
            let mneg = false;
            if (m.startsWith('~')) { mneg = true; m = m.slice(1); }
            if (!METHODS.has(m)) return skip(stats, 'networkSkipped', 'bad-method-option');
            (mneg ? f.methods.exclude : f.methods.include).push(m);
          }
          break;
        }
        case 'match-case':
          f.matchCase = !neg;
          break;
        case 'important':
          f.important = true;
          break;
        case 'all':
          for (const t of RESOURCE_TYPES) f.types.add(t);
          f.popup = true;
          break;
        case 'popup':
          if (neg) break;
          f.popup = true;
          break;
        case 'redirect':
        case 'rewrite':
        case 'mp4': {
          let res = name === 'mp4' ? 'mp4' : (value || '');
          res = res.replace(/^abp-resource:/, '').replace(/:\d+$/, '');
          if (REDIRECT_RESOURCES[res]) f.redirect = REDIRECT_RESOURCES[res];
          else if (BLOCK_INSTEAD_OF_REDIRECT.has(res)) f.blockInsteadOfRedirect = true;
          else return skip(stats, 'networkSkipped', 'unknown-redirect-resource');
          break;
        }
        case 'empty':
          f.redirect = REDIRECT_RESOURCES.empty;
          break;
        case 'elemhide':
        case 'ehide':
          f.elemhide = true;
          f.cosmeticOnly = true;
          break;
        case 'generichide':
        case 'ghide':
          f.generichide = true;
          f.cosmeticOnly = true;
          break;
        case 'specifichide':
        case 'shide':
          f.specifichide = true;
          f.cosmeticOnly = true;
          break;
        case 'badfilter':
          f.badfilter = true;
          break;
        case '_':
        case '__':
        case 'reason':
          break;
        case 'redirect-rule':
          return skip(stats, 'networkSkipped', 'redirect-rule');
        case 'csp':
        case 'removeparam':
        case 'queryprune':
        case 'header':
        case 'permissions':
        case 'replace':
        case 'urltransform':
        case 'uritransform':
        case 'urlskip':
        case 'inline-script':
        case 'inline-font':
        case 'popunder':
        case 'genericblock':
        case 'sitekey':
        case 'webrtc':
        case 'cname':
        case 'ipaddress':
        case 'stealth':
        case 'cookie':
        case 'jsonprune':
        case 'hls':
        case 'network':
        case 'app':
        case 'extension':
        case 'content':
        case 'jsinject':
        case 'urlblock':
          return skip(stats, 'networkSkipped', `option-${name}`);
        default:
          return skip(stats, 'networkSkipped', 'unknown-option');
      }
    }
  }

  // Cosmetic exceptions ($elemhide / $generichide) carry no network meaning.
  if (f.cosmeticOnly && (f.types.size > 0 || f.popup || f.docException)) f.cosmeticOnly = false;
  if ((f.elemhide || f.generichide || f.specifichide) && !exception) {
    return skip(stats, 'networkSkipped', 'elemhide-on-block-filter');
  }

  if (regex === null) {
    const p = normalizeUrlPattern(pattern);
    if (p === null) return skip(stats, 'networkSkipped', 'bad-pattern');
    f.pattern = p;
  } else {
    if (/[^\x00-\x7f]/.test(regex)) return skip(stats, 'networkSkipped', 'non-ascii-regex');
  }

  // A filter with only "match everything" and no constraint would block the web.
  if (!exception && f.regex === null && f.pattern === '' && f.initiator.include.length === 0
    && f.request.include.length === 0 && !f.popup) {
    return skip(stats, 'networkSkipped', 'too-broad');
  }
  return f;
}

/** Hostname of a "||host^…" filter when the host is complete, else null. */
function anchoredHostname(urlFilter) {
  const m = /^\|\|([a-z0-9][a-z0-9\-_.]*)([\^/:?]|$)/.exec(urlFilter);
  if (!m || m[1].endsWith('.')) return null;
  return m[1];
}

/** Turns a parsed network filter into a DNR rule without id ("proto rule"), or null. */
function toProtoRule(f) {
  const condition = {};
  if (f.regex !== null) condition.regexFilter = f.regex;
  else if (f.pattern !== '') condition.urlFilter = f.pattern;
  if (f.matchCase && (condition.urlFilter || condition.regexFilter)) condition.isUrlFilterCaseSensitive = true;

  let action;
  let priority;
  let types = [...f.types];
  const negTypes = [...f.negTypes];

  if (f.exception && f.docException) {
    action = { type: 'allowAllRequests' };
    priority = PRIORITY.ALLOW;
    types = ['main_frame', 'sub_frame'];
  } else if (f.exception) {
    action = { type: 'allow' };
    priority = PRIORITY.ALLOW;
  } else if (f.redirect) {
    action = { type: 'redirect', redirect: { extensionPath: f.redirect } };
    priority = f.important ? PRIORITY.IMPORTANT_REDIRECT : PRIORITY.REDIRECT;
  } else {
    action = { type: 'block' };
    priority = f.important ? PRIORITY.IMPORTANT_BLOCK : PRIORITY.BLOCK;
  }

  if (types.length > 0) {
    const finalTypes = types.filter((t) => !f.negTypes.has(t));
    if (finalTypes.length === 0) return null;
    condition.resourceTypes = finalTypes.sort();
  } else if (negTypes.length > 0) {
    const excluded = new Set(negTypes);
    excluded.add('main_frame');
    if (NON_DOCUMENT_TYPES.every((t) => excluded.has(t))) return null;
    condition.excludedResourceTypes = [...excluded].sort();
  }

  if (f.party === 'third') condition.domainType = 'thirdParty';
  else if (f.party === 'first') condition.domainType = 'firstParty';

  if (f.initiator.include.length) condition.initiatorDomains = uniqueSorted(f.initiator.include);
  if (f.initiator.exclude.length) condition.excludedInitiatorDomains = uniqueSorted(f.initiator.exclude);
  if (f.request.include.length) condition.requestDomains = uniqueSorted(f.request.include);
  if (f.request.exclude.length) condition.excludedRequestDomains = uniqueSorted(f.request.exclude);
  if (f.methods.include.length) condition.requestMethods = uniqueSorted(f.methods.include);
  if (f.methods.exclude.length) condition.excludedRequestMethods = uniqueSorted(f.methods.exclude);

  if (action.type === 'allowAllRequests' && condition.domainType) delete condition.domainType;

  return { priority, action, condition };
}

/* ------------------------------------------------------------------------- */
/* Cosmetic filters                                                           */
/* ------------------------------------------------------------------------- */

function emptyCosmetic() {
  return {
    genericClasses: new Set(),
    genericIds: new Set(),
    genericComplex: new Set(),
    genericExcluded: new Map(), // selector → Set(excluded hosts)
    specific: new Map(), // host → Map(selector → Set(excluded) | null)
    exceptions: new Map(), // host → Set(selector)
    genericExceptions: new Set(),
    styles: new Map(), // host → Map(selector → decls)
    procedural: new Map(), // host → Map(json → plan)
    elemhide: new Set(),
    generichide: new Set(),
    specifichide: new Set(),
  };
}

function addToMapSet(map, key, value) {
  let s = map.get(key);
  if (!s) { s = new Set(); map.set(key, s); }
  s.add(value);
}

const SIMPLE_CLASS_RE = /^\.([A-Za-z_][\w-]*)$/;
const SIMPLE_ID_RE = /^#([A-Za-z_][\w-]*)$/;

function plainSelectorLooksValid(sel) {
  if (PLAIN_SELECTOR_BAD.test(sel)) return false;
  // Balanced brackets / parentheses / quotes (cheap sanity check; the build tool
  // runs a real CSS parser on top of this).
  let paren = 0;
  let bracket = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '\\') { i++; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      for (i++; i < sel.length && sel[i] !== q; i++) if (sel[i] === '\\') i++;
      if (i >= sel.length) return false;
      continue;
    }
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    if (paren < 0 || bracket < 0) return false;
  }
  return paren === 0 && bracket === 0;
}

function parseScriptletArgs(inner) {
  const args = [];
  let cur = '';
  let quote = null;
  let i = 0;
  // Leading whitespace of each argument is ignored; quotes (', ", `) protect commas.
  const pushArg = () => { args.push(cur.trim()); cur = ''; };
  for (; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === '\\' && inner[i + 1] === quote) { cur += quote; i++; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
      continue;
    }
    if (c === '\\' && inner[i + 1] === ',') { cur += ','; i++; continue; }
    if ((c === '"' || c === "'" || c === '`') && cur.trim() === '') { quote = c; cur = ''; continue; }
    if (c === ',') { pushArg(); continue; }
    cur += c;
  }
  if (quote) return null;
  pushArg();
  return args;
}

/* ------------------------------------------------------------------------- */
/* Main entry point                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Parses a filter list.
 * @returns {{ network: object[], cosmetic: object, scriptlets: Map, scriptletExceptions: Map,
 *             popups: object[], stats: object }}
 */
export function parseFilterList(text, { allowGenericScriptlets = false } = {}) {
  const stats = newStats();
  const network = [];
  const badfilters = new Set();
  const cosmetic = emptyCosmetic();
  const scriptlets = new Map(); // host → Map(json → [name, ...args])
  const scriptletExceptions = new Map(); // host → Set(json | '*')
  const popups = [];

  const lines = text.split(/\r?\n/);
  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    stats.lines += 1;
    if (line.startsWith('!') || (line.startsWith('[') && line.endsWith(']'))) {
      stats.comments += 1;
      continue;
    }
    if (line.startsWith('#') && !/^#@?(?:\$\?|[?$%])?#/.test(line)) {
      stats.comments += 1; // hosts-file style comment
      continue;
    }

    const skippedBefore = stats.networkSkipped + stats.cosmeticSkipped + stats.scriptletsSkipped;
    const noteSkipped = () => {
      if (stats.skippedSamples.length < 5
        && stats.networkSkipped + stats.cosmeticSkipped + stats.scriptletsSkipped > skippedBefore) {
        stats.skippedSamples.push(line);
      }
    };

    const cm = COSMETIC_RE.exec(line);
    if (cm) {
      parseCosmeticLine(cm[1], cm[2], cm[3], { cosmetic, scriptlets, scriptletExceptions, stats, allowGenericScriptlets });
      noteSkipped();
      continue;
    }
    if (/^[^\s/|^]*\$@?\$/.test(line) && !line.includes('##')) {
      skip(stats, 'cosmeticSkipped', 'html-filtering');
      noteSkipped();
      continue;
    }

    // Plain hosts-file lines ("0.0.0.0 ads.example.com") → ||host^
    const hostsLine = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([\w.-]+)\s*$/.exec(line);
    const filterText = hostsLine ? `||${hostsLine[1]}^` : line;

    const f = parseNetworkFilter(filterText, stats);
    if (!f) {
      noteSkipped();
      continue;
    }
    if (f.badfilter) {
      badfilters.add(stripBadfilter(filterText));
      continue;
    }
    stats.network += 1;
    network.push(f);
  }

  const filtered = badfilters.size === 0 ? network : network.filter((f) => !badfilters.has(f.raw));

  // Split network filters into DNR rules, popup filters and cosmetic exceptions.
  const protoRules = [];
  for (const f of filtered) {
    if (f.elemhide || f.generichide || f.specifichide || f.docException) {
      const host = anchoredHostname(f.pattern || '');
      if (host && (f.pattern === `||${host}^` || f.pattern === `||${host}` || f.pattern === `||${host}/`)) {
        if (f.elemhide || f.docException) cosmetic.elemhide.add(host);
        if (f.generichide) cosmetic.generichide.add(host);
        if (f.specifichide) cosmetic.specifichide.add(host);
      }
      if (f.cosmeticOnly) continue;
    }
    if (f.popup) {
      const entry = popupEntry(f);
      if (entry) {
        popups.push(entry);
        stats.popup += 1;
      }
      // "$popup" alone does not apply to network requests.
      if (f.types.size === 0) continue;
    }
    if (f.blockInsteadOfRedirect) f.redirect = null;
    const proto = toProtoRule(f);
    if (proto) protoRules.push(proto);
  }

  return { network: protoRules, cosmetic, scriptlets, scriptletExceptions, popups, stats };
}

function popupEntry(f) {
  const e = { x: f.exception ? 1 : 0 };
  if (f.regex !== null) {
    e.re = f.regex;
  } else if (f.pattern === '') {
    e.re = '';
  } else {
    const m = PURE_HOST_RE.exec(f.pattern);
    if (m) e.h = m[1];
    else e.re = patternToRegExpSource(f.pattern);
  }
  if (!f.matchCase && e.re) e.i = 1;
  if (f.initiator.include.length) e.inc = uniqueSorted(f.initiator.include);
  if (f.initiator.exclude.length) e.exc = uniqueSorted(f.initiator.exclude);
  if (f.party) e.p = f.party === 'third' ? 3 : 1;
  // A domain-less "match all" popup filter would close every new tab.
  if (e.re === '' && !e.inc) return null;
  return e;
}

function parseCosmeticLine(domainText, sep, body, ctx) {
  const { cosmetic, scriptlets, scriptletExceptions, stats } = ctx;
  const exception = sep.includes('@');
  const kind = sep.replace('@', ''); // ##, #?#, #$#, #%#, #$?#

  if (domainText.startsWith('[')) return skip(stats, 'cosmeticSkipped', 'adguard-modifiers');
  const d = parseDomainList(domainText, ',');
  if (d.invalid > 0 && d.include.length === 0 && d.exclude.length === 0) {
    return skip(stats, 'cosmeticSkipped', 'bad-domains');
  }

  if (kind === '##' && body.startsWith('+js(')) {
    return parseScriptletLine(d, exception, body, ctx);
  }
  if (kind === '#%#') return skip(stats, 'cosmeticSkipped', 'unsupported-#%#');
  if (body.startsWith('^')) return skip(stats, 'cosmeticSkipped', 'html-filtering');

  let selector = body.trim();
  if (selector === '') return skip(stats, 'cosmeticSkipped', 'empty-selector');

  // "selector { declarations }" — CSS injection (AdGuard/ABP syntax, also found in EasyList).
  let injectedStyle = null;
  let injectedRemove = false;
  const inj = /^(.*?)\s*\{([^{}]*)\}$/.exec(selector);
  if (inj) {
    selector = inj[1].trim();
    const decls = inj[2].trim();
    if (/^remove\s*:\s*true\s*;?$/i.test(decls)) {
      injectedRemove = true;
    } else {
      injectedStyle = sanitizeStyle(decls);
      if (!injectedStyle) return skip(stats, 'cosmeticSkipped', 'unsafe-style');
    }
    if (selector === '') return skip(stats, 'cosmeticSkipped', 'empty-selector');
  } else if (kind === '#$#' || kind === '#$?#') {
    return skip(stats, 'cosmeticSkipped', 'unsupported-snippet');
  }
  if (kind === '#?#' || kind === '#$?#') selector = normalizeExtendedSelector(selector);

  let plan = null;
  let styleDecls = injectedStyle;
  if (hasProceduralOperator(selector)) {
    plan = compileProcedural(selector);
    if (!plan) return skip(stats, 'cosmeticSkipped', 'unsupported-procedural');
    if (plan.a && (injectedStyle || injectedRemove)) return skip(stats, 'cosmeticSkipped', 'double-action');
    if (injectedRemove) plan.a = ['remove'];
    else if (injectedStyle) plan.a = ['style', injectedStyle];
    if (planIsPlainCss(plan)) {
      selector = plan.t[0][1];
      styleDecls = plan.a ? plan.a[1] : null;
      plan = null;
    }
  } else if (injectedRemove) {
    plan = { t: [['css', selector]], a: ['remove'] };
  }
  if (!plan && !plainSelectorLooksValid(selector)) return skip(stats, 'cosmeticSkipped', 'bad-selector');

  const generic = d.include.length === 0;

  if (exception) {
    if (plan || styleDecls) return skip(stats, 'cosmeticSkipped', 'procedural-exception');
    if (generic) {
      if (d.exclude.length > 0) return skip(stats, 'cosmeticSkipped', 'negated-generic-exception');
      cosmetic.genericExceptions.add(selector);
    } else {
      for (const h of d.include) addToMapSet(cosmetic.exceptions, h, selector);
    }
    stats.cosmetic += 1;
    return null;
  }

  if (plan || styleDecls) {
    if (generic) return skip(stats, 'cosmeticSkipped', plan ? 'generic-procedural' : 'generic-style');
    for (const h of d.include) {
      if (plan) {
        let m = cosmetic.procedural.get(h);
        if (!m) { m = new Map(); cosmetic.procedural.set(h, m); }
        const p = d.exclude.length ? { ...plan, x: uniqueSorted(d.exclude) } : plan;
        m.set(JSON.stringify(p), p);
      } else {
        let m = cosmetic.styles.get(h);
        if (!m) { m = new Map(); cosmetic.styles.set(h, m); }
        m.set(selector, styleDecls);
      }
    }
    stats.cosmetic += 1;
    if (plan) stats.procedural += 1;
    return null;
  }

  if (generic) {
    if (d.exclude.length > 0) {
      let ex = cosmetic.genericExcluded.get(selector);
      if (!ex) { ex = new Set(); cosmetic.genericExcluded.set(selector, ex); }
      for (const h of d.exclude) ex.add(h);
    } else {
      const cls = SIMPLE_CLASS_RE.exec(selector);
      const id = SIMPLE_ID_RE.exec(selector);
      if (cls) cosmetic.genericClasses.add(cls[1]);
      else if (id) cosmetic.genericIds.add(id[1]);
      else cosmetic.genericComplex.add(selector);
    }
  } else {
    for (const h of d.include) {
      let m = cosmetic.specific.get(h);
      if (!m) { m = new Map(); cosmetic.specific.set(h, m); }
      if (d.exclude.length) {
        const prev = m.get(selector);
        if (prev === null) continue; // already unconditional
        const ex = prev || new Set();
        for (const x of d.exclude) ex.add(x);
        m.set(selector, ex);
      } else {
        m.set(selector, null);
      }
    }
  }
  stats.cosmetic += 1;
  return null;
}

function parseScriptletLine(d, exception, body, ctx) {
  const { scriptlets, scriptletExceptions, stats, allowGenericScriptlets } = ctx;
  if (!body.endsWith(')')) return skip(stats, 'scriptletsSkipped', 'bad-scriptlet');
  const inner = body.slice(4, -1);
  if (exception && inner.trim() === '') {
    for (const h of d.include) addToMapSet(scriptletExceptions, h, '*');
    stats.scriptlets += 1;
    return null;
  }
  const args = parseScriptletArgs(inner);
  if (!args || args.length === 0 || args[0] === '') return skip(stats, 'scriptletsSkipped', 'bad-scriptlet');
  const rawName = args[0].replace(/\.js$/, '').toLowerCase();
  const name = SCRIPTLET_ALIASES[rawName];
  if (!name) return skip(stats, 'scriptletsSkipped', `scriptlet-${rawName.startsWith('trusted-') ? 'trusted' : 'unsupported'}`);
  // Trailing empty arguments are not significant.
  while (args.length > 1 && args[args.length - 1] === '') args.pop();
  const call = [name, ...args.slice(1)];
  const key = JSON.stringify(call);

  if (exception) {
    for (const h of d.include) addToMapSet(scriptletExceptions, h, key);
    stats.scriptlets += 1;
    return null;
  }
  const hosts = d.include.filter((h) => !h.endsWith('.*'));
  if (d.include.length === 0) {
    if (!allowGenericScriptlets) return skip(stats, 'scriptletsSkipped', 'generic-scriptlet');
    hosts.push('*');
  }
  if (hosts.length === 0) return skip(stats, 'scriptletsSkipped', 'entity-only-scriptlet');
  for (const h of hosts) {
    let m = scriptlets.get(h);
    if (!m) { m = new Map(); scriptlets.set(h, m); }
    m.set(key, call);
  }
  for (const h of d.exclude) addToMapSet(scriptletExceptions, h, key);
  stats.scriptlets += 1;
  return null;
}

/* ------------------------------------------------------------------------- */
/* Network rule compilation (merging, subsumption, ids)                       */
/* ------------------------------------------------------------------------- */

function isAllowAction(rule) {
  return rule.action.type === 'allow' || rule.action.type === 'allowAllRequests';
}

/** Drops hosts that are subdomains of other hosts in the same list. */
function collapseHosts(hosts) {
  const set = new Set(hosts);
  return [...set].filter((h) => {
    let i = h.indexOf('.');
    while (i !== -1) {
      if (set.has(h.slice(i + 1))) return false;
      i = h.indexOf('.', i + 1);
    }
    return true;
  }).sort();
}

function coveredBy(host, set) {
  let h = host;
  for (;;) {
    if (set.has(h)) return true;
    const i = h.indexOf('.');
    if (i === -1) return false;
    h = h.slice(i + 1);
  }
}

/**
 * Merges and de-duplicates proto rules, assigns ids.
 * Returns { rules, regexRules, allowMaxId } — regex rules are kept apart because Chrome
 * refuses to load a static ruleset containing a single regex it cannot compile; they are
 * validated with isRegexSupported() at runtime instead.
 */
export function compileNetworkRules(protoRules, { startId = 1 } = {}) {
  const regexRules = [];
  const groups = new Map(); // merge key → { proto, hosts:Set }
  const others = new Map(); // json → proto

  for (const proto of protoRules) {
    const c = proto.condition;
    if (c.regexFilter !== undefined) {
      regexRules.push(proto);
      continue;
    }
    const m = c.urlFilter ? PURE_HOST_RE.exec(c.urlFilter) : null;
    if (m && !c.requestDomains && !c.excludedRequestDomains && m[1].includes('.')) {
      const { urlFilter, isUrlFilterCaseSensitive, ...rest } = c;
      const key = JSON.stringify({ p: proto.priority, a: proto.action, c: rest });
      let g = groups.get(key);
      if (!g) {
        g = { proto: { priority: proto.priority, action: proto.action, condition: rest }, hosts: new Set() };
        groups.set(key, g);
      }
      g.hosts.add(m[1]);
      continue;
    }
    others.set(JSON.stringify(proto), proto);
  }

  // Hosts blocked unconditionally (no other condition at all).
  const unconditional = new Set();
  for (const g of groups.values()) {
    if (g.proto.action.type === 'block' && g.proto.priority === PRIORITY.BLOCK
      && Object.keys(g.proto.condition).length === 0) {
      for (const h of g.hosts) unconditional.add(h);
    }
  }

  const subsumable = (proto) => proto.action.type === 'block' && proto.priority === PRIORITY.BLOCK;

  const merged = [];
  for (const g of groups.values()) {
    let hosts = collapseHosts([...g.hosts]);
    const isUnconditional = subsumable(g.proto) && Object.keys(g.proto.condition).length === 0;
    if (subsumable(g.proto) && !isUnconditional) hosts = hosts.filter((h) => !coveredBy(h, unconditional));
    if (hosts.length === 0) continue;
    merged.push({ ...g.proto, condition: { requestDomains: hosts, ...g.proto.condition } });
  }
  for (const proto of others.values()) {
    if (subsumable(proto) && proto.condition.urlFilter) {
      const host = anchoredHostname(proto.condition.urlFilter);
      if (host && coveredBy(host, unconditional)) continue;
    }
    merged.push(proto);
  }

  // Allow rules first so the popup can tell blocks from exceptions by id.
  merged.sort((a, b) => Number(isAllowAction(b)) - Number(isAllowAction(a)));
  let id = startId;
  let allowMaxId = startId - 1;
  const rules = merged.map((proto) => {
    const rule = { id: id++, priority: proto.priority, action: proto.action, condition: proto.condition };
    if (isAllowAction(rule)) allowMaxId = rule.id;
    return rule;
  });
  return { rules, regexRules, allowMaxId };
}

/* ------------------------------------------------------------------------- */
/* Serialisation helpers for cosmetic data                                    */
/* ------------------------------------------------------------------------- */

/** Converts the in-memory cosmetic accumulator into compact JSON. */
export function serializeCosmetic(c, { validateSelector } = {}) {
  const ok = validateSelector || (() => true);
  const out = {
    genericClasses: [...c.genericClasses].sort(),
    genericIds: [...c.genericIds].sort(),
    genericComplex: [...c.genericComplex].filter(ok).sort(),
    genericExcluded: [...c.genericExcluded].filter(([s]) => ok(s)).map(([s, ex]) => [s, [...ex].sort()]),
    specific: {},
    exceptions: {},
    genericExceptions: [...c.genericExceptions].sort(),
    styles: {},
    procedural: {},
    elemhide: [...c.elemhide].sort(),
    generichide: [...c.generichide].sort(),
    specifichide: [...c.specifichide].sort(),
  };
  for (const [h, m] of [...c.specific].sort()) {
    const list = [];
    for (const [sel, ex] of m) {
      if (!ok(sel)) continue;
      list.push(ex ? [sel, [...ex].sort()] : sel);
    }
    if (list.length) out.specific[h] = list;
  }
  for (const [h, s] of [...c.exceptions].sort()) out.exceptions[h] = [...s].sort();
  for (const [h, m] of [...c.styles].sort()) {
    const list = [...m].filter(([sel]) => ok(sel));
    if (list.length) out.styles[h] = list;
  }
  for (const [h, m] of [...c.procedural].sort()) out.procedural[h] = [...m.values()];
  return out;
}

export function serializeScriptlets(scriptlets, exceptions) {
  const data = {};
  for (const [h, m] of [...scriptlets].sort()) data[h] = [...m.values()];
  const exc = {};
  for (const [h, s] of [...exceptions].sort()) exc[h] = [...s].map((k) => (k === '*' ? '*' : JSON.parse(k)));
  return { data, exceptions: exc };
}
