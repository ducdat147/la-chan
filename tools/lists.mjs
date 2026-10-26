// Filter lists bundled with Lá Chắn. Order matters: it is the order shown in the UI.
// `urls` are tried in order; the first that answers with a filter list wins.
// `extra` sources only contribute the lines selected by `pick` (see build-filters.mjs).

export const LISTS = [
  {
    id: 'easylist',
    title: 'EasyList',
    category: 'ads',
    description: 'Bộ lọc quảng cáo quốc tế phổ biến nhất (banner, pop-up, video).',
    defaultEnabled: true,
    homepage: 'https://easylist.to/',
    license: 'GPLv3 / CC BY-SA 3.0',
    sources: [
      {
        cache: 'easylist.txt',
        urls: [
          'https://easylist.to/easylist/easylist.txt',
          'https://raw.githubusercontent.com/easylist/easylist/gh-pages/easylist.txt',
          'https://raw.githubusercontent.com/uBlockOrigin/uAssets/gh-pages/thirdparties/easylist.txt',
        ],
      },
    ],
  },
  {
    id: 'abpvn',
    title: 'ABPVN',
    category: 'ads',
    description: 'Quảng cáo, pop-up và chuyển hướng trên các trang tiếng Việt.',
    defaultEnabled: true,
    homepage: 'https://abpvn.com/',
    license: 'GPLv3',
    sources: [
      {
        cache: 'abpvn.txt',
        urls: [
          'https://abpvn.com/filter/abpvn-IPl6HE.txt',
          'https://raw.githubusercontent.com/abpvn/abpvn/master/filter/abpvn.txt',
        ],
      },
      {
        // uBO flavour of the same list: we only take its scriptlets and :style() rules.
        cache: 'abpvn_ublock.txt',
        pick: 'scriptlets-and-styles',
        urls: ['https://raw.githubusercontent.com/abpvn/abpvn/master/filter/abpvn_ublock.txt'],
      },
    ],
  },
  {
    id: 'youtube',
    title: 'Lá Chắn – YouTube',
    category: 'ads',
    description: 'Quảng cáo trong video và trên giao diện YouTube, kèm tự động bỏ qua quảng cáo còn sót.',
    defaultEnabled: true,
    homepage: '',
    license: 'MIT',
    sources: [{ file: 'filters-src/youtube.txt' }],
  },
  {
    id: 'easyprivacy',
    title: 'EasyPrivacy',
    category: 'privacy',
    description: 'Chặn trình theo dõi, pixel đo lường và thu thập dữ liệu hành vi.',
    defaultEnabled: true,
    homepage: 'https://easylist.to/',
    license: 'GPLv3 / CC BY-SA 3.0',
    sources: [
      {
        cache: 'easyprivacy.txt',
        urls: [
          'https://easylist.to/easylist/easyprivacy.txt',
          'https://raw.githubusercontent.com/easylist/easylist/gh-pages/easyprivacy.txt',
          'https://raw.githubusercontent.com/uBlockOrigin/uAssets/gh-pages/thirdparties/easyprivacy.txt',
        ],
      },
    ],
  },
  {
    id: 'cookies',
    title: 'EasyList Cookie',
    category: 'annoyances',
    description: 'Ẩn thông báo xin phép cookie. Tắt sẵn vì đôi khi làm lỗi trang.',
    defaultEnabled: false,
    homepage: 'https://easylist.to/',
    license: 'GPLv3 / CC BY-SA 3.0',
    sources: [
      {
        cache: 'easylist-cookies.txt',
        urls: [
          'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
          'https://raw.githubusercontent.com/uBlockOrigin/uAssets/gh-pages/thirdparties/easylist-cookies.txt',
        ],
      },
    ],
  },
];
