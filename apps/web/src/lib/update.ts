declare const __BUILD__: string;

/**
 * Keeps an open page on the newest build: checks /version.json when the page comes back
 * into view (e.g. reopened from the home-screen shortcut) and every few minutes.
 * Coming back into view reloads at once when `quiet()` says nothing is open for editing;
 * otherwise `onNew` is told so the page can offer the update.
 */
export function watchUpdates(onNew: () => void, quiet: () => boolean) {
  if (import.meta.env.DEV) return () => {};
  let found = false;
  const check = async (reload: boolean) => {
    try {
      const r = await fetch('/version.json', { cache: 'no-store' });
      const { build } = await r.json();
      if (build && build !== __BUILD__) {
        if (reload && quiet()) location.reload();
        else if (!found) { found = true; onNew(); }
      }
    } catch { /* offline: try again later */ }
  };
  const onVis = () => { if (document.visibilityState === 'visible') check(true); };
  document.addEventListener('visibilitychange', onVis);
  addEventListener('pageshow', onVis);
  const t = setInterval(() => check(false), 5 * 60_000);
  check(true);
  return () => { document.removeEventListener('visibilitychange', onVis); removeEventListener('pageshow', onVis); clearInterval(t); };
}
