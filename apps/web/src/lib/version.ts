/** Release history shown on the sign-in page; add an entry at the top with every update that goes live. */
export const RELEASES: { v: string; date: string; notes: string[] }[] = [
  { v: 'v0.7', date: '2026-10-20', notes: ['五樓露台四周改成女兒牆（高 150，依立面圖標示），不再被「上方透空遮陽」誤判成沒有邊', '五樓頂（屋突屋頂平台）邊緣改成 120 公分欄杆，依平面圖標示', '手機省電：畫面不動時停止重繪、降低解析度與陰影，減少發燙', '有新版本時 Android 手機會輕震提醒'] },
  { v: 'v0.6', date: '2026-10-20', notes: ['建築圖與結構圖一起匯入時，改用建築圖生成 3D，不再只出現一塊樓板', '登入頁顯示版次與更新內容', '有新版本時只顯示通知，按「更新」才更新'] },
  { v: 'v0.5.2', date: '2026-10-20', notes: ['選檔區整塊都能點，手機點一次就開'] },
  { v: 'v0.5.1', date: '2026-10-20', notes: ['選檔區顯示手機一次勾選多個檔的方法'] },
  { v: 'v0.5', date: '2026-10-20', notes: ['落地窗、捲門、樓板、樓梯、玻璃欄杆、梁', '模板、混凝土與數量計算式', '多檔匯入、手機捷徑自動更新'] },
];
export const VERSION = RELEASES[0].v;
