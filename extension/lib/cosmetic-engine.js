// Element-hiding engine used by the service worker. Merges the cosmetic data of the
// enabled lists and answers "what should be hidden on <hostname>?".

import { hostnameKeys } from './hosts.js';

const CHUNK = 40;

/** "a,b,c{display:none!important}" in chunks so one bad selector cannot void the rest. */
export function hideCss(selectors, chunk = CHUNK) {
  let css = '';
  for (let i = 0; i < selectors.length; i += chunk) {
    css += `${selectors.slice(i, i + chunk).join(',\n')}\n{display:none!important}\n`;
  }
  return css;
}

/** One rule per selector (for unvalidated user selectors). */
export function hideCssEach(selectors) {
  return selectors.map((s) => `${s}{display:none!important}`).join('\n');
}

export function styleCss(pairs) {
  return pairs.map(([sel, decls]) => `${sel}{${decls}}`).join('\n');
}

function excludedFor(keys, excluded) {
  if (!excluded) return false;
  for (const k of keys) if (excluded.has(k)) return true;
  return false;
}

export class CosmeticEngine {
  constructor(datasets = []) {
    this.classes = new Set();
    this.ids = new Set();
    this.complex = new Set();
    this.genericExcluded = new Map(); // selector → Set(hosts)
    this.specific = new Map(); // host → Map(selector → Set(excluded) | null)
    this.exceptions = new Map(); // host → Set(selector)
    this.genericExceptions = new Set();
    this.styles = new Map(); // host → [[selector, decls]]
    this.procedural = new Map(); // host → [plan]
    this.elemhide = new Set();
    this.generichide = new Set();
    this.specifichide = new Set();
    this.userSelectors = new Set(); // selectors that came from the user's own filters
    this.cache = new Map();
    this.baseGenericCss = null;
    for (const d of datasets) this.add(d);
  }

  add(data, { user = false } = {}) {
    for (const c of data.genericClasses || []) this.classes.add(c);
    for (const i of data.genericIds || []) this.ids.add(i);
    for (const s of data.genericComplex || []) {
      this.complex.add(s);
      if (user) this.userSelectors.add(s);
    }
    for (const [sel, hosts] of data.genericExcluded || []) {
      let set = this.genericExcluded.get(sel);
      if (!set) { set = new Set(); this.genericExcluded.set(sel, set); }
      for (const h of hosts) set.add(h);
      if (user) this.userSelectors.add(sel);
    }
    for (const [host, entries] of Object.entries(data.specific || {})) {
      let m = this.specific.get(host);
      if (!m) { m = new Map(); this.specific.set(host, m); }
      for (const e of entries) {
        const [sel, ex] = typeof e === 'string' ? [e, null] : e;
        if (user) this.userSelectors.add(sel);
        if (ex === null) { m.set(sel, null); continue; }
        const prev = m.get(sel);
        if (prev === null) continue;
        const set = prev || new Set();
        for (const h of ex) set.add(h);
        m.set(sel, set);
      }
    }
    for (const [host, sels] of Object.entries(data.exceptions || {})) {
      let s = this.exceptions.get(host);
      if (!s) { s = new Set(); this.exceptions.set(host, s); }
      for (const sel of sels) s.add(sel);
    }
    for (const sel of data.genericExceptions || []) this.genericExceptions.add(sel);
    for (const [host, pairs] of Object.entries(data.styles || {})) {
      const list = this.styles.get(host) || [];
      list.push(...pairs);
      this.styles.set(host, list);
    }
    for (const [host, plans] of Object.entries(data.procedural || {})) {
      const list = this.procedural.get(host) || [];
      list.push(...plans);
      this.procedural.set(host, list);
    }
    for (const h of data.elemhide || []) this.elemhide.add(h);
    for (const h of data.generichide || []) this.generichide.add(h);
    for (const h of data.specifichide || []) this.specifichide.add(h);
    this.cache.clear();
    this.baseGenericCss = null;
  }

  get counts() {
    let specific = 0;
    for (const m of this.specific.values()) specific += m.size;
    return {
      generic: this.classes.size + this.ids.size + this.complex.size,
      specific,
      hosts: this.specific.size,
    };
  }

