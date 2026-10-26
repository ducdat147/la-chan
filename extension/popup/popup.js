// Lá Chắn — toolbar popup.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const fmt = new Intl.NumberFormat('vi-VN');

const RING = {
  active: '★ LÁ CHẮN ★ ĐÃ CHẶN QUẢNG CÁO',
  paused: '★ LÁ CHẮN ★ TẠM DỪNG TRÊN TRANG',
  off: '★ LÁ CHẮN ★ ĐANG TẮT TRÊN MỌI TRANG',
};

const CATEGORY_LABELS = [
  ['ads', 'quảng cáo'],
  ['privacy', 'trình theo dõi'],
  ['annoyances', 'thông báo cookie'],
];

let tabId = null;
let state = null;
let stamped = false;

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function resolveTabId() {
  if (params.has('tabId')) return Number(params.get('tabId'));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

function sealNumber(total) {
  const el = $('seal-number');
  const text = total > 9999 ? '9999+' : String(total);
  el.textContent = text;
  const size = text.length <= 2 ? 34 : text.length === 3 ? 28 : text.length === 4 ? 23 : 19;
  el.setAttribute('font-size', String(size));
}

function render() {
  const root = $('popup');
  const s = state;
  const mode = !s.supported ? 'unsupported' : !s.enabled ? 'off' : s.paused ? 'paused' : 'active';
  root.dataset.mode = mode;

  $('global-toggle').checked = s.enabled;
  $('global-toggle').setAttribute('aria-label', s.enabled ? 'Lá Chắn đang bật trên mọi trang' : 'Lá Chắn đang tắt trên mọi trang');

  $('host').textContent = s.supported ? s.host.replace(/^www\./, '') : 'Trang nội bộ của trình duyệt';

  const status = {
    unsupported: 'Chrome không cho tiện ích chạy trên trang này, nên không có gì để chặn.',
    off: 'Lá Chắn đang tắt. Quảng cáo hiển thị trên mọi trang.',
    paused: 'Đã tạm dừng trên trang này. Quảng cáo và trình theo dõi không bị chặn ở đây.',
    active: 'Đang chặn quảng cáo, pop-up và trình theo dõi trên trang này.',
  }[mode];
  $('status').textContent = status;

  const showTally = mode !== 'unsupported';
  $('tally').hidden = !showTally;
  $('actions').hidden = mode === 'unsupported' || mode === 'off';

  if (showTally) {
    $('seal-ring-text').textContent = RING[mode] || RING.active;
    const total = mode === 'active' ? s.counts.total : 0;
    if (mode === 'active') sealNumber(total);
    else {
      $('seal-number').textContent = '—';
      $('seal-number').setAttribute('font-size', '30');
    }
    $('seal-label').textContent = mode === 'active'
      ? `Đã chặn ${fmt.format(total)} yêu cầu trên trang này`
      : 'Không chặn trên trang này';

    const lead = $('breakdown-lead');
    const list = $('breakdown-list');
    list.replaceChildren();
    if (mode === 'active' && total > 0) {
      lead.textContent = `${fmt.format(total)} yêu cầu bị chặn`;
      for (const [key, label] of CATEGORY_LABELS) {
        const n = s.counts[key] || 0;
        if (n === 0) continue;
        const li = document.createElement('li');
        const strong = document.createElement('strong');
        strong.textContent = fmt.format(n);
        li.append(strong, document.createTextNode(label));
        list.append(li);
      }
    } else if (mode === 'active') {
      lead.textContent = 'Chưa có gì để chặn';
      const li = document.createElement('li');
      li.textContent = 'Trang này chưa tải quảng cáo hay trình theo dõi nào.';
      list.append(li);
    } else if (mode === 'paused') {
      lead.textContent = 'Đang tạm dừng';
      const li = document.createElement('li');
      li.textContent = s.pausedBy.length && s.pausedBy[0] !== s.site
        ? `Do bạn đã tạm dừng cả ${s.pausedBy[0]}.`
        : 'Bật lại bất cứ lúc nào bằng nút bên dưới.';
      list.append(li);
    } else {
      lead.textContent = 'Không chặn gì';
      const li = document.createElement('li');
      li.textContent = 'Bật công tắc phía trên để bảo vệ lại.';
      list.append(li);
    }

    const seal = $('seal');
    if (mode === 'active' && !stamped) {
      stamped = true;
      seal.classList.add('stamp');
    }
  }

  $('pause-label').textContent = mode === 'paused' ? 'Bật lại trên trang này' : 'Tạm dừng trên trang này';
}

function needsReload() {
  $('reload-row').hidden = false;
  $('reload').focus();
}

async function refresh() {
  state = await send({ type: 'popup:state', tabId });
  if (!state || state.error) {
    $('status').textContent = 'Không đọc được trạng thái. Hãy mở lại cửa sổ này.';
    return;
  }
  render();
  requestAnimationFrame(() => document.documentElement.classList.add('ready'));
}

async function main() {
  tabId = await resolveTabId();
  await refresh();

  $('global-toggle').addEventListener('change', async (ev) => {
    await send({ type: 'settings:setEnabled', enabled: ev.target.checked });
    await refresh();
    if (state.supported) needsReload();
  });

  $('pause').addEventListener('click', async () => {
    const target = state.paused && state.pausedBy.length ? state.pausedBy[0] : state.site;
    await send({ type: 'popup:setSitePaused', site: target, paused: !state.paused });
    await refresh();
    needsReload();
  });

  $('pick').addEventListener('click', async () => {
    const res = await send({ type: 'popup:startPicker', tabId });
    if (res && res.ok) window.close();
    else $('status').textContent = 'Không mở được công cụ chọn trên trang này.';
  });

  $('reload').addEventListener('click', async () => {
    await chrome.tabs.reload(tabId);
    window.close();
  });

  $('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

main();
