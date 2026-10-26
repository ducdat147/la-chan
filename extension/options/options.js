// Lá Chắn — settings page.

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('vi-VN');
const send = (msg) => chrome.runtime.sendMessage(msg);

const CATEGORY = {
  ads: 'Quảng cáo',
  privacy: 'Trình theo dõi',
  annoyances: 'Phiền toái',
};

let state = null;
let savedFilters = '';

function plural(n, word) {
  return `${fmt.format(n)} ${word}`;
}

const pad = (n) => String(n).padStart(2, '0');

function formatDate(d) {
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${time} ngày ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

/** List versions are usually timestamps ("202610011844", "Thu, 01 Oct 2026 …", "2026.10.02"). */
function describeVersion(v) {
  let m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(v);
  if (m) return `Cập nhật lúc ${m[4]}:${m[5]} ngày ${Number(m[3])}/${Number(m[2])}/${m[1]}`;
  m = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/.exec(v);
  if (m) return `Cập nhật ngày ${Number(m[3])}/${Number(m[2])}/${m[1]}`;
  const t = Date.parse(v);
  if (!Number.isNaN(t) && /[a-z]/i.test(v)) return `Cập nhật lúc ${formatDate(new Date(t))}`;
  return `Phiên bản ${v}`;
}

function renderMasthead() {
  const s = state.settings;
  $('global-toggle').checked = s.enabled;
  $('global-status').textContent = s.enabled
    ? 'Đang chặn quảng cáo, pop-up và trình theo dõi trên mọi trang.'
    : 'Đang tắt. Bật công tắc để chặn quảng cáo trở lại.';
}

function renderLists() {
  const ul = $('lists');
  ul.replaceChildren();
  let activeRules = 0;
  for (const list of state.lists) {
    if (list.enabled) activeRules += list.counts.networkRules + list.counts.regexRules;
    const li = document.createElement('li');
    li.className = 'list';
    li.dataset.enabled = String(list.enabled);

    const sw = document.createElement('label');
    sw.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = list.enabled;
    input.id = `list-${list.id}`;
    input.setAttribute('aria-describedby', `list-desc-${list.id}`);
    const track = document.createElement('span');
    track.className = 'track';
    sw.append(input, track);
    input.addEventListener('change', async () => {
      input.disabled = true;
      state = await send({ type: 'options:setList', id: list.id, enabled: input.checked });
      render();
    });

    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'list-title';
    const name = document.createElement('label');
    name.htmlFor = input.id;
    name.textContent = list.title;
    const kind = document.createElement('span');
    kind.className = 'list-kind';
    kind.textContent = CATEGORY[list.category] || list.category;
    title.append(name, kind);
    if (list.homepage) {
      const a = document.createElement('a');
      a.href = list.homepage;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Trang chủ';
      title.append(a);
    }

    const desc = document.createElement('p');
    desc.className = 'list-desc';
    desc.id = `list-desc-${list.id}`;
    desc.textContent = list.description;

    const stats = document.createElement('p');
    stats.className = 'list-stats';
    const parts = [];
    if (list.counts.networkRules) parts.push(plural(list.counts.networkRules + list.counts.regexRules, 'luật chặn mạng'));
    if (list.counts.cosmetic) parts.push(plural(list.counts.cosmetic, 'quy tắc ẩn phần tử'));
    if (list.counts.scriptlets) parts.push(plural(list.counts.scriptlets, 'đoạn mã chống quảng cáo'));
    if (list.counts.popupFilters) parts.push(plural(list.counts.popupFilters, 'mẫu pop-up'));
    let text = parts.join(', ');
    if (list.version) text += `. ${describeVersion(list.version)}.`;
    if (list.enabled && state.settings.enabled && !list.active && list.counts.networkRules > 0) {
      text += ' Chrome chưa bật được luật mạng của danh sách này.';
    }
    stats.textContent = text;

    body.append(title, desc, stats);
    li.append(sw, body);
    ul.append(li);
  }

  const available = state.availableStaticRules;
  $('rules-note').textContent = `Đang dùng ${fmt.format(activeRules)} luật chặn mạng. Chrome luôn cho phép ít nhất ${fmt.format(30000)}`
    + (typeof available === 'number' ? ` và hiện còn trống ${fmt.format(available)} luật.` : '.');

  const err = $('ruleset-error');
  err.hidden = !state.rulesetError;
  err.textContent = state.rulesetError
    ? `Chrome từ chối bật một số danh sách (${state.rulesetError}). Hãy tắt bớt danh sách hoặc tiện ích chặn quảng cáo khác.`
    : '';
}

function renderSites() {
  const ul = $('sites');
  ul.replaceChildren();
  const list = state.settings.allowlist;
  $('sites-empty').hidden = list.length > 0;
  for (const site of list) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = site;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger';
    remove.textContent = 'Bật lại chặn';
    remove.setAttribute('aria-label', `Bật lại chặn trên ${site}`);
    remove.addEventListener('click', async () => {
      const next = state.settings.allowlist.filter((s) => s !== site);
      state.settings.allowlist = await send({ type: 'options:setAllowlist', allowlist: next });
      renderSites();
    });
    li.append(name, remove);
    ul.append(li);
  }
}

