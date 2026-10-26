// Unit tests for the shared filter parser. Run: npm run test:parser
import assert from 'node:assert/strict';
import {
  parseFilterList, compileNetworkRules, normalizeUrlPattern, patternToRegExpSource, serializeCosmetic, PRIORITY,
} from '../extension/lib/filter-parser.js';
import { compileProcedural, hasProceduralOperator } from '../extension/lib/procedural.js';
import { hostnameKeys, toASCIIHostname } from '../extension/lib/hosts.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
};

const rulesOf = (text) => compileNetworkRules(parseFilterList(text).network).rules;
const one = (text) => {
  const rules = rulesOf(text);
  assert.equal(rules.length, 1, `expected 1 rule for ${text}, got ${JSON.stringify(rules)}`);
  return rules[0];
};

test('url patterns', () => {
  assert.equal(normalizeUrlPattern('||Example.COM^'), '||example.com^');
  assert.equal(normalizeUrlPattern('||*ads.js'), 'ads.js');
  assert.equal(normalizeUrlPattern('*/banner/*'), '/banner/');
  assert.equal(normalizeUrlPattern('*'), '');
  assert.equal(normalizeUrlPattern('||bücher.de/ads'), '||xn--bcher-kva.de/ads');
  assert.equal(normalizeUrlPattern('/quảng-cáo/'), '/qu%E1%BA%A3ng-c%C3%A1o/');
  assert.equal(normalizeUrlPattern('foo bar'), null);
});

test('popup regex', () => {
  const re = new RegExp(patternToRegExpSource('||ads.example.com^'), 'i');
  assert.ok(re.test('https://ads.example.com/x'));
  assert.ok(re.test('https://www.ads.example.com/'));
  assert.ok(!re.test('https://notads.example.com.evil/'));
  assert.ok(new RegExp(patternToRegExpSource('|https://x.com/a*b|')).test('https://x.com/a123b'));
});

test('pure host filters merge into requestDomains', () => {
  const rules = rulesOf('||a.com^\n||b.com^\n||sub.a.com^\n||c.com^$third-party\n||a.com^$third-party');
  const plain = rules.find((r) => !r.condition.domainType);
  assert.deepEqual(plain.condition, { requestDomains: ['a.com', 'b.com'] });
  const third = rules.find((r) => r.condition.domainType);
  assert.deepEqual(third.condition, { requestDomains: ['c.com'], domainType: 'thirdParty' }); // a.com subsumed
});

test('subsumption drops rules covered by a whole-domain block', () => {
  const rules = rulesOf('||ads.com^\n||ads.com/banner/$image\n||x.ads.com^$script\n||keep.com/ad$image\n||ads.com/a$important');
  assert.equal(rules.length, 3);
  assert.ok(rules.some((r) => r.condition.urlFilter === '||keep.com/ad'));
  assert.ok(rules.some((r) => r.priority === PRIORITY.IMPORTANT_BLOCK));
});

test('options → conditions', () => {
  const r = one('/ads/banner.$script,image,third-party,domain=a.com|~b.a.com,match-case');
  assert.deepEqual(r.action, { type: 'block' });
  assert.equal(r.condition.urlFilter, '/ads/banner.');
  assert.deepEqual(r.condition.resourceTypes, ['image', 'script']);
  assert.equal(r.condition.domainType, 'thirdParty');
  assert.deepEqual(r.condition.initiatorDomains, ['a.com']);
  assert.deepEqual(r.condition.excludedInitiatorDomains, ['b.a.com']);
  assert.equal(r.condition.isUrlFilterCaseSensitive, true);

  const neg = one('/track.$~script,~image');
  assert.deepEqual(neg.condition.excludedResourceTypes, ['image', 'main_frame', 'script']);

  const doc = one('.com/smartpop/$document');
  assert.deepEqual(doc.condition.resourceTypes, ['main_frame']);
});

test('exceptions and priorities', () => {
  const allow = one('@@||cdn.com/ads.js$script,domain=site.vn');
  assert.equal(allow.action.type, 'allow');
  assert.equal(allow.priority, PRIORITY.ALLOW);
  const doc = one('@@||site.vn^$document');
  assert.equal(doc.action.type, 'allowAllRequests');
  assert.deepEqual(doc.condition.resourceTypes, ['main_frame', 'sub_frame']);
  const imp = one('||x.com/a.js$important,script');
  assert.equal(imp.priority, PRIORITY.IMPORTANT_BLOCK);
});

