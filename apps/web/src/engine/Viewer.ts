import {
  isBox, isDoor, SAMPLE_D, SAMPLE_ROOMS, SAMPLE_W, WALL_H,
  type BoxObject, type CadData, type DoorObject, type ModelObject, type RoomRect,
} from '@cloud-modeler/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type RenderMode = 'mat' | 'layer' | 'white' | 'xray' | 'wire';
export type Tool = 'orbit' | 'pan' | 'select' | 'measure' | 'push' | 'move' | 'draw' | 'paint' | 'flip' | 'del' | 'walk';
export type SceneKey = 'sw' | 'ne' | 'top' | 'hall';
export type DrawKind = 'wall' | 'tall' | 'low';

export interface ViewerEvents {
  info(text: string): void;
  toast(text: string): void;
  delta(dx: number, dz: number): void;
  /** the model changed and should be saved */
  change(objects: ModelObject[], cad: CadData | null): void;
}

export const LAYER_COLORS: Record<string, { name: string; color: number }> = {
  wall: { name: '結構牆', color: 0x3f4b5e },
  cabinet: { name: '櫃體', color: 0xf08c2e },
  furniture: { name: '家具', color: 0x8b5cf6 },
  bath: { name: '衛浴', color: 0x14b8a6 },
  door: { name: '門', color: 0xb45309 },
  glass: { name: '玻璃', color: 0x7dd3fc },
  custom: { name: '自建', color: 0x22c55e },
};

export const TOOL_HINT: Record<Tool, string> = {
  orbit: '旋轉：拖曳旋轉視角，滾輪或雙指縮放。點構件可查看尺寸。',
  pan: '平移：拖曳移動畫面。',
  select: '構件：點選牆、櫃、家具或門，查看名稱與尺寸。按 Delete 可刪除。',
  measure: '捲尺：依序點兩個點量距離。開啟磁吸時會吸附到構件角點。',
  push: '推拉：按住構件上下拖曳，改變高度。',
  move: '移動：按住構件拖曳。磁吸開啟時會貼齊相鄰構件邊緣。',
  draw: '畫牆/櫃：在地面拖曳。畫牆時依拖曳方向自動決定走向。',
  paint: '油漆桶：選一個顏色，再點構件上色。',
  flip: '改門向：點門片，依序切換四種開門方向。',
  del: '刪除：點構件刪除，可用復原找回。',
  walk: '漫遊：拖曳畫面轉頭，WASD／方向鍵或右下按鈕走動。',
};

interface Label { el: HTMLDivElement; pos: THREE.Vector3; room?: boolean; cad?: boolean; meas?: boolean }
type Drag =
  | { kind: 'look'; x: number; y: number }
  | { kind: 'draw'; p0: { x: number; z: number }; preview?: THREE.Mesh; box?: Omit<BoxObject, 'id'> }
  | { kind: 'move'; o: BoxObject; sx: number; sz: number; p0: THREE.Vector3 | null; lastHit?: BoxObject | null }
  | { kind: 'push'; o: BoxObject; sh: number; y0: number; scale: number };

const isDarkTheme = () => getComputedStyle(document.documentElement).colorScheme.includes('dark');
const cssColor = (name: string) => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#e9edf2');

