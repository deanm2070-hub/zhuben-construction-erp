import { useEffect, useState } from 'react';
import { myReferrals, PLANS, REFERRAL, shareLink, type Account } from '../lib/account';
import { supabase } from '../lib/supabase';
import { Modal } from './Modal';

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('zh-TW') : '');

/** 個人資訊: sign-up date, expiry, successful shares and the share link. */
export function ProfileInfo({ email, account, onClose }: { email: string; account: Account; onClose: () => void }) {
  const p = account.profile;
  const [refs, setRefs] = useState<{ rewarded: number; pending: number } | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    myReferrals().then(setRefs);
    // a referred account sees how far it is towards the reward of the friend who shared
    if (p?.referred_by && !p.referral_rewarded_at && supabase) {
      supabase.from('usage_days').select('minutes').gte('minutes', REFERRAL.minutes).gte('day', p.created_at.slice(0, 10)).then(({ data }) => setDays(data ? data.length : null));
    }
  }, []);
  const link = p?.ref_code ? shareLink(p.ref_code) : '';
  const text = `我在用「築本3D工程估算」：匯入 AutoCAD 圖面自動建 3D、算工程數量。用這個連結申請免費試用：${link}`;
  const copy = async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* not allowed */ } };

  return (
    <Modal title="個人資訊" onClose={onClose} actions={<button className="chip on" onClick={onClose}>關閉</button>}>
      <div className="info">
        <div><span>帳號</span><b>{email}</b></div>
        <div><span>註冊時間</span><b>{p ? new Date(p.created_at).toLocaleString('zh-TW') : '—'}</b></div>
        <div><span>帳號期限</span><b>{account.admin ? '管理員（不限期）' : p ? `${p.expires_at ? `${date(p.expires_at)} 到期` : '不限期'}・${PLANS[p.plan] || p.plan}` : '—'}</b></div>
        <div><span>成功分享次數</span><b>{refs ? `${refs.rewarded} 次${refs.pending ? `（另有 ${refs.pending} 位進行中）` : ''}` : '—'}</b></div>
        {days !== null && <div><span>試用活動進度</span><b>{Math.min(days, REFERRAL.days)} / {REFERRAL.days} 天</b></div>}
      </div>
      {link && <>
        <p className="note">分享給朋友：對方用你的連結申請試用，並在開通後 {REFERRAL.within} 天內有 {REFERRAL.days} 天、每天累計上線滿 {REFERRAL.minutes / 60} 小時，你的帳號就自動延長 {REFERRAL.reward} 天（每個帳號限延長一次）。</p>
        <input id="share-link" type="text" readOnly value={link} onFocus={e => e.target.select()} />
        <div className="kv">
          <button className="chip" onClick={copy}>{copied ? '已複製' : '複製連結'}</button>
          <a className="chip key" style={{ textDecoration: 'none' }} href={`https://line.me/R/share?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener">用 LINE 分享</a>
        </div>
      </>}
    </Modal>
  );
}
