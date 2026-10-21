import { DEFAULT_SETTINGS, type ProjectInfo, type ProjectModel } from '@cloud-modeler/core';
import { supabase } from './supabase';

export type Role = 'owner' | 'editor' | 'viewer';
export interface ProjectMeta { id: string; name: string; updated_at: string; thumbnail: string | null; meta?: ProjectInfo; owner?: string; created_at?: string }
export interface StoredProject extends ProjectMeta { model: ProjectModel }
export interface Member { user_id: string; email: string; role: 'viewer' | 'editor'; added_at: string }
export interface SourceFile { path: string; name: string; size: number; at: string }
/** The team tables come with migration 0011; until it has run, sharing says so instead of failing oddly. */
export const NEEDS_DB = '團隊共用需要資料庫更新（supabase/migrations/0011_team_projects.sql）尚未執行';
const missing = (e: { message?: string; code?: string } | null) => !!e && (e.code === '42P01' || e.code === '42703' || e.code === 'PGRST202' || e.code === 'PGRST204' || /does not exist|schema cache/.test(e.message || ''));

export interface ProjectStore {
  readonly cloud: boolean;
  list(): Promise<ProjectMeta[]>;
  load(id: string): Promise<StoredProject>;
  create(name: string, model: ProjectModel): Promise<string>;
  save(id: string, patch: { name?: string; model?: ProjectModel; thumbnail?: string; meta?: ProjectInfo }): Promise<void>;
  remove(id: string): Promise<void>;
  /** Keeps the original CAD/PDF file next to the project. Returns the stored path. */
  uploadSource(id: string, file: File): Promise<string | null>;
  /** the original files kept for a project, newest first */
  sources(id: string, owner?: string): Promise<SourceFile[]>;
  sourceUrl(path: string): Promise<string>;
  /** the signed-in user's role on a project */
  role(p: ProjectMeta): Promise<Role>;
  members(id: string): Promise<Member[]>;
  share(id: string, email: string, role: 'viewer' | 'editor'): Promise<void>;
  unshare(id: string, userId: string): Promise<void>;
  /** the signed-in user's id (null in local mode) */
  me(): Promise<string | null>;
}

export const emptyModel = (): ProjectModel => ({ objects: [], cad: null, finishes: {}, settings: { ...DEFAULT_SETTINGS } });

