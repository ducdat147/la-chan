# Lá Chắn – chặn quảng cáo cho Chrome

Tiện ích Chrome (Manifest V3) chặn quảng cáo, pop-up và trình theo dõi trên mọi trang web, có xử lý riêng cho trang tiếng Việt và YouTube.

## Lá Chắn làm được gì

- **Chặn ở tầng mạng.** EasyList, EasyPrivacy và ABPVN (danh sách cho web Việt) được biên dịch thành luật `declarativeNetRequest` của Chrome. Hơn 110.000 bộ lọc gốc gộp lại còn khoảng 13.000 luật, nằm gọn trong mức 30.000 luật mà Chrome luôn đảm bảo.
- **Ẩn khung quảng cáo còn sót.** CSS được Chrome chèn với độ ưu tiên của người dùng nên trang web không ghi đè được. Hỗ trợ cả bộ lọc nâng cao như `:has-text()`, `:upward()`, `:remove()`, `:style()`.
- **Đóng pop-up và pop-under** mở tới tên miền quảng cáo có trong danh sách lọc.
- **Chặn quảng cáo bật ra khi bấm vào trang**, kể cả khi tên miền quảng cáo chưa có trong danh sách. Lớp phủ vô hình hay đoạn mã bắt mọi cú click không mở được tab quảng cáo nữa. Với kiểu tab-under, nội dung vẫn mở ở tab mới nhưng tab đang xem không bị đẩy sang trang quảng cáo.
- **Mã chống quảng cáo (scriptlet)** kiểu uBlock Origin cho các trang có pop-up hoặc chặn trình chặn quảng cáo, chủ yếu từ ABPVN.
- **YouTube:** xoá dữ liệu quảng cáo khỏi phản hồi của trình phát, ẩn quảng cáo trên giao diện, tự bấm "Bỏ qua" hoặc tua qua quảng cáo còn lọt, gỡ hộp thoại cấm trình chặn quảng cáo.
- **Chọn phần tử để ẩn** những gì danh sách bỏ sót, từ cửa sổ của tiện ích hoặc menu chuột phải.
- **Tạm dừng theo trang**, bật/tắt từng danh sách, tự viết bộ lọc theo cú pháp Adblock Plus / uBlock Origin.
- Đếm số yêu cầu bị chặn trên từng trang. Không gửi dữ liệu duyệt web đi đâu cả; phông chữ cũng được đóng gói sẵn.

## Cài đặt

1. Giải nén, giữ nguyên cấu trúc thư mục.
2. Mở `chrome://extensions`, bật **Chế độ dành cho nhà phát triển** ở góc trên bên phải.
3. Bấm **Tải tiện ích đã giải nén** và chọn thư mục `extension/` (thư mục chứa `manifest.json`).
4. Bấm biểu tượng mảnh ghép trên thanh công cụ rồi ghim **Lá Chắn**.

Cần Chrome 120 trở lên. Trình duyệt nhân Chromium khác (Edge, Brave, Cốc Cốc…) cũng cài được theo cách tương tự.

## Sử dụng

- **Bấm biểu tượng Lá Chắn** để xem số yêu cầu đã chặn trên trang (con dấu đỏ), tạm dừng trên trang đó, hoặc chọn phần tử để ẩn.
- **Quảng cáo vẫn lọt?** Chọn *Chọn phần tử để ẩn* (hoặc chuột phải → *Chặn phần tử này…*), trỏ vào quảng cáo, bấm, rồi *Ẩn vĩnh viễn*. Quy tắc được lưu trong *Bộ lọc của tôi*.
- **Trang bị lỗi?** Chọn *Tạm dừng trên trang này* rồi tải lại trang.
- **Cài đặt** (chuột phải vào biểu tượng → *Tuỳ chọn*): bật/tắt danh sách, danh sách trang tạm dừng, bộ lọc tự viết, tuỳ chọn pop-up, menu chuột phải và con số trên biểu tượng.

Ví dụ bộ lọc tự viết:

```
||quangcao.example.vn^              chặn mọi yêu cầu tới tên miền này
example.com##.banner-top            ẩn phần tử trên example.com
##.sponsored-box                    ẩn trên mọi trang
example.com##.tin:has-text(Tài trợ) ẩn khối tin có chữ "Tài trợ"
||trang-quang-cao.vn^$popup         tự đóng pop-up mở tới địa chỉ này
@@||example.com/player.js           cho phép một địa chỉ bị chặn nhầm
```

## Cập nhật bộ lọc

Danh sách bộ lọc được đóng gói sẵn vào tiện ích. Để lấy bản mới nhất (nên làm vài tuần một lần):

```bash
pnpm install
pnpm build
```

Sau đó vào `chrome://extensions` và bấm nút tải lại trên thẻ Lá Chắn. Lệnh build tải EasyList, EasyPrivacy, ABPVN và EasyList Cookie (có địa chỉ dự phòng trên GitHub), biên dịch, kiểm tra từng luật theo đúng các điều kiện Chrome áp dụng, rồi in thống kê. Không có mạng thì dùng `pnpm build:offline` với bản đã tải lần trước trong `tools/.cache/`. Danh sách nguồn nằm ở `tools/lists.mjs`; muốn thêm danh sách khác thì thêm một mục vào đó.

## Kiểm thử

```bash
pnpm test                # kiểm thử bộ chuyển đổi bộ lọc (Node)
pnpm test:e2e            # 74 kiểm tra trong Chromium thật (cần Python)
```

