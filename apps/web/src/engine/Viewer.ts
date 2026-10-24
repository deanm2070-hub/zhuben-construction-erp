import {
  isBox, isDoor, memberOf, roomSlabAt, unpackMesh, SAMPLE_D, SAMPLE_ROOMS, SAMPLE_W, WALL_H,
  type BoxObject, type CadData, type Material, type DoorObject, type ModelObject, type RoomRect, type SketchLine,
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
export type Tool = 'orbit' | 'pan' | 'select' | 'measure' | 'line' | 'push' | 'move' | 'draw' | 'paint' | 'finish' | 'flip' | 'del' | 'walk' | 'fix';
/** front: 正立面 (from the south), bird: 鳥瞰圖, side: 側向立面 (from the east), eye: the eye-level perspective */
export type SceneKey = 'front' | 'bird' | 'side' | 'eye';
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
  /** the hand-drawn lines changed and should be saved */
  sketch?(lines: SketchLine[]): void;
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
  line: '畫線：依序點下各點連成線，會鎖在構件角點、線的端點與中點（紅點），沿紅綠藍軸向時自動對齊；畫線中可直接輸入長度（cm）按 Enter。按 Esc、右鍵或點回起點結束。',
  push: '推拉：按住構件頂面上下拖曳改高度；按住側面左右拖曳，把那一面往外拉長或往內縮短。靠近其他構件的頂面、底面、邊緣或樓層高度時自動鎖點（紅點）。',
  move: '移動：按住構件拖曳。',
  draw: '繪圖：選工具列的種類（牆、RC牆、欄杆、柱、樓板、櫃），在地面拖曳。牆與欄杆依拖曳方向決定走向，可改厚度與高度。',
  paint: '油漆桶：選一個顏色，再點構件上色。',
  finish: '材質：選一種材質（抿石子、二丁掛、水泥漆…），再點牆的一個面；數量會依指定的面統計在「工程數量」。',
  flip: '改門向：點門片，依序切換四種開門方向。',
  del: '刪除：點構件刪除，可用復原找回。',
  walk: '漫遊：拖曳畫面轉頭，用左下搖桿或 WASD／方向鍵走動；切換樓層會走到那一層。',
  fix: '補牆板：「柱間補牆」依序點兩根柱（或牆），在中間補一道牆；「點房間補樓板」先選樓層，再點房間地面補上樓板。',
};
/** quick-correction kinds of the 補牆板 tool */
export type FixKind = 'wall' | 'slab';
/** the structural frame stays solid in the x-ray view, in these colours; everything else turns to glass */
const XRAY: Record<string, number> = { 柱: 0x2f6fd6, 梁: 0xe0862e, 基礎: 0x8a6440 };

