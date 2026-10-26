// Lá Chắn — click guard (MAIN world, registered on every site while the option is on).
//
// Stops click-hijacking ads that filter lists cannot name in advance:
//   • an invisible layer over the page, or a page-wide click handler, that opens an ad in
//     a new tab wherever you click
//   • "tab-under": the click opens the page you wanted in a new tab while the current tab
//     is sent to an ad
// Only new windows and top-level navigations to another site, started by script within a
// second of a click, are judged. Clicks on real links and buttons keep working.
(() => {
  'use strict';

  const GESTURE_MS = 1000;
  const COMMON_SLD = new Set(['ac', 'biz', 'co', 'com', 'edu', 'gov', 'go', 'gob', 'gv', 'id', 'info', 'int', 'io',
    'ltd', 'me', 'mil', 'name', 'ne', 'net', 'nic', 'or', 'org', 'pro', 'web']);
  const CONTROLS = 'a[href],area[href],button,input,select,textarea,label,summary,option,[role=button],[role=link],'
    + '[role=menuitem],[role=tab],[role=checkbox],[role=switch],[role=option],[onclick],[contenteditable]:not([contenteditable=false])';
  const LINKS = 'a[href],area[href]';
  const POINTER_EVENTS = new Set(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend', 'click', 'auxclick']);

  // Page scripts run after us and may patch these, so keep the originals.
  const { apply } = Reflect;
  const URLCtor = URL;
  const now = performance.now.bind(performance);
  const getStyle = window.getComputedStyle;
  const rectOf = Element.prototype.getBoundingClientRect;
  const closest = Element.prototype.closest;
  const composedPath = Event.prototype.composedPath;
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  const stopLoading = window.stop;

  const style = (el) => apply(getStyle, window, [el]);

  /* ------------------------------------------------------------------ sites */

  function siteOf(host) {
    if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
    const labels = host.replace(/\.$/, '').split('.');
    const n = labels.length;
    const keep = n > 2 && labels[n - 1].length === 2 && COMMON_SLD.has(labels[n - 2]) ? 3 : 2;
    return labels.slice(-keep).join('.');
  }

  const HOME = (() => {
    try { return siteOf(new URLCtor(self.origin).hostname); } catch { return ''; }
  })();

  // 'blank' (a window the ad fills in later), 'home' (this site), 'foreign' or 'other' (javascript:, blob:…).
  function classify(raw) {
    const s = raw == null ? '' : String(raw).trim();
    if (s === '' || s === 'about:blank') return 'blank';
    let url;
    try {
      url = new URLCtor(s, document.baseURI);
    } catch {
      return 'other';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.href === 'about:blank' ? 'blank' : 'other';
    return HOME && siteOf(url.hostname) === HOME ? 'home' : 'foreign';
  }

  /* ---------------------------------------------------------------- gesture */

  let gesture = null; // { kind, target, at, home, blocked, navTo }

  function pathTarget(ev) {
    const t = apply(composedPath, ev, [])[0] || ev.target;
    return t instanceof Element ? t : (t && t.parentElement) || null;
  }

  function note(ev) {
    if (!ev.isTrusted) return;
    const kind = ev.type === 'keydown' ? 'key' : 'pointer';
    const target = pathTarget(ev);
    const t = now();
    if (ev.type === 'pointerdown' || kind === 'key' || !gesture || gesture.kind !== kind || t - gesture.at > GESTURE_MS) {
      gesture = { kind, target, at: t, home: false, blocked: false, navTo: null };
    } else {
      gesture.target = target;
      gesture.at = t;
    }
  }

  const live = () => (gesture && now() - gesture.at < GESTURE_MS ? gesture : null);

  /* --------------------------------------------------------------- judging */

  function clear(color) {
    if (color === 'transparent') return true;
    const m = /^rgba\((?:[^,]+,){3}\s*([\d.]+)\)$/.exec(color);
    return !!m && Number(m[1]) <= 0.1;
  }

  // Share of the viewport covered by a fixed/absolute element (0 for anything else).
  function coverage(el) {
    const cs = style(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return 0;
    const r = apply(rectOf, el, []);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(r.right, vw) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? (w * h) / (vw * vh) : 0;
  }

  function looksEmpty(el) {
    const cs = style(el);
    if (Number(cs.opacity) <= 0.1) return true;
    if (cs.backgroundImage !== 'none' || !clear(cs.backgroundColor)) return false;
    if (el.textContent.trim()) return false;
    return !el.querySelector('img,svg,video,canvas,iframe,picture,object,embed');
  }

  // The layer the click landed on, if it is an invisible one spread over the page,
  // or a link stretched over (nearly) the whole viewport.
  function overlayOf(el) {
    const link = apply(closest, el, [LINKS]);
    if (link && coverage(link) >= 0.8) return link;
    let n = el;
    for (let depth = 0; depth < 4 && n && n !== document.body && n !== document.documentElement; depth++) {
      if (coverage(n) >= 0.25 && looksEmpty(n)) return n;
      n = n.parentElement;
    }
    return null;
  }

  function interactive(el) {
    const c = apply(closest, el, [CONTROLS]);
    if (c && c !== document.body && c !== document.documentElement) return true;
    const body = document.body;
    return style(el).cursor === 'pointer' && !(body && style(body).cursor === 'pointer');
  }

  // A click on an invisible layer or on plain page content (text, background, a bare video)
  // is not a request to open anything. Overlays found this way stop catching clicks.
  function suspicious(g) {
    if (g.kind !== 'pointer' || !g.target || !g.target.isConnected) return false;
    const layer = overlayOf(g.target);
    if (layer) {
      apply(setProperty, layer.style, ['pointer-events', 'none', 'important']);
      return true;
    }
    return !interactive(g.target);
  }

  function callerIsForeign() {
    for (const line of (new Error().stack || '').split('\n')) {
      const m = /(https?:\/\/[^\s()]+):\d+:\d+\)?\s*$/.exec(line);
      if (m) return classify(m[1]) === 'foreign';
    }
    return false;
  }

  // The usual "any click opens an ad" snippet: another site's script listening on the whole
  // page, firing even when the click hit a button.
  function pageWide(ev) {
    if (!ev || !ev.isTrusted || !POINTER_EVENTS.has(ev.type)) return false;
    const ct = ev.currentTarget;
    if (ct !== window && ct !== document && ct !== document.documentElement && ct !== document.body) return false;
    const target = pathTarget(ev);
    if (!target || apply(closest, target, [LINKS])) return false;
    return callerIsForeign();
  }

  // A new tab or window opened while the user is clicking. Returns false to block it.
  function allowOpen(g, raw, ev) {
    const dest = classify(raw);
    if (dest === 'other') return true;
    if (dest === 'home') {
      // This page moved itself to a new tab while already leaving for another site: tab-under.
      if (g.navTo) {
        apply(stopLoading, window, []);
        g.navTo = null;
      }
      g.home = true;
      return true;
    }
    if (suspicious(g) || pageWide(ev)) {
      g.blocked = true;
      return false;
    }
    return true;
  }

  /* ------------------------------------------------------------ new windows */

  const ours = new WeakSet();

  const fakeWindow = new Proxy(function fakeWindow() {}, {
    get(target, prop) {
      if (prop === 'closed') return false;
      if (prop === 'opener' || prop === 'parent' || prop === 'top') return window;
      if (prop === Symbol.toPrimitive) return () => '';
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return fakeWindow;
    },
    set() { return true; },
    apply() { return fakeWindow; },
  });

  const openTrap = {
    apply(target, self, args) {
      const g = live();
      const name = args[1] == null ? '' : String(args[1]).trim().toLowerCase();
      const newWindow = name !== '_self' && name !== '_top' && name !== '_parent';
      if (g && newWindow && !allowOpen(g, args[0], window.event)) return fakeWindow;
      return apply(target, self, args);
    },
  };

  function guardOpen(w) {
    try {
      if (!w || ours.has(w.open)) return;
      const p = new Proxy(w.open, openTrap);
      ours.add(p);
      w.open = p;
    } catch { /* another origin: its own copy of this script guards it */ }
  }

  guardOpen(window);

  // A fresh about:blank iframe hands out an untouched window.open.
  const frameWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  if (frameWindow && frameWindow.get) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      ...frameWindow,
      get: new Proxy(frameWindow.get, {
        apply(target, self, args) {
          const w = apply(target, self, args);
          if (w && w !== window) guardOpen(w);
          return w;
        },
      }),
    });
  }

  /* ----------------------------------------------------------------- links */

  const isLink = (el) => el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement;

  function opensNewWindow(a, ev) {
    const base = document.querySelector('base[target]');
    const name = (a.target || (base && base.target) || '').trim().toLowerCase();
    if (name && name !== '_self' && name !== '_top' && name !== '_parent') return true;
    return !!ev && ev.isTrusted && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button === 1);
  }

  // A link clicked by script (a.click(), dispatchEvent) rather than by the user.
  function blockLink(a) {
    const g = live();
    if (!g || a.hasAttribute('download') || !opensNewWindow(a, null)) return false;
    return !allowOpen(g, a.href, window.event);
  }

  let passing = null;

  HTMLElement.prototype.click = new Proxy(HTMLElement.prototype.click, {
    apply(target, self, args) {
      if (!isLink(self)) return apply(target, self, args);
      if (blockLink(self)) return undefined;
      passing = self;
      try {
        return apply(target, self, args);
      } finally {
        passing = null;
      }
    },
  });

  // Links that were never added to the page do not reach the window listener below.
  EventTarget.prototype.dispatchEvent = new Proxy(EventTarget.prototype.dispatchEvent, {
    apply(target, self, args) {
      const ev = args[0];
      if (ev && ev.type === 'click' && isLink(self) && !self.isConnected && blockLink(self)) return false;
      return apply(target, self, args);
    },
  });

  function onClick(ev) {
    note(ev);
    const target = pathTarget(ev);
    const a = target && apply(closest, target, [LINKS]);
    if (!a) return;
    if (!ev.isTrusted) {
      if (a !== passing && blockLink(a)) ev.preventDefault();
      return;
    }
    const g = live();
    if (classify(a.href) === 'foreign') {
      const layer = overlayOf(target);
      if (layer) {
        ev.preventDefault();
        apply(setProperty, layer.style, ['pointer-events', 'none', 'important']);
        if (g) g.blocked = true;
        return;
      }
    }
    if (g && opensNewWindow(a, ev) && classify(a.href) === 'home') g.home = true;
  }

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend', 'keydown']) {
    window.addEventListener(type, note, { capture: true, passive: true });
  }
  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);

  /* ------------------------------------------------------------- tab-under */

  // Script sending this tab to another site during a click that also opened this site in a
  // new tab, or a click on an invisible layer / plain content.
  if (window === window.top && window.navigation) {
    window.navigation.addEventListener('navigate', (ev) => {
      if (ev.userInitiated || ev.hashChange || ev.formData || ev.downloadRequest != null) return;
      if (ev.navigationType !== 'push' && ev.navigationType !== 'replace') return;
      const g = live();
      if (!g || classify(ev.destination.url) !== 'foreign') return;
      if (g.home || g.blocked || suspicious(g)) {
        if (ev.cancelable) ev.preventDefault();
        g.blocked = true;
      } else {
        g.navTo = ev.destination.url;
      }
    });
  }
})();
