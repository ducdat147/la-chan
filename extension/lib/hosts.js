// Hostname helpers shared by the build tool (Node) and the service worker.

const ASCII_HOST = /^[a-z0-9.\-_]+$/;

// Second-level labels that usually sit under a ccTLD (example.com.vn, example.co.uk…).
const COMMON_SLD = new Set([
  'ac', 'biz', 'co', 'com', 'edu', 'gov', 'go', 'gob', 'gv', 'health', 'info', 'int', 'ltd',
  'me', 'mil', 'name', 'ne', 'net', 'nic', 'or', 'org', 'pro', 'web',
]);

/** Lower-cases and punycodes a hostname. Returns null when it is not a usable hostname. */
export function toASCIIHostname(input) {
  if (typeof input !== 'string') return null;
  let host = input.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '' || host.startsWith('.') || host.includes('..')) return null;
  if (ASCII_HOST.test(host)) return host;
  try {
    const h = new URL(`http://${host}/`).hostname;
    return ASCII_HOST.test(h) ? h : null;
  } catch {
    return null;
  }
}

/** "a.b.example.com" → ["a.b.example.com", "b.example.com", "example.com", "com"] */
export function hostnameSuffixes(hostname) {
  const out = [];
  let h = hostname;
  for (;;) {
    out.push(h);
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  return out;
}

/**
 * Entity forms used by uBO-style filters ("example.*").
 * "www.example.com.vn" → ["www.example.com.*", "www.example.*", "example.com.*", "example.*", …]
 */
export function entitySuffixes(hostname) {
  const out = new Set();
  for (const suffix of hostnameSuffixes(hostname)) {
    const labels = suffix.split('.');
    if (labels.length < 2) continue;
    out.add(`${labels.slice(0, -1).join('.')}.*`);
    if (labels.length >= 3 && COMMON_SLD.has(labels[labels.length - 2])) {
      out.add(`${labels.slice(0, -2).join('.')}.*`);
    }
  }
  return [...out];
}

/** All keys a hostname can be filed under: plain suffixes first, then entity forms. */
export function hostnameKeys(hostname) {
  return [...hostnameSuffixes(hostname), ...entitySuffixes(hostname)];
}

/** True if `hostname` equals or is a subdomain of any entry in `domains` (entities allowed). */
export function hostnameMatchesAny(hostname, domains) {
  if (!domains || domains.length === 0) return false;
  const set = domains instanceof Set ? domains : new Set(domains);
  for (const key of hostnameKeys(hostname)) {
    if (set.has(key)) return true;
  }
  return false;
}

/** Hostname of an http(s) URL, or '' for anything else. */
export function hostnameFromURL(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : '';
  } catch {
    return '';
  }
}

/** Registrable-ish site of a hostname (approximation without the Public Suffix List). */
export function siteOf(hostname) {
  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  const n = COMMON_SLD.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
  return labels.slice(-n).join('.');
}