interface Label { el: HTMLDivElement; pos: THREE.Vector3; room?: boolean; cad?: boolean; meas?: boolean; sel?: boolean }
type Drag =
  | { kind: 'look'; x: number; y: number }
  | { kind: 'draw'; p0: { x: number; z: number }; preview?: THREE.Mesh; box?: Omit<BoxObject, 'id'> }
  | { kind: 'move'; o: BoxObject; sx: number; sz: number; p0: THREE.Vector3 | null; lastHit?: BoxObject | null }
  | { kind: 'push'; o: BoxObject; sh: number; y0: number; scale: number }
  /** push / pull on a side face: that face moves along its outward direction, the opposite face stays */
  | { kind: 'pushSide'; o: BoxObject; axis: 'w' | 'd'; s0: number; x0: number; z0: number; dir: THREE.Vector3; plane: THREE.Plane; p0: THREE.Vector3 };

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
  /** 材質 tool: the finish put on a clicked face ('' clears it), and how far it spreads */
  finishMat = '外牆1:3水泥砂漿打底+抿石子';
  finishScope: 'one' | 'plane' | 'all' = 'all';
  /** the project's 建材項目: how a picked finish looks */
  private materials: Material[] = [];
  setMaterials(list: Material[]) {
    this.materials = list;
    if (this.objects.some(o => isBox(o) && o.faces)) this.rebuild();
  }
  selectedId: number | null = null;
  /** member kinds (柱, 梁, 樓板 …) hidden from the view */
  hidden = new Set<string>();
  fixKind: FixKind = 'wall';
  /** 柱間補牆: the first column or wall picked */
  private fixA: number | null = null;
  /** exploded view: extra gap between storeys, cm (0: off) */
  explode = 0;
  /** x-ray: columns, beams and footings solid, the rest see-through */
  xray = false;
  /** exterior wall tiles in the rendered look: 'auto' picks a colour scheme from the building, a number a scheme, 'none' plain */
  facade: 'auto' | 'none' | number = 'auto';
  private facadeKey: unknown = null;
  private facadeFaces = new Map<number, number[]>();
  /** sun study: day of the year and solar hour (null: the fixed late-morning sun), plan north rotated by northDeg */
  sunStudy: { day: number; hour: number; northDeg: number } | null = null;

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
  private history: { o: string; c: CadData | null; s?: SketchLine[] }[] = [];
  private center = new THREE.Vector3(SAMPLE_W / 2, 0, SAMPLE_D / 2);
  /** height of what is shown, so tall buildings fit the camera */
  private height = WALL_H;
  private bounds = { W: SAMPLE_W, D: SAMPLE_D };
  private uid = 1;
  private fly: { from: { pos: THREE.Vector3; target: THREE.Vector3; fov: number }; to: { pos: THREE.Vector3; target: THREE.Vector3; fov: number }; t0: number } | null = null;
  private walk = { on: false, yaw: 0, pitch: 0, keys: new Set<string>(), axis: { x: 0, y: 0 }, saved: null as null | { pos: THREE.Vector3; target: THREE.Vector3; fov: number } };
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
  private phone = false;
  private visible = true;
  private disposers: (() => void)[] = [];

  constructor(private view: HTMLElement, private labelLayer: HTMLElement, private ev: ViewerEvents) {
    // phones: fewer pixels and cheaper shadows keep the GPU (and the phone) cool
    const phone = this.phone = matchMedia('(pointer: coarse)').matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: !phone, preserveDrawingBuffer: true, powerPreference: phone ? 'low-power' : 'default' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 1.25 : 2));
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
    this.sun.shadow.mapSize.set(phone ? 1024 : 4096, phone ? 1024 : 4096);
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
    // draw only while something moves: a tap, click or key anywhere (a toolbar button changes the view) or any
    // pointer movement over the 3D view keeps it drawing for a moment; scrolling a table elsewhere does not
    const wake = () => { this.active = performance.now(); };
    for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
      addEventListener(type, wake, { passive: true, capture: true });
      this.disposers.push(() => removeEventListener(type, wake, { capture: true }));
    }
    for (const type of ['pointermove', 'wheel'] as const) {
      view.addEventListener(type, wake, { passive: true });
      this.disposers.push(() => view.removeEventListener(type, wake));
    }
    this.controls.addEventListener('change', wake);
    // nothing is drawn while the 3D view is off screen (another module tab) or the app is in the background
    const io = new IntersectionObserver(es => { this.visible = es.some(e => e.isIntersecting); if (this.visible) wake(); });
    io.observe(view);
    this.disposers.push(() => io.disconnect());
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
    this.endLine();
    this.setSketch([]);
    this.applyCadView();
    this.rebuild();
    this.goScene('bird', true);
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
    this.goScene('bird');
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
    // walking: go to that storey at eye height
    if (this.walk.on) this.camera.position.y = this.floorBase + 160;
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
    this.history.push({ o: JSON.stringify(this.objects), c: this.cad, s: this.sketch });
    if (this.history.length > 60) this.history.shift();
  }
  private commit() { this.ev.change(this.objects, this.cad); }
  undo() {
    const h = this.history.pop();
    if (!h) return this.ev.toast('沒有可以復原的步驟');
    this.objects = JSON.parse(h.o);
    if (h.s && h.s !== this.sketch) { this.sketch = h.s; this.drawSketch(); this.ev.sketch?.(this.sketch); }
    if (h.c !== this.cad) { this.cad = h.c; this.applyCadView(); this.goScene('bird'); }
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
    this.buildCaps();
  }
  private capGroup = new THREE.Group();
  /**
   * Solid section faces: every part the cut passes through shows its cut face filled in (columns, beams, slabs and
   * walls in their own shade), so a section reads as solid concrete instead of hollow shells.
   */
  private buildCaps() {
    for (const c of this.capGroup.children.slice()) { this.capGroup.remove(c); (c as THREE.Mesh).geometry?.dispose(); }
    if (!this.capGroup.parent) this.scene.add(this.capGroup);
    if (!this.sectionOn || !this.sectionPlane) return;
    const kind = this.sectionKind, v = this.sectionH, n = this.sectionPlane.normal, off = 0.15;
    const byColor = new Map<number, number[]>();
    const quad = (col: number, pts: THREE.Vector3[]) => {
      const a = byColor.get(col) || byColor.set(col, []).get(col)!;
      for (const i of [0, 1, 2, 0, 2, 3]) a.push(pts[i].x - n.x * off, pts[i].y - n.y * off, pts[i].z - n.z * off);
    };
    for (const o of this.objects) {
      if (!isBox(o) || !this.shown(o) || o.layer === 'glass' || o.layer === 'rail') continue;
      const mem = memberOf(o), light = o.layer === 'wall' && (o.wall === 'light' || /輕隔間/.test(o.name));
      const col = mem === '柱' ? 0x2b3442 : mem === '梁' ? 0x7c4a1e : mem === '樓板' || mem === '基礎' ? 0x4b5563 : mem === '樓梯' ? 0x6b7280 : light ? 0xb9bcc2 : mem === '牆' ? 0x3a4250 : 0x8a8f98;
      const y0 = o.y + this.lift(o.floor), y1 = y0 + o.h, c = Math.cos(o.rot || 0), sn = Math.sin(o.rot || 0);
      // the footprint corners (same turn as the mesh: rotation.y = rot)
      const fp = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => { const lx = a * o.w / 2, lz = b * o.d / 2; return [o.x + lx * c + lz * sn, o.z - lx * sn + lz * c]; });
      if (kind === 'h') {
        if (!(y0 < v && y1 > v)) continue;
        quad(col, fp.map(([x, z]) => new THREE.Vector3(x, v, z)));
        continue;
      }
      // a vertical cut: where the plane crosses the footprint, from the underside to the top
      const k = kind === 'x' ? 0 : 1, hits: number[] = [];
      for (let i = 0; i < 4; i++) {
        const p = fp[i], q = fp[(i + 1) % 4];
        if ((p[k] - v) * (q[k] - v) > 0 || p[k] === q[k]) continue;
        const t = (v - p[k]) / (q[k] - p[k]);
        hits.push(p[1 - k] + (q[1 - k] - p[1 - k]) * t);
      }
      if (hits.length < 2) continue;
      const lo = Math.min(...hits), hi = Math.max(...hits);
      if (hi - lo < 0.5) continue;
      const P = (u: number, y: number) => kind === 'x' ? new THREE.Vector3(v, y, u) : new THREE.Vector3(u, y, v);
      quad(col, [P(lo, y0), P(hi, y0), P(hi, y1), P(lo, y1)]);
    }
    for (const [col, arr] of byColor) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      m.raycast = () => {};
      this.capGroup.add(m);
    }
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
    if (this.tool === 'line' && t !== 'line') this.endLine();
    this.fixA = null;
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
    // light partitions in light grey, so the RC walls stand out in their own colour
    if (m === 'layer') return new THREE.MeshLambertMaterial({ color: o.layer === 'wall' && (('wall' in o && o.wall === 'light') || /輕隔間/.test(o.name)) ? 0xd6d6d6 : LAYER_COLORS[o.layer].color, transparent: glass, opacity: glass ? 0.45 : 1 });
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
    this.tileFaces(m, o);
    this.finishFaces(m, o);
    return m;
  }
  /** faces given a finish by hand show that finish in every look but the x-ray */
  private finishFaces(m: THREE.Mesh, o: ModelObject) {
    if (this.xray || isDoor(o) || !(o as BoxObject).faces) return;
    const b = o as BoxObject, fs = Object.entries(b.faces!).filter(([f, v]) => v && !((+f === 2 || +f === 3) && this.extFinish(v))).map(([f, v]) => [+f, v] as const);
    if (!fs.length) return;
    const g = m.geometry as THREE.BoxGeometry, uv = g.getAttribute('uv') as THREE.BufferAttribute, cur = m.material;
    const mats = Array.isArray(cur) ? [...cur] : [0, 1, 2, 3, 4, 5].map(() => cur as THREE.Material);
    for (const [f, name] of fs) {
      const look = finishLook(name, this.scheme()?.main, this.materials.find(x => x.name === name));
      mats[f] = look.mat;
      // texture repeats in cm: across the face, and up (top and bottom faces: across the depth)
      const wid = f < 2 ? b.d : b.w, hgt = f === 2 || f === 3 ? b.d : b.h;
      const off = (f < 2 ? b.z - b.d / 2 : b.x - b.w / 2) / look.u, up = f === 2 || f === 3 ? 0 : b.y;
      for (let k = 4 * f; k < 4 * f + 4; k++) uv.setXY(k, off + (uv.getX(k) * wid) / look.u, (up + uv.getY(k) * hgt) / look.v);
    }
    m.material = mats;
    uv.needsUpdate = true;
  }
  /** an exterior finish (外牆面): only ever on upright faces */
  private extFinish(name: string) { return this.materials.find(x => x.name === name)?.use === 'ext' || /^外牆/.test(name); }
  /** 材質 tool: put the chosen finish on the clicked face, and on the faces in the same plane when asked */
  private finishClick(e: PointerEvent) {
    const h = this.hitObject(e);
    if (!h || isDoor(h.o) || h.o.stair || h.o.soffit || !h.normal) { this.ev.toast('請點牆或構件的一個面'); return; }
    const n = h.normal;
    let f = Math.abs(n.x) > 0.5 ? (n.x > 0 ? 0 : 1) : Math.abs(n.y) > 0.5 ? (n.y > 0 ? 2 : 3) : (n.z > 0 ? 4 : 5);
    const o = h.o as BoxObject;
    const ext = !!this.finishMat && this.extFinish(this.finishMat);
    if (ext && (f === 2 || f === 3)) {
      // an exterior finish goes on an upright face: a tap on the top or underside of a slab or ledge (its edge is
      // only 15 cm high) means the edge nearest the tap
      const p = h.point, edges = o.rot ? [] : ([[0, o.x + o.w / 2 - p.x], [1, p.x - (o.x - o.w / 2)], [4, o.z + o.d / 2 - p.z], [5, p.z - (o.z - o.d / 2)]] as const)
        .filter(([e]) => this.exterior().get(o.id)?.includes(e) ?? true).slice().sort((a, b) => a[1] - b[1]);
      if (!edges.length || edges[0][1] > 80) { this.ev.toast('外牆材質請點牆、樓板的外側立面（側邊），不能貼在地坪或天花'); return; }
      f = edges[0][0];
    }
    const plane = (q: BoxObject) => f < 2 ? q.x + (f === 0 ? 1 : -1) * q.w / 2 : f < 4 ? q.y + (f === 2 ? q.h : 0) : q.z + (f === 4 ? 1 : -1) * q.d / 2;
    const p0 = plane(o);
    // the same plane: upright faces only (the tops of all the floor slabs share a level, the floor is not one face),
    // and with an exterior finish only those that look outdoors (not the indoor face of a wall on that line)
    const slabOut = (q: BoxObject) => {
      // a slab edge looks outdoors when no other slab piece of that floor carries on past it
      const d = 5, px = q.x + (f === 0 ? q.w / 2 + d : f === 1 ? -q.w / 2 - d : 0), pz = q.z + (f === 4 ? q.d / 2 + d : f === 5 ? -q.d / 2 - d : 0);
      return !this.objects.some(r => isBox(r) && r !== q && r.layer === 'slab' && r.floor === q.floor && !r.rot && Math.abs(px - r.x) < r.w / 2 && Math.abs(pz - r.z) < r.d / 2);
    };
    const outward = (q: BoxObject) => !ext || q === o || (q.layer === 'slab' ? slabOut(q) : !!this.exterior().get(q.id)?.includes(f));
    const same = this.finishScope === 'one' || o.rot || f === 2 || f === 3 ? [o] : this.objects.filter((q): q is BoxObject => isBox(q) && !q.rot && !q.stair && q.layer === o.layer
      && (this.finishScope === 'all' || q.floor === o.floor) && Math.abs(plane(q) - p0) < 3 && outward(q));
    this.snapshot();
    for (const q of same) {
      const fs = { ...(q.faces || {}) };
      if (this.finishMat) fs[f] = this.finishMat; else delete fs[f];
      q.faces = Object.keys(fs).length ? fs : undefined;
      if (!q.faces) delete q.faces;
    }
    this.rebuild();
    this.commit();
    this.ev.info(this.finishMat ? `已指定材質：${this.finishMat.replace(/^外牆1:3水泥砂漿打底\+/, '')}（${same.length} 個面）` : `已清除材質（${same.length} 個面）`);
  }
  /** the colour scheme in force: [main wall tile, accent tile for the ground storey and parapets] */
  private scheme(): FacadeScheme | null {
    if (this.facade === 'none') return null;
    if (typeof this.facade === 'number') return FACADE_SCHEMES[this.facade % FACADE_SCHEMES.length];
    // auto: chosen from the building's size, so one building keeps its look
    const n = Math.round(this.cad?.W || 0) * 7 + Math.round(this.cad?.D || 0) * 3 + this.objects.length;
    return FACADE_SCHEMES[n % FACADE_SCHEMES.length];
  }
  /** rendered look: the outward faces of exterior walls get 二丁掛 tiles (227×60 mm, running bond) */
  private tileFaces(m: THREE.Mesh, o: ModelObject) {
    if (!this.real || this.xray || isDoor(o)) return;
    const sc = this.scheme();
    if (!sc) return;
    const faces = this.exterior().get(o.id);
    if (!faces?.length) return;
    const b = o as BoxObject, g = m.geometry as THREE.BoxGeometry, uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const base = this.floors.length && b.floor === [...this.floors].sort((p, q) => p.y - q.y)[0].key;
    const accent = base || /女兒牆|欄杆|裝飾板|裝飾柱/.test(b.name);
    const tile = new THREE.MeshStandardMaterial({ map: tileTexture(accent ? sc.accent : sc.main), roughness: 0.72, metalness: 0 });
    const plain = m.material as THREE.Material;
    m.material = [0, 1, 2, 3, 4, 5].map(f => faces.includes(f) ? tile : plain);
    for (const f of faces) {
      const wid = f < 2 ? b.d : b.w, off = (f < 2 ? b.z - b.d / 2 : b.x - b.w / 2) / TILE_U;
      for (let k = 4 * f; k < 4 * f + 4; k++) uv.setXY(k, off + uv.getX(k) * wid / TILE_U, (b.y + uv.getY(k) * b.h) / TILE_V);
    }
    uv.needsUpdate = true;
  }
  /**
   * The faces (BoxGeometry order: +x −x +y −y +z −z) of each wall that look outdoors: a little past the face there
   * is no floor of that storey or the one above, and no other wall. Light partitions are left out.
   */
  private exterior() {
    let sig = this.objects.length;
    for (const o of this.objects) if (!isDoor(o)) sig = (sig * 31 + Math.round(o.x * 3 + o.z * 5 + o.w * 7 + o.d * 11 + o.h * 13 + o.y)) | 0;
    if (this.facadeKey === sig) return this.facadeFaces;
    this.facadeKey = sig;
    const out = new Map<number, number[]>();
    this.facadeFaces = out;
    type R = { x0: number; x1: number; z0: number; z1: number };
    const slabs = new Map<string, R[]>(), walls = new Map<string, BoxObject[]>();
    const boxes = this.objects.filter((o): o is BoxObject => !isDoor(o));
    for (const o of boxes) {
      const k = o.floor || '';
      if (o.layer === 'slab' && !o.rot) (slabs.get(k) || slabs.set(k, []).get(k)!).push({ x0: o.x - o.w / 2, x1: o.x + o.w / 2, z0: o.z - o.d / 2, z1: o.z + o.d / 2 });
      if (o.layer === 'wall' || o.layer === 'glass') (walls.get(k) || walls.set(k, []).get(k)!).push(o);
    }
    const order = [...this.floors].sort((p, q) => p.y - q.y).map(f => f.key);
    const inR = (rs: R[] | undefined, x: number, z: number) => !!rs?.some(r => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
    const inBox = (os: BoxObject[] | undefined, me: BoxObject, x: number, z: number) => !!os?.some(o => {
      if (o === me) return false;
      const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0), dx = x - o.x, dz = z - o.z;
      return Math.abs(dx * c - dz * s) < o.w / 2 && Math.abs(dx * s + dz * c) < o.d / 2;
    });
    const bbox = new Map<string, R>();
    for (const [k, ws] of walls) bbox.set(k, { x0: Math.min(...ws.map(o => o.x - o.w / 2)), x1: Math.max(...ws.map(o => o.x + o.w / 2)), z0: Math.min(...ws.map(o => o.z - o.d / 2)), z1: Math.max(...ws.map(o => o.z + o.d / 2)) });
    for (const o of boxes) {
      if (o.layer !== 'wall' || o.wall === 'light' || /輕隔間|隔間牆/.test(o.name) || Math.min(o.w, o.d) < 8 || o.h < 30) continue;
      const k = o.floor || '', i = order.indexOf(k), up = i >= 0 ? order[i + 1] : undefined;
      const own = slabs.get(k), above = up ? slabs.get(up) : undefined, bb = bbox.get(k)!;
      const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
      const outdoors = (x: number, z: number) => own?.length || above?.length
        ? !inR(own, x, z) && !inR(above, x, z) && !inBox(walls.get(k), o, x, z)
        : x < bb.x0 || x > bb.x1 || z < bb.z0 || z > bb.z1;
      const faces: number[] = [];
      // local face normals and half sizes: +x −x +z −z
      for (const [f, nx, nz] of [[0, 1, 0], [1, -1, 0], [4, 0, 1], [5, 0, -1]] as const) {
        const half = nx ? o.w / 2 : o.d / 2, len = nx ? o.d : o.w;
        if (len < 20) continue;
        let hits = 0;
        for (const t of [-0.3, 0, 0.3]) {
          const lx = nx * (half + 40) + (nz ? t * len : 0), lz = nz * (half + 40) + (nx ? t * len : 0);
          if (outdoors(o.x + lx * c + lz * s, o.z - lx * s + lz * c)) hits++;
        }
        if (hits >= 2) faces.push(f);
      }
      if (faces.length) out.set(o.id, faces);
    }
    return out;
  }
  setFacade(f: 'auto' | 'none' | number) { this.facade = f; this.rebuild(); this.invalidate(); }
  rebuild() {
    for (const c of this.objGroup.children.slice()) {
      this.objGroup.remove(c);
      c.traverse(n => { const m = n as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
    }
    for (const o of this.objects) if (this.shown(o)) {
      const n = this.buildObj(o);
      n.position.y += this.lift(o.floor);
      if (this.xray) this.xrayNode(n, XRAY[memberOf(o)]);
      this.objGroup.add(n);
    }
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
  /** exploded view: how far a storey's parts are raised */
  private lift(floor?: string) {
    if (!this.explode || !floor || this.floor) return 0;
    const i = [...this.floors].sort((a, b) => a.y - b.y).findIndex(f => f.key === floor);
    return i > 0 ? i * this.explode : 0;
  }
  /** x-ray look of one part: solid in its colour (structure) or faint glass */
  private xrayNode(n: THREE.Object3D, solid?: number) {
    n.traverse(c => {
      const m = c as THREE.Mesh;
      if ((m as unknown as THREE.LineSegments).isLineSegments) {
        const lm = m.material as THREE.LineBasicMaterial;
        if (solid === undefined) { lm.transparent = true; lm.opacity = 0.12; lm.depthWrite = false; }
        return;
      }
      if (!m.isMesh) return;
      (m.material as THREE.Material).dispose();
      m.material = solid !== undefined
        ? new THREE.MeshStandardMaterial({ color: solid, roughness: 0.6 })
        : new THREE.MeshLambertMaterial({ color: 0xa9b4c4, transparent: true, opacity: 0.1, depthWrite: false });
      m.castShadow = solid !== undefined;
      if (solid === undefined) m.renderOrder = 2;
    });
  }
  setExplode(gap: number) { this.explode = Math.max(0, gap); this.rebuild(); this.invalidate(); }
  setXray(on: boolean) { this.xray = on; this.rebuild(); this.invalidate(); }
  private meshOf(id: number) {
    let r: THREE.Mesh | null = null;
    this.objGroup.traverse(n => { if ((n as THREE.Mesh).isMesh && n.userData.id === id) r = n as THREE.Mesh; });
    return r as THREE.Mesh | null;
  }
  private updateSelection() {
    if (this.selBox) { this.helperGroup.remove(this.selBox); this.selBox = null; }
    const i = this.labels.findIndex(l => l.sel);
    if (i >= 0) { this.labels[i].el.remove(); this.labels.splice(i, 1); }
    const o = this.byId(this.selectedId);
    this.ev.select?.(o || null);
    if (!o) return;
    const m = this.meshOf(o.id);
    if (!m) return;
    // the selected part's name floats above it, so a new name shows at once
    const b = new THREE.Box3().setFromObject(m);
    this.addLabel(`<b>${esc(o.name || '構件')}</b>`, new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y + 15, (b.min.z + b.max.z) / 2), 'tag selTag').sel = true;
    this.selBox = new THREE.BoxHelper(m, 0x1f6feb);
    (this.selBox.material as THREE.LineBasicMaterial).depthTest = false;
    this.selBox.renderOrder = 10;
    this.helperGroup.add(this.selBox);
    this.ev.info(describe(o));
  }

  /** The kept SketchUp geometry, rebuilt only when the model, storey or render mode changes. */
  private buildMeshes() {
    const key = `${this.cad?.meshes?.length ?? 0}|${this.floor}|${this.mode}|${isDarkTheme()}|${this.explode}|${this.xray}`;
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
      m.position.y = this.lift(cm.floor);
      if (this.xray) this.xrayNode(m);
      this.meshGroup.add(m);
      // SketchUp-style outlines: only creases, not the triangulation
      if (this.real) continue;
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), this.edgeMat());
      e.raycast = () => {};
      e.position.y = m.position.y;
      if (this.xray) this.xrayNode(e);
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
    const st = this.sunStudy ? sunDirection(this.sunStudy.day, this.sunStudy.hour, this.sunStudy.northDeg) : null;
    if (st) {
      // sun study: the real sun of that day and hour; below the horizon only the sky light is left
      this.sun.position.set(c.x + st.dir.x * 1800 * s, Math.max(0.02, st.dir.y) * 1800 * s, c.z + st.dir.z * 1800 * s);
      this.sun.intensity = st.alt > 0 ? 0.6 + 2.2 * Math.min(1, Math.sin(st.alt) * 1.6) : 0;
    } else {
      // late-morning sun from the south-east: the south faces lit, the west faces in soft shade, shadows falling back-left in the default view
      this.sun.position.set(c.x + 1100 * s, 1250 * s, c.z + 900 * s);
      this.sun.intensity = 2.2;
    }
    this.sun.target.position.copy(c);
    Object.assign(this.sun.shadow.camera, { left: -1000 * s, right: 1000 * s, top: 1000 * s, bottom: -1000 * s, near: 100, far: 4000 * s });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.invalidate();
    this.camera.far = Math.max(40000, 14000 * s);
    this.camera.updateProjectionMatrix();
  }

  /** Sun study on (day of the year 1–365, solar hour 0–24) or off (null). Returns the sun's altitude and azimuth, degrees. */
  setSunStudy(v: { day: number; hour: number; northDeg: number } | null) {
    this.sunStudy = v;
    this.fitSun();
    if (!v) return null;
    const st = sunDirection(v.day, v.hour, v.northDeg);
    return { alt: st.alt * 180 / Math.PI, az: st.az * 180 / Math.PI };
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
      if ((it.room && this.cad) || (!this.showLabels && !it.meas && !it.sel)) { it.el.hidden = true; continue; }
      // a vertical section also takes away the names of what is cut off
      if (!it.meas && !it.sel && this.sectionPlane && this.sectionKind !== 'h' && this.sectionPlane.distanceToPoint(it.pos) < 0) { it.el.hidden = true; continue; }
      v.copy(it.pos).project(this.camera);
      const off = v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2;
      it.el.hidden = off;
      if (!off) it.el.style.transform = `translate(${(v.x + 1) / 2 * rw}px, ${(1 - v.y) / 2 * rh}px) translate(-50%,-50%)`;
    }
  }

  /* ---------- camera ---------- */
  private sceneDef(k: SceneKey): { pos: number[]; target?: number[]; fov: number } {
    const s = Math.max(this.bounds.W, this.bounds.D, this.height * 1.4) / 1180, c = this.center;
    if (k === 'bird') return { pos: [c.x - 1050 * s, 1250 * s, c.z + 1250 * s], fov: 40 };
    if (k === 'front' || k === 'side') {
      // elevations: level view straight at the middle of the building, far enough to see all of it
      const fov = 30, b = this.floor ? this.floorBase : 0, cy = b + this.height / 2;
      const aspect = this.view.clientWidth / Math.max(1, this.view.clientHeight), t = Math.tan(fov / 2 * Math.PI / 180);
      const wide = k === 'front' ? this.bounds.W : this.bounds.D, deep = k === 'front' ? this.bounds.D : this.bounds.W;
      const d = Math.max(this.height * 0.6 / t, wide * 0.6 / (t * aspect)) + deep / 2;
      return k === 'front' ? { pos: [c.x, cy, c.z + d], target: [c.x, cy, c.z], fov } : { pos: [c.x + d, cy, c.z], target: [c.x, cy, c.z], fov };
    }
    if (k === 'eye') {
      // two-point perspective from a person standing outside the south-west corner: eye height, level view
      const b = this.floor ? this.floorBase : 0, d = Math.max(this.bounds.W, this.bounds.D) * 0.7 + this.height * 0.6;
      return { pos: [c.x - d * 0.62, b + 160, c.z + d * 0.78], target: [c.x, b + 160 + this.height * 0.12, c.z], fov: 55 };
    }
    return { pos: [c.x - 1050 * s, 1250 * s, c.z + 1250 * s], fov: 40 };
  }
  /** Flies to a part (or a spot on a floor): the camera keeps its direction and comes close enough to see it. */
  focusOn(id: number | null, at?: [number, number], floorKey?: string) {
    this.exitWalk();
    const o = id !== null ? this.byId(id) : undefined;
    let cx: number, cy: number, cz: number, size: number;
    if (o && isBox(o)) { cx = o.x; cy = o.y + o.h / 2; cz = o.z; size = Math.max(o.w, o.d, o.h); }
    else if (o) { cx = o.axis === 'x' ? (o.a + o.b) / 2 : o.at; cz = o.axis === 'z' ? (o.a + o.b) / 2 : o.at; cy = 100; size = Math.abs(o.b - o.a); }
    else if (at) { cx = at[0]; cz = at[1]; cy = (this.floors.find(f => f.key === floorKey)?.y || 0) + 150; size = 300; }
    else return;
    const target = new THREE.Vector3(cx, cy, cz);
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.length() < 1) dir.set(-1, 1, 1);
    dir.normalize();
    const dist = Math.max(400, size * 2.2 + 250);
    const to = { pos: target.clone().addScaledVector(dir, dist), target, fov: this.camera.fov };
    this.fly = { from: { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov }, to, t0: performance.now() };
    this.invalidate();
  }
  private lastScene: SceneKey = 'bird';
  private lastAspect = 0;
  goScene(k: SceneKey, instant = false) {
    this.exitWalk();
    this.lastScene = k;
    const s = this.sceneDef(k);
    const target = s.target ? new THREE.Vector3(...s.target) : this.center.clone();
    const aspect = this.view.clientWidth / Math.max(1, this.view.clientHeight);
    const fit = s.target ? 1 : Math.max(1, 0.92 / aspect);
    const to = { pos: new THREE.Vector3(...s.pos).sub(target).multiplyScalar(fit).add(target), target, fov: s.fov };
    if (k !== 'eye') this.fitView(to);
    if (instant) {
      this.camera.position.copy(to.pos);
      this.controls.target.copy(to.target);
      this.camera.fov = to.fov;
      this.camera.updateProjectionMatrix();
      return;
    }
    this.fly = { from: { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov }, to, t0: performance.now() };
  }
  /**
   * Centre what is shown in the view and fill it: the camera keeps its direction, the target moves to the middle of
   * the model as seen on screen (a model seen from a corner is lopsided around its plan centre), and the distance
   * is set so the model takes up most of the width or height, whichever it meets first.
   */
  private fitView(to: { pos: THREE.Vector3; target: THREE.Vector3; fov: number }) {
    const box = new THREE.Box3();
    for (const g of [this.objGroup, this.meshGroup, ...(this.cad ? [] : [this.floorGroup])]) if (g.visible && g.children.length) box.expandByObject(g);
    if (box.isEmpty()) return;
    const corners: THREE.Vector3[] = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const cam = new THREE.PerspectiveCamera(to.fov, this.view.clientWidth / Math.max(1, this.view.clientHeight), 1, 1e7);
    const dir = to.pos.clone().sub(to.target), target = to.target.clone();
    let dist = dir.length();
    dir.normalize();
    const v = new THREE.Vector3();
    for (let it = 0; it < 6; it++) {
      cam.position.copy(target).addScaledVector(dir, dist);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const c of corners) { v.copy(c).project(cam); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
      // move the target so the model's screen box is centred (on the plane through the target, across the view)
      const h = Math.tan(to.fov / 2 * Math.PI / 180) * dist, w = h * cam.aspect;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      target.addScaledVector(right, (x0 + x1) / 2 * w).addScaledVector(up, (y0 + y1) / 2 * h);
      const fill = Math.max((x1 - x0) / 2, (y1 - y0) / 2) / 0.86;
      dist *= Math.min(3, Math.max(0.33, fill));
    }
    to.target.copy(target);
    to.pos.copy(target).addScaledVector(dir, dist);
  }
  private resize() {
    this.active = performance.now();
    const w = this.view.clientWidth, h = this.view.clientHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    // the phone turned (or the panels above folded): frame the model again for the new shape of the view
    const a = this.camera.aspect;
    if (this.lastAspect && Math.abs(Math.log(a / this.lastAspect)) > 0.25 && !this.walk.on) this.goScene(this.lastScene, true);
    this.lastAspect = a;
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
  /** On-screen joystick: x right, y forward, each -1 … 1. */
  walkStick(x: number, y: number) { this.walk.axis = { x, y }; this.invalidate(); }

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
      if (o) return { o, point: h.point, normal: h.face?.normal.clone() };
    }
    return null;
  }
  /** parts near enough to lock on to while pushing: square boxes within 15 m */
  private lockParts(o: BoxObject) {
    return this.objects.filter((q): q is BoxObject => q !== o && isBox(q) && !q.rot && Math.abs(q.x - o.x) < 1500 + (q.w + o.w) / 2 && Math.abs(q.z - o.z) < 1500 + (q.d + o.d) / 2);
  }
  /** the nearest level within tol of v: the top or underside of a nearby part, or a floor level */
  private lockLevel(o: BoxObject, v: number, tol: number): { v: number; what: string } | null {
    let best: { v: number; what: string; d: number } | null = null;
    const take = (lv: number, what: string) => { const dd = Math.abs(lv - v); if (dd <= tol && (!best || dd < best.d)) best = { v: lv, what, d: dd }; };
    for (const q of this.lockParts(o)) { take(q.y + q.h, `${q.name} 頂面`); take(q.y, `${q.name} 底面`); }
    for (const f of this.floors) { take(f.y, `${f.key} 樓地板`); take(f.y + f.h, `${f.key} 樓頂`); }
    return best ? { v: (best as { v: number }).v, what: (best as { what: string }).what } : null;
  }
  /** pulling a side face: lock it on to a face line (or corner) of a nearby part along the pull direction */
  private lockFace(d: Extract<NonNullable<typeof this.drag>, { kind: 'pushSide' }>, ns: number, tol: number): { s: number; at: THREE.Vector3; what: string } | null {
    const o = d.o, ax = Math.abs(d.dir.x) > 0.99 ? 'x' : Math.abs(d.dir.z) > 0.99 ? 'z' : null;
    if (!ax) return null;
    const sign = ax === 'x' ? Math.sign(d.dir.x) : Math.sign(d.dir.z);
    // the fixed face, and where the moving face would be
    const c0 = ax === 'x' ? d.x0 : d.z0, fixed = c0 - sign * d.s0 / 2, at = fixed + sign * ns;
    let best: { v: number; what: string; dd: number; q: BoxObject } | null = null;
    for (const q of this.lockParts(o)) {
      const qc = ax === 'x' ? q.x : q.z, qh = (ax === 'x' ? q.w : q.d) / 2;
      for (const [v, side] of [[qc - qh, '面'], [qc + qh, '面'], [qc, '中心']] as const) {
        const dd = Math.abs(v - at);
        if (dd <= tol && (!best || dd < best.dd)) best = { v, what: `${q.name} ${side === '中心' ? '中心線' : '邊緣'}`, dd, q };
      }
    }
    if (!best) return null;
    const b = best as { v: number; what: string; q: BoxObject };
    const s2 = Math.abs(b.v - fixed), y = o.y + o.h + this.lift(o.floor);
    const across = ax === 'x' ? o.z : o.x;
    return { s: Math.round(s2 * 10) / 10, at: ax === 'x' ? new THREE.Vector3(b.v, y, across) : new THREE.Vector3(across, y, b.v), what: b.what };
  }
  private snapDot: THREE.Mesh | null = null;
  /** a small marker where the push locked on, gone when not locked */
  private snapMark(p: THREE.Vector3 | null) {
    if (!p) { if (this.snapDot) { this.helperGroup.remove(this.snapDot); this.snapDot = null; } return; }
    if (!this.snapDot) {
      this.snapDot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff2d55, depthTest: false }));
      this.snapDot.renderOrder = 10;
      this.helperGroup.add(this.snapDot);
    }
    this.snapDot.scale.setScalar(Math.max(4, this.camera.position.distanceTo(p) / 120));
    this.snapDot.position.copy(p);
  }
  /** a top or bottom face is pushed up and down (height); a side face is pulled sideways (length or width) */
  private pushDrag(o: BoxObject, point: THREE.Vector3, normal: THREE.Vector3 | undefined, e: PointerEvent): NonNullable<typeof this.drag> {
    if (!normal || Math.abs(normal.y) > 0.5) return { kind: 'push', o, sh: o.h, y0: e.clientY, scale: this.camera.position.distanceTo(this.controls.target) / 700 };
    const axis = Math.abs(normal.x) >= Math.abs(normal.z) ? 'w' : 'd';
    const local = axis === 'w' ? new THREE.Vector3(Math.sign(normal.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(normal.z));
    const dir = local.applyAxisAngle(new THREE.Vector3(0, 1, 0), o.rot || 0);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -point.y);
    return { kind: 'pushSide', o, axis, s0: o[axis], x0: o.x, z0: o.z, dir, plane, p0: point.clone() };
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
    on(v, 'contextmenu', e => { if (this.tool === 'line') e.preventDefault(); });
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
      if (this.tool === 'line' && this.lineA) {
        if (e.key === 'Escape') { this.endLine(); return; }
        if (/^[0-9.]$/.test(e.key)) { this.lineBuf += e.key; this.ev.info(`長度：${this.lineBuf} cm（按 Enter 確定）`); e.preventDefault(); return; }
        if (e.key === 'Backspace' && this.lineBuf) { this.lineBuf = this.lineBuf.slice(0, -1); this.ev.info(`長度：${this.lineBuf} cm`); e.preventDefault(); return; }
        if (e.key === 'Enter' && this.lineBuf) { this.lineTyped(); e.preventDefault(); return; }
      }
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
    if (d && (d.kind === 'move' || d.kind === 'push' || d.kind === 'pushSide')) { this.history.pop(); this.snapMark(null); }
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
        : this.pushDrag(h.o, h.point, h.normal, e);
      this.take(e);
    }
  }
  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d && this.tool === 'line') { this.linePreview(e); return; }
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
      this.meshOf(d.o.id)?.position.set(r.x, d.o.y + d.o.h / 2 + this.lift(d.o.floor), r.z);
      this.selBox?.update();
      this.ev.delta(r.x - d.sx, r.z - d.sz);
      this.ev.info(`移動 ${d.o.name}｜ΔX:${Math.round(r.x - d.sx)} ΔZ:${Math.round(r.z - d.sz)} cm`);
      if (r.hit && r.hit !== d.lastHit) { const rm = this.roomAt(r.hit.x, r.hit.z); this.ev.toast(`🧲 磁吸貼合 ${rm ? rm.n : ''}${r.hit.name}`); }
      d.lastHit = r.hit;
    }
    if (d.kind === 'push') {
      const step = this.magnet ? 5 : 1;
      let nh = Math.max(2, Math.round((d.sh + (d.y0 - e.clientY) * d.scale) / step) * step);
      // lock on to the top or bottom of a nearby part, or a floor level, within about 12 px
      const lock = this.lockLevel(d.o, d.o.y + nh, 12 * d.scale);
      if (lock) nh = Math.max(2, Math.round((lock.v - d.o.y) * 10) / 10);
      this.snapMark(lock ? new THREE.Vector3(d.o.x, lock.v + this.lift(d.o.floor), d.o.z) : null);
      d.o.h = nh;
      const m = this.meshOf(d.o.id);
      if (m) {
        m.geometry.dispose();
        m.geometry = new THREE.BoxGeometry(d.o.w, nh, d.o.d);
        const edge = m.children[0] as THREE.LineSegments | undefined;
        if (edge) { edge.geometry.dispose(); edge.geometry = new THREE.EdgesGeometry(m.geometry); }
        m.position.y = d.o.y + nh / 2 + this.lift(d.o.floor);
      }
      this.selBox?.update();
      this.ev.info(`推拉 ${d.o.name}｜高度 ${nh} cm（原 ${d.sh} cm）${lock ? `｜🔒 鎖點：${lock.what}` : ''}`);
    }
    if (d.kind === 'pushSide') {
      this.setRay(e);
      const p = new THREE.Vector3();
      if (!this.ray.ray.intersectPlane(d.plane, p)) return;
      const step = this.magnet ? 5 : 1;
      let ns = Math.max(2, Math.round((d.s0 + p.sub(d.p0).dot(d.dir)) / step) * step);
      // lock the moving face on to a face or corner of a nearby part (square parts only)
      const px = this.camera.position.distanceTo(this.controls.target) / 700;
      const lock = this.lockFace(d, ns, 12 * px);
      if (lock) ns = Math.max(2, lock.s);
      const moved = ns - d.s0;
      d.o[d.axis] = ns;
      d.o.x = d.x0 + d.dir.x * moved / 2; d.o.z = d.z0 + d.dir.z * moved / 2;
      const m = this.meshOf(d.o.id);
      if (m) {
        m.geometry.dispose();
        m.geometry = new THREE.BoxGeometry(d.o.w, d.o.h, d.o.d);
        const edge = m.children[0] as THREE.LineSegments | undefined;
        if (edge) { edge.geometry.dispose(); edge.geometry = new THREE.EdgesGeometry(m.geometry); }
        m.position.set(d.o.x, d.o.y + d.o.h / 2 + this.lift(d.o.floor), d.o.z);
      }
      this.selBox?.update();
      this.snapMark(lock ? lock.at : null);
      this.ev.info(`推拉 ${d.o.name}｜${d.axis === 'w' ? '長' : '寬'} ${Math.round(ns * 10) / 10} cm（原 ${d.s0} cm）${lock ? `｜🔒 鎖點：${lock.what}` : ''}`);
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
        this.snapMark(null);
        if (d.o.h === d.sh) this.history.pop(); else this.commit();
        this.rebuild();
      } else if (d.kind === 'pushSide') {
        this.snapMark(null);
        if (d.o[d.axis] === d.s0) this.history.pop(); else this.commit();
        this.rebuild();
      }
      this.drag = null;
      this.controls.enabled = this.tool !== 'walk';
      return;
    }
    if (this.tool === 'line' && e.button === 2 && wasClick) { this.endLine(); this.ev.info('畫線結束'); return; }
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
    if (tool === 'line') return this.lineClick(e);
    if (tool === 'del' && this.lineHit(e) >= 0) {
      const i = this.lineHit(e);
      this.snapshot();
      this.sketch = this.sketch.filter((_, j) => j !== i);
      this.drawSketch();
      this.ev.sketch?.(this.sketch);
      this.ev.toast('已刪除線（可按復原）');
      return;
    }
    if (tool === 'fix') return this.fixKind === 'wall' ? this.fixWall(e) : this.fixSlab(e);
    if (tool === 'finish') return this.finishClick(e);
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
  /** 柱間補牆: first click picks a column (or wall), the second one adds a wall closing the gap to it */
  private fixWall(e: PointerEvent) {
    const h = this.hitObject(e);
    if (!h || !isBox(h.o) || h.o.layer !== 'wall') { this.ev.toast('請點柱或牆'); return; }
    const a = this.byId(this.fixA);
    if (!a || !isBox(a) || a === h.o) {
      this.fixA = h.o.id;
      this.selectedId = h.o.id;
      this.updateSelection();
      this.ev.info(`已選 ${h.o.name}，再點另一根柱或牆，會在兩者之間補一道牆`);
      return;
    }
    const w = wallBetween(a, h.o);
    this.fixA = null;
    if (!w) { this.ev.toast('兩者已經相接，或相距太遠（超過 12 m）'); return; }
    this.snapshot();
    const o = { id: this.uid++, ...w, floor: a.floor || h.o.floor } as BoxObject;
    if (!o.floor) delete o.floor;
    this.objects.push(o);
    this.selectedId = o.id;
    this.rebuild();
    this.commit();
    this.ev.toast(`已補牆 ${Math.round(Math.max(o.w, o.d))} cm（可按復原）`);
  }
  /** 點房間補樓板: the floor of the room clicked, bounded by that storey's walls, minus slabs already there */
  private fixSlab(e: PointerEvent) {
    if (this.floors.length && !this.floor) { this.ev.toast('請先在上方「樓層」選一層，再點房間'); return; }
    const key = this.floor || undefined, base = this.floorBase;
    this.setRay(e);
    const p = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -base), p)) return;
    const on = (o: ModelObject) => !key || o.floor === key;
    const walls = this.objects.filter((o): o is BoxObject => isBox(o) && (o.layer === 'wall' || o.layer === 'rail' || o.layer === 'glass') && on(o) && o.h >= 60 && o.y < base + 150);
    const slabs = this.objects.filter((o): o is BoxObject => isBox(o) && o.layer === 'slab' && on(o) && !/梁/.test(o.name) && Math.abs(o.y + o.h - base) < 10);
    const rects = roomSlabAt(walls, p.x, p.z, this.bounds.W, this.bounds.D, slabs.map(o => ({ x0: o.x - o.w / 2, x1: o.x + o.w / 2, z0: o.z - o.d / 2, z1: o.z + o.d / 2 })));
    if (!rects.length) {
      const inSlab = slabs.some(o => Math.abs(p.x - o.x) < o.w / 2 && Math.abs(p.z - o.z) < o.d / 2);
      this.ev.toast(inSlab ? '這個房間已經有樓板' : '這裡沒有圍起來的房間：先用「柱間補牆」把缺的牆補上，或用「繪圖 › 樓板」畫');
      return;
    }
    this.snapshot();
    let area = 0;
    for (const r of rects) {
      const o: BoxObject = { id: this.uid++, layer: 'slab', name: '樓板（手動補板）', x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, h: 15, y: base - 15, color: 0xd6d1c7 };
      if (key) o.floor = key;
      this.objects.push(o);
      area += o.w * o.d;
    }
    this.rebuild();
    this.commit();
    this.ev.toast(`已補樓板 ${(area / 1e4).toFixed(1)} m²（可按復原）`);
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
  /* ---------- 畫線 ---------- */
  sketch: SketchLine[] = [];
  private sketchGroup = new THREE.Group();
  private lineA: THREE.Vector3 | null = null;
  private lineStart: THREE.Vector3 | null = null;
  private lineEnd: THREE.Vector3 | null = null;
  private linePrev: THREE.Line | null = null;
  private lineBuf = '';
  setSketch(lines: SketchLine[]) { this.sketch = lines; this.drawSketch(); }
  private drawSketch() {
    if (!this.sketchGroup.parent) this.scene.add(this.sketchGroup);
    for (const c of this.sketchGroup.children.slice()) { this.sketchGroup.remove(c); (c as THREE.LineSegments).geometry.dispose(); }
    if (!this.sketch.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.sketch.flatMap(l => [...l.a, ...l.b]), 3));
    const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: isDarkTheme() ? 0xf8fafc : 0x111827 }));
    m.renderOrder = 5;
    this.sketchGroup.add(m);
  }
  /** index of the drawn line under the pointer, or -1 */
  private lineHit(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const scr = (v: number[]) => { const p = new THREE.Vector3(v[0], v[1], v[2]).project(this.camera); return [(p.x + 1) / 2 * r.width, (1 - p.y) / 2 * r.height]; };
    let best = -1, bd = 8;
    this.sketch.forEach((l, i) => {
      const [ax, ay] = scr(l.a), [bx, by] = scr(l.b), dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)), d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  /** the point under the pointer, locked to a nearby corner, line end or midpoint (12 px), or along an axis from the last point */
  private linePoint(e: PointerEvent) {
    const h = this.hitObject(e);
    let p = h ? h.point.clone() : this.hitGround(e);
    if (!p) return null;
    const r = this.renderer.domElement.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const cands: [THREE.Vector3, string][] = [];
    for (const l of this.sketch) {
      const a = new THREE.Vector3(...l.a), b = new THREE.Vector3(...l.b);
      cands.push([a, '端點'], [b, '端點'], [a.clone().add(b).multiplyScalar(0.5), '中點']);
    }
    if (this.lineStart) cands.push([this.lineStart, '起點']);
    if (h && isBox(h.o)) {
      const o = h.o, c = Math.cos(o.rot || 0), sn = Math.sin(o.rot || 0), y0 = o.y + this.lift(o.floor);
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) for (const y of [y0, y0 + o.h]) {
        const lx = a * o.w / 2, lz = b * o.d / 2;
        cands.push([new THREE.Vector3(o.x + lx * c + lz * sn, y, o.z - lx * sn + lz * c), '角點']);
      }
    }
    let best: [THREE.Vector3, string] | null = null, bd = 12;
    for (const [q, what] of cands) {
      const s = q.clone().project(this.camera), sx = (s.x + 1) / 2 * r.width, sy = (1 - s.y) / 2 * r.height, d = Math.hypot(sx - px, sy - py);
      if (s.z < 1 && d < bd) { bd = d; best = [q, what]; }
    }
    if (best) return { p: best[0].clone(), what: best[1] };
    // along the red / green / blue axis from the last point when within 4°
    if (this.lineA) {
      const v = p.clone().sub(this.lineA), L = v.length();
      if (L > 1) for (const [ax, what] of [[new THREE.Vector3(1, 0, 0), '紅軸'], [new THREE.Vector3(0, 0, 1), '綠軸'], [new THREE.Vector3(0, 1, 0), '藍軸']] as const) {
        if (Math.abs(v.dot(ax)) / L > Math.cos(4 * Math.PI / 180)) return { p: this.lineA.clone().addScaledVector(ax, v.dot(ax)), what };
      }
    }
    if (!h && this.magnet) { p.x = this.snap(p.x); p.z = this.snap(p.z); }
    return { p, what: '' };
  }
  private linePreview(e: PointerEvent) {
    const q = this.linePoint(e);
    this.snapMark(q && q.what ? q.p : null);
    if (!this.lineA || !q) return;
    this.lineEnd = q.p;
    if (!this.linePrev) {
      this.linePrev = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xff2d55, dashSize: 10, gapSize: 6, depthTest: false }));
      this.linePrev.renderOrder = 11;
      this.helperGroup.add(this.linePrev);
    }
    this.linePrev.geometry.setFromPoints([this.lineA, q.p]);
    this.linePrev.computeLineDistances();
    if (!this.lineBuf) this.ev.info(`畫線：長度 ${Math.round(this.lineA.distanceTo(q.p))} cm${q.what ? `｜🔒 ${q.what}` : ''}（可直接輸入長度按 Enter）`);
  }
  private addLine(a: THREE.Vector3, b: THREE.Vector3) {
    if (a.distanceTo(b) < 1) return;
    this.snapshot();
    const r = (v: THREE.Vector3) => [Math.round(v.x * 10) / 10, Math.round(v.y * 10) / 10, Math.round(v.z * 10) / 10] as [number, number, number];
    this.sketch = [...this.sketch, { a: r(a), b: r(b) }];
    this.drawSketch();
    this.ev.sketch?.(this.sketch);
  }
  private lineClick(e: PointerEvent) {
    const q = this.linePoint(e);
    if (!q) return;
    this.lineBuf = '';
    if (!this.lineA) { this.lineA = q.p; this.lineStart = q.p.clone(); this.ev.info('畫線：點下一點（Esc 結束）'); return; }
    this.addLine(this.lineA, q.p);
    // back at the start closes the outline and ends the line
    if (this.lineStart && q.p.distanceTo(this.lineStart) < 0.5) { this.endLine(); this.ev.info('已封閉，畫線結束'); return; }
    this.lineA = q.p;
  }
  /** a length typed while drawing: the next point that far along the current direction */
  private lineTyped() {
    const a = this.lineA, L = parseFloat(this.lineBuf);
    this.lineBuf = '';
    if (!a || !this.lineEnd || !(L > 0)) return;
    const dir = this.lineEnd.clone().sub(a);
    if (dir.length() < 0.01) return;
    const b = a.clone().addScaledVector(dir.normalize(), L);
    this.addLine(a, b);
    this.lineA = b;
    this.ev.info(`已畫 ${L} cm，繼續點下一點或輸入長度`);
  }
  private endLine() {
    this.lineA = null; this.lineStart = null; this.lineEnd = null; this.lineBuf = '';
    if (this.linePrev) { this.helperGroup.remove(this.linePrev); this.linePrev.geometry.dispose(); this.linePrev = null; }
    this.snapMark(null);
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
      this.ao!.enabled = !this.sectionPlane && !this.xray;
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
    if (!this.visible || document.hidden) return;
    // phones: at most 30 frames a second while moving (half the work, the GPU stays cool)
    if (this.phone && now - this.last < 30) return;
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
      if (w.axis.x || w.axis.y) { this.camera.position.addScaledVector(fw, sp * 1.4 * w.axis.y); this.camera.position.addScaledVector(r, sp * 1.4 * w.axis.x); }
    } else if (this.controls.update()) this.active = now;
    // idle: redraw about once a second only, which catches any change made without input
    const busy = !!f || (this.walk.on && (this.walk.keys.size > 0 || !!this.walk.axis.x || !!this.walk.axis.y)) || now - this.active < 1500;
    // rendered modes: plain frames while moving, then one finished frame (ambient occlusion, smooth edges) once at rest
    const rest = this.real && !this.walk.on && !busy;
    if (busy || now - this.drawn > (this.phone ? 4000 : 1000) || (rest && !this.finished)) {
      this.selBox?.update();
      // phones skip the ambient-occlusion pass (16 samples over the whole screen): the plain frame is the finished one
      if (rest && !this.phone && this.finish()) this.finished = true;
      else { this.renderer.render(this.scene, this.camera); this.finished = rest; }
      this.placeLabels();
      this.drawn = now;
    }
  }
}

