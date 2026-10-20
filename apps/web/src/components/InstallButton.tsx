import { useEffect, useState } from 'react';

type Prompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/** "Install to desktop": uses the browser's install prompt when it offers one, else says how to do it by hand. */
export function InstallButton() {
  const [ev, setEv] = useState<Prompt | null>(null);
  const [help, setHelp] = useState(false);
  const [done, setDone] = useState(() => matchMedia('(display-mode: standalone)').matches);
  useEffect(() => {
    const on = (e: Event) => { e.preventDefault(); setEv(e as Prompt); };
    const ok = () => { setDone(true); setEv(null); };
    addEventListener('beforeinstallprompt', on);
    addEventListener('appinstalled', ok);
    return () => { removeEventListener('beforeinstallprompt', on); removeEventListener('appinstalled', ok); };
  }, []);
  if (done) return null;
  const click = async () => {
    if (!ev) return setHelp(h => !h);
    await ev.prompt();
    await ev.userChoice;
    setEv(null);
  };
  return (
    <span>
      <button className="chip" id="install-app" onClick={click}>安裝到桌面</button>
      {help && <p className="note">用 Chrome 或 Edge 開啟，按網址列右側的「安裝」圖示（或選單 → 儲存並分享 → 安裝為應用程式），桌面就會出現圖示，之後像一般軟體開啟。</p>}
    </span>
  );
}
