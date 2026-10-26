// Compiles procedural cosmetic filters (uBO / ABP extended syntax) into JSON "plans"
// that content/cosmetic.js executes. Shared by the build tool and the service worker.
//
// Plan format: { t: [[op, arg], ...], a?: ['remove'] | ['style', 'decls'] }
//   ops: css, spath, matches, has-text, has, not, upward, matches-css,
//        min-text-length, xpath, matches-path

const OP_ALIASES = {
  'has-text': 'has-text',
  contains: 'has-text',
  '-abp-contains': 'has-text',
  has: 'has',
  '-abp-has': 'has',
  if: 'has',
  not: 'not',
  'if-not': 'not',
  upward: 'upward',
  'nth-ancestor': 'upward',
  'matches-css': 'matches-css',
  'matches-css-before': 'matches-css',
  'matches-css-after': 'matches-css',
  'min-text-length': 'min-text-length',
  xpath: 'xpath',
  'matches-path': 'matches-path',
  remove: 'remove',
  style: 'style',
};

// Operators we recognise but cannot run: a filter using one of them is dropped.
const UNSUPPORTED = new Set([
  '-abp-properties', 'watch-attr', 'others', 'shadow', 'matches-attr', 'matches-prop',
  'matches-media', 'remove-attr', 'remove-class', 'is-procedural',
]);

// Pseudo-classes that only make sense procedurally (anything native is left to the CSS engine).
const ALWAYS_PROCEDURAL = new Set(
  Object.keys(OP_ALIASES).filter((name) => !['has', 'not', 'if', 'if-not'].includes(name)),
);

const PSEUDO_RE = /^:(-?[a-zA-Z][\w-]*)\(/;

function skipQuoted(s, i) {
  const q = s[i];
  for (i += 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === q) return i;
  }
  return -1;
}

