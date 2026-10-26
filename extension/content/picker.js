// Lá Chắn — element picker. Injected on demand (popup button or context menu).
// Lets the user point at something on the page and hide it permanently on this site.
(() => {
  'use strict';

  if (globalThis.__lachanPickerStop) globalThis.__lachanPickerStop();

  const mode = globalThis.__lachanPickerMode || 'pick';
  const contextTarget = globalThis.__lachanContextTarget;
  delete globalThis.__lachanPickerMode;

  const host = location.hostname.replace(/^www\./, '');

  /* ------------------------------------------------------------ selectors */

  const isStableToken = (s) => {
    if (!s || s.length > 48 || !/^[A-Za-z_][\w-]*$/.test(s)) return false;
    if (/\d{4,}/.test(s)) return false;
    if (/^(css|sc|jsx|svelte|emotion|tw|styled)-/i.test(s)) return false;
    if (/^[a-z]{1,3}-[A-Za-z0-9]{5,}$/.test(s) && /\d/.test(s)) return false;
    if (/^_?[A-Za-z0-9]{6,}$/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return false;
    return true;
  };

  const compound = (el) => {
    if (el.id && isStableToken(el.id)) return `#${CSS.escape(el.id)}`;
    let s = el.localName;
    for (const c of [...el.classList].filter(isStableToken).slice(0, 2)) s += `.${CSS.escape(c)}`;
    return s;
  };

  const count = (sel) => {
    try {
      return document.querySelectorAll(sel).length;
    } catch {
      return -1;
    }
  };

  const exactSelector = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && node !== document.body) {
      let part = compound(node);
      if (part.startsWith('#')) {
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent && [...parent.children].filter((c) => c !== node && c.matches(part)).length > 0) {
        const sameTag = [...parent.children].filter((c) => c.localName === node.localName);
        part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      if (count(sel) === 1) return sel;
      node = parent;
    }
    return parts.join(' > ') || el.localName;
  };

  const attributeSelector = (el) => {
    const attr = el.localName === 'a' ? 'href' : ['iframe', 'img', 'embed', 'video', 'source'].includes(el.localName) ? 'src' : null;
    if (!attr) return null;
    const value = el.getAttribute(attr);
    if (!value) return null;
    try {
      const u = new URL(value, location.href);
      if (u.hostname && u.hostname.replace(/^www\./, '') !== host) {
        return `${el.localName}[${attr}*="${u.hostname.replace(/^www\./, '')}"]`;
      }
      const path = u.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
      if (path) return `${el.localName}[${attr}*="/${path.replace(/"/g, '')}"]`;
    } catch { /* ignore */ }
    return null;
  };

  const candidatesFor = (el) => {
    const out = [];
    const add = (label, sel) => {
      if (!sel || out.some((c) => c.sel === sel)) return;
      const n = count(sel);
      if (n > 0) out.push({ label, sel, n });
    };
    add('Đúng phần tử này', exactSelector(el));
    const c = compound(el);
    if (c !== el.localName) add('Các phần tử giống vậy', c);
    add('Theo địa chỉ quảng cáo', attributeSelector(el));
    return out;
  };

  /* ------------------------------------------------------------------- UI */

  const root = document.createElement('lachan-picker');
  root.setAttribute('style', 'all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; display: block !important;');
  const shadow = root.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .catcher { position: fixed; inset: 0; cursor: crosshair; background: transparent; }
      .box { position: fixed; pointer-events: none; border: 2px solid #c2272d; background: rgba(194, 39, 45, 0.12);
             border-radius: 3px; display: none; }
      .box.hover { border-style: dashed; background: rgba(194, 39, 45, 0.08); }
      .tag { position: fixed; pointer-events: none; display: none; padding: 2px 6px; border-radius: 4px;
             background: #c2272d; color: #fff; font: 600 11px/1.4 system-ui, sans-serif; white-space: nowrap; }
      .panel { position: fixed; right: 16px; bottom: 16px; width: min(380px, calc(100vw - 32px));
               background: #0f1a18; color: #e3ece8; border-radius: 14px; padding: 14px 14px 12px;
               font: 400 13px/1.45 'Be Vietnam Pro', system-ui, -apple-system, 'Segoe UI', sans-serif;
               box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); }
      .panel.left { right: auto; left: 16px; }
      .head { display: flex; align-items: center; gap: 8px; }
      .head svg { width: 18px; height: 18px; flex: none; }
      .title { font-weight: 800; font-size: 14px; margin-right: auto; color: #6fc2ae; }
      .x { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; color: #93a8a2; font-size: 18px; line-height: 1; }
      .x:hover { background: #22342f; color: #fff; }
      .hint { margin: 8px 0 0; color: #b9c9c4; }
      .choices { display: grid; gap: 6px; margin-top: 10px; }
      .choice { all: unset; display: flex; justify-content: space-between; gap: 10px; padding: 7px 10px; border-radius: 8px;
                background: #182724; cursor: pointer; }
      .choice:hover { background: #22342f; }
      .choice[aria-pressed="true"] { outline: 2px solid #6fc2ae; }
      .choice b { font-weight: 600; }
      .choice span { color: #93a8a2; white-space: nowrap; }
      .sel { width: 100%; margin-top: 10px; padding: 8px 10px; border: 1px solid #2c423c; border-radius: 8px; background: #0b1513;
             color: #e3ece8; font: 12px/1.4 ui-monospace, Consolas, Menlo, monospace; resize: vertical; min-height: 38px; }
      .sel:focus { outline: 2px solid #6fc2ae; outline-offset: 1px; }
      .sel.bad { border-color: #e5484d; }
      .nav { display: flex; gap: 6px; margin-top: 8px; }
      .row { display: flex; gap: 8px; margin-top: 12px; }
      button.b { all: unset; display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 0 12px;
                 border-radius: 9px; font-weight: 600; cursor: pointer; background: #182724; color: #6fc2ae; }
      button.b:hover { background: #22342f; }
      button.b:focus-visible, .choice:focus-visible, .x:focus-visible { outline: 2px solid #6fc2ae; outline-offset: 2px; }
      button.b[disabled] { opacity: 0.45; cursor: default; }
      button.primary { background: #c2272d; color: #fff; flex: 1; }
      button.primary:hover { background: #a61b22; }
      .count { margin-top: 8px; color: #b9c9c4; }
      .count strong { color: #fff; }
    </style>
    <div class="catcher" part="catcher"></div>
    <div class="box hover"></div>
    <div class="tag"></div>
    <div class="matches"></div>
    <div class="panel" role="dialog" aria-label="Ẩn phần tử">
      <div class="head">
        <svg viewBox="0 0 100 100" aria-hidden="true"><path fill="#6fc2ae" d="M50 7 C62 7 75 10 87 15.5 L87 45 C87 70 71 85.5 50 94 C29 85.5 13 70 13 45 L13 15.5 C25 10 38 7 50 7 Z"/><path d="M50 20 C51.5 42 51.5 63 50 85 M50.6 44 L33 32 M50.6 44 L67 32" stroke="#0f1a18" stroke-width="8" stroke-linecap="round" fill="none"/></svg>
        <span class="title">Ẩn phần tử</span>
        <button class="x" type="button" data-act="quit" aria-label="Thoát">×</button>
      </div>
      <p class="hint">Di chuột tới quảng cáo rồi bấm để chọn. Nhấn Esc để thoát.</p>
      <div class="picked" hidden>
        <div class="choices"></div>
        <textarea class="sel" rows="2" spellcheck="false" aria-label="Bộ chọn CSS"></textarea>
        <div class="nav">
          <button class="b" type="button" data-act="up">Chọn khung lớn hơn</button>
          <button class="b" type="button" data-act="down">Khung nhỏ hơn</button>
        </div>
        <p class="count"></p>
        <div class="row">
          <button class="b primary" type="button" data-act="save">Ẩn vĩnh viễn trên ${host}</button>
          <button class="b" type="button" data-act="again">Chọn lại</button>
        </div>
      </div>
    </div>`;

  const q = (s) => shadow.querySelector(s);
  const catcher = q('.catcher');
  const hoverBox = q('.box.hover');
  const tag = q('.tag');
  const matchesLayer = q('.matches');
  const panel = q('.panel');
  const picked = q('.picked');
  const hint = q('.hint');
  const choices = q('.choices');
  const selInput = q('.sel');
  const countEl = q('.count');

  let hovered = null;
  let chain = []; // [selected, parent, grandparent…]; last = current
  let current = null;
  let rafPending = false;

  const elementAt = (x, y) => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === root || el === document.documentElement || el === document.body) continue;
      return el;
    }
    return null;
  };

  const place = (box, el) => {
    if (!el || !el.isConnected) {
      box.style.display = 'none';
      return null;
    }
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    return r;
  };

  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return `${compound(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  };

  const drawHover = () => {
    const r = place(hoverBox, current ? null : hovered);
    if (r && hovered) {
      tag.textContent = describe(hovered);
      tag.style.display = 'block';
      tag.style.left = `${Math.max(4, r.left)}px`;
      tag.style.top = `${r.top > 24 ? r.top - 22 : r.bottom + 4}px`;
    } else {
      tag.style.display = 'none';
    }
  };

  const drawMatches = () => {
    matchesLayer.replaceChildren();
    if (!current) return;
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll(selInput.value)].slice(0, 80);
    } catch { /* invalid selector */ }
    for (const el of nodes) {
      const box = document.createElement('div');
      box.className = 'box';
      matchesLayer.append(box);
      place(box, el);
    }
  };

  const redraw = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      drawHover();
      drawMatches();
    });
  };

  const updateCount = () => {
    const n = count(selInput.value.trim());
    selInput.classList.toggle('bad', n < 0);
    q('[data-act="save"]').disabled = n <= 0;
    if (n < 0) countEl.textContent = 'Bộ chọn không hợp lệ.';
    else if (n === 0) countEl.textContent = 'Bộ chọn này không khớp phần tử nào.';
    else countEl.innerHTML = `Sẽ ẩn <strong>${n}</strong> phần tử trên trang này và các lần sau.`;
    redraw();
  };

  const renderChoices = () => {
    choices.replaceChildren();
    for (const c of candidatesFor(current)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'choice';
      b.setAttribute('aria-pressed', String(c.sel === selInput.value));
      const label = document.createElement('b');
      label.textContent = c.label;
      const n = document.createElement('span');
      n.textContent = `${c.n} phần tử`;
      b.append(label, n);
      b.addEventListener('click', () => {
        selInput.value = c.sel;
        for (const other of choices.children) other.setAttribute('aria-pressed', String(other === b));
        updateCount();
      });
      choices.append(b);
    }
  };

  const select = (el) => {
    current = el;
    hovered = null;
    const first = candidatesFor(el)[0];
    selInput.value = first ? first.sel : exactSelector(el);
    hint.textContent = 'Chọn cách ẩn, hoặc sửa bộ chọn CSS bên dưới.';
    picked.hidden = false;
    catcher.style.cursor = 'default';
    q('[data-act="down"]').disabled = chain.length <= 1;
    q('[data-act="up"]').disabled = !el.parentElement || el.parentElement === document.body || el.parentElement === document.documentElement;
    renderChoices();
    updateCount();
    const saveButton = q('[data-act="save"]');
    if (!saveButton.disabled) saveButton.focus();
  };

  const reset = () => {
    current = null;
    chain = [];
    picked.hidden = true;
    hint.textContent = 'Di chuột tới quảng cáo rồi bấm để chọn. Nhấn Esc để thoát.';
    catcher.style.cursor = 'crosshair';
    matchesLayer.replaceChildren();
    redraw();
  };

  const stop = () => {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', redraw, true);
    window.removeEventListener('resize', redraw, true);
    root.remove();
    delete globalThis.__lachanPickerStop;
  };

  const save = async () => {
    const selector = selInput.value.trim();
    if (count(selector) <= 0) return;
    q('[data-act="save"]').disabled = true;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'picker:save', selector });
    } catch {
      res = null;
    }
    if (!res || !res.ok) {
      countEl.textContent = 'Không lưu được bộ lọc. Thử tải lại trang rồi chọn lại.';
      q('[data-act="save"]').disabled = false;
      return;
    }
    for (const el of document.querySelectorAll(selector)) el.style.setProperty('display', 'none', 'important');
    stop();
  };

  function onKey(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      if (current) reset();
      else stop();
    }
  }

  catcher.addEventListener('mousemove', (ev) => {
    if (current) return;
    const el = elementAt(ev.clientX, ev.clientY);
    if (el !== hovered) {
      hovered = el;
      redraw();
    }
    // Keep the panel out of the way of what the user is pointing at.
    panel.classList.toggle('left', ev.clientX > window.innerWidth - 420 && ev.clientY > window.innerHeight - 320);
  });

  catcher.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (current) return;
    const el = elementAt(ev.clientX, ev.clientY);
    if (!el) return;
    chain = [el];
    select(el);
  });

  shadow.addEventListener('click', (ev) => {
    const act = ev.target.closest && ev.target.closest('[data-act]');
    if (!act) return;
    switch (act.dataset.act) {
      case 'quit': stop(); break;
      case 'again': reset(); break;
      case 'save': save(); break;
      case 'up': {
        const parent = current && current.parentElement;
        if (parent && parent !== document.body && parent !== document.documentElement) {
          chain.push(parent);
          select(parent);
        }
        break;
      }
      case 'down':
        if (chain.length > 1) {
          chain.pop();
          select(chain[chain.length - 1]);
        }
        break;
      default:
    }
  });

  selInput.addEventListener('input', () => {
    for (const other of choices.children) other.setAttribute('aria-pressed', 'false');
    updateCount();
  });
  selInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      save();
    }
  });

  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', redraw, true);
  window.addEventListener('resize', redraw, true);
  document.documentElement.append(root);
  globalThis.__lachanPickerStop = stop;

  if (mode === 'context' && contextTarget instanceof Element && contextTarget.isConnected) {
    chain = [contextTarget];
    select(contextTarget);
  }
})();
