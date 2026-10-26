// Decides whether a newly opened tab/window is an advertising pop-up, using the
// "$popup" filters of the enabled lists. Evaluated in the service worker.

import { hostnameFromURL, hostnameSuffixes, hostnameMatchesAny, siteOf } from './hosts.js';

export class PopupMatcher {
  constructor(entryLists = []) {
    this.block = { hosts: new Map(), patterns: [] };
    this.allow = { hosts: new Map(), patterns: [] };
    this.size = 0;
    for (const entries of entryLists) for (const e of entries) this.add(e);
  }

  add(entry) {
    const bucket = entry.x ? this.allow : this.block;
    if (entry.h) {
      const list = bucket.hosts.get(entry.h) || [];
      list.push(entry);
      bucket.hosts.set(entry.h, list);
    } else {
      let re = null;
      if (entry.re) {
        try {
          re = new RegExp(entry.re, entry.i ? 'i' : '');
        } catch {
          return;
        }
      }
      bucket.patterns.push({ ...entry, compiled: re });
    }
    this.size++;
  }

  static constraintsOk(entry, sourceHost, targetHost) {
    if (entry.inc && !(sourceHost && hostnameMatchesAny(sourceHost, entry.inc))) return false;
    if (entry.exc && sourceHost && hostnameMatchesAny(sourceHost, entry.exc)) return false;
    if (entry.p) {
      const third = !sourceHost || siteOf(sourceHost) !== siteOf(targetHost);
      if (entry.p === 3 && !third) return false;
      if (entry.p === 1 && third) return false;
    }
    return true;
  }

  static matchBucket(bucket, url, targetHost, sourceHost) {
    for (const suffix of hostnameSuffixes(targetHost)) {
      const list = bucket.hosts.get(suffix);
      if (!list) continue;
      for (const e of list) if (PopupMatcher.constraintsOk(e, sourceHost, targetHost)) return e;
    }
    for (const e of bucket.patterns) {
      if (e.compiled && !e.compiled.test(url)) continue;
      if (PopupMatcher.constraintsOk(e, sourceHost, targetHost)) return e;
    }
    return null;
  }

  /** True when `url`, opened by a page at `sourceUrl`, should be closed. */
  matches(url, sourceUrl) {
    const targetHost = hostnameFromURL(url);
    if (!targetHost) return false;
    const sourceHost = hostnameFromURL(sourceUrl);
    if (!PopupMatcher.matchBucket(this.block, url, targetHost, sourceHost)) return false;
    return !PopupMatcher.matchBucket(this.allow, url, targetHost, sourceHost);
  }
}