test('allow rules get the lowest ids', () => {
  const { rules, allowMaxId } = compileNetworkRules(parseFilterList('/a1.js\n@@/b1.js$image\n/c1.js\n@@/d1.js$script').network);
  assert.equal(allowMaxId, 2);
  assert.ok(rules.slice(0, 2).every((r) => r.action.type === 'allow'));
});

test('redirects', () => {
  const r = one('||g.com/gpt.js$script,redirect=noopjs');
  assert.deepEqual(r.action, { type: 'redirect', redirect: { extensionPath: '/resources/noop.js' } });
  assert.equal(r.priority, PRIORITY.REDIRECT);
  const abp = one('||x.com/v.mp3$rewrite=abp-resource:blank-mp3,domain=y.com');
  assert.equal(abp.action.redirect.extensionPath, '/resources/noop-0.1s.mp3');
  const mp4 = one('||x.com/v.mp4$rewrite=abp-resource:blank-mp4,domain=y.com');
  assert.equal(mp4.action.type, 'block');
  assert.equal(rulesOf('||x.com/ima.js$script,redirect=google-ima.js').length, 0);
});

test('unsupported / unsafe filters are skipped', () => {
  assert.equal(rulesOf('||x.com^$csp=script-src none').length, 0);
  assert.equal(rulesOf('$script,third-party').length, 0); // would block every third-party script
  assert.equal(rulesOf('||x.com^$domain=google.*').length, 0);
  assert.equal(rulesOf('||x.com^$unknownoption').length, 0);
});

test('regex filters are kept apart', () => {
  const { rules, regexRules } = compileNetworkRules(parseFilterList('/^https?:\\/\\/ads\\d+\\./$script').network);
  assert.equal(rules.length, 0);
  assert.equal(regexRules.length, 1);
  assert.equal(regexRules[0].condition.regexFilter, '^https?:\\/\\/ads\\d+\\.');
});

test('badfilter', () => {
  assert.equal(rulesOf('||x.com/ad$script\n||x.com/ad$script,badfilter').length, 0);
});

test('popup filters', () => {
  const { popups, network } = parseFilterList('||pop.com^$popup\n||shopee.vn^$popup,domain=phim.vn\n@@||ok.com^$popup');
  assert.equal(network.length, 0);
  assert.deepEqual(popups[0], { x: 0, h: 'pop.com' });
  assert.deepEqual(popups[1], { x: 0, h: 'shopee.vn', inc: ['phim.vn'] });
  assert.equal(popups[2].x, 1);
});

test('cosmetic filters', () => {
  const { cosmetic } = parseFilterList([
    '##.ad-banner', '###ad_top', '##div[id^="div-gpt-ad"]', '~site.com##.foo',
    'site.com,~m.site.com##.sponsored', 'site.com##.promo', 'site.com#@#.ad-banner',
    '#@#.legit', 'site.com##.box:has-text(Quảng cáo)', 'site.com##.top {top:0 !important}',
    'site.com##.x:style(color: red)', 'site.com##.gone {remove:true;}', 'site.com##.bad {background:url(x)}',
    'site.com##article:has(header:has(.sp))', '@@||nohide.com^$elemhide', '@@||nogeneric.com^$generichide',
  ].join('\n'));
  const c = serializeCosmetic(cosmetic);
  assert.deepEqual(c.genericClasses, ['ad-banner']);
  assert.deepEqual(c.genericIds, ['ad_top']);
  assert.deepEqual(c.genericComplex, ['div[id^="div-gpt-ad"]']);
  assert.deepEqual(c.genericExcluded, [['.foo', ['site.com']]]);
  assert.deepEqual(c.specific['site.com'], [['.sponsored', ['m.site.com']], '.promo']);
  assert.deepEqual(c.exceptions['site.com'], ['.ad-banner']);
  assert.deepEqual(c.genericExceptions, ['.legit']);
  assert.deepEqual(c.styles['site.com'], [['.top', 'top:0 !important'], ['.x', 'color: red']]);
  const plans = c.procedural['site.com'];
  assert.deepEqual(plans[0], { t: [['css', '.box'], ['has-text', { s: 'Quảng cáo' }]] });
  assert.deepEqual(plans[1], { t: [['css', '.gone']], a: ['remove'] });
  assert.deepEqual(plans[2], { t: [['css', 'article'], ['has', { t: [['css', 'header:has(.sp)']] }]] });
  assert.equal(plans.length, 3);
  assert.deepEqual(c.elemhide, ['nohide.com']);
  assert.deepEqual(c.generichide, ['nogeneric.com']);
});

