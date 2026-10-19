# 雲端 3D 室內繪圖與工程數量計算

瀏覽器裡的 3D 平面建模工具：匯入 AutoCAD DWG／DXF 或 PDF 平面圖，自動生成牆、門、窗與房間，並依「業主報價單」格式計算結構與裝修數量，可下載 Excel。

## 專案結構

| 路徑 | 內容 |
| --- | --- |
| `packages/core` | 純計算邏輯：DXF 解析、雙線牆配對、房間分割、數量計算（含單元測試） |
| `apps/web` | 前端（Vite＋React＋TypeScript＋Three.js）：登入、專案列表、3D 編輯器、匯入、數量表 |
| `services/dwg-converter` | DWG → DXF 轉檔服務（Node＋GNU LibreDWG，Docker） |
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
VITE_DWG_CONVERTER_URL=https://dwg.example.com
```

`npm run build` 後將 `apps/web/dist` 部署到任一靜態主機（Vercel、Netlify、Cloudflare Pages 等），環境變數在建置時設定。

### 3. DWG 轉檔服務

瀏覽器無法直接讀 DWG，需要這個服務把 DWG 轉成 DXF。詳見 `services/dwg-converter/README.md`。

```bash
cd services/dwg-converter
docker build -t dwg-converter .
docker run -p 8080:8080 \
  -e ALLOWED_ORIGINS=https://your-app.example.com \
  -e SUPABASE_URL=https://xxxx.supabase.co \
  -e SUPABASE_ANON_KEY=... \
  dwg-converter
```

未設定 `VITE_DWG_CONVERTER_URL` 時，匯入 DWG 會提示使用者先在 AutoCAD 另存為 DXF。

## 數量計算說明

- 依房間名稱推定地坪／天花／牆面做法（F1、F2A、F2B、F4、F5、C1、C2、W1A、W1B、W2），可在「空間做法設定」逐房調整。
- 結構：外牆與樓板混凝土、鋼筋（預設 120 kg/m³）、模板。
- 門窗依尺寸分組，並計算填縫與外牆開口防水長度。
- 浴廁 H=1.2M 防水、陽台防水、踢腳板、外牆依方位分面。
- 鋼架、水電、弱電、消防、圍牆、雜項目前標示「另計」。
