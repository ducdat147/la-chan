/*
 * Lá Chắn — scriptlet runtime.
 *
 * Runs in the page's MAIN world at document_start, on the hosts a filter list
 * targets with "##+js(...)" filters. It is a compact re-implementation of the
 * most used uBlock Origin scriptlets. tools/build-filters.mjs wraps this
 * function together with the list's data into extension/scriptlets/<list>.js.
 *
 * This file is a template: it is not loaded by the extension directly.
 */
function lachanScriptlets(DATA, EXCEPTIONS) {
  'use strict';

  const hostname = location.hostname || (() => {
    try { return new URL(document.referrer || location.ancestorOrigins?.[0] || '').hostname; } catch { return ''; }
  })();
  if (!hostname) return;

  /* ---------------------------------------------------------------- helpers */

  const COMMON_SLD = new Set(['ac', 'biz', 'co', 'com', 'edu', 'gov', 'go', 'gob', 'gv', 'info', 'int',
    'ltd', 'me', 'mil', 'name', 'ne', 'net', 'nic', 'or', 'org', 'pro', 'web']);

  const hostnameKeys = (h) => {
    const keys = [];
    let s = h;
    for (;;) {
      keys.push(s);
      const labels = s.split('.');
      if (labels.length >= 2) {
        keys.push(`${labels.slice(0, -1).join('.')}.*`);
        if (labels.length >= 3 && COMMON_SLD.has(labels[labels.length - 2])) {
          keys.push(`${labels.slice(0, -2).join('.')}.*`);
        }
      }
      const dot = s.indexOf('.');
      if (dot === -1) break;
      s = s.slice(dot + 1);
    }
    return keys;
  };

  const isObject = (v) => v !== null && (typeof v === 'object' || typeof v === 'function');

  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** uBO pattern semantics: "/re/flags" is a regex, anything else a literal substring. */
  const toRegExp = (pattern, defaultFlags = '') => {
    if (pattern === '' || pattern === undefined) return /^/;
    const m = /^\/(.+)\/([gimsu]*)$/.exec(pattern);
    if (m) {
      try { return new RegExp(m[1], m[2] || defaultFlags); } catch { return /(?!)/; }
    }
    return new RegExp(escapeRegex(pattern), defaultFlags);
  };

  /** Pattern with optional leading "!" negation → { re, not }. */
  const toNeedle = (pattern = '') => {
    let not = false;
    let p = pattern;
    if (p.startsWith('!')) { not = true; p = p.slice(1); }
    return { re: toRegExp(p), not, empty: p === '' };
  };

  const fnToString = Function.prototype.toString;
  const describe = (v) => {
    try {
      if (typeof v === 'function') return fnToString.call(v);
      return String(v);
    } catch {
      return '';
    }
  };

  const ERROR_TOKEN = `lachan${Math.random().toString(36).slice(2)}`;
  let onErrorPatched = false;
  const patchOnError = () => {
    if (onErrorPatched) return;
    onErrorPatched = true;
    window.addEventListener('error', (ev) => {
      if (typeof ev.message === 'string' && ev.message.includes(ERROR_TOKEN)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    }, true);
    const prev = window.onerror;
    window.onerror = function onerror(msg, ...rest) {
      if (typeof msg === 'string' && msg.includes(ERROR_TOKEN)) return true;
      if (typeof prev === 'function') return prev.call(this, msg, ...rest);
      return false;
    };
  };
  const abort = () => {
    patchOnError();
    throw new ReferenceError(ERROR_TOKEN);
  };

  const parseConstant = (raw) => {
    switch (raw) {
      case 'undefined': return { v: undefined };
      case 'false': return { v: false };
      case 'true': return { v: true };
      case 'null': return { v: null };
      case "''": case 'emptyStr': return { v: '' };
      case '[]': case 'emptyArr': return { v: [] };
      case '{}': case 'emptyObj': return { v: {} };
      case 'noopFunc': return { v: function noop() {} };
      case 'trueFunc': return { v: function t() { return true; } };
      case 'falseFunc': return { v: function f() { return false; } };
      case 'throwFunc': return { v: function th() { throw new Error(); } };
      case 'noopCallbackFunc': return { v: function cb() { return function noop() {}; } };
      case 'noopPromiseResolve': return { v: function pr() { return Promise.resolve(); } };
      case 'noopPromiseReject': return { v: function pj() { return Promise.reject(); } };
      case 'yes': case 'no': case 'on': case 'off': case 'accepted': case 'rejected':
        return { v: raw };
      default:
        if (/^-?\d+$/.test(raw)) {
          const n = Number(raw);
          return Math.abs(n) <= 0x7FFF ? { v: n } : null;
        }
        return null;
    }
  };

  /**
   * Installs `leaf(owner, prop)` on the property named by `chain` ("a.b.c"),
   * waiting for intermediate objects that do not exist yet.
   */
  const onChain = (owner, chain, leaf) => {
    const pos = chain.indexOf('.');
    if (pos === -1) { leaf(owner, chain); return; }
    const prop = chain.slice(0, pos);
    const rest = chain.slice(pos + 1);
    let current;
    try { current = owner[prop]; } catch { return; }
    if (isObject(current)) { onChain(current, rest, leaf); return; }
    const desc = Object.getOwnPropertyDescriptor(owner, prop);
    if (desc && desc.configurable === false) return;
    const prevGet = desc && desc.get;
    const prevSet = desc && desc.set;
    let value = current;
    try {
      Object.defineProperty(owner, prop, {
        configurable: true,
        enumerable: true,
        get() { return prevGet ? prevGet.call(this) : value; },
        set(v) {
          if (prevSet) prevSet.call(this, v);
          value = v;
          if (isObject(v)) onChain(v, rest, leaf);
        },
      });
    } catch { /* ignore */ }
  };

  const whenReady = (fn) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  };

  const observeDom = (fn, stay) => {
    let timer = 0;
    const run = () => { timer = 0; try { fn(); } catch { /* ignore */ } };
    const observer = new MutationObserver(() => {
      if (timer === 0) timer = setTimeout(run, 50);
    });
    const start = () => {
      run();
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      if (!stay) {
        window.addEventListener('load', () => setTimeout(() => observer.disconnect(), 3000), { once: true });
      }
    };
    whenReady(start);
  };

  /* ------------------------------------------------------------ scriptlets */

  const SCRIPTLETS = {
    'set-constant'(chain = '', rawValue = '') {
      if (chain === '') return;
      const c = parseConstant(rawValue);
      if (c === null) return;
      const value = c.v;
      onChain(window, chain, (owner, prop) => {
        const desc = Object.getOwnPropertyDescriptor(owner, prop);
        if (desc && desc.configurable === false) return;
        const prevSet = desc && desc.set;
        try {
          Object.defineProperty(owner, prop, {
            configurable: true,
            enumerable: desc ? desc.enumerable : true,
            get() { return value; },
            set(v) { if (prevSet) prevSet.call(this, v); },
          });
        } catch { /* ignore */ }
      });
    },

    'abort-on-property-read'(chain = '') {
      if (chain === '') return;
      onChain(window, chain, (owner, prop) => {
        try {
          Object.defineProperty(owner, prop, { configurable: true, get: abort, set() {} });
        } catch { /* ignore */ }
      });
    },

    'abort-on-property-write'(chain = '') {
      if (chain === '') return;
      onChain(window, chain, (owner, prop) => {
        try {
          Object.defineProperty(owner, prop, { configurable: true, get() { return undefined; }, set: abort });
        } catch { /* ignore */ }
      });
    },

    'abort-current-script'(target = '', needle = '', context = '') {
      if (target === '') return;
      const reNeedle = toRegExp(needle, 's');
      const reContext = context === '' ? null : toRegExp(context);
      const thisScript = document.currentScript;
      const textOf = (el) => {
        const text = el.textContent;
        if (text.trim() !== '') return text;
        const m = /^data:[^,]*,(.+)$/.exec(el.src || '');
        if (!m) return el.src || '';
        try { return /;base64/.test(el.src.split(',')[0]) ? atob(m[1]) : decodeURIComponent(m[1]); } catch { return ''; }
      };
      const validate = () => {
        const el = document.currentScript;
        if (!(el instanceof HTMLScriptElement) || el === thisScript) return;
        if (reContext && !reContext.test(el.src || '')) return;
        if (!reNeedle.test(textOf(el))) return;
        abort();
      };
      onChain(window, target, (owner, prop) => {
        const desc = Object.getOwnPropertyDescriptor(owner, prop);
        if (desc && desc.configurable === false) return;
        let value = desc ? (desc.get ? undefined : desc.value) : undefined;
        const prevGet = desc && desc.get;
        const prevSet = desc && desc.set;
        try {
          Object.defineProperty(owner, prop, {
            configurable: true,
            get() { validate(); return prevGet ? prevGet.call(this) : value; },
            set(v) { validate(); if (prevSet) prevSet.call(this, v); else value = v; },
          });
        } catch { /* ignore */ }
      });
    },

    'add-event-listener-defuser'(type = '', pattern = '') {
      const reType = type === '' ? /^/ : toRegExp(type);
      const exactType = type !== '' && !type.startsWith('/') ? type : null;
      const reHandler = toRegExp(pattern, 's');
      const proto = EventTarget.prototype;
      proto.addEventListener = new Proxy(proto.addEventListener, {
        apply(target, thisArg, args) {
          const t = String(args[0]);
          const typeMatches = exactType !== null ? t === exactType : reType.test(t);
          if (typeMatches && reHandler.test(describe(args[1]))) return undefined;
          return Reflect.apply(target, thisArg, args);
        },
      });
    },

    'no-settimeout-if'(needle = '', delay = '') {
      SCRIPTLETS.$timer('setTimeout', needle, delay);
    },

    'no-setinterval-if'(needle = '', delay = '') {
      SCRIPTLETS.$timer('setInterval', needle, delay);
    },

    $timer(name, needle, delay) {
      const n = toNeedle(needle);
      let delayNot = false;
      let d = delay;
      if (d.startsWith('!')) { delayNot = true; d = d.slice(1); }
      const delayValue = d === '' ? null : Number(d);
      window[name] = new Proxy(window[name], {
        apply(target, thisArg, args) {
          const text = describe(args[0]);
          let defuse = n.empty ? !n.not : n.re.test(text) !== n.not;
          if (defuse && delayValue !== null) defuse = (Number(args[1]) === delayValue) !== delayNot;
          if (defuse) args[0] = function noop() {};
          return Reflect.apply(target, thisArg, args);
        },
      });
    },

    'json-prune'(rawPrune = '', rawNeedle = '') {
      const prunePaths = rawPrune.split(/ +/).filter(Boolean);
      const needlePaths = rawNeedle.split(/ +/).filter(Boolean);
      if (prunePaths.length === 0) return;

      const walk = (obj, segs, i, onLeaf) => {
        if (!isObject(obj)) return false;
        const s = segs[i];
        const last = i === segs.length - 1;
        if (s === '[]' || s === '*') {
          let hit = false;
          for (const k of Object.keys(obj)) {
            if (last) { onLeaf(obj, k); hit = true; } else if (walk(obj[k], segs, i + 1, onLeaf)) hit = true;
          }
          return hit;
        }
        if (!(s in obj)) return false;
        if (last) { onLeaf(obj, s); return true; }
        return walk(obj[s], segs, i + 1, onLeaf);
      };
      const has = (obj, path) => walk(obj, path.split('.'), 0, () => {});
      const prune = (obj) => {
        if (!isObject(obj)) return obj;
        if (needlePaths.length && !needlePaths.every((p) => has(obj, p))) return obj;
        for (const p of prunePaths) walk(obj, p.split('.'), 0, (o, k) => { try { delete o[k]; } catch { /* ignore */ } });
        return obj;
      };

      JSON.parse = new Proxy(JSON.parse, {
        apply(target, thisArg, args) { return prune(Reflect.apply(target, thisArg, args)); },
      });
      Response.prototype.json = new Proxy(Response.prototype.json, {
        apply(target, thisArg, args) { return Reflect.apply(target, thisArg, args).then(prune); },
      });
    },

    'no-window-open-if'(pattern = '', delay = '', decoy = '') {
      const n = toNeedle(pattern);
      const fake = new Proxy(function fakeWindow() {}, {
        get(target, prop) {
          if (prop === 'closed') return false;
          if (prop === 'opener' || prop === 'parent' || prop === 'top') return window;
          if (prop === Symbol.toPrimitive) return () => '';
          if (typeof prop === 'symbol' || prop === 'then') return undefined;
          return fake;
        },
        set() { return true; },
        apply() { return fake; },
      });
      window.open = new Proxy(window.open, {
        apply(target, thisArg, args) {
          const url = String(args[0] ?? '');
          const matched = n.empty ? !n.not : n.re.test(url) !== n.not;
          if (!matched) return Reflect.apply(target, thisArg, args);
          if (decoy === 'obj' || decoy === 'blank' || delay !== '') {
            const frame = document.createElement('iframe');
            frame.style.setProperty('display', 'none', 'important');
            frame.src = 'about:blank';
            (document.body || document.documentElement).appendChild(frame);
            const seconds = Number(delay) || 1;
            setTimeout(() => frame.remove(), seconds * 1000);
            return frame.contentWindow || fake;
          }
          return fake;
        },
      });
    },

    'remove-attr'(attrs = '', selector = '', behavior = '') {
      const names = attrs.split(/\s*\|\s*/).filter(Boolean);
      if (names.length === 0) return;
      const sel = selector || names.map((a) => `[${CSS.escape(a)}]`).join(',');
      observeDom(() => {
        for (const el of document.querySelectorAll(sel)) {
          for (const a of names) el.removeAttribute(a);
        }
      }, behavior.includes('stay'));
    },

    'remove-class'(classes = '', selector = '', behavior = '') {
      const names = classes.split(/\s*\|\s*/).filter(Boolean);
      if (names.length === 0) return;
      const sel = selector || names.map((c) => `.${CSS.escape(c)}`).join(',');
      observeDom(() => {
        for (const el of document.querySelectorAll(sel)) el.classList.remove(...names);
      }, behavior.includes('stay'));
    },

    'remove-node-text'(nodeName = '', condition = '') {
      if (nodeName === '') return;
      const reName = nodeName.startsWith('/') ? toRegExp(nodeName, 'i') : new RegExp(`^${escapeRegex(nodeName)}$`, 'i');
      const reCond = toRegExp(condition, 's');
      const handle = (node) => {
        if (!node || !reName.test(node.nodeName)) return;
        const text = node.textContent;
        if (text === '' || !reCond.test(text)) return;
        node.textContent = '';
      };
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            handle(node);
            if (node.nodeType === 3) handle(node.parentNode);
          }
        }
      });
      observer.observe(document, { childList: true, subtree: true });
      window.addEventListener('load', () => observer.disconnect(), { once: true });
    },

    'no-fetch-if'(props = '') {
      const needles = SCRIPTLETS.$parseProps(props);
      if (needles === null) return;
      window.fetch = new Proxy(window.fetch, {
        apply(target, thisArg, args) {
          let details;
          try {
            const req = args[0];
            const init = args[1] || {};
            details = {
              url: req instanceof Request ? req.url : String(req),
              method: String(init.method || (req instanceof Request ? req.method : 'GET')).toUpperCase(),
              body: typeof init.body === 'string' ? init.body : '',
            };
          } catch {
            return Reflect.apply(target, thisArg, args);
          }
          if (!SCRIPTLETS.$matchProps(needles, details)) return Reflect.apply(target, thisArg, args);
          return Promise.resolve(new Response('', { status: 200, statusText: 'OK' }));
        },
      });
    },

    'no-xhr-if'(props = '') {
      const needles = SCRIPTLETS.$parseProps(props);
      if (needles === null) return;
      const store = new WeakMap();
      const proto = XMLHttpRequest.prototype;
      proto.open = new Proxy(proto.open, {
        apply(target, thisArg, args) {
          store.set(thisArg, { method: String(args[0] || 'GET').toUpperCase(), url: String(args[1] || '') });
          return Reflect.apply(target, thisArg, args);
        },
      });
      proto.send = new Proxy(proto.send, {
        apply(target, thisArg, args) {
          const details = store.get(thisArg);
          if (!details || !SCRIPTLETS.$matchProps(needles, { ...details, body: typeof args[0] === 'string' ? args[0] : '' })) {
            return Reflect.apply(target, thisArg, args);
          }
          const define = (k, v) => { try { Object.defineProperty(thisArg, k, { value: v, configurable: true }); } catch { /* ignore */ } };
          define('readyState', 4);
          define('status', 200);
          define('statusText', 'OK');
          define('response', '');
          define('responseText', '');
          define('responseURL', details.url);
          setTimeout(() => {
            for (const type of ['readystatechange', 'load', 'loadend']) {
              try { thisArg.dispatchEvent(new Event(type)); } catch { /* ignore */ }
            }
          }, 1);
          return undefined;
        },
      });
    },

    $parseProps(props) {
      if (props === '') return null;
      const out = [];
      for (const part of props.split(/\s+/)) {
        if (part === '') continue;
        const m = /^(\w+):(.+)$/.exec(part);
        if (m && m[1] !== 'http' && m[1] !== 'https') out.push([m[1], toRegExp(m[2])]);
        else out.push(['url', toRegExp(part)]);
      }
      return out.length ? out : null;
    },

    $matchProps(needles, details) {
      for (const [key, re] of needles) {
        const v = details[key];
        if (v === undefined || !re.test(String(v))) return false;
      }
      return true;
    },

    'set-local-storage-item'(key = '', value = '') {
      SCRIPTLETS.$storage('localStorage', key, value);
    },

    'set-session-storage-item'(key = '', value = '') {
      SCRIPTLETS.$storage('sessionStorage', key, value);
    },

    $storage(which, key, value) {
      if (key === '') return;
      const allowed = {
        undefined: 'undefined', false: 'false', true: 'true', null: 'null', '{}': '{}', '[]': '[]',
        "''": '', '': '', emptyObj: '{}', emptyArr: '[]', yes: 'yes', no: 'no', on: 'on', off: 'off',
        accept: 'accept', accepted: 'accepted', reject: 'reject', rejected: 'rejected',
      };
      try {
        const storage = window[which];
        if (value === '$remove$') { storage.removeItem(key); return; }
        let v;
        if (Object.prototype.hasOwnProperty.call(allowed, value)) v = allowed[value];
        else if (/^\d+$/.test(value) && Number(value) <= 0x7FFF) v = value;
        else return;
        storage.setItem(key, v);
      } catch { /* storage disabled */ }
    },

    'noeval-if'(needle = '') {
      const re = toRegExp(needle);
      window.eval = new Proxy(window.eval, {
        apply(target, thisArg, args) {
          if (re.test(String(args[0]))) return undefined;
          return Reflect.apply(target, thisArg, args);
        },
      });
    },
  };

  /* ----------------------------------------------------------------- runner */

  const keys = hostnameKeys(hostname);
  const calls = new Map();
  for (const key of ['*', ...keys]) {
    const list = DATA[key];
    if (list) for (const call of list) calls.set(JSON.stringify(call), call);
  }
  for (const key of keys) {
    const list = EXCEPTIONS[key];
    if (!list) continue;
    for (const ex of list) {
      if (ex === '*') return;
      calls.delete(JSON.stringify(ex));
    }
  }
  for (const [name, ...args] of calls.values()) {
    const fn = SCRIPTLETS[name];
    if (typeof fn !== 'function' || name.startsWith('$')) continue;
    try {
      fn(...args);
    } catch { /* a broken scriptlet must never break the page */ }
  }
}
