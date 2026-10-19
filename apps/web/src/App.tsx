import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { AuthPage } from './components/AuthPage';
import { Editor } from './components/Editor';
import { ProjectsPage } from './components/ProjectsPage';
import { supabase } from './lib/supabase';

const readRoute = () => {
  const m = location.hash.match(/^#\/p\/([\w-]+)(\/import)?$/);
  return m ? { id: m[1], importNow: !!m[2] } : null;
};

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null);
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  if (supabase && session === undefined) return <div className="page"><div className="wrap"><p className="note">載入中…</p></div></div>;
  if (supabase && !session) return <AuthPage />;
  if (route) return <Editor key={route.id} projectId={route.id} importNow={route.importNow} onExit={() => { location.hash = ''; }} />;
  return <ProjectsPage email={session?.user.email ?? null} onOpen={(id, importNow) => { location.hash = `#/p/${id}${importNow ? '/import' : ''}`; }} />;
}