export class Viewer {
  objects: ModelObject[] = [];
  cad: CadData | null = null;
  mode: RenderMode = 'mat';
  tool: Tool = 'orbit';
  magnet = true;
  showLabels = true;
  sectionOn = false;
  sectionH = 140;
  drawKind: DrawKind = 'wall';
  paintColor = 0x2f6fd6;
  selectedId: number | null = null;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 5, 40000);
  private controls: OrbitControls;
  private sun = new THREE.DirectionalLight(0xfff4e0, 0.75);
  private grid: THREE.GridHelper | null = null;
  private floorGroup = new THREE.Group();
  private objGroup = new THREE.Group();
  private measGroup = new THREE.Group();
  private helperGroup = new THREE.Group();
  private cadGroup = new THREE.Group();
  private cadFloor: THREE.Mesh | null = null;
  private underlay: THREE.Mesh | null = null;
  private selBox: THREE.BoxHelper | null = null;
  private labels: Label[] = [];
  private history: { o: string; c: CadData | null }[] = [];
  private center = new THREE.Vector3(SAMPLE_W / 2, 0, SAMPLE_D / 2);
  private bounds = { W: SAMPLE_W, D: SAMPLE_D };
  private uid = 1;
  private fly: { from: { pos: THREE.Vector3; target: THREE.Vector3; fov: number }; to: { pos: THREE.Vector3; target: THREE.Vector3; fov: number }; t0: number } | null = null;
  private walk = { on: false, yaw: 0, pitch: 0, keys: new Set<string>(), saved: null as null | { pos: THREE.Vector3; target: THREE.Vector3; fov: number } };
  private drag: Drag | null = null;
  private pointers = new Set<number>();
  private downAt: { x: number; y: number; t: number } | null = null;
  private measA: THREE.Vector3 | null = null;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private raf = 0;
  private last = performance.now();
  private disposers: (() => void)[] = [];

  constructor(private view: HTMLElement, private labelLayer: HTMLElement, private ev: ViewerEvents) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    view.prepend(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa6b8, 2.2));
    this.sun.intensity = 2.2;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun, this.sun.target, this.floorGroup, this.objGroup, this.measGroup, this.helperGroup, this.cadGroup);
    this.buildSampleFloors(SAMPLE_ROOMS);
    this.bindEvents();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(view);
    this.disposers.push(() => ro.disconnect());
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => this.themeChanged();
    mq.addEventListener('change', onTheme);
    this.disposers.push(() => mq.removeEventListener('change', onTheme));
    this.resize();
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.disposers.forEach(d => d());
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.forEach(l => l.el.remove());
  }

  /* ---------- model ---------- */
  load(objects: ModelObject[], cad: CadData | null) {
    this.objects = objects;
    this.cad = cad;
    this.uid = Math.max(0, ...objects.map(o => o.id)) + 1;
    this.selectedId = null;
    this.history = [];
    this.clearMeasure();
    this.applyCadView();
    this.rebuild();
    this.goScene('sw', true);
  }
  /** Replaces the model as one undoable step (CAD import, reset). */
  replace(objects: ModelObject[], cad: CadData | null) {
    this.snapshot();
    this.objects = objects;
    this.cad = cad;
    this.uid = Math.max(0, ...objects.map(o => o.id)) + 1;
    this.selectedId = null;
    this.clearMeasure();
    this.applyCadView();
    this.rebuild();
    this.commit();
    this.goScene('sw');
  }
  nextId() { return this.uid; }
  get roomRects(): RoomRect[] | undefined { return this.cad ? undefined : SAMPLE_ROOMS; }
  get planBounds() { return { ...this.bounds }; }
  roomLabels() {
    if (this.cad) return this.cad.texts.map(t => ({ n: t.s, x: t.x, z: t.z }));
    return SAMPLE_ROOMS.map(r => ({ n: r.n, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }));
  }
  private byId(id: number | null) { return this.objects.find(o => o.id === id); }
  private snapshot() {
    this.history.push({ o: JSON.stringify(this.objects), c: this.cad });
    if (this.history.length > 60) this.history.shift();
  }
  private commit() { this.ev.change(this.objects, this.cad); }
  undo() {
    const h = this.history.pop();
    if (!h) return this.ev.toast('沒有可以復原的步驟');
    this.objects = JSON.parse(h.o);
    if (h.c !== this.cad) { this.cad = h.c; this.applyCadView(); this.goScene('sw'); }
    this.selectedId = null;
    this.rebuild();
    this.commit();
    this.ev.toast('已復原上一步');
  }
  deleteSelected() {
    const o = this.byId(this.selectedId);
    if (!o || this.walk.on) return;
    this.snapshot();
    this.objects = this.objects.filter(x => x !== o);
    this.selectedId = null;
    this.rebuild();
    this.commit();
    this.ev.toast(`已刪除 ${o.name}`);
  }

  /* ---------- settings ---------- */
  setMode(m: RenderMode) { this.mode = m; this.rebuild(); }
  setMagnet(on: boolean) { this.magnet = on; }
  setShowLabels(on: boolean) { this.showLabels = on; }
  setSection(on: boolean, h = this.sectionH) {
    this.sectionOn = on;
    this.sectionH = h;
    this.renderer.clippingPlanes = on ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), h)] : [];
  }
  setTool(t: Tool) {
    if (this.tool === 'walk' && t !== 'walk') this.exitWalk();
    if (this.tool === 'measure' && t !== 'measure') this.measA = null;
    this.tool = t;
    this.controls.mouseButtons.LEFT = t === 'pan' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    this.controls.touches.ONE = t === 'pan' ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    this.controls.enableRotate = t !== 'draw';
    if (t === 'walk') this.enterWalk();
    this.ev.info(TOOL_HINT[t]);
  }
  themeChanged() { this.makeGrid(); this.rebuild(); }

  /* ---------- building meshes ---------- */
  private buildSampleFloors(rooms: RoomRect[]) {
    for (const r of rooms) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), new THREE.MeshStandardMaterial({ color: r.f, roughness: 0.9 }));
      m.rotation.x = -Math.PI / 2;
      m.position.set((r.x0 + r.x1) / 2, 0, (r.z0 + r.z1) / 2);
      m.receiveShadow = true;
      m.userData.baseColor = r.f;
      this.floorGroup.add(m);
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      this.addLabel(`<b>${esc(r.n)}</b><span>${esc(r.s || `${w} × ${d} cm`)}</span>`, new THREE.Vector3((r.x0 + r.x1) / 2, 20, (r.z0 + r.z1) / 2), 'tag').room = true;
    }
    this.addLabel(`◂ 總面寬 ${SAMPLE_W} cm ▸`, new THREE.Vector3(SAMPLE_W / 2, WALL_H + 10, -40), 'dim').room = true;
  }

  private matFor(o: ModelObject): THREE.Material {
    const glass = o.layer === 'glass';
    const m = this.mode;
    if (m === 'mat') return new THREE.MeshStandardMaterial({ color: o.color, roughness: glass ? 0.1 : 0.75, transparent: glass, opacity: glass ? 0.35 : 1, depthWrite: !glass });
    if (m === 'layer') return new THREE.MeshLambertMaterial({ color: LAYER_COLORS[o.layer].color, transparent: glass, opacity: glass ? 0.45 : 1 });
    if (m === 'white') return new THREE.MeshLambertMaterial({ color: 0xfbfbfa, transparent: glass, opacity: glass ? 0.4 : 1 });
    if (m === 'xray') return new THREE.MeshLambertMaterial({ color: o.color, transparent: true, opacity: 0.16, depthWrite: false });
    const b = new THREE.MeshBasicMaterial();
    b.visible = false;
    return b;
  }
  private edgeMat() {
    const dark = isDarkTheme();
    if (this.mode === 'wire') return new THREE.LineBasicMaterial({ color: dark ? 0x7fb0ff : 0x1f6feb });
    if (this.mode === 'xray') return new THREE.LineBasicMaterial({ color: dark ? 0x9fb6d6 : 0x334155, transparent: true, opacity: 0.7 });
    return new THREE.LineBasicMaterial({ color: 0x1b2230, transparent: true, opacity: 0.55 });
  }
  private boxMesh(w: number, h: number, d: number, o: ModelObject) {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(g, this.matFor(o));
    m.castShadow = this.mode === 'mat' || this.mode === 'white' || this.mode === 'layer';
    m.receiveShadow = true;
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), this.edgeMat());
    e.raycast = () => {};
    m.add(e);
    return m;
  }
  private buildDoor(o: DoorObject) {
    const len = o.b - o.a, hingeEnd = o.flip & 1, side = (o.flip & 2) ? -1 : 1;
    const base = o.axis === 'x' ? (hingeEnd ? Math.PI : 0) : (hingeEnd ? Math.PI / 2 : -Math.PI / 2);
    const hx = o.axis === 'x' ? (hingeEnd ? o.b : o.a) : o.at, hz = o.axis === 'x' ? o.at : (hingeEnd ? o.b : o.a);
    const open = side * (hingeEnd ? -1 : 1) * Math.PI * 0.38;
    const g = new THREE.Group();
    g.position.set(hx, 0, hz);
    const leaf = new THREE.Group();
    leaf.rotation.y = base + open;
    const panel = this.boxMesh(len - 4, 210, /大門/.test(o.name) ? 6 : 4, o);
    panel.position.set(len / 2, 105, 0);
    panel.userData.id = o.id;
    leaf.add(panel);
    g.add(leaf);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 24; i++) { const a = base + open * i / 24; pts.push(new THREE.Vector3(len * Math.cos(a), 1.5, -len * Math.sin(a))); }
    pts.push(new THREE.Vector3(0, 1.5, 0));
    const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0x9a6a43, dashSize: 6, gapSize: 4 }));
    arc.computeLineDistances();
    arc.raycast = () => {};
    g.add(arc);
    const header = this.boxMesh(o.axis === 'x' ? len : 12, WALL_H - 210, o.axis === 'x' ? 12 : len, { ...o, layer: 'wall', color: 0xeeebe5 } as unknown as ModelObject);
    header.position.set(o.axis === 'x' ? (hingeEnd ? -len / 2 : len / 2) : 0, 210 + (WALL_H - 210) / 2, o.axis === 'x' ? 0 : (hingeEnd ? -len / 2 : len / 2));
    header.raycast = () => {};
    g.add(header);
    return g;
  }
  private buildObj(o: ModelObject): THREE.Object3D {
    if (isDoor(o)) return this.buildDoor(o);
    const m = this.boxMesh(o.w, o.h, o.d, o);
    m.position.set(o.x, o.y + o.h / 2, o.z);
    m.rotation.y = o.rot || 0;
    m.userData.id = o.id;
    return m;
  }
  rebuild() {
    for (const c of this.objGroup.children.slice()) {
      this.objGroup.remove(c);
      c.traverse(n => { const m = n as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
    }
    for (const o of this.objects) this.objGroup.add(this.buildObj(o));
    const floorTint = (f: THREE.Mesh, base: number) => {
      const mat = f.material as THREE.MeshStandardMaterial;
      mat.color.setHex(this.mode === 'white' ? 0xf4f4f2 : this.mode === 'layer' ? 0xe9ecf0 : base);
      mat.transparent = this.mode === 'xray';
      mat.opacity = this.mode === 'xray' ? 0.35 : 1;
    };
    for (const f of this.floorGroup.children as THREE.Mesh[]) { floorTint(f, f.userData.baseColor); f.visible = this.mode !== 'wire' && !this.cad; }
    if (this.cadFloor) { floorTint(this.cadFloor, 0xe2cfae); this.cadFloor.visible = this.mode !== 'wire'; }
    this.updateSelection();
  }
  private meshOf(id: number) {
    let r: THREE.Mesh | null = null;
    this.objGroup.traverse(n => { if ((n as THREE.Mesh).isMesh && n.userData.id === id) r = n as THREE.Mesh; });
    return r as THREE.Mesh | null;
  }
  private updateSelection() {
    if (this.selBox) { this.helperGroup.remove(this.selBox); this.selBox = null; }
    const o = this.byId(this.selectedId);
    if (!o) return;
    const m = this.meshOf(o.id);
    if (!m) return;
    this.selBox = new THREE.BoxHelper(m, 0x1f6feb);
    (this.selBox.material as THREE.LineBasicMaterial).depthTest = false;
    this.selBox.renderOrder = 10;
    this.helperGroup.add(this.selBox);
    this.ev.info(describe(o));
  }

  /* ---------- CAD overlay ---------- */
  private applyCadView() {
    for (const c of this.cadGroup.children.slice()) { this.cadGroup.remove(c); const m = c as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material).dispose(); }
    for (let i = this.labels.length - 1; i >= 0; i--) if (this.labels[i].cad) { this.labels[i].el.remove(); this.labels.splice(i, 1); }
    this.cadFloor = null;
    const cad = this.cad;
    this.bounds = cad ? { W: cad.W, D: cad.D } : { W: SAMPLE_W, D: SAMPLE_D };
    this.center.set(this.bounds.W / 2, 0, this.bounds.D / 2);
    if (cad) {
      this.cadFloor = new THREE.Mesh(new THREE.PlaneGeometry(cad.W, cad.D), new THREE.MeshStandardMaterial({ color: 0xe2cfae, roughness: 0.9 }));
      this.cadFloor.rotation.x = -Math.PI / 2;
      this.cadFloor.position.set(cad.W / 2, 0, cad.D / 2);
      this.cadFloor.receiveShadow = true;
      this.cadGroup.add(this.cadFloor);
      if (cad.segs.length) {
        const arr = new Float32Array(cad.segs.length / 2 * 3);
        for (let i = 0, j = 0; i < cad.segs.length; i += 2, j += 3) { arr[j] = cad.segs[i]; arr[j + 1] = 1.5; arr[j + 2] = cad.segs[i + 1]; }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x8a5a2b }));
        l.raycast = () => {};
        this.cadGroup.add(l);
      }
      for (const t of cad.texts) this.addLabel(`<b>${esc(t.s)}</b>`, new THREE.Vector3(t.x, 20, t.z), 'tag').cad = true;
      this.addLabel(`◂ 總面寬 ${Math.round(cad.W)} cm ▸`, new THREE.Vector3(cad.W / 2, WALL_H + 10, -40), 'dim').cad = true;
    }
    this.makeGrid();
    this.fitSun();
  }
  private makeGrid() {
    if (this.grid) this.scene.remove(this.grid);
    const gs = Math.max(4000, Math.ceil(Math.max(this.bounds.W, this.bounds.D) * 3 / 100) * 100);
    this.grid = new THREE.GridHelper(gs, Math.min(400, gs / 50), cssColor('--grid1'), cssColor('--grid2'));
    this.grid.position.set(this.center.x, -1, this.center.z);
    this.scene.add(this.grid);
    this.scene.background = cssColor('--canvas');
  }
  private fitSun() {
    const s = Math.max(this.bounds.W, this.bounds.D) / 1180, c = this.center;
    this.sun.position.set(c.x - 900 * s, 1600 * s, c.z + 700 * s);
    this.sun.target.position.copy(c);
    Object.assign(this.sun.shadow.camera, { left: -1000 * s, right: 1000 * s, top: 1000 * s, bottom: -1000 * s, near: 100, far: 4000 * s });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.camera.far = Math.max(40000, 14000 * s);
    this.camera.updateProjectionMatrix();
  }

  /** Lays an image (a rendered PDF page or a photo of a plan) on the floor for tracing. */
  setUnderlay(source: HTMLCanvasElement | HTMLImageElement | null) {
    if (this.underlay) { this.scene.remove(this.underlay); (this.underlay.material as THREE.MeshBasicMaterial).map?.dispose(); this.underlay = null; }
    if (!source) return;
    const tex = source instanceof HTMLCanvasElement ? new THREE.CanvasTexture(source) : new THREE.Texture(source);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    const ar = source.height / source.width, w = this.bounds.W;
    this.underlay = new THREE.Mesh(new THREE.PlaneGeometry(w, w * ar), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.6, depthWrite: false }));
    this.underlay.rotation.x = -Math.PI / 2;
    this.underlay.position.set(w / 2, 2, w * ar / 2);
    this.underlay.renderOrder = 1;
    this.scene.add(this.underlay);
  }
  get hasUnderlay() { return !!this.underlay; }

  /* ---------- labels ---------- */
  private addLabel(html: string, pos: THREE.Vector3, cls: string): Label {
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = html;
    this.labelLayer.appendChild(el);
    const it: Label = { el, pos };
    this.labels.push(it);
    return it;
  }
  private placeLabels() {
    const rw = this.view.clientWidth, rh = this.view.clientHeight, v = new THREE.Vector3();
    for (const it of this.labels) {
      if ((it.room && this.cad) || (!this.showLabels && !it.meas)) { it.el.hidden = true; continue; }
      v.copy(it.pos).project(this.camera);
      const off = v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2;
      it.el.hidden = off;
      if (!off) it.el.style.transform = `translate(${(v.x + 1) / 2 * rw}px, ${(1 - v.y) / 2 * rh}px) translate(-50%,-50%)`;
    }
  }

  /* ---------- camera ---------- */
  private sceneDef(k: SceneKey): { pos: number[]; target?: number[]; fov: number } {
    const s = Math.max(this.bounds.W, this.bounds.D) / 1180, c = this.center;
    if (k === 'sw') return { pos: [c.x - 1050 * s, 1250 * s, c.z + 1250 * s], fov: 40 };
    if (k === 'ne') return { pos: [c.x + 1050 * s, 1250 * s, c.z - 1250 * s], fov: 40 };
    if (k === 'top') return { pos: [c.x, 9500 * s, c.z + 1], fov: 8.5 };
    if (this.cad) return { pos: [c.x, 170, c.z + this.bounds.D * 0.42], target: [c.x, 120, c.z - this.bounds.D * 0.1], fov: 60 };
    return { pos: [560, 300, 860], target: [540, 140, 250], fov: 55 };
  }
  goScene(k: SceneKey, instant = false) {
    this.exitWalk();
    const s = this.sceneDef(k);
    const target = s.target ? new THREE.Vector3(...s.target) : this.center.clone();
    const aspect = this.view.clientWidth / Math.max(1, this.view.clientHeight);
    const fit = s.target ? 1 : Math.max(1, 0.92 / aspect);
    const to = { pos: new THREE.Vector3(...s.pos).sub(target).multiplyScalar(fit).add(target), target, fov: s.fov };
    if (instant) {
      this.camera.position.copy(to.pos);
      this.controls.target.copy(to.target);
      this.camera.fov = to.fov;
      this.camera.updateProjectionMatrix();
      return;
    }
    this.fly = { from: { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov }, to, t0: performance.now() };
  }
  private resize() {
    const w = this.view.clientWidth, h = this.view.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /* ---------- walk ---------- */
  private enterWalk() {
    this.walk.on = true;
    this.walk.saved = { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
    this.camera.position.set(this.cad ? this.center.x : 560, 160, this.cad ? this.bounds.D - 80 : 860);
    this.walk.yaw = 0;
    this.walk.pitch = -0.05;
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
    this.controls.enabled = false;
  }
  private exitWalk() {
    if (!this.walk.on) return;
    this.walk.on = false;
    const s = this.walk.saved;
    if (s) { this.camera.position.copy(s.pos); this.controls.target.copy(s.target); this.camera.fov = s.fov; this.camera.updateProjectionMatrix(); }
    this.controls.enabled = true;
  }
  /** On-screen walk buttons: f/b/l/r. */
  walkKey(k: string, down: boolean) { if (down) this.walk.keys.add(k); else this.walk.keys.delete(k); }

  /* ---------- picking ---------- */
  private setRay(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
  }
  private hitObject(e: PointerEvent) {
    this.setRay(e);
    for (const h of this.ray.intersectObjects(this.objGroup.children, true)) {
      if (!(h.object as THREE.Mesh).isMesh || !h.object.userData.id) continue;
      if (this.sectionOn && h.point.y > this.sectionH) continue;
      const o = this.byId(h.object.userData.id);
      if (o) return { o, point: h.point };
    }
    return null;
  }
  private hitGround(e: PointerEvent) {
    this.setRay(e);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.ground, p) ? p : null;
  }
  private snap = (v: number) => this.magnet ? Math.round(v / 5) * 5 : Math.round(v);
  private magnetSnap(o: BoxObject, nx: number, nz: number) {
    if (!this.magnet) return { x: nx, z: nz, hit: null as BoxObject | null };
    const T = 18;
    let bx: number | null = null, bz: number | null = null, hit: BoxObject | null = null;
    const minX = nx - o.w / 2, maxX = nx + o.w / 2, minZ = nz - o.d / 2, maxZ = nz + o.d / 2;
    for (const p of this.objects) {
      if (p === o || !isBox(p)) continue;
      const pMinX = p.x - p.w / 2, pMaxX = p.x + p.w / 2, pMinZ = p.z - p.d / 2, pMaxZ = p.z + p.d / 2;
      const overlapZ = maxZ > pMinZ - T && minZ < pMaxZ + T, overlapX = maxX > pMinX - T && minX < pMaxX + T;
      if (overlapZ) for (const [a, b] of [[minX, pMaxX], [maxX, pMinX], [minX, pMinX], [maxX, pMaxX]]) { const d = b - a; if (Math.abs(d) < T && (bx === null || Math.abs(d) < Math.abs(bx))) { bx = d; hit = p; } }
      if (overlapX) for (const [a, b] of [[minZ, pMaxZ], [maxZ, pMinZ], [minZ, pMinZ], [maxZ, pMaxZ]]) { const d = b - a; if (Math.abs(d) < T && (bz === null || Math.abs(d) < Math.abs(bz))) { bz = d; hit = hit || p; } }
    }
    return { x: bx !== null ? nx + bx : this.snap(nx), z: bz !== null ? nz + bz : this.snap(nz), hit };
  }
  private roomAt(x: number, z: number) {
    return this.cad ? null : SAMPLE_ROOMS.find(r => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
  }

  /* ---------- pointer & keyboard ---------- */
  private bindEvents() {
    const v = this.view, cv = this.renderer.domElement;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, cap = false) => {
      el.addEventListener(type, fn as EventListener, cap);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener, cap));
    };
    on(v, 'pointerdown', e => this.onDown(e), true);
    on(v, 'pointermove', e => this.onMove(e));
    on(v, 'pointerup', e => this.onUp(e));
    on(v, 'pointercancel', e => { this.pointers.delete(e.pointerId); if (this.drag) this.cancelDrag(); });
    const keyMap: Record<string, string> = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
    on(window, 'keydown', e => {
      const t = e.target as HTMLElement;
      if (t.matches?.('input,textarea,select')) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.undo(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId) { this.deleteSelected(); return; }
      if (this.walk.on && keyMap[e.code]) { this.walk.keys.add(keyMap[e.code]); e.preventDefault(); }
    });
    on(window, 'keyup', e => { if (keyMap[e.code]) this.walk.keys.delete(keyMap[e.code]); });
    void cv;
  }
  private take(e: PointerEvent) { this.controls.enabled = false; this.renderer.domElement.setPointerCapture(e.pointerId); }
  private cancelDrag() {
    const d = this.drag;
    if (d && d.kind === 'draw' && d.preview) this.helperGroup.remove(d.preview);
    if (d && (d.kind === 'move' || d.kind === 'push')) this.history.pop();
    this.drag = null;
    this.controls.enabled = this.tool !== 'walk';
    this.rebuild();
  }
  private onDown(e: PointerEvent) {
    if (e.target !== this.renderer.domElement) return;
    this.pointers.add(e.pointerId);
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (this.pointers.size > 1) { if (this.drag) this.cancelDrag(); return; }
    if (e.button !== 0) return;
    const tool = this.tool;
    if (tool === 'walk') { this.drag = { kind: 'look', x: e.clientX, y: e.clientY }; this.take(e); return; }
    if (tool === 'draw') {
      const p = this.hitGround(e);
      if (!p) return;
      this.drag = { kind: 'draw', p0: { x: this.snap(p.x), z: this.snap(p.z) } };
      this.take(e);
      return;
    }
    if (tool === 'move' || tool === 'push') {
      const h = this.hitObject(e);
      if (!h) return;
      if (!isBox(h.o)) { this.ev.toast('門片請用「改門向」調整'); return; }
      if (h.o.layer === 'wall' && h.o.name.startsWith('外牆') && tool === 'move') { this.ev.toast('外牆為結構體，無法移動'); return; }
      this.selectedId = h.o.id;
      this.updateSelection();
      this.snapshot();
      this.drag = tool === 'move'
        ? { kind: 'move', o: h.o, sx: h.o.x, sz: h.o.z, p0: this.hitGround(e) }
        : { kind: 'push', o: h.o, sh: h.o.h, y0: e.clientY, scale: this.camera.position.distanceTo(this.controls.target) / 700 };
      this.take(e);
    }
  }
  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'look') {
      this.walk.yaw -= (e.clientX - d.x) * 0.005;
      this.walk.pitch = Math.max(-1.2, Math.min(1.2, this.walk.pitch - (e.clientY - d.y) * 0.004));
      d.x = e.clientX; d.y = e.clientY;
      return;
    }
    if (d.kind === 'move') {
      const p = this.hitGround(e);
      if (!p || !d.p0) return;
      const r = this.magnetSnap(d.o, d.sx + p.x - d.p0.x, d.sz + p.z - d.p0.z);
      d.o.x = r.x; d.o.z = r.z;
      this.meshOf(d.o.id)?.position.set(r.x, d.o.y + d.o.h / 2, r.z);
      this.selBox?.update();
      this.ev.delta(r.x - d.sx, r.z - d.sz);
      this.ev.info(`移動 ${d.o.name}｜ΔX:${Math.round(r.x - d.sx)} ΔZ:${Math.round(r.z - d.sz)} cm`);
      if (r.hit && r.hit !== d.lastHit) { const rm = this.roomAt(r.hit.x, r.hit.z); this.ev.toast(`🧲 磁吸貼合 ${rm ? rm.n : ''}${r.hit.name}`); }
      d.lastHit = r.hit;
    }
    if (d.kind === 'push') {
      const step = this.magnet ? 5 : 1;
      const nh = Math.max(2, Math.round((d.sh + (d.y0 - e.clientY) * d.scale) / step) * step);
      d.o.h = nh;
      const m = this.meshOf(d.o.id);
      if (m) {
        m.geometry.dispose();
        m.geometry = new THREE.BoxGeometry(d.o.w, nh, d.o.d);
        const edge = m.children[0] as THREE.LineSegments;
        edge.geometry.dispose();
        edge.geometry = new THREE.EdgesGeometry(m.geometry);
        m.position.y = d.o.y + nh / 2;
      }
      this.selBox?.update();
      this.ev.info(`推拉 ${d.o.name}｜高度 ${nh} cm（原 ${d.sh} cm）`);
    }
    if (d.kind === 'draw') {
      const p = this.hitGround(e);
      if (!p) return;
      const box = this.drawBox(d.p0, { x: this.snap(p.x), z: this.snap(p.z) });
      if (d.preview) this.helperGroup.remove(d.preview);
      d.preview = undefined; d.box = undefined;
      if (!box) return;
      const m = new THREE.Mesh(new THREE.BoxGeometry(box.w, box.h, box.d), new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.45 }));
      m.position.set(box.x, box.h / 2, box.z);
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0x15803d })));
      this.helperGroup.add(m);
      d.preview = m; d.box = box;
      this.ev.info(`${box.name}｜${box.w} × ${box.d} × ${box.h} cm`);
    }
  }
  private drawBox(a: { x: number; z: number }, b: { x: number; z: number }): Omit<BoxObject, 'id'> | null {
    const dx = b.x - a.x, dz = b.z - a.z;
    if (Math.abs(dx) < 10 && Math.abs(dz) < 10) return null;
    if (this.drawKind === 'wall') {
      if (Math.abs(dx) >= Math.abs(dz)) return { x: (a.x + b.x) / 2, z: a.z, w: Math.abs(dx), d: 12, h: WALL_H, y: 0, name: '新增隔間牆', layer: 'wall', color: 0xeeebe5 };
      return { x: a.x, z: (a.z + b.z) / 2, w: 12, d: Math.abs(dz), h: WALL_H, y: 0, name: '新增隔間牆', layer: 'wall', color: 0xeeebe5 };
    }
    const tall = this.drawKind === 'tall';
    return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, w: Math.max(10, Math.abs(dx)), d: Math.max(10, Math.abs(dz)), h: tall ? 240 : 90, y: 0, name: tall ? '新增高櫃' : '新增矮櫃', layer: 'cabinet', color: 0xc98a4b };
  }
  private onUp(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    const da = this.downAt;
    const wasClick = !!da && Math.hypot(e.clientX - da.x, e.clientY - da.y) < 6 && performance.now() - da.t < 500;
    const d = this.drag;
    if (d) {
      if (d.kind === 'draw') {
        if (d.preview) this.helperGroup.remove(d.preview);
        if (d.box) {
          this.snapshot();
          const o = { id: this.uid++, ...d.box } as BoxObject;
          this.objects.push(o);
          this.selectedId = o.id;
          this.rebuild();
          this.commit();
          this.ev.toast(`已建立 ${o.name}`);
        }
      } else if (d.kind === 'move') {
        if (d.o.x === d.sx && d.o.z === d.sz) this.history.pop(); else this.commit();
        this.rebuild();
      } else if (d.kind === 'push') {
        if (d.o.h === d.sh) this.history.pop(); else this.commit();
        this.rebuild();
      }
      this.drag = null;
      this.controls.enabled = this.tool !== 'walk';
      return;
    }
    if (wasClick && e.target === this.renderer.domElement && e.button === 0) this.clickTool(e);
  }
  private clickTool(e: PointerEvent) {
    const tool = this.tool;
    if (tool === 'select' || tool === 'orbit' || tool === 'pan') {
      const h = this.hitObject(e);
      this.selectedId = h ? h.o.id : null;
      this.updateSelection();
      if (!h && tool === 'select') this.ev.info('沒有選到構件。點牆、櫃、家具或門查看尺寸。');
      return;
    }
    if (tool === 'measure') return this.measureClick(e);
    const h = this.hitObject(e);
    if (!h) return;
    if (tool === 'paint') {
      this.snapshot();
      h.o.color = this.paintColor;
      if (this.mode !== 'mat') { this.mode = 'mat'; this.ev.toast('已切回「材質＋邊線」以顯示顏色'); }
      this.rebuild();
      this.commit();
      this.ev.info(`已上色：${h.o.name}`);
      return;
    }
    if (tool === 'flip') {
      if (!isDoor(h.o)) { this.ev.toast('請點門片'); return; }
      this.snapshot();
      h.o.flip = (h.o.flip + 1) % 4;
      this.selectedId = h.o.id;
      this.rebuild();
      this.commit();
      this.ev.toast(`🚪 ${h.o.name}：開向 ${['左內', '右內', '左外', '右外'][h.o.flip]}`);
      return;
    }
    if (tool === 'del') {
      this.snapshot();
      this.objects = this.objects.filter(o => o !== h.o);
      if (this.selectedId === h.o.id) this.selectedId = null;
      this.rebuild();
      this.commit();
      this.ev.toast(`已刪除 ${h.o.name}（可按復原）`);
    }
  }
  private measureClick(e: PointerEvent) {
    const h = this.hitObject(e);
    const p = h ? h.point.clone() : this.hitGround(e);
    if (!p) return;
    if (this.magnet && h && isBox(h.o)) {
      const o = h.o;
      for (const x of [o.x - o.w / 2, o.x + o.w / 2]) if (Math.abs(p.x - x) < 15) p.x = x;
      for (const z of [o.z - o.d / 2, o.z + o.d / 2]) if (Math.abs(p.z - z) < 15) p.z = z;
    } else if (this.magnet) { p.x = this.snap(p.x); p.z = this.snap(p.z); }
    const dot = new THREE.Mesh(new THREE.SphereGeometry(4, 12, 8), new THREE.MeshBasicMaterial({ color: 0x1f6feb, depthTest: false }));
    dot.renderOrder = 11;
    dot.position.copy(p);
    this.measGroup.add(dot);
    if (!this.measA) { this.measA = p; this.ev.info('捲尺：再點第二個點'); return; }
    const a = this.measA;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, p]), new THREE.LineBasicMaterial({ color: 0x1f6feb, depthTest: false }));
    line.renderOrder = 11;
    this.measGroup.add(line);
    const dist = a.distanceTo(p);
    this.addLabel(`${Math.round(dist)} cm`, a.clone().add(p).multiplyScalar(0.5), 'dim meas').meas = true;
    this.ev.info(`量測距離 ${Math.round(dist)} cm｜水平 ΔX ${Math.round(Math.abs(p.x - a.x))}  ΔZ ${Math.round(Math.abs(p.z - a.z))}｜垂直 ${Math.round(Math.abs(p.y - a.y))} cm`);
    this.measA = null;
  }
  clearMeasure() {
    for (const c of this.measGroup.children.slice()) { this.measGroup.remove(c); (c as THREE.Mesh).geometry.dispose(); }
    for (let i = this.labels.length - 1; i >= 0; i--) if (this.labels[i].meas) { this.labels[i].el.remove(); this.labels.splice(i, 1); }
    this.measA = null;
  }

  /* ---------- export ---------- */
  exportOBJ(name: string) {
    let out = `# ${name}\n# units: centimeters\n`, vi = 1;
    this.scene.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    this.objGroup.traverse(n => {
      const m = n as THREE.Mesh;
      if (!m.isMesh || !m.userData.id) return;
      const o = this.byId(m.userData.id);
      if (!o) return;
      const pos = m.geometry.attributes.position, idx = m.geometry.index!;
      out += `o ${o.name.replace(/\s+/g, '_')}_${o.id}\n`;
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); out += `v ${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.z.toFixed(1)}\n`; }
      for (let i = 0; i < idx.count; i += 3) out += `f ${idx.getX(i) + vi} ${idx.getX(i + 1) + vi} ${idx.getX(i + 2) + vi}\n`;
      vi += pos.count;
    });
    return out;
  }
  /** Small JPEG of the current view for the project list. */
  thumbnail() {
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement, c = document.createElement('canvas');
    c.width = 320; c.height = Math.round(320 * src.height / Math.max(1, src.width));
    c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  }

  /* ---------- loop ---------- */
  private frame(now: number) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const f = this.fly;
    if (f) {
      const k = Math.min(1, (now - f.t0) / 700), e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(f.from.pos, f.to.pos, e);
      this.controls.target.lerpVectors(f.from.target, f.to.target, e);
      this.camera.fov = f.from.fov + (f.to.fov - f.from.fov) * e;
      this.camera.updateProjectionMatrix();
      if (k >= 1) this.fly = null;
    }
    if (this.walk.on) {
      const w = this.walk;
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(w.pitch, w.yaw, 0);
      const sp = 260 * dt, fw = new THREE.Vector3(-Math.sin(w.yaw), 0, -Math.cos(w.yaw)), r = new THREE.Vector3(Math.cos(w.yaw), 0, -Math.sin(w.yaw));
      if (w.keys.has('f')) this.camera.position.addScaledVector(fw, sp);
      if (w.keys.has('b')) this.camera.position.addScaledVector(fw, -sp);
      if (w.keys.has('r')) this.camera.position.addScaledVector(r, sp);
      if (w.keys.has('l')) this.camera.position.addScaledVector(r, -sp);
    } else this.controls.update();
    this.selBox?.update();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    this.raf = requestAnimationFrame(t => this.frame(t));
  }
}

export function describe(o: ModelObject) {
  if (isDoor(o)) return `${o.name}｜門｜門寬 ${o.b - o.a} cm｜用「改門向」切換開向`;
  return `${o.name}｜${LAYER_COLORS[o.layer].name}｜${Math.round(o.w)} × ${Math.round(o.d)} × ${Math.round(o.h)} cm` + (o.y ? `｜離地 ${o.y} cm` : '');
}
export const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
