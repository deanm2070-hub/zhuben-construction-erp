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
  /** set from line colours: same colour as the exterior wall → concrete (rc), another colour → light partition */
  wall?: 'rc' | 'light';
  /** stair steps and stair handrail pieces: riser height, cm */
  rise?: number;
  /** on the first step of each stair: the whole stair for the takeoff (risers as labelled 上16) */
  stair?: StairInfo;
  /** structural members read from the structural plans: mark and the storey key of the plan (2F beams carry the 2F slab) */
  rc?: RcTag;
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
}

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
}

export interface ProjectModel {
  objects: ModelObject[];
  cad: CadData | null;
  finishes: Record<string, Partial<FinishChoice>>;
  settings: TakeoffSettings;
}

export const isDoor = (o: ModelObject): o is DoorObject => o.layer === 'door';
export const isBox = (o: ModelObject): o is BoxObject => o.layer !== 'door';
