# DWG 轉檔服務

把 DWG 轉成 DXF，給網頁端的匯入流程使用。內部呼叫 [LibreDWG](https://www.gnu.org/software/libredwg/) 的 `dwg2dxf`。

```bash
docker build -t dwg-converter .
docker run -p 8080:8080 -e ALLOWED_ORIGINS=https://你的網域 \
  -e SUPABASE_URL=... -e SUPABASE_ANON_KEY=... dwg-converter
```

| 環境變數 | 說明 |
| --- | --- |
| `ALLOWED_ORIGINS` | 允許呼叫的網頁網域，逗號分隔；預設 `*` |
| `SUPABASE_URL`、`SUPABASE_ANON_KEY` | 設定後只有登入的使用者能轉檔 |
| `MAX_BYTES` | 上傳上限，預設 50 MB |
| `TIMEOUT_MS` | 單檔轉換時限，預設 90 秒 |

部署後把網址填到網頁的 `VITE_DWG_CONVERTER_URL`。可部署到 Fly.io、Render、Cloud Run 等任何能跑 Docker 的地方。

授權：LibreDWG 為 GPLv3，以獨立程序執行，不與網頁程式碼連結。若需要更完整的 DWG 相容性，可改用 ODA File Converter（需申請 ODA 授權），只要替換 `server.js` 裡的轉檔指令。
