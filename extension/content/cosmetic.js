// Lá Chắn — element hiding (runs in every frame at document_start).
//
// 1. Asks the service worker for this frame: it injects the site-specific and
//    "complex" generic CSS itself (origin USER, so pages cannot override it).
// 2. Surveys class/id names present in the page and asks for matching generic
//    filters (EasyList has ~13 000 of them; only the few that match are injected).
// 3. Runs procedural filters (:has-text(), :upward(), :remove()…) that CSS can't express.
(() => {
  'use strict';

  if (globalThis.__lachanCosmetic) return;
  globalThis.__lachanCosmetic = true;

  // Remembered for the "Chặn phần tử này…" context-menu entry.
  document.addEventListener('contextmenu', (ev) => {
    globalThis.__lachanContextTarget = ev.composedPath ? ev.composedPath()[0] : ev.target;
  }, true);

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res);
      });
    } catch {
      resolve(undefined); // extension reloaded: this script is orphaned
    }
  });

  /* -------------------------------------------------------------- surveyor */

  // Collects class and id names in time slices (never one long task), sends the new
  // ones to the service worker, which injects CSS for the few that match a filter.
  function startSurveyor() {
    const seenClasses = new Set();
    const seenIds = new Set();
    let newClasses = [];
    let newIds = [];
    let budget = 30000; // stop surveying pathological pages after this many names

    const queue = (el) => {
      const id = el.id;
      if (typeof id === 'string' && id !== '' && !seenIds.has(id)) {
        seenIds.add(id);
        newIds.push(id);
      }
      const list = el.classList;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (!seenClasses.has(c)) {
            seenClasses.add(c);
            newClasses.push(c);
          }
        }
      }
    };

    const flush = () => {
      if (newClasses.length === 0 && newIds.length === 0) return;
      budget -= newClasses.length + newIds.length;
      send({ type: 'cosmetic:generic', classes: newClasses, ids: newIds });
      newClasses = [];
      newIds = [];
    };

    // Work queue: NodeLists/arrays of elements, consumed in ~6 ms slices.
    const work = [];
    let cursor = 0;
    let scheduled = false;
    const pump = () => {
      scheduled = false;
      const deadline = performance.now() + 6;
      while (work.length > 0) {
        const items = work[0];
        while (cursor < items.length) {
          queue(items[cursor++]);
          if ((cursor & 255) === 0 && performance.now() > deadline) {
            flush();
            schedule(0);
            return;
          }
        }
        work.shift();
        cursor = 0;
      }
      flush();
    };
    const schedule = (delay) => {
      if (scheduled || budget <= 0) return;
      scheduled = true;
      setTimeout(pump, delay);
    };
    const scanDocument = () => {
      work.push(document.querySelectorAll('[id],[class]'));
      schedule(0);
    };

    // While the page is still being parsed, rescan now and then instead of observing
    // every node the parser inserts (that is what made big pages slow).
    scanDocument();
    let loadingTimer = 0;
    if (document.readyState === 'loading') {
      loadingTimer = setInterval(() => {
        if (document.readyState === 'loading') scanDocument();
      }, 1000);
    }

    const observe = () => {
      clearInterval(loadingTimer);
      scanDocument();
      const added = [];
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes') {
            added.push(m.target);
          } else {
            for (const n of m.addedNodes) {
              if (n.nodeType !== 1) continue;
              added.push(n);
              if (n.firstElementChild) work.push(n.querySelectorAll('[id],[class]'));
            }
          }
        }
        if (added.length) work.push(added.splice(0));
        if (budget <= 0) observer.disconnect();
        else schedule(50);
      });
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'],
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', observe, { once: true });
    } else {
      observe();
    }
  }

  /* ----------------------------------------------------- procedural filters */

  const unique = (nodes) => [...new Set(nodes)];

  const textTester = (arg, exact = false) => {
    if (arg.re !== undefined) {
      let re;
      try {
        re = new RegExp(arg.re, arg.f || '');
      } catch {
        return () => false;
      }
      return (text) => re.test(text);
    }
    if (exact) return (text) => text === arg.s;
    return (text) => text.includes(arg.s);
  };

  const relative = (sel) => (/^\s*[>+~]/.test(sel) ? `:scope ${sel}` : sel);

  const OPS = {
    css: (nodes, sel) => unique(nodes.flatMap((n) => [...n.querySelectorAll(relative(sel))])),
    matches: (nodes, sel) => nodes.filter((n) => n.matches(sel)),
    spath: (nodes, sel) => {
      const trimmed = sel.trim();
      const c = trimmed[0];
      const out = [];
      for (const n of nodes) {
        if (c === '+' || c === '~') {
          const rest = trimmed.slice(1).trim();
          if (c === '+') {
            const s = n.nextElementSibling;
            if (s && s.matches(rest)) out.push(s);
          } else {
            for (let s = n.nextElementSibling; s; s = s.nextElementSibling) if (s.matches(rest)) out.push(s);
          }
        } else {
          out.push(...n.querySelectorAll(`:scope${sel}`));
        }
      }
      return unique(out);
    },
    'has-text': (nodes, arg) => {
      const test = textTester(arg);
      return nodes.filter((n) => test(n.textContent || ''));
    },
    has: (nodes, plan) => nodes.filter((n) => run(plan, n, 'descendants').length > 0),
    not: (nodes, plan) => nodes.filter((n) => run(plan, n, 'self').length === 0),
    upward: (nodes, arg) => unique(nodes.map((n) => {
      if (typeof arg === 'number') {
        let p = n;
        for (let i = 0; i < arg && p; i++) p = p.parentElement;
        return p;
      }
      return n.parentElement ? n.parentElement.closest(arg) : null;
    }).filter(Boolean)),
    'matches-css': (nodes, { p, n: prop, v }) => {
      const test = textTester(v, true);
      return nodes.filter((el) => {
        const style = getComputedStyle(el, p || undefined);
        return test(style.getPropertyValue(prop) || style[prop] || '');
      });
    },
    'min-text-length': (nodes, len) => nodes.filter((n) => (n.textContent || '').length >= len),
    xpath: (nodes, expr) => {
      const out = [];
      for (const n of nodes) {
        const r = document.evaluate(expr, n, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < r.snapshotLength; i++) {
          const x = r.snapshotItem(i);
          if (x.nodeType === 1) out.push(x);
        }
      }
      return unique(out);
    },
    'matches-path': (nodes, arg) => (textTester(arg)(location.pathname + location.search) ? nodes : []),
  };

  function run(plan, root, mode) {
    const tasks = plan.t;
    let i = 0;
    let nodes;
    const [op0, arg0] = tasks[0];
    if (op0 === 'css') {
      nodes = mode === 'root' ? [...document.querySelectorAll(arg0)] : [...root.querySelectorAll(relative(arg0))];
      i = 1;
    } else if (mode === 'self') {
      nodes = [root];
    } else if (op0 === 'xpath') {
      nodes = [mode === 'root' ? document : root];
    } else {
      nodes = mode === 'root' ? [document.documentElement] : [...root.querySelectorAll('*')];
    }
    for (; i < tasks.length && nodes.length > 0; i++) {
      const fn = OPS[tasks[i][0]];
      if (!fn) return [];
      nodes = fn(nodes, tasks[i][1]);
    }
    return nodes;
  }

  function applyAction(action, el) {
    if (!action) {
      el.style.setProperty('display', 'none', 'important');
      return;
    }
    if (action[0] === 'remove') {
      el.remove();
      return;
    }
    if (action[0] === 'style') {
      for (const decl of action[1].split(';')) {
        const m = /^\s*([\w-]+)\s*:\s*(.+?)\s*$/.exec(decl);
        if (!m) continue;
        const important = /!\s*important$/i.test(m[2]);
        el.style.setProperty(m[1], m[2].replace(/!\s*important$/i, '').trim(), important ? 'important' : '');
      }
    }
  }

  function startProcedural(plans) {
    const done = new WeakMap(); // element → Set(plan index)
    let timer = 0;
    let lastRun = 0;

    const apply = () => {
      timer = 0;
      lastRun = Date.now();
      plans.forEach((plan, index) => {
        let nodes;
        try {
          nodes = run(plan, document, 'root');
        } catch {
          return; // invalid selector on this page — ignore this filter
        }
        for (const el of nodes) {
          let s = done.get(el);
          if (s && s.has(index)) continue;
          if (!s) { s = new Set(); done.set(el, s); }
          s.add(index);
          applyAction(plan.a, el);
        }
      });
    };
    const schedule = () => {
      if (timer !== 0) return;
      const wait = Math.max(0, 150 - (Date.now() - lastRun));
      timer = setTimeout(apply, wait);
    };

    const observer = new MutationObserver(schedule);
    const start = () => {
      apply();
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      // Also run early on long pages, before parsing ends.
      setTimeout(() => { if (document.readyState === 'loading') apply(); }, 300);
    } else {
      start();
    }
  }

  /* ------------------------------------------------------------------ start */

  send({ type: 'cosmetic:init' }).then((res) => {
    if (!res || !res.enabled) return;
    if (res.generic) startSurveyor();
    if (Array.isArray(res.procedural) && res.procedural.length) startProcedural(res.procedural);
  });
})();