`test:e2e` cần `pip install playwright` và `playwright install chromium`. Bộ kiểm thử chạy một máy chủ cục bộ trả lời cho mọi tên miền, nên kiểm được việc chặn thật: yêu cầu bị chặn không bao giờ tới máy chủ. Nó cũng kiểm tra ẩn phần tử, đóng pop-up, chặn lớp phủ quảng cáo và tab-under, tạm dừng theo trang, công cụ chọn, bộ lọc tự viết, scriptlet trên trang Việt, YouTube và chụp ảnh giao diện vào `tests/e2e/out/`. Muốn dùng trình duyệt khác thì đặt `CHROME_PATH` (Chrome bản thường từ 137 trở đi bỏ qua cờ `--load-extension`, hãy dùng Chromium hoặc Chrome for Testing).

## Cách hoạt động

| Phần | Vai trò |
| --- | --- |
| `extension/rules/*.json` | Bộ luật tĩnh, mỗi danh sách một bộ. Bộ lọc chỉ chứa tên miền (`||ads.com^`) được gộp thành một luật `requestDomains`. |
| `extension/background.js` | Service worker: bật/tắt bộ luật, luật động (tạm dừng trang, regex, bộ lọc tự viết), chèn CSS, đóng pop-up, menu chuột phải, biểu tượng. |
| `extension/content/cosmetic.js` | Chạy ở mọi khung trang: xin CSS cho tên miền, gom tên class/id để áp bộ lọc ẩn chung, chạy bộ lọc nâng cao. |
| `extension/scriptlets/*.js` | Scriptlet chạy trong ngữ cảnh trang, chỉ đăng ký cho các tên miền có trong danh sách. |
| `extension/content/click-guard.js` | Chạy trong ngữ cảnh trang ở mọi trang. Chặn tab quảng cáo mở ra từ lớp phủ vô hình hoặc từ mã bắt click của cả trang, và chặn tab-under. |
| `extension/content/youtube.js` | Bỏ qua quảng cáo YouTube còn lọt. |
| `extension/content/picker.js` | Công cụ chọn phần tử. |
| `extension/lib/` | Bộ chuyển đổi cú pháp bộ lọc, dùng chung cho lệnh build và cho bộ lọc tự viết. |
| `tools/` | Lệnh build bộ lọc, mã nguồn scriptlet, kiểm thử đơn vị. |
| `filters-src/youtube.txt` | Danh sách YouTube riêng của Lá Chắn. |

Một vài điểm thiết kế đáng chú ý:

- Chrome từ chối nạp cả tiện ích nếu bộ luật tĩnh có một luật sai. Vì vậy lệnh build kiểm tra từng luật, kiểm tra selector CSS bằng trình phân tích CSS, và đưa luật regex sang luật động, được kiểm tra bằng `isRegexSupported()` lúc chạy.
- Khoảng 13.000 bộ lọc ẩn chung của EasyList chỉ là một class hoặc một id. Thay vì chèn tất cả vào mọi trang, `cosmetic.js` gom các class/id thực sự có trên trang (theo từng đợt nhỏ để không làm giật trang) và service worker chỉ chèn những cái khớp.
- Ngoại lệ (`@@`) được đánh số luật nhỏ hơn luật chặn, nhờ vậy cửa sổ của tiện ích đếm đúng số yêu cầu bị chặn.

## Giới hạn cần biết

- Không trình chặn nào bắt được mọi quảng cáo. Khi gặp quảng cáo lọt, công cụ chọn phần tử là cách nhanh nhất.
- **YouTube** đổi cách phát quảng cáo liên tục, kể cả chèn quảng cáo ngay trên máy chủ. Lá Chắn xử lý nhiều lớp nhưng có thể phải cập nhật `filters-src/youtube.txt` hoặc `content/youtube.js` khi YouTube thay đổi.
- **Bài được tài trợ trên Facebook, TikTok** nằm chung luồng nội dung và bị làm rối mã; các danh sách đi kèm gần như không xử lý được.
- Giới hạn của Manifest V3: Chrome không cho dùng regex vượt 2 KB khi biên dịch (hiện 15/27 bộ lọc regex bị bỏ), không hỗ trợ `$csp`, `$removeparam`. Scriptlet `trusted-*` và một số tài nguyên chuyển hướng của uBlock Origin cũng không có. Lệnh build in ra số bộ lọc bị bỏ qua và lý do.
- Bộ lọc chỉ mới khi build lại (xem phần Cập nhật).
- Khi tải tiện ích dạng giải nén, Chrome tự tạo thư mục `extension/_metadata/`. Đó là dữ liệu tạm, có thể xoá.

## Giấy phép của thành phần bên thứ ba

- EasyList, EasyPrivacy, EasyList Cookie: GPLv3 hoặc CC BY-SA 3.0, theo [easylist.to](https://easylist.to/).
- ABPVN: GPLv3, theo [abpvn.com](https://abpvn.com/).
- Phông chữ Be Vietnam Pro: SIL Open Font License (`extension/fonts/OFL.txt`).

Dữ liệu trong `extension/rules`, `extension/filters` và `extension/scriptlets` được tạo từ các danh sách trên và giữ nguyên giấy phép gốc. Nếu phát hành lên Chrome Web Store, hãy ghi rõ nguồn và tuân thủ các giấy phép này.
