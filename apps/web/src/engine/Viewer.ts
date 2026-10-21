import {
  isBox, isDoor, memberOf, unpackMesh, SAMPLE_D, SAMPLE_ROOMS, SAMPLE_W, WALL_H,
  type BoxObject, type CadData, type DoorObject, type ModelObject, type RoomRect,
} from '@cloud-modeler/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** mat: automatic rendering (lit materials, sky, soft shadows); persp: the same look from eye level */
export type RenderMode = 'mat' | 'persp' | 'layer' | 'white' | 'wire';
export type Tool = 'orbit' | 'pan' | 'select' | 'measure' | 'push' | 'move' | 'draw' | 'paint' | 'flip' | 'del' | 'walk';
export type SceneKey = 'sw' | 'ne' | 'top' | 'hall' | 'eye';
export type DrawKind = 'wall' | 'rc' | 'rail' | 'column' | 'slab' | 'tall' | 'low';
/** what each drawing tool makes: thickness of a line-drawn part (0: drawn as a rectangle), default height, cm */
export const DRAW_KINDS: Record<DrawKind, { label: string; thick: number; h: number; layer: BoxObject['layer']; color: number }> = {
  wall: { label: '隔間牆', thick: 12, h: 240, layer: 'wall', color: 0xeeebe5 },
  rc: { label: 'RC牆', thick: 18, h: 320, layer: 'wall', color: 0xd9d6cf },
  rail: { label: '欄杆', thick: 10, h: 110, layer: 'rail', color: 0x6b7280 },
  column: { label: '柱', thick: 0, h: 320, layer: 'wall', color: 0xeeebe5 },
  slab: { label: '樓板', thick: 0, h: 15, layer: 'slab', color: 0xd6d1c7 },
  tall: { label: '高櫃', thick: 0, h: 240, layer: 'cabinet', color: 0xc98a4b },
  low: { label: '矮櫃', thick: 0, h: 90, layer: 'cabinet', color: 0xc98a4b },
};

export interface ViewerEvents {
  info(text: string): void;
  toast(text: string): void;
  delta(dx: number, dz: number): void;
  /** the model changed and should be saved */
  change(objects: ModelObject[], cad: CadData | null): void;
  /** the selected part changed (null: nothing selected) */
  select?(o: ModelObject | null): void;
}

