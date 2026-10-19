import { supabase } from './supabase';

const base = (import.meta.env.VITE_DWG_CONVERTER_URL as string | undefined)?.replace(/\/$/, '');
export const dwgConverterReady = !!base;

/** Sends a DWG file to services/dwg-converter and returns the DXF text. */
export async function convertDwg(file: File): Promise<ArrayBuffer> {
  if (!base) throw new Error('尚未設定 DWG 轉檔服務');
  const headers: Record<string, string> = {};
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = new FormData();
  body.append('file', file);
  const res = await fetch(`${base}/convert`, { method: 'POST', body, headers });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(msg || `轉檔服務回應 ${res.status}`);
  }
  return res.arrayBuffer();
}
