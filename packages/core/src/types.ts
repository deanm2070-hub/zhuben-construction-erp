/** All lengths are centimetres. Plan x grows east, z grows south (north is the top of the plan). */
export type LayerKey = 'wall' | 'cabinet' | 'furniture' | 'bath' | 'door' | 'glass' | 'custom';

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
}

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
}

export interface ProjectModel {
  objects: ModelObject[];
  cad: CadData | null;
  finishes: Record<string, Partial<FinishChoice>>;
  settings: TakeoffSettings;
}

export const isDoor = (o: ModelObject): o is DoorObject => o.layer === 'door';
export const isBox = (o: ModelObject): o is BoxObject => o.layer !== 'door';