/**
 * A wall closing the gap between two parts (columns, wall ends): across the facing faces, as thick as the thinner wall
 * end (columns: 20 cm), from the lower foot to the higher top. Null when they touch or are more than 12 m apart.
 */
export function wallBetween(a: BoxObject, b: BoxObject): Omit<BoxObject, 'id'> | null {
  const y = Math.min(a.y, b.y), h = Math.max(a.y + a.h, b.y + b.h) - y;
  const thin = [a, b].filter(o => Math.min(o.w, o.d) < 30).map(o => Math.min(o.w, o.d));
  const t = thin.length ? Math.min(...thin) : 20;
  const base = { layer: 'wall' as const, name: '牆（手動補牆）', color: 0xeeebe5, y, h };
  const square = (o: BoxObject) => !o.rot || Math.abs(Math.sin(2 * o.rot)) < 1e-3;
  if (square(a) && square(b)) {
    // sizes along the plan axes (a quarter turn swaps them)
    const ext = (o: BoxObject) => Math.abs(Math.sin(o.rot || 0)) > 0.5 ? { w: o.d, d: o.w } : { w: o.w, d: o.d };
    const ea = ext(a), eb = ext(b);
    const alongX = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
    const [l, r, el, er] = (alongX ? a.x <= b.x : a.z <= b.z) ? [a, b, ea, eb] : [b, a, eb, ea];
    const g0 = alongX ? l.x + el.w / 2 : l.z + el.d / 2, g1 = alongX ? r.x - er.w / 2 : r.z - er.d / 2;
    if (g1 - g0 < 5 || g1 - g0 > 1200) return null;
    // across: the middle of the two parts' common band, or of their centres when they do not line up
    const lo = Math.max(alongX ? l.z - el.d / 2 : l.x - el.w / 2, alongX ? r.z - er.d / 2 : r.x - er.w / 2);
    const hi = Math.min(alongX ? l.z + el.d / 2 : l.x + el.w / 2, alongX ? r.z + er.d / 2 : r.x + er.w / 2);
    const c = hi > lo ? (lo + hi) / 2 : alongX ? (l.z + r.z) / 2 : (l.x + r.x) / 2;
    const tt = hi > lo ? Math.min(t, hi - lo) : t;
    return alongX ? { ...base, x: (g0 + g1) / 2, z: c, w: g1 - g0, d: tt } : { ...base, x: c, z: (g0 + g1) / 2, w: tt, d: g1 - g0 };
  }
  // a part at an angle: along the line between the centres, less half of each part
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) - (Math.min(a.w, a.d) + Math.min(b.w, b.d)) / 2;
  if (L < 5 || L > 1200) return null;
  return { ...base, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, w: L, d: t, rot: Math.atan2(-dz, dx) };
}

