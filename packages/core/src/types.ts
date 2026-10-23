/** All lengths are centimetres. Plan x grows east, z grows south (north is the top of the plan). */
export type LayerKey = 'wall' | 'slab' | 'stair' | 'rail' | 'cabinet' | 'furniture' | 'bath' | 'door' | 'glass' | 'custom';

export interface BoxObject {
  id: number;
  layer: Exclude<LayerKey, 'door'>;
  name: string;
  /** centre of the footprint */
  x: number;
  z: number;
  /** size along local x, local z and height */
  w: number;
  d: number;
  h: number;
  /** height of the underside above the floor */
  y: number;
  /** rotation around the vertical axis, radians */
  rot?: number;
  color: number;
  /** storey key (1F, 2F … RF) for whole-building imports; y is then measured from 1F */
  floor?: string;
  /** AutoCAD colour index of the lines a wall was drawn with */
  wc?: number;
  /** drawing layer the part was built from (what a correction teaches the importer about that layer) */
  src?: string;
  /** set from line colours: same colour as the exterior wall → concrete (rc), another colour → light partition */
  wall?: 'rc' | 'light';
  /** stair steps: the underside slopes (waist slab) from `lo` at the low end to `hi` at the high end along `axis`, absolute heights, cm */
  soffit?: { axis: 'x' | 'z'; lo: number; hi: number };
  /** stair steps and stair handrail pieces: riser height, cm */
  rise?: number;
  /** on the first step of each stair: the whole stair for the takeoff (risers as labelled 上16) */
  stair?: StairInfo;
  /** structural members read from the structural plans: mark and the storey key of the plan (2F beams carry the 2F slab) */
  rc?: RcTag;
  /** member kind chosen by hand in the 構件屬性 panel (柱, 梁, 樓板, 牆 …); wins over what the name and layer suggest */
  member?: string;
  /** finish picked by hand for single faces (BoxGeometry face order: 0 +x, 1 −x, 2 top, 3 bottom, 4 +z, 5 −z), a FACE_FINISHES name */
  faces?: Record<number, string>;
}

export interface RcTag { kind: 'beam' | 'column'; mark: string; fl: string; b?: number; h?: number }

export interface StairInfo { risers: number; flights: number; width: number; run: number; rise: number; landing: number }

export interface DoorObject {
  id: number;
  layer: 'door';
  name: string;
  /** the wall the opening sits in runs along this axis */
  axis: 'x' | 'z';
  /** coordinate of the wall line on the other axis */
  at: number;
  /** opening from a to b along the axis */
  a: number;
  b: number;
  /** 0–3: hinge side × swing side */
  flip: number;
  color: number;
  floor?: string;
  /** sill level of the opening (absolute, default 0) and leaf height (default 210) */
  y?: number;
  h?: number;
}

export type ModelObject = BoxObject | DoorObject;

export interface RoomRect {
  n: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** floor colour */
  f: number;
  /** subtitle shown on the room tag */
  s?: string;
}

export interface CadDoor { x: number; z: number; w: number }
export interface CadText { x: number; z: number; s: string }

/** What remains of an imported drawing besides the 3D objects. */
export interface CadData {
  name: string;
  W: number;
  D: number;
  /** flat list of 2D line segments x1,z1,x2,z2,… drawn on the floor */
  segs: number[];
  texts: CadText[];
  doors: CadDoor[];
  /** whole-building imports: one entry per storey, bottom to top */
  floors?: CadFloor[];
  /** reinforcement read from the structural detail sheets, and the slab panels of the structural plans */
  rc?: RcData;
  /** drawing layer names (whole-building imports) */
  layers?: string[];
  /** the drawing style (office) the import was made with: corrections made on this project teach it */
  style?: { id: string; name: string };
  /** imported 3D models (SketchUp): the geometry not turned into walls, slabs … kept as plain mesh */
  meshes?: CadMesh[];
}

/** Plain mesh in plan cm (x east, y up from 1F, z south): base64 Int16 positions on a 1 cm grid and Uint16 (wide: Uint32) triangle indices. */
export interface CadMesh { floor?: string; color: number; opacity?: number; pos: string; idx: string; wide?: boolean }