/** Index of the parenthesis closing the one at `open`, or -1. */
function closingParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '"' || c === "'") {
      // Quotes inside regex literals of :has-text() are plain characters; only honour
      // them when they look like a quoted CSS string.
      const prev = s[i - 1];
      if (prev === '(' || prev === '=' || prev === ' ' || prev === ',') {
        const end = skipQuoted(s, i);
        if (end !== -1) { i = end; continue; }
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits a selector into CSS fragments and pseudo-class calls (top level only). */
function tokenize(sel) {
  const out = [];
  let i = 0;
  let cssStart = 0;
  let bracket = 0;
  while (i < sel.length) {
    const c = sel[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"' || c === "'") {
      const end = skipQuoted(sel, i);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (c === '[') { bracket++; i++; continue; }
    if (c === ']') { bracket--; i++; continue; }
    if (c === ':' && bracket === 0) {
      const m = PSEUDO_RE.exec(sel.slice(i));
      if (m) {
        const open = i + m[0].length - 1;
        const close = closingParen(sel, open);
        if (close === -1) return null;
        const name = m[1].toLowerCase();
        const arg = sel.slice(open + 1, close);
        if (cssStart < i) out.push({ css: sel.slice(cssStart, i) });
        out.push({ name, arg });
        i = close + 1;
        cssStart = i;
        continue;
      }
    }
    i++;
  }
  if (bracket !== 0) return null;
  if (cssStart < sel.length) out.push({ css: sel.slice(cssStart) });
  return out;
}

/** True when the selector needs JavaScript (cannot be expressed as plain CSS). */
export function hasProceduralOperator(selector) {
  const tokens = tokenize(selector);
  if (tokens === null) return false;
  for (const tok of tokens) {
    if (tok.css !== undefined) continue;
    if (ALWAYS_PROCEDURAL.has(tok.name) || UNSUPPORTED.has(tok.name)) return true;
    if (tok.name === '-abp-has' || tok.name === 'if' || tok.name === 'if-not') return true;
    // Chrome rejects :has() nested in :has(); such filters are run procedurally.
    if (tok.name === 'has' && NESTED_HAS_RE.test(tok.arg)) return true;
    if ((tok.name === 'has' || tok.name === 'not' || tok.name === 'is' || tok.name === 'where')
      && hasProceduralOperator(tok.arg)) return true;
  }
  return false;
}

const NESTED_HAS_RE = /:(?:-abp-)?has\(/;

/** Native-CSS-safe :has()/:not() argument (no procedural op, no nested :has). */
function isNativeArg(op, arg) {
  if (hasProceduralOperator(arg)) return false;
  return !(op === 'has' && NESTED_HAS_RE.test(arg));
}

/**
 * Rewrites ABP extended syntax to native CSS when possible:
 * ":-abp-has(.x)" → ":has(.x)". Leaves procedural pieces alone.
 */
export function normalizeExtendedSelector(selector) {
  return selector
    .replace(/:-abp-has\(/g, ':has(')
    .replace(/:-abp-contains\(/g, ':has-text(');
}

function parseTextArg(arg) {
  let a = arg.trim();
  const re = /^\/(.+)\/([imsu]*)$/.exec(a);
  if (re) {
    try {
      new RegExp(re[1], re[2]); // eslint-disable-line no-new
    } catch {
      return null;
    }
    return { re: re[1], f: re[2] };
  }
  if ((a.startsWith('"') && a.endsWith('"')) || (a.startsWith("'") && a.endsWith("'"))) {
    a = a.slice(1, -1);
  }
  if (a === '') return null;
  return { s: a.replace(/\\(.)/g, '$1') };
}

const SAFE_DECLS = /^[^{}<>\\@]*$/;

/** Validates a declaration block used by :style(). Returns the cleaned string or null. */
export function sanitizeStyle(decls) {
  const d = decls.trim();
  if (d === '' || !SAFE_DECLS.test(d)) return null;
  if (/url\s*\(|image-set|expression\s*\(|-moz-binding|behavior\s*:/i.test(d)) return null;
  return d;
}

/**
 * Compiles `selector` into a plan. Returns null when unsupported or malformed.
 * `mode` = 'root' (document), 'descendants' (inside :has) or 'self' (inside :not).
 */
export function compileProcedural(selector, mode = 'root') {
  const tokens = tokenize(selector.trim());
  if (tokens === null || tokens.length === 0) return null;

  const tasks = [];
  let css = ''; // pending native CSS (may include native :has()/:not())
  let action;
  let sawOperator = false;

  const flushCss = () => {
    const piece = css.trim() === '' ? '' : css;
    css = '';
    if (piece === '') return;
    if (tasks.length === 0 && !sawOperator) {
      tasks.push(['css', piece.trim()]);
    } else if (/^\s*[>+~]/.test(piece) || /^\s/.test(piece)) {
      tasks.push(['spath', piece.startsWith(' ') ? ` ${piece.trim()}` : piece.trim()]);
    } else {
      tasks.push(['matches', piece.trim()]);
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (action) return null; // nothing may follow :remove() / :style()
    if (tok.css !== undefined) { css += tok.css; continue; }

    const name = tok.name;
    if (UNSUPPORTED.has(name)) return null;
    const op = OP_ALIASES[name];

    // Native pseudo-classes (including :has/:not without procedural content) stay CSS.
    if (op === undefined) {
      css += `:${name}(${tok.arg})`;
      continue;
    }
    if ((op === 'has' || op === 'not') && isNativeArg(op, tok.arg)) {
      css += `:${op}(${tok.arg})`;
      continue;
    }

    flushCss();
    sawOperator = true;
    switch (op) {
      case 'has-text': {
        const arg = parseTextArg(tok.arg);
        if (!arg) return null;
        tasks.push(['has-text', arg]);
        break;
      }
      case 'has':
      case 'not': {
        const inner = compileProcedural(tok.arg, op === 'has' ? 'descendants' : 'self');
        if (!inner || inner.a) return null;
        tasks.push([op, inner]);
        break;
      }
      case 'upward': {
        const a = tok.arg.trim();
        if (/^\d+$/.test(a)) {
          const n = Number(a);
          if (n < 1 || n > 256) return null;
          tasks.push(['upward', n]);
        } else if (name === 'upward' && a !== '' && !hasProceduralOperator(a)) {
          tasks.push(['upward', a]);
        } else {
          return null;
        }
        break;
      }
      case 'matches-css': {
        const m = /^\s*([\w-]+)\s*:\s*(.+?)\s*$/.exec(tok.arg);
        if (!m) return null;
        const value = parseTextArg(m[2]);
        if (!value) return null;
        const pseudo = name.endsWith('-before') ? '::before' : name.endsWith('-after') ? '::after' : null;
        tasks.push(['matches-css', { p: pseudo, n: m[1], v: value }]);
        break;
      }
      case 'min-text-length': {
        const n = Number(tok.arg.trim());
        if (!Number.isInteger(n) || n < 0) return null;
        tasks.push(['min-text-length', n]);
        break;
      }
      case 'xpath': {
        const expr = tok.arg.trim();
        if (expr === '') return null;
        tasks.push(['xpath', expr]);
        break;
      }
      case 'matches-path': {
        const arg = parseTextArg(tok.arg);
        if (!arg) return null;
        tasks.push(['matches-path', arg]);
        break;
      }
      case 'remove':
        if (tok.arg.trim() !== '') return null;
        action = ['remove'];
        break;
      case 'style': {
        const decls = sanitizeStyle(tok.arg);
        if (!decls) return null;
        action = ['style', decls];
        break;
      }
      default:
        return null;
    }
  }
  flushCss();

  if (tasks.length === 0) {
    // ":style()/:remove()" on nothing, or an empty selector.
    return null;
  }
  // Relative/self modes: the leading CSS is interpreted by the executor.
  if (mode !== 'root' && tasks[0][0] === 'css') {
    tasks[0] = [mode === 'self' ? 'matches' : 'css', tasks[0][1]];
  }
  const plan = { t: tasks };
  if (action) plan.a = action;
  return plan;
}

/** True when the plan is just a CSS selector plus an optional :style() — i.e. no JS needed. */
export function planIsPlainCss(plan) {
  return plan.t.length === 1 && plan.t[0][0] === 'css' && (!plan.a || plan.a[0] === 'style');
}