/**
 * Direction towards the sun at latitude 25° N (Taiwan), solar time: x east, y up, z south (plan up is north,
 * turned by northDeg clockwise when the drawing's north is not up). alt / az in radians, az from north clockwise.
 */
export function sunDirection(day: number, hour: number, northDeg = 0) {
  const lat = 25 * Math.PI / 180, dec = 23.44 * Math.PI / 180 * Math.sin(2 * Math.PI * (284 + day) / 365), H = (hour - 12) * 15 * Math.PI / 180;
  const alt = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) + Math.PI;
  const a = az + northDeg * Math.PI / 180;
  return { alt, az, dir: new THREE.Vector3(Math.sin(a) * Math.cos(alt), Math.sin(alt), -Math.cos(a) * Math.cos(alt)) };
}

export function describe(o: ModelObject) {
  if (isDoor(o)) return `${o.name}｜門｜門寬 ${o.b - o.a} cm｜用「改門向」切換開向`;
  return `${o.name}｜${o.layer === 'wall' && (('wall' in o && o.wall === 'light') || /輕隔間/.test(o.name)) ? '輕隔間牆' : LAYER_COLORS[o.layer].name}｜${Math.round(o.w)} × ${Math.round(o.d)} × ${Math.round(o.h)} cm` + (o.y ? `｜離地 ${o.y} cm` : '');
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

/** one 二丁掛 module: a 22.7 × 6 cm tile and its joint, in cm */
const TILE_U = 47, TILE_V = 55.2;
export interface FacadeScheme { name: string; main: string; accent: string }
/** exterior tile schemes: main walls, and the darker (or lighter) accent of the ground storey and parapets */
export const FACADE_SCHEMES: FacadeScheme[] = [
  { name: '米白＋咖啡', main: '#d9ceb8', accent: '#7c5b45' },
  { name: '淺灰＋深灰', main: '#c7c3bb', accent: '#5f6165' },
  { name: '磚紅＋米白', main: '#a85c45', accent: '#ddd3c1' },
  { name: '奶茶＋深咖', main: '#c8a98a', accent: '#6b4c3b' },
  { name: '深灰＋米白', main: '#6d6d70', accent: '#dad2c4' },
];
const tileCache = new Map<string, THREE.Texture>();
const lookCache = new Map<string, { mat: THREE.MeshStandardMaterial; u: number; v: number }>();
/** what a finish looks like on a face: a texture and the size in cm one repeat of it covers */
export function finishLook(name: string, tileHex = '#d9ceb8', m?: Material) {
  const key = `${name}|${tileHex}|${m?.look || ''}|${m?.color || ''}`, hit = lookCache.get(key);
  if (hit) return hit;
  let out: { mat: THREE.MeshStandardMaterial; u: number; v: number };
  // a look set in the 建材項目 list wins over the one read from the name; its colour tints the pattern
  const look = m?.look;
  if (look) {
    const col = new THREE.Color(m!.color || '#d8d2c4');
    if (look === 'tile') out = { mat: new THREE.MeshStandardMaterial({ map: tileTexture(m!.color || tileHex), roughness: 0.72 }), u: TILE_U, v: TILE_V };
    else if (look === 'paint') out = { mat: new THREE.MeshStandardMaterial({ color: col, roughness: 0.9 }), u: 100, v: 100 };
    else {
      const kind = look === 'ceramic' ? 'tile' : look;
      const tint = col.clone().lerp(new THREE.Color('#ffffff'), 0.35);
      out = { mat: new THREE.MeshStandardMaterial({ map: patternTexture(kind), color: tint, roughness: look === 'stone' ? 0.95 : 0.45, metalness: look === 'rib' || look === 'panel' ? 0.35 : 0 }), u: look === 'stone' ? 50 : look === 'panel' ? 120 : look === 'ceramic' ? 60 : 100, v: look === 'panel' ? 60 : look === 'stone' ? 50 : look === 'ceramic' ? 60 : 100 };
    }
    lookCache.set(key, out);
    return out;
  }
  if (/二丁掛/.test(name)) out = { mat: new THREE.MeshStandardMaterial({ map: tileTexture(tileHex), roughness: 0.72 }), u: TILE_U, v: TILE_V };
  else if (/磁磚/.test(name)) out = { mat: new THREE.MeshStandardMaterial({ map: patternTexture('tile'), roughness: 0.4 }), u: 60, v: 60 };
  else if (/抿石子/.test(name)) out = { mat: new THREE.MeshStandardMaterial({ map: patternTexture('stone'), roughness: 0.95 }), u: 50, v: 50 };
  else if (/鋼板/.test(name)) out = { mat: new THREE.MeshStandardMaterial({ map: patternTexture('rib'), roughness: 0.45, metalness: 0.35 }), u: 100, v: 100 };
  else if (/金屬飾板/.test(name)) out = { mat: new THREE.MeshStandardMaterial({ map: patternTexture('panel'), roughness: 0.4, metalness: 0.4 }), u: 120, v: 60 };
  else out = { mat: new THREE.MeshStandardMaterial({ color: /外牆/.test(name) ? 0xe9e3d6 : 0xf3f1ec, roughness: 0.9 }), u: 100, v: 100 };
  lookCache.set(key, out);
  return out;
}
/** small repeating patterns drawn on a canvas: washed pebbles, ribbed sheet, panels with joints, wall tiles */
function patternTexture(kind: 'stone' | 'rib' | 'panel' | 'tile') {
  const hit = tileCache.get(kind);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  if (kind === 'stone') {
    g.fillStyle = '#b9b1a3'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) {
      const v = 120 + rnd() * 110, t = rnd();
      g.fillStyle = t < 0.15 ? `rgb(${v * 0.55},${v * 0.5},${v * 0.45})` : t < 0.3 ? `rgb(${v},${v * 0.92},${v * 0.82})` : `rgb(${v * 0.9},${v * 0.88},${v * 0.84})`;
      g.beginPath(); g.arc(rnd() * 256, rnd() * 256, 1 + rnd() * 2.6, 0, Math.PI * 2); g.fill();
    }
  } else if (kind === 'rib') {
    g.fillStyle = '#8796a3'; g.fillRect(0, 0, 256, 256);
    for (let x = 0; x < 256; x += 32) { g.fillStyle = '#a9b6c1'; g.fillRect(x, 0, 8, 256); g.fillStyle = '#6d7b87'; g.fillRect(x + 8, 0, 3, 256); }
  } else if (kind === 'panel') {
    g.fillStyle = '#9c9fa3'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#5d6064'; g.fillRect(0, 0, 256, 4); g.fillRect(0, 0, 3, 256);
  } else {
    g.fillStyle = '#c9c6bf'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#f2f0eb'; g.fillRect(2, 2, 252, 252);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  tileCache.set(kind, t);
  return t;
}
/** two tiles wide and eight rows high, each row shifted half a tile, every tile a shade off the next */
function tileTexture(hex: string) {
  const hit = tileCache.get(hex);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!, sx = 512 / TILE_U, sy = 512 / TILE_V;
  const base = new THREE.Color(hex), grout = base.clone().lerp(new THREE.Color('#e4e0d8'), 0.6).multiplyScalar(0.92);
  g.fillStyle = '#' + grout.getHexString();
  g.fillRect(0, 0, 512, 512);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let r = 0; r < 8; r++) for (let i = -1; i < 2; i++) {
    const x = (i * 23.5 + (r % 2) * 11.75) * sx, y = r * 6.9 * sy;
    const col = base.clone().multiplyScalar(0.9 + rnd() * 0.2);
    g.fillStyle = '#' + col.getHexString();
    g.fillRect(x + 0.4 * sx, y + 0.45 * sy, 22.7 * sx, 6 * sy);
    // a little grain on the face
    for (let k = 0; k < 40; k++) {
      g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '0,0,0'},${0.04 + rnd() * 0.05})`;
      g.fillRect(x + (0.4 + rnd() * 22) * sx, y + (0.45 + rnd() * 5.4) * sy, 2, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  tileCache.set(hex, t);
  return t;
}
