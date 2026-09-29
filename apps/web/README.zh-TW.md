# Kobrixa 網站

使用 React + Vite 建置的網站，包含產品頁面、文件及在瀏覽器中執行的 EV3 媒體工具。

> [English README](README.md)

## 原始碼結構

```text
src/
├── main.tsx                    # React 啟動入口；載入全站與共用控制項樣式
├── vite-env.d.ts               # Vite 資源匯入型別宣告
├── app/
│   ├── app.tsx                # 語言設定保存、Outlet 與路由焦點／捲動行為
│   └── router.tsx             # 路由表與頁面連接
├── components/                # 跨頁面共用的導覽、控制項與 CSS
├── features/
│   ├── home/                  # 首頁與其內容
│   ├── product/               # 功能介紹與下載頁面，以及各自的 CSS
│   ├── docs/                  # 文件頁面、Markdown 匯入與 API 參考
│   └── tools/
│       ├── tools-page.tsx     # 媒體工作室分頁與頁面配置
│       ├── tools.css          # 媒體工作室樣式
│       ├── components/        # 圖片／音訊編輯器與工具專用介面
│       └── lib/               # 轉換、編碼、匯出輔助函式及同目錄測試
└── styles/
    └── global.css             # 既有全站樣式，包含首頁與文件頁樣式
```

各功能專用的元件與邏輯應放在所屬的功能目錄。只有多個頁面功能都會使用的元件，
才放入 `src/components/`。測試以 `*.test.ts` 命名，放在受測模組旁；
網站的 Vitest 設定會遞迴尋找這些測試。
TypeScript 模組請使用帶有 `.js` 副檔名的直接相對匯入，以符合工作區的 NodeNext 慣例。
不需要集中轉匯出的 barrel 檔案。

文件 Markdown 保留在儲存庫的 `docs/` 目錄，由 `features/docs/docs-content.ts` 匯入。
公開靜態檔案放在 `public/`，原始美術素材放在 `artwork/`。
HTML 入口維持為 `/src/main.tsx`。

## 本機指令

從儲存庫根目錄執行：

```sh
pnpm --filter @kobrixa/web dev
pnpm --filter @kobrixa/web check
pnpm --filter @kobrixa/web test
pnpm --filter @kobrixa/web build
```

## 社群素材庫（Gallery）

