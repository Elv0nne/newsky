# Anime47 Repo — SkyStream

Repo extension SkyStream cho **Anime47**, port từ plugin CloudStream gốc (`Anime47Provider.kt` +
`HydraxExtractor.kt`) sang JS (Sky Gen 2).

## ⚠️ Việc cần làm trước khi deploy

### 1. Điền tài khoản Anime47

Mở file `Anime47Provider/plugin.js`, tìm 2 dòng:

```js
const ACCOUNT_EMAIL = "your-email@example.com";
const ACCOUNT_PASSWORD = "your-password";
```

thành tài khoản Anime47 thật.

### 2. Cập nhật lại Cloudflare Worker (BẮT BUỘC — code Worker đã đổi, cần dán lại)

**Vì sao cần Worker:**
- **Server FE** (`vlogphim.net`) dùng CDN `cdn<N>.nonprofit.asia` — CDN này trả về vài byte rác ở
  đầu mỗi đoạn video khiến player không phát được (lỗi phía CDN gốc, không phải lỗi plugin).
- **Server HY** (Hydrax/Abyss: `playhydrax.com`, `abysscdn.com`...) không trả link phát trực tiếp —
  trang embed chứa dữ liệu mã hoá cần giải mã (AES-CTR) mới lấy được link CDN thật, và video được
  chia nhỏ thành từng đoạn 2MB cũng mã hoá riêng.

Cả 2 vấn đề này bản CloudStream gốc xử lý ngay trong app; SkyStream không có cơ chế tương đương nên
cần 1 Worker đứng giữa để xử lý thay.

**Nếu bạn đã tạo Worker `anime47-fix` từ trước, chỉ cần:**

1. Vào **dash.cloudflare.com** → **Workers & Pages** → chọn Worker đã tạo.
2. Bấm **Edit code**.
3. **Xoá hết** code cũ trong ô soạn thảo.
4. Mở file `worker.js` trong repo này (bản mới), copy **toàn bộ nội dung**, dán đè vào.
5. Bấm **Save and Deploy**.

Domain Worker giữ nguyên như cũ, không cần đổi gì trong `plugin.js` nếu tên Worker không đổi.

**Nếu tạo mới từ đầu**, làm theo các bước sau (~5 phút, hoàn toàn qua trình duyệt):

1. Vào **dash.cloudflare.com** → đăng nhập.
2. **Workers & Pages** → **Create** → **Start with Hello World!** → đặt tên (vd `anime47-fix`) → **Deploy**.
3. Bấm **Edit code**, xoá code mẫu, dán toàn bộ nội dung `worker.js`, **Save and Deploy**.
4. Copy domain Worker (dạng `https://anime47-fix.<tên-bạn>.workers.dev`).
5. Mở `Anime47Provider/plugin.js`, điền domain đó vào:
   ```js
   const WORKER_PROXY_BASE = "https://anime47-fix.<tên-bạn>.workers.dev";
   ```

**Kiểm tra Worker hoạt động đúng:**

- Server FE — dán vào trình duyệt (thay `<domain-worker>` và lấy `<url-fe-thật>` từ 1 lần
  `skystream test -f loadStreams`):
  ```
  https://<domain-worker>/proxy?u=<encodeURIComponent(url-fe-thật)>
  ```
  Nếu tải về nội dung `#EXTM3U ...` là đúng.

- Server HY — dán vào trình duyệt (thay `<video_id>` bằng tham số `v=` lấy từ URL HY gốc,
  ví dụ URL gốc `https://playhydrax.com/?v=JDo5MS3Dv&from=...` thì `video_id = JDo5MS3Dv`):
  ```
  https://<domain-worker>/hydrax?v=<video_id>
  ```
  Nếu tải về dữ liệu nhị phân (không phải thông báo lỗi text) là đúng — khó xem trực tiếp bằng
  trình duyệt vì đây là dữ liệu video thô, cách chắc chắn hơn là dán vào VLC (Media → Open Network
  Stream) và bấm Play, phải phát được hình + tiếng bình thường.

> Gói Cloudflare Workers miễn phí cho phép 100.000 request/ngày, dư cho nhu cầu cá nhân.

## 🚀 Deploy plugin lên GitHub

```bash
cd anime47-repo
git init
git add .
git commit -m "init: Anime47 SkyStream plugin"
git branch -M main
git remote add origin https://github.com/Elv0nne/anime47-repo.git
git push -u origin main
```

GitHub Action (`.github/workflows/build.yml`) sẽ tự chạy `skystream deploy` và tạo `dist/plugins.json`.

## 📱 Thêm vào app SkyStream

**Settings → Manage Extensions → Add Repository**, dán:

```
https://raw.githubusercontent.com/Elv0nne/anime47-repo/main/repo.json
```

## 🛠 Test cục bộ (cần máy có `npm`)

```bash
npm install -g skystream-cli
cd Anime47Provider
skystream test -f getHome
skystream test -f search -q "one piece"
skystream test -f load -q "https://anime47.best/anime/one-piece-12345"
skystream test -f loadStreams -q "[123456]"
```

## 📋 Đối chiếu với bản Kotlin gốc

Đã port đầy đủ:
- `getHome`, `search`, `load` (gộp tập theo số tập từ nhiều team/group dịch)
- `loadStreams` (gọi API watch theo từng id tập, map nhãn phụ đề)
- Đăng nhập lấy `access_token`, cache token trong phiên chạy
- **Server FE**: vá lỗi offset byte MPEG-TS của CDN `nonprofit.asia` qua Worker (`/proxy` endpoint)
- **Server HY**: giải mã metadata AES-CTR + ghép segment 2MB qua Worker (`/hydrax` endpoint) —
  thuật toán MD5/AES-CTR/double-base64 trong `worker.js` đã được kiểm chứng khớp byte-for-byte với
  bản Java/Kotlin gốc (`javax.crypto`) trước khi đưa vào.

## 📁 Cấu trúc

```
anime47-repo/
├── Anime47Provider/
│   ├── plugin.json
│   └── plugin.js
├── worker.js             # Cloudflare Worker: /proxy (vá FE) + /hydrax (giải mã HY)
├── package.json
├── repo.json
└── .github/workflows/build.yml
```
