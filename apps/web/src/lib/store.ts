import { DEFAULT_SETTINGS, type ProjectModel } from '@cloud-modeler/core';
import { supabase } from './supabase';

export interface ProjectMeta { id: string; name: string; updated_at: string; thumbnail: string | null }
export interface StoredProject extends ProjectMeta { model: ProjectModel }

export interface ProjectStore {
  readonly cloud: boolean;
  list(): Promise<ProjectMeta[]>;
  load(id: string): Promise<StoredProject>;
  create(name: string, model: ProjectModel): Promise<string>;
  save(id: string, patch: { name?: string; model?: ProjectModel; thumbnail?: string }): Promise<void>;
  remove(id: string): Promise<void>;
  /** Keeps the original CAD/PDF file next to the project. Returns the stored path. */
  uploadSource(id: string, file: File): Promise<string | null>;
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
    return all.map(({ id, name, updated_at, thumbnail }) => ({ id, name, updated_at, thumbnail })).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
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
  async save(id: string, patch: { name?: string; model?: ProjectModel; thumbnail?: string }) {
    const p = await this.load(id);
    await tx('readwrite', s => s.put({ ...p, ...patch, updated_at: new Date().toISOString() }));
  }
  async remove(id: string) { await tx('readwrite', s => s.delete(id)); }
  async uploadSource() { return null; }
}

/* ---------- cloud mode: Supabase (see supabase/migrations) ---------- */
class SupabaseStore implements ProjectStore {
  readonly cloud = true;
  private get db() { return supabase!; }
  async list() {
    const { data, error } = await this.db.from('projects').select('id,name,updated_at,thumbnail').order('updated_at', { ascending: false });
    if (error) throw error;
    return data as ProjectMeta[];
  }
  async load(id: string) {
    const { data, error } = await this.db.from('projects').select('id,name,updated_at,thumbnail,model').eq('id', id).single();
    if (error) throw error;
    return data as StoredProject;
  }
  async create(name: string, model: ProjectModel) {
    const { data, error } = await this.db.from('projects').insert({ name, model }).select('id').single();
    if (error) throw error;
    return (data as { id: string }).id;
  }
  async save(id: string, patch: { name?: string; model?: ProjectModel; thumbnail?: string }) {
    const { error } = await this.db.from('projects').update(patch).eq('id', id);
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
}

export const store: ProjectStore = supabase ? new SupabaseStore() : new LocalStore();