正式網站：[kobrixa.com/gallery](https://kobrixa.com/gallery)。
2026-09-29 部署的 Worker 版本為 `0eb45157-e081-427c-9720-209091c8da3c`
（新版共用頁尾及法律頁對齊），來源 Git commit 為 `9475456`。
本次更新前、可供回復的正式版本為 `f0559852-25e0-4be9-8f15-a0c81cce59b7`（條款與隱私頁）。
共用控制項更新前、可供回復的穩定版本為 `3d686fa6-fe64-4f0a-a804-bada65ef3829`。
加入 Gallery 前的網站版本為 `ce816d79-1a24-4fd4-b5c2-f93ff63fab35`。

Gallery 在既有單頁應用程式（SPA）中加入 Worker API。
D1 儲存帳號、經雜湊處理的工作階段憑證、作品與審核紀錄；
私有 R2 的 `MEDIA` binding 只保存已驗證的 EV3 成品。
原始素材只在瀏覽器本機解碼，不會傳送到伺服器。
Gallery 介面與 API 錯誤訊息支援繁體中文及英文。

### 本機設定

1. 執行 `pnpm install --frozen-lockfile` 安裝工作區依賴。
2. 將 `apps/web/.dev.vars.example` 複製為 `apps/web/.dev.vars`。請勿提交此檔案。
3. 建立**獨立的開發用 GitHub OAuth App**，首頁網址設為
   `http://localhost:8787`，callback 網址設為 `http://localhost:8787/api/auth/callback`。
   將其 Client ID 與 secret 填入 `.dev.vars`。此 App 不要求儲存庫存取權限。
4. 執行 `pnpm --filter @kobrixa/web db:local`，將 migration 套用至本機 D1。
5. 執行 `pnpm --filter @kobrixa/web preview:worker`，開啟 `http://localhost:8787/gallery`。
   Wrangler 預設使用本機 D1 與 R2，不需要正式環境的資料。

若要使用 Vite 熱更新，請在 `.dev.vars` 設定 `SITE_ORIGIN=http://localhost:5173`，
並將開發用 OAuth callback 改為 `http://localhost:5173/api/auth/callback`。
保持 Wrangler 在連接埠 8787 執行，再啟動 `pnpm --filter @kobrixa/web dev`。
Vite 會將 `/api` 請求代理至該 Worker。
本機 HTTP 使用僅限該主機的 HttpOnly 工作階段 Cookie；
正式環境 HTTPS 使用帶有 Secure 屬性與 `__Host-` 前綴的 Cookie。
請勿將本機伺服器公開到網際網路。

`pnpm --filter @kobrixa/web check` 會透過 Wrangler 產生執行環境／binding 型別，
並檢查前端及 Worker 的 TypeScript。產生的執行環境型別檔已被版本控制忽略。
`pnpm --filter @kobrixa/web test` 會執行媒體單元測試及使用獨立資料的 Miniflare 整合測試；
也可單獨執行 `test:worker`。
整合測試模擬 GitHub 伺服器回應，並使用暫存 D1／R2 資料，
不會在應用程式中加入略過登入驗證的開發入口。

### 正式環境設定

正式環境的 `kobrixa-gallery` D1 資料庫與私有 R2 bucket 已建立，
D1 ID 已記錄於 `wrangler.jsonc`。
正式 GitHub OAuth App 為 **Kobrixa Gallery**（application ID：`3878675`），
其公開的 Client ID 也已設定。Client secret 只能保存在 Worker 的 secret binding 中。

若要在新的 Cloudflare 帳號建立環境，請從 `apps/web` 執行：

```sh
pnpm exec wrangler d1 create kobrixa-gallery
pnpm exec wrangler r2 bucket create kobrixa-gallery
```

將回傳的 D1 `database_id` 填入 `wrangler.jsonc` 的 `DB` binding。
R2 bucket 必須保持私有：**不要**啟用 r2.dev 端點或公開 bucket 的自訂網域。
全新部署時，請建立正式 GitHub OAuth App，首頁網址為 `https://kobrixa.com`，
callback 網址為 `https://kobrixa.com/api/auth/callback`。
在 Wrangler 的 vars 中設定 `GITHUB_CLIENT_ID`，再透過互動提示儲存 secret：

```sh
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler d1 migrations apply DB --remote
pnpm run deploy
```

`GALLERY_ADMIN_IDS` 是以逗號分隔的固定數字 ID 清單，不可填入使用者名稱。
伺服器會在每次已登入的請求中檢查此清單。
請勿將任何私密憑證放入 `VITE_*` 變數。
OAuth 設定缺漏時，登入入口會停用，OAuth 端點會回傳 503。

此 migration 只建立 Gallery 的資料表與索引。
日後變更 schema 前，請先使用 `wrangler d1 export DB --remote --output backup.sql` 備份 D1。
若程式碼部署有問題，可使用 `wrangler rollback` 回復版本；不要刪除 Gallery 資料。
每日排程會清除過期的 OAuth state／工作階段，以及最多 100 批超過 24 小時且沒有作品引用的上傳資料。
仍被引用的草稿與已拒絕作品會保留。
上傳批次會在寫入 R2 **之前**記錄，因此未完成或中斷的上傳也能安全清理。
請監控 Worker 的 `gallery_request_failed` 結構化日誌事件、
使用者回報的 OAuth callback 失敗，以及排程執行失敗。

### API 與審核規則

- `GET /api/auth/me`、`GET /api/auth/github`、`GET /api/auth/callback`、
  `POST /api/auth/logout` 提供 GitHub 登入、身分查詢與登出。
- `GET /api/gallery?scope=public|mine|admin&kind=image|audio&q=...&page=1`
  回傳 `{ items, more }`，每頁 24 件作品。
  公開列表依公開時間排序，個人／管理員列表依更新時間排序；時間相同時以 ID 決定順序。
- `POST /api/gallery` 建立草稿；`PUT /api/gallery/:id` 修改作者自己的草稿、
  已拒絕或已撤下作品。兩者皆接受 multipart 的 `title`、`description` 與有順序的 `files`。
  更新時必須提供 `version`；省略檔案欄位會保留現有媒體。
- `GET /api/gallery/:id` 回傳作品資訊。
  `POST /api/gallery/:id/submit` 必須提供 `{ version, agreement: true }`；
  `withdraw`、`approve`、`reject` 與 `takedown` 必須提供 `{ version }`，
  拒絕／下架另需非空白的 `reason`。
- `GET /api/gallery/:id/preview`、`/archive` 與 `/files/:index`
  分別產生預覽、附署名資訊的 ZIP，或下載指定的 EV3 檔案。
  每次請求都會檢查公開狀態、作者身分或管理員權限；所有 API 回應皆使用 `no-store`。

送審後的作品在撤下或完成審核前不可修改。已公開作品必須先撤下才能編輯。
無論由作者撤下或管理員下架，作品都必須重新審核才能再次公開。
SQL 條件式更新可防止依過期版本核准，以及同時進行多項審核決定；
資料庫 trigger 負責強制執行每日限額並記錄變更。
限額 trigger 使用 `SELECT RAISE(...) WHERE ...`，以相容遠端 D1 的 SQL 解析；
請避免在這些 trigger 中使用巢狀 CASE/END。
每日限額以 UTC 計算，每個帳號每天最多送審 20 件作品、上傳 100 批資料。
送審時必須明確同意 CC BY 4.0。草稿不占用送審限額。
若送審失敗，已儲存的草稿仍會保留，可從「我的作品」重試。

原始素材限制：圖片 20 MiB、音訊 50 MiB，選取的輸出範圍最長 60 秒。
可接受的原生格式包括最大 176×128 的 RGF，以及資料長度完全符合標頭的 8 kHz 未壓縮 RSF。
一件作品最多可由八個依序排列的 RSF 組成。
Multipart 請求大小上限為 1 MiB，包含標頭與作品資訊。
檔案使用系統產生的標準名稱；不接受使用者上傳壓縮檔、指令碼、HTML 或任意預覽檔。
Gallery 的音訊預覽使用 RSF 中完全相同的量化 PCM 資料。
ZIP 中的播放程式碼由系統產生，不使用使用者提供的程式碼。
EV3 在檔案交界處可能出現短暫停頓，瀏覽器預覽不會模擬這些停頓。

### 發布驗證

正式環境憑證設定完成後，請使用真實 GitHub 登入流程提交一張圖片及一段長音訊範例。
確認管理員能預覽並核准，且未登入的瀏覽器只能在核准後下載到內容一致的檔案。
撤下或下架各作品，再確認匿名訪客無法透過列表、預覽、ZIP 或檔案直連取得內容。
測試繁中與英文，以及窄螢幕／手機版面。
自動化測試透過模擬 GitHub 回應涵蓋上述狀態與權限邊界，
不會驗證正式 OAuth 憑證或實體 EV3 的播放效果。

## 共用介面控制項

`src/components/ui/` 包含 Select、AudioPlayer、FileDrop 及明確套用類別的控制項樣式。
請依用途加入 `ui-control`、`ui-choice`、`ui-range` 或 `ui-disclosure` 類別，
避免新增影響整個頁面所有 input／button／fieldset 的樣式規則。
Select 使用 portal 顯示選單，支援鍵盤導覽與輸入文字定位，
並讓目前操作的選項保持可見，同時不捲動背後的頁面。
AudioPlayer 按需載入音訊，同一時間只允許一個 Gallery 播放器播放。
FileDrop 保留原生檔案選擇視窗的行為，並遵守 fieldset 的停用狀態。

jsdom 互動測試涵蓋鍵盤選取／取消、選單定位、音訊生命週期／重試／來源替換，
以及檔案選取／拖放狀態。使用 `pnpm exec vitest run --project web` 執行；
Worker 整合測試則可使用 `pnpm --filter @kobrixa/web test:worker` 執行。