function renderOptions() {
  $('opt-popup').checked = state.settings.popupBlocker;
  $('opt-menu').checked = state.settings.contextMenu;
  $('opt-badge').checked = state.settings.showBadge;
  const built = state.builtAt ? formatDate(new Date(state.builtAt)) : 'không rõ';
  $('about-version').textContent = `Phiên bản ${state.version}. Bộ lọc được đóng gói lúc ${built}.`;
}

function render() {
  renderMasthead();
  renderLists();
  renderSites();
  renderOptions();
}

function setSaveStatus(text, kind = '') {
  const el = $('save-status');
  el.textContent = text;
  el.className = `save-status ${kind}`;
}

async function saveFilters() {
  const text = $('user-filters').value;
  $('save-filters').disabled = true;
  setSaveStatus('Đang lưu…');
  const r = await send({ type: 'options:setUserFilters', text });
  $('save-filters').disabled = false;
  if (!r || r.error) {
    setSaveStatus(`Không lưu được: ${r ? r.error : 'không có phản hồi'}.`, 'bad');
    return;
  }
  savedFilters = text;
  const parts = [];
  parts.push(plural(r.network, 'luật mạng'));
  parts.push(plural(r.cosmetic, 'quy tắc ẩn'));
  if (r.popup) parts.push(plural(r.popup, 'mẫu pop-up'));
  let msg = `Đã lưu: ${parts.join(', ')}.`;
  let kind = 'ok';
  if (r.skipped) {
    const sample = (r.skippedSamples || [])[0];
    msg += ` ${plural(r.skipped, 'dòng')} không dùng được nên bị bỏ qua${sample ? `, ví dụ: ${sample}` : ''}.`;
    kind = 'bad';
  }
  if (r.failed && r.failed.length) {
    const first = r.failed[0];
    msg += ` Chrome từ chối ${plural(r.failed.length, 'luật')}: ${first.filter} (${first.error}).`;
    kind = 'bad';
  }
  setSaveStatus(msg, kind);
}

async function main() {
  state = await send({ type: 'options:state' });
  if (!state || state.error) {
    $('global-status').textContent = 'Không đọc được cài đặt. Hãy tải lại trang này.';
    return;
  }
  $('user-filters').value = state.userFilters;
  savedFilters = state.userFilters;
  render();
  requestAnimationFrame(() => document.documentElement.classList.add('ready'));

  if (location.hash === '#chao-mung') $('welcome').hidden = false;
  $('welcome-close').addEventListener('click', () => {
    $('welcome').hidden = true;
    history.replaceState(null, '', location.pathname);
  });

  $('global-toggle').addEventListener('change', async (ev) => {
    await send({ type: 'settings:setEnabled', enabled: ev.target.checked });
    state = await send({ type: 'options:state' });
    render();
  });

  $('add-site').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const raw = $('site-input').value.trim();
    const err = $('site-error');
    if (!raw) return;
    const before = new Set(state.settings.allowlist);
    const next = await send({ type: 'options:setAllowlist', allowlist: [...before, raw] });
    if (next.length === before.size) {
      const guess = raw.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#:]/)[0].replace(/^www\./, '');
      err.hidden = false;
      err.textContent = next.includes(guess)
        ? `${guess} đã có trong danh sách.`
        : `“${raw}” không phải tên miền hợp lệ. Hãy nhập dạng tuoitre.vn.`;
      return;
    }
    err.hidden = true;
    state.settings.allowlist = next;
    $('site-input').value = '';
    renderSites();
  });

  $('save-filters').addEventListener('click', saveFilters);
  $('user-filters').addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
      ev.preventDefault();
      saveFilters();
    }
  });
  $('user-filters').addEventListener('input', () => {
    if ($('user-filters').value !== savedFilters) setSaveStatus('Có thay đổi chưa lưu.');
    else setSaveStatus('');
  });

  for (const [id, key] of [['opt-popup', 'popupBlocker'], ['opt-menu', 'contextMenu'], ['opt-badge', 'showBadge']]) {
    $(id).addEventListener('change', async (ev) => {
      await send({ type: 'options:setOption', key, value: ev.target.checked });
      state.settings[key] = ev.target.checked;
    });
  }

  // Keep in sync when the popup changes something while this page is open.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    state = await send({ type: 'options:state' });
    renderMasthead();
    renderLists();
    renderSites();
  });
}

main();
