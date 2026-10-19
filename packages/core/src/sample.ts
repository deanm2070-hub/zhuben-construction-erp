import type { ModelObject, RoomRect } from './types';

export const SAMPLE_W = 1180;
export const SAMPLE_D = 900;
export const WALL_H = 280;

export const SAMPLE_ROOMS: RoomRect[] = [
  { n: '次臥室', x0: 0, x1: 380, z0: 0, z1: 330, f: 0xdcc199 },
  { n: '雙衛浴區', x0: 380, x1: 684, z0: 0, z1: 240, f: 0xdfe5ea, s: '155 + 149 cm' },
  { n: '主臥＋更衣室', x0: 684, x1: 1180, z0: 0, z1: 311, f: 0xd8bb90 },
  { n: '走道', x0: 380, x1: 684, z0: 240, z1: 480, f: 0xe2c9a2 },
  { n: '廚房 Kitchen', x0: 0, x1: 380, z0: 330, z1: 480, f: 0xe6e2da, s: '一字型廚具＋冰箱' },
  { n: '客臥室', x0: 684, x1: 1180, z0: 311, z1: 579, f: 0xdcc199 },
  { n: '客廳 Living', x0: 0, x1: 430, z0: 480, z1: 900, f: 0xe2c9a2 },
  { n: '餐廳 Dining', x0: 430, x1: 684, z0: 480, z1: 900, f: 0xe2c9a2, s: '餐桌 224×80 cm' },
  { n: '多功能室', x0: 684, x1: 942, z0: 579, z1: 752, f: 0xdcc199 },
  { n: '收納區', x0: 942, x1: 1180, z0: 579, z1: 752, f: 0xe6e2da },
  { n: '玄關', x0: 684, x1: 1180, z0: 752, z1: 900, f: 0xd9d4cb, s: '主入口動線' },
];

/** The demo apartment: walls, doors, windows, cabinets and furniture. */
export function sampleObjects(): ModelObject[] {
  let id = 1;
  const o: ModelObject[] = [];
  const wallBox = (x1: number, x2: number, z1: number, z2: number, extra: Partial<ModelObject> = {}) =>
    o.push({ id: id++, layer: 'wall', name: '牆', x: (x1 + x2) / 2, z: (z1 + z2) / 2, w: x2 - x1, d: z2 - z1, h: WALL_H, y: 0, color: 0xeeebe5, ...extra } as ModelObject);
  const H = (x1: number, x2: number, z: number, t = 12, extra = {}) => wallBox(x1, x2, z - t / 2, z + t / 2, extra);
  const V = (z1: number, z2: number, x: number, t = 12, extra = {}) => wallBox(x - t / 2, x + t / 2, z1, z2, extra);
  const B = (layer: 'cabinet' | 'furniture' | 'bath' | 'glass', name: string, x0: number, x1: number, z0: number, z1: number, h: number, color: number, y = 0) =>
    o.push({ id: id++, layer, name, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, h, y, color });
  const DOOR = (name: string, axis: 'x' | 'z', at: number, a: number, b: number, flip = 0) =>
    o.push({ id: id++, layer: 'door', name, axis, at, a, b, flip, color: 0x9a6a43 });
  const WIN = (x1: number, x2: number, z: number) => {
    H(x1, x2, z, 20, { h: 90, name: '窗台' });
    H(x1, x2, z, 20, { y: 230, h: 50, name: '窗楣' });
    B('glass', '窗玻璃', x1, x2, z - 2, z + 2, 140, 0xa9dcff, 90);
  };
  H(0, 800, 0, 20, { name: '外牆' }); WIN(800, 1060, 0); H(1060, 1180, 0, 20, { name: '外牆' });
  H(0, 120, 900, 20, { name: '外牆' }); WIN(120, 480, 900); H(480, 1180, 900, 20, { name: '外牆' });
  V(0, 900, 0, 20, { name: '外牆' });
  V(0, 790, 1180, 20, { name: '外牆' }); V(880, 900, 1180, 20, { name: '外牆' });
  V(0, 250, 380); H(0, 380, 330);
  H(380, 400, 240); H(480, 580, 240); H(660, 684, 240); V(0, 240, 535);
  V(0, 245, 684); V(305, 330, 684); V(420, 752, 684);
  H(684, 1180, 311); H(684, 1180, 579); V(579, 752, 942);
  H(684, 780, 752); H(860, 1000, 752); H(1080, 1180, 752);
  DOOR('次臥門', 'z', 380, 250, 330, 1); DOOR('浴室門 A', 'x', 240, 400, 480, 0); DOOR('浴室門 B', 'x', 240, 580, 660, 0);
  DOOR('主臥門', 'z', 684, 245, 305, 3); DOOR('客臥門', 'z', 684, 330, 420, 2);
  DOOR('多功能室門', 'x', 752, 780, 860, 2); DOOR('收納區門', 'x', 752, 1000, 1080, 2); DOOR('玄關大門', 'z', 1180, 790, 880, 2);
  B('furniture', '雙人床', 30, 190, 40, 250, 45, 0xf4f2ee); B('cabinet', '衣櫃', 220, 374, 6, 66, 240, 0xc98a4b);
  B('glass', '淋浴拉門 A', 386, 500, 108, 110, 200, 0xa9dcff); B('bath', '馬桶 A', 485, 529, 150, 200, 40, 0xffffff); B('bath', '淋浴區 A', 386, 500, 6, 108, 4, 0xf3f6f8);
  B('glass', '淋浴拉門 B', 541, 660, 108, 110, 200, 0xa9dcff); B('bath', '馬桶 B', 541, 585, 150, 200, 40, 0xffffff); B('bath', '洗手台 B', 630, 678, 130, 234, 85, 0xfafafa);
  B('furniture', '雙人床（主臥）', 850, 1030, 95, 305, 45, 0xf4f2ee); B('cabinet', '更衣室高櫃', 1110, 1170, 10, 300, 240, 0xc98a4b);
  B('furniture', '單人加大床', 900, 1050, 330, 530, 45, 0xf4f2ee); B('cabinet', '書桌櫃', 1100, 1170, 400, 520, 75, 0xc98a4b);
  B('furniture', '書桌', 700, 860, 590, 650, 75, 0x6b4f3a); B('cabinet', '書櫃', 880, 936, 585, 746, 200, 0xc98a4b);
  B('cabinet', '收納高櫃', 948, 1174, 585, 645, 240, 0xc98a4b); B('cabinet', '鞋櫃', 960, 1174, 864, 894, 110, 0xc98a4b);
  B('cabinet', '一字型廚具', 6, 300, 336, 396, 90, 0xd9d4cb); B('cabinet', '冰箱', 300, 374, 336, 401, 180, 0xcfd6de);
  B('furniture', '三人沙發', 20, 110, 560, 800, 80, 0x6f7d93); B('furniture', '茶几', 160, 240, 630, 730, 40, 0x6b4f3a);
  B('cabinet', '電視櫃', 370, 424, 560, 800, 50, 0xc98a4b);
  B('furniture', '餐桌', 520, 600, 560, 784, 75, 0x6b4f3a);
  for (const z of [585, 652, 719]) { B('furniture', '餐椅', 478, 518, z, z + 42, 45, 0x41557a); B('furniture', '餐椅', 602, 642, z, z + 42, 45, 0x41557a); }
  return o;
}
