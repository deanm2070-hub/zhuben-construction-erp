# 築本算圖（雲端 3D 室內繪圖與工程數量計算）

瀏覽器裡的 3D 平面建模工具：匯入 AutoCAD DWG／DXF、SketchUp 模型或 PDF 平面圖，自動生成牆、門、窗與房間，並依「業主報價單」格式計算結構與裝修數量，可下載 Excel。

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
2. 在 SQL Editor 依序執行 `supabase/migrations/0001_projects.sql`、`0002_subscriptions.sql`、`0003_single_device.sql`、`0004_renewal_reminders.sql`、`0005_trial_referrals.sql`、`0006_rename.sql`（或使用 `supabase db push`）。
   0002 加入訂閱控管：每個帳號有方案與到期日，第一個在「我的專案」按「把這個帳號設為管理員」的帳號成為管理員，可在「管理員後台」新增帳號、延長、停用。到期或停用的帳號由資料庫權限（RLS）擋住，打不開專案。
   `0003_single_device.sql`：一個帳號同時只能在一台裝置使用，後登入的裝置接手，先前的裝置被登出（管理員不受限）。
   `0004_renewal_reminders.sql`：每天台灣時間 9 點，資料庫透過 Resend（resend.com）寄續訂提醒信給 14 天內到期的帳號（同一到期日只寄一次）。寄信前先在 SQL Editor 單獨執行 `select vault.create_secret('你的 Resend API 金鑰', 'resend_api_key');`，金鑰加密存在 Supabase Vault，不放在程式或網站。寄件人、回覆信箱、續訂方式在管理員後台設定；Resend 未驗證網域前只能從 onboarding@resend.dev 寄到 Resend 註冊信箱。
   `0005_trial_referrals.sql`：試用改由管理員開通（登入頁連到 LINE @870ufuor），分享碼與推薦人、每日上線分鐘數與登入紀錄；被推薦的帳號開通後 7 天內有 3 天各上線滿 60 分鐘，推薦人自動延長 7 天。
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

## SketchUp 模型

`.skp`（SketchUp 2013 以後）直接在瀏覽器讀取（`openskp`，MIT 授權，第一次開才下載）；SketchUp 匯出的 `.dae`、`.obj`、`.glb`、`.fbx`、`.stl` 也可以。辨識在 `packages/core/src/meshImport.ts`：

- 樓層：面積大的朝上水平面是各層樓板面，下方的朝下面量出板厚；最上面只剩矮牆的是屋頂（RF）。
- 牆：每層每 10 cm 水平切一刀，兩個平行、背對背、相距 3–80 cm 的切線是一道牆的兩面；某段高度兩面都斷開、上面又接回來就是開口，從地面起算是門，有窗台的是窗（窗台、窗楣高度用開口上下的水平面校正）。
- 外牆與室內牆依外側是否接到建築外面判斷；厚 18 cm 以上的室內牆算 RC 牆，其餘算隔間牆。
- 兩個方向都配成對、不超過 120 cm 的短牆是柱；只在上方、底下有梁底面的是梁；高度等差的踏面串是樓梯。
- 名稱看得出是家具、門窗、樓梯的群組／元件（中英文），以及重複擺放的小元件，不當作結構。
- 沒被辨識成構件的面（家具、斜屋頂、裝飾）照原樣顯示，存在專案裡（`cad.meshes`）。

## 數量計算說明

- 依房間名稱推定地坪／天花／牆面做法（F1、F2A、F2B、F4、F5、C1、C2、W1A、W1B、W2），可在「空間做法設定」逐房調整。
- 結構：外牆與樓板混凝土、鋼筋（預設 120 kg/m³）、模板。
- 門窗依尺寸分組，並計算填縫與外牆開口防水長度。
- 浴廁 H=1.2M 防水、陽台防水、踢腳板、外牆依方位分面。
- 鋼架、水電、弱電、消防、圍牆、雜項目前標示「另計」。
