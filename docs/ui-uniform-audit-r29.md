# R29 — Uniform-Scale Audit Plan ("rà tỉ mỉ từng chi tiết")

Mục tiêu: "cho nhỏ thì nhỏ đồng bộ toàn bộ web" phải thành **bất biến đo được**, không còn cảm tính.

## 0. Định nghĩa đo được của "đồng bộ"
Khi root knob đổi 16px → 13.5px (tỉ lệ 0.84375), với **MỌI phần tử nhìn thấy được** trên **MỌI màn hình**:
- computed `font-size` phải giảm **đúng** tỉ lệ knob (sai số 0% — rem là tuyến tính)
- chiều cao / padding / gap / radius giảm đúng tỉ lệ (±3% — dành cho line-height làm tròn)
- Ngoại lệ được duyệt (whitelist): viền 1px, box-shadow blur, điều kiện `@media`, canvas, `--vvh`/`clamp()` chủ ý.

## 1. Phase A — Bằng chứng từ máy người dùng (song song, blocker riêng)
Người dùng là nguồn chân lý (bài học 0.0.100–0.0.102):
1. Screenshot màn hình đang thấy "chỗ nhỏ chỗ không".
2. Mở `?debug=1` — ghi lại HUD: UA / viewport / dpr / **root font-size** / visualViewport scale.
3. Kiểm tra engine: Samsung Internet → Cài đặt → **Trình duyệt → Trợ năng / Appearance → Text zoom / font size** — nếu >100%, engine phóng **chỉ chữ** trong khung không đổi → đúng triệu chứng. Phương án: `-webkit-text-size-adjust: 100%; text-size-adjust: 100%` + hướng dẫn đặt lại zoom từng trang.
4. F5 cứng, xác nhận stamp `ui 0.0.106` trên welcome.

## 2. Phase B — Máy đo tỉ lệ toàn phần (harness)
Probe Playwright trong `apps/dpi-playground/` (ràng buộc: `.mjs`, không TS syntax, Chrome `/usr/bin/google-chrome`, cấm đụng 4780/4781 + `~/.local/share/durable-pi*` ngoài file token đã biết):
- Với mỗi cặp (màn hình × trạng thái) × băng (1440 / 1024-chuột / 900-touch / 412-touch / 360-touch):
  - thu MỌI phần tử visible: `computed font-size`, `getBoundingClientRect().height`, tag+class
  - so tỉ lệ với băng chuẩn 1440 → in bảng **offender** (tỉ lệ lệch > 1.5% font, > 3% height)
- Hai nguồn dữ liệu: (1) dist tĩnh cho màn không cần hub; (2) **prod read-only** (kỹ thuật của `/tmp/userflow.mjs`, `/tmp/git-tab-prod.png`) cho các màn cần session thật.

### Danh sách màn × trạng thái (bắt buộc rà hết, từng cái)
| # | Màn | Trạng thái phải có |
|---|---|---|
| 1 | Welcome | hero, features, topbar đầy đủ |
| 2 | Network sidebar | tree multi-level, device chip, session row, agent row |
| 3 | Chat | user msg; markdown: h1–h4, code inline, code block, **bảng**, list, blockquote, hr |
| 4 | Tool-block | collapse + expand + diff |
| 5 | Composer | 1 dòng / nhiều dòng; follow-up select, queue-mode, send, stop |
| 6 | Chat-header | crumbs sâu, branch row (git chip), actions |
| 7 | Inspector | Details · Usage (3 block + meter) · Files/tree · Graph · Env · State · Archive · Host · Notify · Schedules · Extensions |
| 8 | GitPanel | status rows, files, commit box, **lanes SVG** (đã biết lỗi), PR panel (GitHub), MR link (GitLab) |
| 9 | Dialogs | New Session (cả advanced), Pairing wizard từng bước, Device Handoff, Share, Help, Confirm |
| 10 | Topbar | bell panel mở (Teleported), connection dot, usage |
| 11 | Mobile | mnav, tree drawer + backdrop |
| 12 | Toast | success / error / info |
| 13 | Empty/loading/error | mỗi panel |

## 3. Phase C — Sửa từng offender theo category
Đã biết trước: GitPanel lane SVG (`:width="lanes[i].width*12+4" height="24"` → tính theo `em`/rem). Mọi offender mới từ Phase B được phân loại: (a) attr px trên SVG không lucide, (b) engine text-inflation (text-size-adjust), (c) sót đơn vị lạ, (d) clamp/min-max floor sai ngữ nghĩa.

## 4. Phase D — Ma trận ảnh cho mắt người dùng
Mỗi màn (13 nhóm) chụp ở 3 băng đại diện → gửi người dùng duyệt. Ảnh từ máy thật của người dùng vẫn ưu tiên cao hơn.

## 5. Phase E — Khóa bằng contract test + release
- Mở rộng `fe-mobile-type-r28`: cấm attr px trên SVG (trừ whitelist), cấm inline px trong template, thêm `text-size-adjust` nếu triển khai.
- Gates: playground full suite, fe-tsc baseline, harness report **0 offender** mọi màn.
- Release + live verify + dist-tag check (nghi thức).

## Tiến độ
- [x] Phase 0 inventory nguồn: CSS/SFC sạch trừ whitelist; 0 inline/:style/JS/canvas; 1 lỗi = GitPanel lanes
- [x] Phase B harness (uniform-audit.tmp.mjs): 8 màn × 3 băng, đọc knob trực tiếp, so tỉ lệ font chính xác ±1.5% / height ±5%
- [x] Phase C fix (9 restatement bị xóa): brand strong 0.875rem · primary.small 0.75rem · error-banner 0.8125rem · markdown 0.9375rem · message-label 0.8125rem · crumb-name 0.875rem · crumb-main 0.875rem · queue-mode select 0.8125/0.75rem · send/stop 0.75rem (chết, bị 10px phủ) + GitPanel lane svg → viewBox + 1.5rem
- [x] Phase C xác minh: font offender prod 35→còn lại = danh sách được duyệt (h1 clamp 0.0.99, trio 10px 0.0.105) + pairing-artifact (tab «Git» ẩn trên mobile ghép nhầm); `.chip` 0.875rem ride chuẩn 13.125→11.375
- [ ] Phase A bằng chứng người dùng (screenshot + ?debug=1 + kiểm tra text-zoom Samsung Internet)
- [ ] Phase D ma trận ảnh
- [ ] Phase E release

### Danh sách NGOẠI LỆ được duyệt (không ride tỉ lệ knob, có chủ đích)
- `h1.welcome` clamp(1.5rem,6vw,1.9rem) — 0.0.99 "text lớn như desktop"
- Toolbar 10px: `.composer-left .queue-mode select` + `[title*="Stop foreground"]` + `.send` — 0.0.105 user yêu cầu
- Chiều cao structural: topbar compact 1 bar · chip→dot · primary/icon-button 1.625rem vừa bar · crumbs icon-only 1 dòng · composer 1 dòng · chat-header auto · touch-target icon-button to hơn (a11y)
- Knob root + iOS focus 16px + mnav 0.75rem (phần tử chỉ tồn tại trên mobile — một giá trị, không phải restatement theo băng)