test('procedural compiler', () => {
  assert.ok(hasProceduralOperator('div:has-text(Ad)'));
  assert.ok(!hasProceduralOperator('div:has(> .ad)'));
  assert.ok(hasProceduralOperator('div:-abp-has(.ad)'));
  assert.deepEqual(compileProcedural('div:-abp-has(.ad)'), { t: [['css', 'div:has(.ad)']] });
  assert.deepEqual(compileProcedural('.a:has-text(/sponsor(ed)?/i):upward(2)'),
    { t: [['css', '.a'], ['has-text', { re: 'sponsor(ed)?', f: 'i' }], ['upward', 2]] });
  assert.deepEqual(compileProcedural('div:has(> span:has-text(Ad)) > p'),
    { t: [['css', 'div'], ['has', { t: [['css', '> span'], ['has-text', { s: 'Ad' }]] }], ['spath', ' > p']] });
  assert.deepEqual(compileProcedural('div:not(:has-text(keep))'),
    { t: [['css', 'div'], ['not', { t: [['has-text', { s: 'keep' }]] }]] });
  assert.deepEqual(compileProcedural('.c:matches-css(position: fixed)'),
    { t: [['css', '.c'], ['matches-css', { p: null, n: 'position', v: { s: 'fixed' } }]] });
  assert.equal(compileProcedural('div:-abp-properties(width: 300px)'), null);
  assert.equal(compileProcedural('div:style(background: url(x))'), null);
  assert.deepEqual(compileProcedural(':xpath(//div[@id="x"])'), { t: [['xpath', '//div[@id="x"]']] });
});

test('scriptlets', () => {
  const r = parseFilterList([
    'site.vn##+js(acs, $, popup)', 'site.vn##+js(nowoif)', 'a.vn,b.vn##+js(set, foo.bar, undefined)',
    'site.vn##+js(aeld, /^(?:click|mousedown)$/, _0x)', 'x.vn##+js(trusted-click-element, .btn)',
    '##+js(nowoif)', 'sub.site.vn#@#+js(nowoif)', 'site.vn##+js(json-prune, a.b c, , )',
  ].join('\n'));
  const site = [...r.scriptlets.get('site.vn').values()];
  assert.deepEqual(site[0], ['abort-current-script', '$', 'popup']);
  assert.deepEqual(site[1], ['no-window-open-if']);
  assert.deepEqual(site[2], ['add-event-listener-defuser', '/^(?:click|mousedown)$/', '_0x']);
  assert.deepEqual(site[3], ['json-prune', 'a.b c']);
  assert.deepEqual([...r.scriptlets.get('a.vn').values()][0], ['set-constant', 'foo.bar', 'undefined']);
  assert.ok(!r.scriptlets.has('x.vn'));
  assert.ok(!r.scriptlets.has('*')); // generic scriptlets are not allowed by default
  assert.deepEqual([...r.scriptletExceptions.get('sub.site.vn')], ['["no-window-open-if"]']);
});

test('hosts', () => {
  assert.equal(toASCIIHostname('Bücher.DE'), 'xn--bcher-kva.de');
  assert.equal(toASCIIHostname('bad host'), null);
  const keys = hostnameKeys('www.example.com.vn');
  for (const k of ['www.example.com.vn', 'example.com.vn', 'com.vn', 'vn', 'example.*', 'example.com.*']) {
    assert.ok(keys.includes(k), k);
  }
});

console.log(`✓ ${passed} nhóm kiểm thử bộ phân tích đã qua`);