/* ---------- local mode: IndexedDB in this browser ---------- */
function idb(): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    const r = indexedDB.open('cloud-modeler', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('projects', { keyPath: 'id' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((ok, no) => {
    const req = fn(db.transaction('projects', mode).objectStore('projects'));
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  });
}
class LocalStore implements ProjectStore {
  readonly cloud = false;
  async list() {
    const all = await tx<StoredProject[]>('readonly', s => s.getAll() as IDBRequest<StoredProject[]>);
    return all.map(({ id, name, updated_at, thumbnail, meta, model }) => ({ id, name, updated_at, thumbnail, meta: meta || model?.info })).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  async load(id: string) {
    const p = await tx<StoredProject | undefined>('readonly', s => s.get(id) as IDBRequest<StoredProject | undefined>);
    if (!p) throw new Error('找不到這個專案');
    return p;
  }
  async create(name: string, model: ProjectModel) {
    const id = crypto.randomUUID();
    await tx('readwrite', s => s.put({ id, name, model, thumbnail: null, updated_at: new Date().toISOString() }));
    return id;
  }
  async save(id: string, patch: { name?: string; model?: ProjectModel; thumbnail?: string; meta?: ProjectInfo }) {
    const p = await this.load(id);
    await tx('readwrite', s => s.put({ ...p, ...patch, updated_at: new Date().toISOString() }));
  }
  async remove(id: string) { await tx('readwrite', s => s.delete(id)); }
  async uploadSource() { return null; }
  async sources() { return []; }
  async sourceUrl(): Promise<string> { throw new Error('本機模式沒有雲端檔案'); }
  async role(): Promise<Role> { return 'owner'; }
  async members() { return []; }
  async share(): Promise<void> { throw new Error('本機模式不能共用，請登入雲端帳號'); }
  async unshare() {}
  async me() { return null; }
}

/* ---------- cloud mode: Supabase (see supabase/migrations) ---------- */
class SupabaseStore implements ProjectStore {
  readonly cloud = true;
  private get db() { return supabase!; }
  /** false once a query found the meta column missing (migration 0011 not run yet) */
  private hasMeta = true;
  private cols(extra = '') { return `id,name,updated_at,created_at,thumbnail,owner${this.hasMeta ? ',meta' : ''}${extra}`; }
  async list() {
    let { data, error } = await this.db.from('projects').select(this.cols()).order('updated_at', { ascending: false });
    if (missing(error) && this.hasMeta) { this.hasMeta = false; ({ data, error } = await this.db.from('projects').select(this.cols()).order('updated_at', { ascending: false })); }
    if (error) throw error;
    return data as unknown as ProjectMeta[];
  }
  async load(id: string) {
    let { data, error } = await this.db.from('projects').select(this.cols(',model')).eq('id', id).single();
    if (missing(error) && this.hasMeta) { this.hasMeta = false; ({ data, error } = await this.db.from('projects').select(this.cols(',model')).eq('id', id).single()); }
    if (error) throw error;
    return data as unknown as StoredProject;
  }
  async create(name: string, model: ProjectModel) {
    const { data, error } = await this.db.from('projects').insert({ name, model }).select('id').single();
    if (error) throw error;
    return (data as { id: string }).id;
  }
  async save(id: string, patch: { name?: string; model?: ProjectModel; thumbnail?: string; meta?: ProjectInfo }) {
    if (!this.hasMeta && patch.meta) { const { meta: _, ...rest } = patch; patch = rest; }
    let { error } = await this.db.from('projects').update(patch).eq('id', id);
    if (missing(error) && patch.meta) { this.hasMeta = false; const { meta: _, ...rest } = patch; ({ error } = await this.db.from('projects').update(rest).eq('id', id)); }
    if (error) throw error;
  }
  async remove(id: string) {
    const { error } = await this.db.from('projects').delete().eq('id', id);
    if (error) throw error;
  }
  async uploadSource(id: string, file: File) {
    const { data: u } = await this.db.auth.getUser();
    if (!u.user) return null;
    const safe = file.name.replace(/[^\w.\-]+/g, '_');
    const path = `${u.user.id}/${id}/${Date.now()}-${safe}`;
    const { error } = await this.db.storage.from('source-files').upload(path, file, { upsert: false });
    if (error) throw error;
    return path;
  }
  async sources(id: string, owner?: string) {
    const me = await this.me();
    const out: SourceFile[] = [];
    for (const who of [...new Set([owner || me, me].filter(Boolean))] as string[]) {
      const { data } = await this.db.storage.from('source-files').list(`${who}/${id}`, { limit: 200, sortBy: { column: 'created_at', order: 'desc' } });
      for (const f of data || []) out.push({ path: `${who}/${id}/${f.name}`, name: f.name.replace(/^\d+-/, ''), size: (f.metadata as { size?: number } | null)?.size || 0, at: f.created_at || '' });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }
  async sourceUrl(path: string) {
    const { data, error } = await this.db.storage.from('source-files').createSignedUrl(path, 600, { download: path.split('/').pop()!.replace(/^\d+-/, '') });
    if (error) throw error;
    return data.signedUrl;
  }
  async role(p: ProjectMeta): Promise<Role> {
    const me = await this.me();
    if (!p.owner || p.owner === me) return 'owner';
    const { data } = await this.db.from('project_members').select('role').eq('project_id', p.id).eq('user_id', me!).maybeSingle();
    return (data?.role as Role) || 'viewer';
  }
  async members(id: string) {
    const { data, error } = await this.db.from('project_members').select('user_id,email,role,added_at').eq('project_id', id).order('added_at');
    if (missing(error)) throw new Error(NEEDS_DB);
    if (error) throw error;
    return data as Member[];
  }
  async share(id: string, email: string, role: 'viewer' | 'editor') {
    const { error } = await this.db.rpc('share_project', { p_project: id, p_email: email, p_role: role });
    if (missing(error)) throw new Error(NEEDS_DB);
    if (error) throw new Error(error.message);
  }
  async unshare(id: string, userId: string) {
    const { error } = await this.db.from('project_members').delete().eq('project_id', id).eq('user_id', userId);
    if (error) throw error;
  }
  async me() { return (await this.db.auth.getSession()).data.session?.user.id || null; }
}

export const store: ProjectStore = supabase ? new SupabaseStore() : new LocalStore();
