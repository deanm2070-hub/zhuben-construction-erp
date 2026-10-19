# 雲端 3D 室內繪圖與工程數量計算

瀏覽器裡的 3D 平面建模工具：匯入 AutoCAD DWG／DXF 或 PDF 平面圖，自動生成牆、門、窗與房間，並依「業主報價單」格式計算結構與裝修數量，可下載 Excel。

## 專案結構

| 路徑 | 內容 |
| --- | --- |
| `packages/core` | 純計算邏輯：DXF 解析、整套執照圖辨識（樓層、樓高、門窗表）、雙線牆配對、房間分割、數量計算（含單元測試） |
| `apps/web` | 前端（Vite＋React＋TypeScript＋Three.js）：登入、專案列表、3D 編輯器、匯入、數量表 |
| `services/dwg-converter` | DWG → DXF 轉檔服務（選用；前端已可直接讀 DWG） |
| `supabase/migrations` | 資料庫與檔案儲存的結構及權限（RLS） |

## 本機開發

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 核心模組測試
npm run typecheck
npm run build
```

未設定 Supabase 時，前端會以「本機模式」運作，專案存在瀏覽器的 IndexedDB，不需登入。

## 正式部署

### 1. Supabase（帳號、資料庫、檔案）

1. 在 supabase.com 建立專案。
2. 在 SQL Editor 執行 `supabase/migrations/0001_projects.sql`（或使用 `supabase db push`）。
3. Authentication → Providers 啟用 Email。
4. 記下 Project URL 與 anon key。

### 2. 前端

複製 `apps/web/.env.example` 為 `apps/web/.env` 並填入：

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=...
```

`npm run build` 後將 `apps/web/dist` 部署到任一靜態主機，環境變數在建置時設定。

**Cloudflare Workers**（已附 `wrangler.jsonc`）：Workers & Pages → Create → 連接此 repo，Build command `npm run build`、Deploy command `npx wrangler deploy`，並在 Advanced settings → Build variables 加入上面兩個 `VITE_` 變數。

### 3. DWG

DWG 直接在瀏覽器讀取（`@mlightcad/libredwg-web`，LibreDWG 編譯成 WebAssembly，約 10 MB，第一次開 DWG 才下載），不需要轉檔服務。
注意：LibreDWG 為 GPL-3.0 授權。

## 整套執照圖自動建模

一個 DWG／DXF 裡放了各層平面圖、立面或剖面圖、門窗表時（常見的執照圖），匯入會自動：

- 依圖名找出各張圖（「一層平面圖」「三層及四層平面圖」「屋突一層平面圖」「屋頂層平面圖」…），並排除綠化、檢討、面積計算等圖。
- 從立面或剖面圖的樓層標示（1F、2F…R1F、RF）算出各層樓板高程與樓高；屋頂層的牆當作女兒牆（高度取圖上「女兒牆高度」文字，預設 120）。
- 讀門窗表：編號旁的「寬x高 名稱」，窗台高由該格的立面小圖量出（窗框下緣到 FL 線，依圖面比例換算）。
- 各層平面用軸線編號（1 與 A）對齊後疊起來；牆、柱圖層建牆，門弧與門窗圖層的線找出開口，套用旁邊門窗編號的高度與窗台高，並補上窗台與窗楣。
- 3D 可切換「整棟／1F／2F…」，數量計算分層計算後合計，房間名稱前面加樓層（例如「2F 客餐廳」）。

## 數量計算說明

- 依房間名稱推定地坪／天花／牆面做法（F1、F2A、F2B、F4、F5、C1、C2、W1A、W1B、W2），可在「空間做法設定」逐房調整。
- 結構：外牆與樓板混凝土、鋼筋（預設 120 kg/m³）、模板。
- 門窗依尺寸分組，並計算填縫與外牆開口防水長度。
- 浴廁 H=1.2M 防水、陽台防水、踢腳板、外牆依方位分面。
- 鋼架、水電、弱電、消防、圍牆、雜項目前標示「另計」。
