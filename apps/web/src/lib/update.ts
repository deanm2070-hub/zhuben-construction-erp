declare const __BUILD__: string;

/**
 * Tells an open page (or home-screen shortcut) that a newer build is live: checks /version.json
 * when the page comes back into view or gets focus, and every minute. The page never reloads by itself;
 * `onNew` gets the new version name so the user can update when their work is done. A push takes the
 * Workers build 2–4 minutes to go live, so a new version shows up at most a minute after that.
 */
export function watchUpdates(onNew: (version: string, notes: string[]) => void) {
  if (import.meta.env.DEV) return () => {};
  let told = '';
  const check = async () => {
    try {
      const r = await fetch('/version.json', { cache: 'no-store' });
      const { build, version, notes } = await r.json();
      if (build && build !== __BUILD__ && build !== told) {
        told = build;
        // a short buzz on phones that allow it (Android); iPhone browsers ignore it
        try { navigator.vibrate?.([60, 80, 60]); } catch { /* not supported */ }
        onNew(version || '', Array.isArray(notes) ? notes : []);
      }
    } catch { /* offline: try again later */ }
  };
  const onVis = () => { if (document.visibilityState === 'visible') check(); };
  document.addEventListener('visibilitychange', onVis);
  addEventListener('pageshow', onVis);
  addEventListener('focus', onVis);
  addEventListener('online', check);
  const t = setInterval(check, 60_000);
  check();
  return () => { document.removeEventListener('visibilitychange', onVis); removeEventListener('pageshow', onVis); removeEventListener('focus', onVis); removeEventListener('online', check); clearInterval(t); };
}

/** A part of the app loaded on demand (DWG reader, SketchUp reader, exports) that this page's build no longer finds on the site. */
export const isStaleChunk = (e: unknown) => /dynamically imported module|Importing a module script failed|error loading dynamically imported|Unable to preload CSS|ChunkLoadError/i.test(String((e as Error)?.message || e));
export const STALE_MSG = '網站剛更新到新版本，這個頁面還是舊版，找不到舊版的讀檔元件。請按「更新並重試」，頁面重新載入後再匯入一次（專案已自動存檔）。';