/** n bars of size #s */
export interface Bar { n: number; s: number }
/** bars of size #s every `at` cm */
export interface Spacing { s: number; at: number }
/** a bar callout of a beam detail: r is its place along the span, 0 the left support and 1 the right */
export interface BeamCallout { n: number; s: number; r: number; cut?: number }
export interface BeamDetail {
  mark: string;
  /** storey keys of the structural plans the detail is for */
  floors: string[];
  b: number;
  h: number;
  top: BeamCallout[];
  bot: BeamCallout[];
  /** stirrup zones: n stirrups of #s every `at` cm (n missing on typical sections), sets 2 for 2*#4 */
  stir: { s: number; n?: number; at: number; sets: number }[];
  /** web bars, n on each face */
  web?: Bar;
}
export interface ColumnDetail { fl: string; mark: string; b: number; h: number; bars: Bar[]; hoop: { s: number; at: [number, number, number]; ties: [number, number] } }
/** a slab of the slab schedule; spacings are [top, bottom] */
export interface SlabDetail { mark: string; floors: string[]; t: number; type: string; short: [Spacing, Spacing]; long: [Spacing, Spacing] }
/** stair schedule: a distribution bars, b bottom main bars, c top main bars */
export interface StairDetail { floors: string[]; t: number; a: Spacing; b: Spacing; c: Spacing }
export interface RebarSpec { beams: BeamDetail[]; columns: ColumnDetail[]; slabs: SlabDetail[]; stairs: StairDetail[]; parapet?: { h: Spacing; v: Spacing }; sheets: string[] }
export interface SlabPanel { fl: string; mark: string; x0: number; x1: number; z0: number; z1: number }
export interface RcData { spec: RebarSpec; panels: SlabPanel[] }

export interface CadFloor {
  key: string;
  /** plan title the storey came from */
  title: string;
  /** floor level above 1F and storey height, cm */
  y: number;
  h: number;
  segs: number[];
  /** drawing layer of each plan line (index into CadData.layers) */
  segLayer?: number[];
  texts: CadText[];
}

export interface Bounds { W: number; D: number }

export interface FinishChoice { f: string; c: string; w: string }

export interface TakeoffSettings {
  /** index into EXT_FINISHES */
  ext: number;
  floor: string;
  /** slab thickness, cm */
  slab: number;
  /** rebar ratio, kg per m³ of concrete */
  rebar: number;
  /** excavation depth for the foundation estimate, cm (default 150) */
  dig?: number;
  /** interior plaster and paint (W1A/W1B) take in the beam soffits and sides (default on) */
  beamDry?: boolean;
  /** wet-room plaster (W2A) takes in the beam soffits and sides (default on) */
  beamWet?: boolean;
  /** wall tiles reach the beam soffit, the slab soffit, or a set height tileH (default beam) */
  tileTo?: 'beam' | 'slab' | 'h';
  tileH?: number;
  /** wet-room wall waterproofing height, cm (default 200) */
  wetH?: number;
  /** exterior waterproofing: frame lengths of the openings + floor joints (M, default), or the wall area (㎡) */
  extWater?: 'joint' | 'area';
}

export interface ProjectModel {
  objects: ModelObject[];
  cad: CadData | null;
  finishes: Record<string, Partial<FinishChoice>>;
  settings: TakeoffSettings;
  /** unit prices, hand-typed lines, fees and the quotation header (預算報價) */
  pricing?: import('./pricing').Pricing;
  /** saved states of the quantities and prices (計算版本) */
  versions?: import('./pricing').CalcVersion[];
  /** project information: category, status, client … (also kept on the project row for the project list) */
  info?: ProjectInfo;
  /** lines drawn by hand with the 畫線 tool: start and end points (x, y, z cm, y up from 1F) */
  sketch?: SketchLine[];
  /** hand corrections of the imported model, by part id (what the importer learns from) */
  fixes?: Record<string, import('./learn').Fix>;
  /** copy of the drawing style the import used, so the roles learnt travel with the project to other devices */
  style?: DrawingStyle;
}
/** The way one office draws (layer names, what each layer holds), learnt from imports and corrections. */
export interface DrawingStyle {
  id: string;
  /** the office's name read from the title block, else the main layer names */
  name: string;
  /** the layers of its plans: how a new drawing set is matched to the style */
  layers: string[];
  /** roles set by hand on the import page */
  manual: Record<string, import('./building').LayerRole>;
  /** roles learnt from the corrections of each project, with the reasons */
  learnt: Record<string, { roles: Record<string, import('./building').LayerRole>; why: Record<string, string>; project?: string }>;
  updated: number;
}

export interface SketchLine { a: [number, number, number]; b: [number, number, number] }

export const PROJECT_STATUS = ['估算中', '已報價', '已得標', '施工中', '已結案'] as const;
export interface ProjectInfo { category?: string; status?: string; client?: string; site?: string; note?: string; /** locked: cannot be deleted until unlocked */ locked?: boolean }

export const isDoor = (o: ModelObject): o is DoorObject => o.layer === 'door';
export const isBox = (o: ModelObject): o is BoxObject => o.layer !== 'door';