  /** CSS for the generic complex selectors (shared by every page without exceptions). */
  genericCssFor(keys, exceptions) {
    const base = !exceptions || exceptions.size === 0;
    if (base && this.baseGenericCss !== null) return this.baseGenericCss;
    const lists = [];
    const user = [];
    for (const sel of this.complex) {
      if (this.genericExceptions.has(sel) || (exceptions && exceptions.has(sel))) continue;
      (this.userSelectors.has(sel) ? user : lists).push(sel);
    }
    for (const [sel, excluded] of this.genericExcluded) {
      if (this.genericExceptions.has(sel) || (exceptions && exceptions.has(sel))) continue;
      if (excludedFor(keys, excluded)) continue;
      (this.userSelectors.has(sel) ? user : lists).push(sel);
    }
    const css = hideCss(lists) + hideCssEach(user);
    // genericExcluded depends on the host, so only cache when there is none.
    if (base && this.genericExcluded.size === 0) this.baseGenericCss = css;
    return css;
  }

  /**
   * Everything that applies to `hostname`:
   * { elemhide, generic, css, procedural, exceptions(Set) }
   */
  lookup(hostname) {
    const cached = this.cache.get(hostname);
    if (cached) return cached;

    const keys = hostnameKeys(hostname);
    const result = { elemhide: false, generic: true, css: '', procedural: [], exceptions: new Set() };
    if (keys.some((k) => this.elemhide.has(k))) {
      result.elemhide = true;
      result.generic = false;
      return this.remember(hostname, result);
    }
    const generichide = keys.some((k) => this.generichide.has(k));
    const specifichide = keys.some((k) => this.specifichide.has(k));

    const exceptions = result.exceptions;
    for (const k of keys) {
      const s = this.exceptions.get(k);
      if (s) for (const sel of s) exceptions.add(sel);
    }
    for (const sel of this.genericExceptions) exceptions.add(sel);

    const specific = [];
    const user = [];
    const styles = [];
    if (!specifichide) {
      for (const k of keys) {
        const m = this.specific.get(k);
        if (!m) continue;
        for (const [sel, excluded] of m) {
          if (exceptions.has(sel) || excludedFor(keys, excluded)) continue;
          (this.userSelectors.has(sel) ? user : specific).push(sel);
        }
      }
      for (const k of keys) {
        const pairs = this.styles.get(k);
        if (pairs) styles.push(...pairs);
        const plans = this.procedural.get(k);
        if (plans) {
          for (const p of plans) {
            if (p.x && excludedFor(keys, new Set(p.x))) continue;
            result.procedural.push(p);
          }
        }
      }
    }

    let css = hideCss(specific) + hideCssEach(user) + styleCss(styles);
    if (generichide) {
      result.generic = false;
    } else {
      // Host-specific exceptions only matter for the generic CSS if they name a generic selector.
      let relevant = null;
      for (const sel of exceptions) {
        if (this.genericExceptions.has(sel)) continue;
        if (this.complex.has(sel) || this.genericExcluded.has(sel)) {
          relevant = relevant || new Set();
          relevant.add(sel);
        }
      }
      css += this.genericCssFor(keys, relevant);
    }
    result.css = css;
    return this.remember(hostname, result);
  }

  remember(hostname, result) {
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(hostname, result);
    return result;
  }

  /** Generic class/id selectors present on the page, minus exceptions for the host. */
  matchGeneric(hostname, classes = [], ids = []) {
    const { exceptions, generic } = this.lookup(hostname);
    if (!generic) return [];
    const out = [];
    for (const c of classes) {
      if (typeof c !== 'string' || !this.classes.has(c)) continue;
      const sel = `.${c}`;
      if (!exceptions.has(sel)) out.push(sel);
    }
    for (const i of ids) {
      if (typeof i !== 'string' || !this.ids.has(i)) continue;
      const sel = `#${i}`;
      if (!exceptions.has(sel)) out.push(sel);
    }
    return out;
  }
}