export const LAYER_COLORS: Record<string, { name: string; color: number }> = {
  wall: { name: '結構牆', color: 0x3f4b5e },
  slab: { name: '樓板', color: 0xb8b2a6 },
  stair: { name: '樓梯', color: 0x9ca3af },
  rail: { name: '欄杆扶手', color: 0x475569 },
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
  measure: '捲尺：依序點兩個點量距離。',
  push: '推拉：按住構件上下拖曳，改變高度。',
  move: '移動：按住構件拖曳。',
  draw: '繪圖：選工具列的種類（牆、RC牆、欄杆、柱、樓板、櫃），在地面拖曳。牆與欄杆依拖曳方向決定走向，可改厚度與高度。',
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
  /** whole-building imports: the storey shown on its own, null for the whole building */
  floor: string | null = null;
  mode: RenderMode = 'mat';
  tool: Tool = 'orbit';
  /** snapping to 5 cm and to neighbouring parts (switched off: the user removed 磁吸貼合) */
  magnet = false;
  showLabels = true;
  sectionOn = false;
  sectionH = 140;
  /** h: horizontal cut at a height; x / z: vertical cut at a plan position; flip keeps the other side */
  sectionKind: 'h' | 'x' | 'z' = 'h';
  sectionFlip = false;
  private sectionPlane: THREE.Plane | null = null;
  drawKind: DrawKind = 'wall';
  /** thickness and height typed in the toolbar, cm (0: the tool's own) */
  drawThick = 0;
  drawH = 0;
  paintColor = 0x2f6fd6;
  selectedId: number | null = null;
  /** member kinds (柱, 梁, 樓板 …) hidden from the view */
  hidden = new Set<string>();

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 5, 40000);
  private controls: OrbitControls;
  private sun = new THREE.DirectionalLight(0xfff4e0, 0.75);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x9aa6b8, 2.2);
  private env: THREE.Texture | null = null;
  private sky: THREE.Texture | null = null;
  private groundMesh: THREE.Mesh | null = null;
  /** rendered modes: ambient occlusion and anti-aliasing, drawn whenever the view comes to rest */
  private composer: EffectComposer | null = null;
  private ao: GTAOPass | null = null;
  private grid: THREE.GridHelper | null = null;
  private floorGroup = new THREE.Group();
  private objGroup = new THREE.Group();
  private measGroup = new THREE.Group();
  private helperGroup = new THREE.Group();
  private cadGroup = new THREE.Group();
  /** imported 3D model geometry that is not a wall, slab … (furniture, stairs, roofs) */
  private meshGroup = new THREE.Group();
  private meshKey = '';
  private cadFloor: THREE.Mesh | null = null;
  private underlay: THREE.Mesh | null = null;
  private selBox: THREE.BoxHelper | null = null;
  private labels: Label[] = [];
  private history: { o: string; c: CadData | null }[] = [];
  private center = new THREE.Vector3(SAMPLE_W / 2, 0, SAMPLE_D / 2);
  /** height of what is shown, so tall buildings fit the camera */
  private height = WALL_H;
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
  private active = performance.now();
  private drawn = 0;
  private disposers: (() => void)[] = [];

  constructor(private view: HTMLElement, private labelLayer: HTMLElement, private ev: ViewerEvents) {
    // phones: fewer pixels and cheaper shadows keep the GPU (and the phone) cool
    const phone = matchMedia('(pointer: coarse)').matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: !phone, preserveDrawingBuffer: true, powerPreference: phone ? 'low-power' : 'default' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.type = phone ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    view.prepend(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.scene.add(this.hemi);
    this.sun.intensity = 2.2;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(phone ? 2048 : 4096, phone ? 2048 : 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 1.5;
    this.scene.add(this.sun, this.sun.target, this.floorGroup, this.objGroup, this.measGroup, this.helperGroup, this.cadGroup, this.meshGroup);
    this.buildSampleFloors(SAMPLE_ROOMS);
    this.bindEvents();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(view);
    this.disposers.push(() => ro.disconnect());
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => this.themeChanged();
    mq.addEventListener('change', onTheme);
    this.disposers.push(() => mq.removeEventListener('change', onTheme));
    // draw only while something moves: any touch, click, key or camera change keeps it drawing for a moment
    const wake = () => { this.active = performance.now(); };
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart'] as const) {
      addEventListener(type, wake, { passive: true, capture: true });
      this.disposers.push(() => removeEventListener(type, wake, { capture: true }));
    }
    this.controls.addEventListener('change', wake);
    this.resize();
    this.raf = requestAnimationFrame(t => this.frame(t));
  }
  /** Ask for a redraw after a change made without user input. */
  invalidate() { this.active = performance.now(); }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.disposers.forEach(d => d());
    this.controls.dispose();
    this.composer?.dispose();
    this.ao?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.forEach(l => l.el.remove());
  }

  /* ---------- model ---------- */
  load(objects: ModelObject[], cad: CadData | null) {
    this.objects = objects;
    this.cad = cad;
    this.floor = null;
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
    this.floor = null;
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
  get floors() { return this.cad?.floors || []; }
  /** Shows one storey of a whole-building import (null: all). */
  setFloor(key: string | null) {
    this.floor = key;
    this.selectedId = null;
    this.applyCadView();
    this.rebuild();
  }
  private get floorBase() { return this.floors.find(f => f.key === this.floor)?.y || 0; }
  private shown(o: ModelObject) { return (!this.floor || !o.floor || o.floor === this.floor) && (!this.hidden.size || !this.hidden.has(memberOf(o))); }
  /** Shows or hides parts of the model by member kind. */
  setHidden(kinds: Iterable<string>) {
    this.hidden = new Set(kinds);
    if (this.selectedId && !this.objects.some(o => o.id === this.selectedId && this.shown(o))) this.selectedId = null;
    this.rebuild();
    this.invalidate();
  }
  /** Changes one part (manual correction from the properties panel) as one undoable step. */
  updateObject(id: number, patch: Partial<ModelObject>) {
    const o = this.byId(id);
    if (!o) return;
    this.snapshot();
    Object.assign(o, patch);
    this.rebuild();
    this.commit();
    this.invalidate();
  }
  /** Selects a part by id (null clears). */
  selectId(id: number | null) { this.selectedId = id; this.updateSelection(); this.invalidate(); }
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
  setMode(m: RenderMode) { this.mode = m; this.rebuild(); this.applyLook(); }
  /** automatic rendering: both the rendered and the eye-level perspective modes */
  private get real() { return this.mode === 'mat' || this.mode === 'persp'; }
  /** Lighting, sky and ground for the rendered look; the plain modes keep the flat canvas and grid. */
  private applyLook() {
    const r = this.real;
    this.renderer.toneMapping = r ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    if (r && !this.env) {
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
    }
    if (r && !this.sky) {
      const c = document.createElement('canvas');
      c.width = 2; c.height = 256;
      const g = c.getContext('2d')!, grad = g.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, '#8fb7e3'); grad.addColorStop(0.55, '#d7e6f3'); grad.addColorStop(1, '#eef2f2');
      g.fillStyle = grad; g.fillRect(0, 0, 2, 256);
      this.sky = new THREE.CanvasTexture(c);
      this.sky.colorSpace = THREE.SRGBColorSpace;
    }
    this.scene.environment = r ? this.env : null;
    this.scene.environmentIntensity = 0.4;
    this.scene.background = r ? this.sky : cssColor('--canvas');
    this.hemi.intensity = r ? 0.55 : 2.2;
    this.hemi.color.setHex(r ? 0xdcebff : 0xffffff);
    this.hemi.groundColor.setHex(r ? 0x8c8270 : 0x9aa6b8);
    this.sun.intensity = r ? 2.6 : 2.2;
    this.sun.color.setHex(r ? 0xfff0d8 : 0xfff4e0);
    // the ground fades into the sky at the horizon, like an architectural rendering
    const size = Math.max(this.bounds.W, this.bounds.D, this.height * 1.4);
    this.scene.fog = r ? new THREE.Fog(0xe4ecf1, size * 4, size * 14) : null;
    if (this.grid) this.grid.visible = !r;
    if (r && !this.groundMesh) {
      this.groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, map: grassTexture(), roughness: 1 }));
      this.groundMesh.rotation.x = -Math.PI / 2;
      this.groundMesh.receiveShadow = true;
      this.groundMesh.raycast = () => {};
      this.scene.add(this.groundMesh);
    }
    if (this.groundMesh) {
      const gs = Math.max(6000, Math.max(this.bounds.W, this.bounds.D) * 6);
      this.groundMesh.scale.set(gs, gs, 1);
      (this.groundMesh.material as THREE.MeshStandardMaterial).map!.repeat.set(gs / 500, gs / 500);
      this.groundMesh.position.set(this.center.x, -2, this.center.z);
      this.groundMesh.visible = r;
    }
    this.invalidate();
  }
  /** physically based look of a part in the rendered modes, by what it is */
  private realMat(o: ModelObject) {
    const L = o.layer, n = o.name || '';
    if (L === 'glass' && !/欄杆/.test(n)) return new THREE.MeshPhysicalMaterial({ color: 0xcfe6f2, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false, envMapIntensity: 1.6 });
    if (L === 'rail' || L === 'glass') return new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.35, metalness: 0.6 });
    if (L === 'door') return new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.55, metalness: 0.05 });
    if (L === 'cabinet' || L === 'furniture') return new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.6 });
    if (L === 'bath') return new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.25, metalness: 0.05 });
    if (L === 'slab' || L === 'stair') return new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.85 });
    return new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.9 });
  }
  setMagnet(on: boolean) { this.magnet = on; }
  setShowLabels(on: boolean) { this.showLabels = on; }
  /** Section cut. Horizontal: v is the height above ground (0 … top of the building); vertical: v is the plan position. */
  setSection(on: boolean, v = this.sectionH, kind = this.sectionKind, flip = this.sectionFlip) {
    this.sectionOn = on;
    this.sectionH = v;
    this.sectionKind = kind;
    this.sectionFlip = flip;
    const s = kind !== 'h' && flip ? -1 : 1;
    const n = kind === 'h' ? new THREE.Vector3(0, -1, 0) : kind === 'x' ? new THREE.Vector3(-s, 0, 0) : new THREE.Vector3(0, 0, -s);
    this.sectionPlane = on ? new THREE.Plane(n, v * s) : null;
    this.applyClip();
    this.invalidate();
  }
  /** the cut applies to the building only: ground, grid and measurements stay whole */
  private applyClip() {
    const planes = this.sectionPlane ? [this.sectionPlane] : null;
    for (const g of [this.floorGroup, this.objGroup, this.cadGroup, this.meshGroup]) g.traverse(n => {
      const m = (n as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const x of m ? (Array.isArray(m) ? m : [m]) : []) if (x.clippingPlanes !== planes) { x.clippingPlanes = planes; x.clipShadows = true; x.needsUpdate = true; }
    });
  }
  /** How far a section can go: plan size and the highest point of the whole building, cm. */
  sectionExtent() {
    let top = Math.max(0, ...this.floors.map(f => f.y + f.h));
    for (const o of this.objects) top = Math.max(top, ((o as { y?: number }).y || 0) + ((o as { h?: number }).h || 0));
    const box = new THREE.Box3().setFromObject(this.objGroup);
    if (!box.isEmpty()) top = Math.max(top, box.max.y);
    return { W: this.bounds.W, D: this.bounds.D, top: Math.ceil(top || WALL_H) };
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
    if (this.real) return this.realMat(o);
    if (m === 'layer') return new THREE.MeshLambertMaterial({ color: LAYER_COLORS[o.layer].color, transparent: glass, opacity: glass ? 0.45 : 1 });
    if (m === 'white') return new THREE.MeshLambertMaterial({ color: 0xfbfbfa, transparent: glass, opacity: glass ? 0.4 : 1 });
    const b = new THREE.MeshBasicMaterial();
    b.visible = false;
    return b;
  }
  private edgeMat() {
    const dark = isDarkTheme();
    if (this.mode === 'wire') return new THREE.LineBasicMaterial({ color: dark ? 0x7fb0ff : 0x1f6feb });
    return new THREE.LineBasicMaterial({ color: 0x1b2230, transparent: true, opacity: 0.55 });
  }
  private boxMesh(w: number, h: number, d: number, o: ModelObject) {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(g, this.matFor(o));
    m.castShadow = this.real || this.mode === 'white' || this.mode === 'layer';
    m.receiveShadow = true;
    // the rendered look has no drawn outlines
    if (this.real) return m;
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
    g.position.set(hx, o.y || 0, hz);
    const leafH = o.h || 210;
    const leaf = new THREE.Group();
    leaf.rotation.y = base + open;
    const panel = this.boxMesh(len - 4, leafH, /大門/.test(o.name) ? 6 : 4, o);
    panel.position.set(len / 2, leafH / 2, 0);
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
    // whole-building imports carry their own lintels
    if (o.floor) return g;
    const header = this.boxMesh(o.axis === 'x' ? len : 12, WALL_H - 210, o.axis === 'x' ? 12 : len, { ...o, layer: 'wall', color: 0xeeebe5 } as unknown as ModelObject);
    header.position.set(o.axis === 'x' ? (hingeEnd ? -len / 2 : len / 2) : 0, 210 + (WALL_H - 210) / 2, o.axis === 'x' ? 0 : (hingeEnd ? -len / 2 : len / 2));
    header.raycast = () => {};
    g.add(header);
    return g;
  }
  /** a part drawn in the material of another layer (frames, handrails), not pickable */
  private part(o: BoxObject, layer: BoxObject['layer'], color: number, w: number, h: number, d: number, x: number, y: number, z: number) {
    const m = this.boxMesh(w, h, d, { ...o, layer, color });
    m.position.set(x, y, z);
    m.raycast = () => {};
    return m;
  }
  /** Windows get an aluminium frame and mullions; glass railings a handrail; railings posts and a top rail. */
  private buildFramed(o: BoxObject): THREE.Object3D | null {
    const railing = /欄杆|扶手/.test(o.name);
    if (o.layer !== 'rail' && !(o.layer === 'glass' && (railing || o.h >= 40))) return null;
    const along = o.w >= o.d, L = along ? o.w : o.d, T = along ? o.d : o.w;
    const g = new THREE.Group();
    g.position.set(o.x, o.y, o.z);
    g.rotation.y = (o.rot || 0) + (along ? 0 : Math.PI / 2);
    const metal = 0x8d939b;
    if (o.layer === 'rail') {
      // top rail and balusters every 12 cm
      g.add(this.part(o, 'rail', o.color, L, 4, 5, 0, o.h - 2, 0));
      const n = Math.max(1, Math.round(L / 12));
      for (let i = 0; i <= n; i++) g.add(this.part(o, 'rail', o.color, 1.6, o.h - 4, 1.6, -L / 2 + L * i / n, (o.h - 4) / 2, 0));
      const hit = this.boxMesh(L, o.h, Math.max(T, 4), { ...o, layer: 'glass' });
      (hit.material as THREE.Material).visible = false;
      hit.position.y = o.h / 2;
      hit.userData.id = o.id;
      g.add(hit);
      return g;
    }
    const pane = this.boxMesh(L, railing ? o.h - 6 : o.h, Math.min(T, 2), { ...o, w: L, d: 2 });
    pane.position.y = railing ? (o.h - 6) / 2 : o.h / 2;
    pane.userData.id = o.id;
    g.add(pane);
    if (railing) {
      g.add(this.part(o, 'rail', metal, L, 5, 6, 0, o.h - 2.5, 0));
      for (const x of [-L / 2 + 2, L / 2 - 2]) g.add(this.part(o, 'rail', metal, 4, o.h - 5, 4, x, (o.h - 5) / 2, 0));
      return g;
    }
    const f = 5, D = Math.max(6, Math.min(T, 10));
    g.add(this.part(o, 'rail', metal, L, f, D, 0, f / 2, 0));
    g.add(this.part(o, 'rail', metal, L, f, D, 0, o.h - f / 2, 0));
    const n = Math.max(1, Math.round(L / 150));
    for (let i = 0; i <= n; i++) g.add(this.part(o, 'rail', metal, f, o.h, D, -L / 2 + f / 2 + (L - f) * i / n, o.h / 2, 0));
    return g;
  }
  private buildShutter(o: DoorObject) {
    const len = o.b - o.a, h = o.h || 210, g = new THREE.Group();
    const cx = o.axis === 'x' ? (o.a + o.b) / 2 : o.at, cz = o.axis === 'x' ? o.at : (o.a + o.b) / 2;
    g.position.set(cx, o.y || 0, cz);
    g.rotation.y = o.axis === 'x' ? 0 : Math.PI / 2;
    const slats = Math.max(4, Math.round(h / 12));
    for (let i = 0; i < slats; i++) {
      const m = this.boxMesh(len, h / slats - 0.6, 3, { ...o, color: 0x9aa3ad } as unknown as ModelObject);
      m.position.y = (i + 0.5) * h / slats;
      m.userData.id = o.id;
      g.add(m);
    }
    const box = this.boxMesh(len + 10, 30, 30, { ...o, color: 0x6b7280 } as unknown as ModelObject);
    box.position.set(0, h + 15, 8);
    box.raycast = () => {};
    g.add(box);
    return g;
  }
  private buildObj(o: ModelObject): THREE.Object3D {
    if (isDoor(o)) return /捲門/.test(o.name) ? this.buildShutter(o) : this.buildDoor(o);
    const framed = this.buildFramed(o);
    if (framed) return framed;
    if (o.soffit) {
      // stair step with the sloping underside of the waist slab: side profile extruded across the flight
      const so = o.soffit, len = so.axis === 'x' ? o.w : o.d, wid = so.axis === 'x' ? o.d : o.w, top = o.y + o.h;
      const sh = new THREE.Shape([new THREE.Vector2(-len / 2, so.lo), new THREE.Vector2(len / 2, so.hi), new THREE.Vector2(len / 2, top), new THREE.Vector2(-len / 2, top)]);
      const g = new THREE.ExtrudeGeometry(sh, { depth: wid, bevelEnabled: false });
      g.translate(0, 0, -wid / 2);
      if (so.axis === 'z') g.rotateY(-Math.PI / 2);
      const m = new THREE.Mesh(g, this.matFor(o));
      m.castShadow = this.real || this.mode === 'white' || this.mode === 'layer';
      m.receiveShadow = true;
      if (!this.real) {
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 20), this.edgeMat());
        e.raycast = () => {};
        m.add(e);
      }
      m.position.set(o.x, 0, o.z);
      m.userData.id = o.id;
      return m;
    }
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
    for (const o of this.objects) if (this.shown(o)) this.objGroup.add(this.buildObj(o));
    this.buildMeshes();
    this.applyClip();
    const floorTint = (f: THREE.Mesh, base: number) => {
      const mat = f.material as THREE.MeshStandardMaterial;
      mat.color.setHex(this.mode === 'white' ? 0xf4f4f2 : this.mode === 'layer' ? 0xe9ecf0 : base);
      mat.transparent = false;
      mat.opacity = 1;
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
    this.ev.select?.(o || null);
    if (!o) return;
    const m = this.meshOf(o.id);
    if (!m) return;
    this.selBox = new THREE.BoxHelper(m, 0x1f6feb);
    (this.selBox.material as THREE.LineBasicMaterial).depthTest = false;
    this.selBox.renderOrder = 10;
    this.helperGroup.add(this.selBox);
    this.ev.info(describe(o));
  }

  /** The kept SketchUp geometry, rebuilt only when the model, storey or render mode changes. */
  private buildMeshes() {
    const key = `${this.cad?.meshes?.length ?? 0}|${this.floor}|${this.mode}|${isDarkTheme()}`;
    if (key === this.meshKey && this.meshCad === this.cad) return;
    this.meshKey = key;
    this.meshCad = this.cad;
    for (const c of this.meshGroup.children.slice()) {
      this.meshGroup.remove(c);
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const cm of this.cad?.meshes || []) {
      if (this.floor && cm.floor && cm.floor !== this.floor) continue;
      const { pos, idx } = unpackMesh(cm);
      const g0 = new THREE.BufferGeometry();
      g0.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g0.setIndex(new THREE.BufferAttribute(idx, 1));
      const g = g0.toNonIndexed();
      g0.dispose();
      g.computeVertexNormals();
      const glass = (cm.opacity ?? 1) < 1;
      const mat = this.matFor({ layer: glass ? 'glass' : 'furniture', color: cm.color } as ModelObject);
      mat.side = THREE.DoubleSide;
      if (glass && this.real) (mat as THREE.MeshStandardMaterial).opacity = Math.max(0.2, cm.opacity!);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = this.real || this.mode === 'white' || this.mode === 'layer';
      m.receiveShadow = true;
      m.raycast = () => {};
      this.meshGroup.add(m);
      // SketchUp-style outlines: only creases, not the triangulation
      if (this.real) continue;
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), this.edgeMat());
      e.raycast = () => {};
      this.meshGroup.add(e);
    }
  }
  private meshCad: CadData | null = null;

  /* ---------- CAD overlay ---------- */
  private applyCadView() {
    for (const c of this.cadGroup.children.slice()) { this.cadGroup.remove(c); const m = c as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material).dispose(); }
    for (let i = this.labels.length - 1; i >= 0; i--) if (this.labels[i].cad) { this.labels[i].el.remove(); this.labels.splice(i, 1); }
    this.cadFloor = null;
    const cad = this.cad;
    this.bounds = cad ? { W: cad.W, D: cad.D } : { W: SAMPLE_W, D: SAMPLE_D };
    const fl = cad?.floors?.find(f => f.key === this.floor);
    const top = cad?.floors?.length ? Math.max(...cad.floors.map(f => f.y + f.h)) : 0;
    const base = fl ? fl.y : 0;
    this.center.set(this.bounds.W / 2, fl ? fl.y : top / 3, this.bounds.D / 2);
    this.height = fl ? fl.h : top || WALL_H;
    if (cad) {
      this.cadFloor = new THREE.Mesh(new THREE.PlaneGeometry(cad.W, cad.D), new THREE.MeshStandardMaterial({ color: 0xe2cfae, roughness: 0.9 }));
      this.cadFloor.rotation.x = -Math.PI / 2;
      this.cadFloor.position.set(cad.W / 2, base, cad.D / 2);
      this.cadFloor.receiveShadow = true;
      this.cadGroup.add(this.cadFloor);
      // a whole building shows each storey's linework and room names only when that storey is picked
      const segs = cad.floors?.length ? fl?.segs || [] : cad.segs, texts = cad.floors?.length ? fl?.texts || [] : cad.texts;
      if (segs.length) {
        const arr = new Float32Array(segs.length / 2 * 3);
        for (let i = 0, j = 0; i < segs.length; i += 2, j += 3) { arr[j] = segs[i]; arr[j + 1] = base + 1.5; arr[j + 2] = segs[i + 1]; }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x8a5a2b }));
        l.raycast = () => {};
        this.cadGroup.add(l);
      }
      for (const t of texts) this.addLabel(`<b>${esc(t.s)}</b>`, new THREE.Vector3(t.x, base + 20, t.z), 'tag').cad = true;
      this.addLabel(`◂ 總面寬 ${Math.round(cad.W)} cm ▸`, new THREE.Vector3(cad.W / 2, (fl ? base + fl.h : top || WALL_H) + 10, -40), 'dim').cad = true;
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
    this.applyLook();
  }
  private fitSun() {
    const s = Math.max(this.bounds.W, this.bounds.D, this.height * 1.4) / 1180, c = this.center;
    // late-morning sun from the south-east: the south faces lit, the west faces in soft shade, shadows falling back-left in the default view
    this.sun.position.set(c.x + 1100 * s, 1250 * s, c.z + 900 * s);
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
      // a vertical section also takes away the names of what is cut off
      if (!it.meas && this.sectionPlane && this.sectionKind !== 'h' && this.sectionPlane.distanceToPoint(it.pos) < 0) { it.el.hidden = true; continue; }
      v.copy(it.pos).project(this.camera);
      const off = v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2;
      it.el.hidden = off;
      if (!off) it.el.style.transform = `translate(${(v.x + 1) / 2 * rw}px, ${(1 - v.y) / 2 * rh}px) translate(-50%,-50%)`;
    }
  }

  /* ---------- camera ---------- */
  private sceneDef(k: SceneKey): { pos: number[]; target?: number[]; fov: number } {
    const s = Math.max(this.bounds.W, this.bounds.D, this.height * 1.4) / 1180, c = this.center;
    if (k === 'sw') return { pos: [c.x - 1050 * s, 1250 * s, c.z + 1250 * s], fov: 40 };
    if (k === 'ne') return { pos: [c.x + 1050 * s, 1250 * s, c.z - 1250 * s], fov: 40 };
    if (k === 'top') return { pos: [c.x, 9500 * s, c.z + 1], fov: 8.5 };
    if (k === 'eye') {
      // two-point perspective from a person standing outside the south-west corner: eye height, level view
      const b = this.floor ? this.floorBase : 0, d = Math.max(this.bounds.W, this.bounds.D) * 0.7 + this.height * 0.6;
      return { pos: [c.x - d * 0.62, b + 160, c.z + d * 0.78], target: [c.x, b + 160 + this.height * 0.12, c.z], fov: 55 };
    }
    if (this.cad) { const b = this.floorBase; return { pos: [c.x, 170 + b, c.z + this.bounds.D * 0.42], target: [c.x, 120 + b, c.z - this.bounds.D * 0.1], fov: 60 }; }
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
    this.active = performance.now();
    const w = this.view.clientWidth, h = this.view.clientHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /* ---------- walk ---------- */
  private enterWalk() {
    this.walk.on = true;
    this.walk.saved = { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
    this.camera.position.set(this.cad ? this.center.x : 560, 160 + this.floorBase, this.cad ? this.bounds.D - 80 : 860);
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
      if (this.sectionPlane && this.sectionPlane.distanceToPoint(h.point) < 0) continue;
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
    // a release that never reached the view (finger lifted outside, window lost focus, browser took the gesture) must not leave the camera locked
    const unlock = () => {
      this.pointers.clear();
      if (this.drag) this.cancelDrag();
      this.controls.enabled = this.tool !== 'walk';
    };
    on(window, 'pointerup', e => { this.pointers.delete(e.pointerId); if (!this.pointers.size && this.drag) unlock(); });
    on(window, 'pointercancel', e => { this.pointers.delete(e.pointerId); if (!this.pointers.size) unlock(); });
    on(window, 'blur', unlock);
    const hidden = () => { if (document.hidden) unlock(); };
    document.addEventListener('visibilitychange', hidden);
    this.disposers.push(() => document.removeEventListener('visibilitychange', hidden));
    on(cv, 'lostpointercapture', () => { if (!this.pointers.size && this.drag) unlock(); });
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
    // a new first touch / click means no other pointer is down: forget any whose release was lost, so the view never stays locked
    if (e.isPrimary) {
      this.pointers.clear();
      if (this.drag) this.cancelDrag();
      this.controls.enabled = this.tool !== 'walk';
    }
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
        const edge = m.children[0] as THREE.LineSegments | undefined;
        if (edge) { edge.geometry.dispose(); edge.geometry = new THREE.EdgesGeometry(m.geometry); }
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
    const k = DRAW_KINDS[this.drawKind], h = this.drawH || k.h, t = this.drawThick || k.thick;
    // a part drawn on one storey of a whole-building import sits on that storey's floor
    const on = this.floor ? { floor: this.floor, y: this.floorBase } : { y: 0 };
    const base = { h: k.layer === 'slab' ? k.h : h, name: `新增${k.label}`, layer: k.layer, color: k.color, ...on };
    if (k.layer === 'slab') base.y = (on.y || 0) - k.h;
    if (t) {
      if (Math.abs(dx) >= Math.abs(dz)) return { x: (a.x + b.x) / 2, z: a.z, w: Math.abs(dx), d: t, ...base };
      return { x: a.x, z: (a.z + b.z) / 2, w: t, d: Math.abs(dz), ...base };
    }
    return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, w: Math.max(10, Math.abs(dx)), d: Math.max(10, Math.abs(dz)), ...base };
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
      if (!this.real) { this.mode = 'mat'; this.applyLook(); this.ev.toast('已切回「自動渲染」以顯示顏色'); }
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
  /**
   * Everything in the model as world-space triangles (cm, Y up), one part per object or imported mesh, for writing
   * other formats. Always the whole building, whichever floor is on screen.
   */
  exportParts() {
    const prev = this.floor;
    if (prev) { this.floor = null; this.rebuild(); }
    this.scene.updateMatrixWorld(true);
    const parts: { name: string; floor: string; layer: string; color: number; opacity: number; tris: Float32Array }[] = [];
    const v = new THREE.Vector3();
    const take = (m: THREE.Mesh, name: string, floor: string, layer: string) => {
      const g = m.geometry, pos = g.attributes.position, idx = g.index, n = idx ? idx.count : pos.count;
      if (!pos || n < 3) return;
      const tris = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
        tris[i * 3] = v.x; tris[i * 3 + 1] = v.y; tris[i * 3 + 2] = v.z;
      }
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
      parts.push({ name, floor, layer, color: mat?.color ? mat.color.getHex() : 0xd9d9d9, opacity: mat?.transparent ? mat.opacity : 1, tris });
    };
    this.objGroup.traverse(n => {
      const m = n as THREE.Mesh;
      if (!m.isMesh || !m.userData.id || !m.visible) return;
      const o = this.byId(m.userData.id);
      if (o) take(m, o.name, o.floor || '', o.layer);
    });
    let k = 0;
    const meshes = (this.cad?.meshes || []);
    for (const c of this.meshGroup.children) {
      const m = c as THREE.Mesh;
      if (!m.isMesh) continue;
      take(m, 'SketchUp 物件', meshes[k++]?.floor || '', 'furniture');
    }
    if (prev) { this.floor = prev; this.rebuild(); }
    return parts;
  }
  private finished = false;
  /** the finished frame of the rendered modes; false when the graphics card cannot do it */
  private finish() {
    try {
      if (!this.composer) {
        const w = this.view.clientWidth, h = this.view.clientHeight, pr = this.renderer.getPixelRatio();
        const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: 4 });
        this.composer = new EffectComposer(this.renderer, rt);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.ao = new GTAOPass(this.scene, this.camera, w, h);
        // the model is in centimetres: shade corners, wall bases and the ground around the building over about half a metre
        this.ao.updateGtaoMaterial({ radius: 60, distanceExponent: 1.2, thickness: 20, scale: 1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
        this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
        this.ao.blendIntensity = 0.85;
        this.composer.addPass(this.ao);
        this.composer.addPass(new OutputPass());
        this.composer.setSize(w, h);
      }
      // a section cut is not seen by the occlusion pass: leave it out rather than shade what was cut away
      this.ao!.enabled = !this.sectionPlane;
      this.composer.render();
      return true;
    } catch (e) {
      console.warn('finished frame unavailable', e);
      this.composer = null;
      return false;
    }
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
    // an error in one frame must not stop the loop: that would freeze the view until a reload
    try { this.drawFrame(now); } catch (err) { console.error(err); }
    this.raf = requestAnimationFrame(t => this.frame(t));
  }
  private drawFrame(now: number) {
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
    } else if (this.controls.update()) this.active = now;
    // idle: redraw about once a second only, which catches any change made without input
    const busy = !!f || (this.walk.on && this.walk.keys.size > 0) || now - this.active < 1500;
    // rendered modes: plain frames while moving, then one finished frame (ambient occlusion, smooth edges) once at rest
    const rest = this.real && !this.walk.on && !busy;
    if (busy || now - this.drawn > 1000 || (rest && !this.finished)) {
      this.selBox?.update();
      if (rest && this.finish()) this.finished = true;
      else { this.renderer.render(this.scene, this.camera); this.finished = false; }
      this.placeLabels();
      this.drawn = now;
    }
  }
}

export function describe(o: ModelObject) {
  if (isDoor(o)) return `${o.name}｜門｜門寬 ${o.b - o.a} cm｜用「改門向」切換開向`;
  return `${o.name}｜${LAYER_COLORS[o.layer].name}｜${Math.round(o.w)} × ${Math.round(o.d)} × ${Math.round(o.h)} cm` + (o.y ? `｜離地 ${o.y} cm` : '');
}
export const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** a soft lawn for the ground of the rendered modes: tufts of a few greens, tiled every 5 m */
function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#9fae86';
  g.fillRect(0, 0, 256, 256);
  const tones = ['#93a37a', '#a9b78f', '#8c9c73', '#b2bf98', '#9aab80'];
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = tones[i % tones.length];
    g.globalAlpha = 0.35 + Math.random() * 0.4;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
