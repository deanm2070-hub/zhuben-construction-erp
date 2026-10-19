/** A two-bedroom flat in millimetres, written as a real ASCII DXF (AutoCAD 2018 header). */
export function sampleDxf(): string {
  const E: string[] = [];
  const line = (l: string, x1: number, y1: number, x2: number, y2: number) => E.push(`0\nLINE\n8\n${l}\n10\n${x1}\n20\n${y1}\n30\n0\n11\n${x2}\n21\n${y2}\n31\n0`);
  const rect = (l: string, x1: number, y1: number, x2: number, y2: number, arr = E) => arr.push(`0\nLWPOLYLINE\n8\n${l}\n90\n4\n70\n1\n10\n${x1}\n20\n${y1}\n10\n${x2}\n20\n${y1}\n10\n${x2}\n20\n${y2}\n10\n${x1}\n20\n${y2}`);
  const arc = (l: string, cx: number, cy: number, r: number, a0: number, a1: number) => E.push(`0\nARC\n8\n${l}\n10\n${cx}\n20\n${cy}\n30\n0\n40\n${r}\n50\n${a0}\n51\n${a1}`);
  const text = (l: string, x: number, y: number, s: string) => E.push(`0\nTEXT\n8\n${l}\n10\n${x}\n20\n${y}\n30\n0\n40\n250\n1\n${s}`);
  const ins = (l: string, b: string, x: number, y: number, rot = 0) => E.push(`0\nINSERT\n8\n${l}\n2\n${b}\n10\n${x}\n20\n${y}\n30\n0\n50\n${rot}`);
  const wall = (x1: number, y1: number, x2: number, y2: number, t: number) => {
    const L = Math.hypot(x2 - x1, y2 - y1), nx = -(y2 - y1) / L * t / 2, ny = (x2 - x1) / L * t / 2;
    line('A-WALL', x1 + nx, y1 + ny, x2 + nx, y2 + ny);
    line('A-WALL', x1 - nx, y1 - ny, x2 - nx, y2 - ny);
  };
  wall(0, 0, 6000, 0, 200); wall(7000, 0, 9000, 0, 200); wall(9000, 0, 9000, 7200, 200); wall(9000, 7200, 0, 7200, 200); wall(0, 7200, 0, 0, 200);
  wall(3600, 7200, 3600, 4900, 120); wall(0, 4000, 3600, 4000, 120); wall(5400, 7200, 5400, 4900, 120); wall(5400, 4000, 9000, 4000, 120);
  wall(3600, 5600, 4200, 5600, 120); wall(5000, 5600, 5400, 5600, 120); wall(7600, 4000, 7600, 2600, 120); wall(7600, 2600, 8000, 2600, 120); wall(8800, 2600, 9000, 2600, 120);
  line('A-WIND', 1000, 7200, 2600, 7200); line('A-WIND', 6400, 7200, 8000, 7200); line('A-WIND', 800, 0, 4600, 0); line('A-WIND', 0, 1200, 0, 3200);
  line('A-DOOR', 3600, 4900, 2700, 4900); arc('A-DOOR', 3600, 4900, 900, 180, 270);
  line('A-DOOR', 5400, 4900, 6300, 4900); arc('A-DOOR', 5400, 4900, 900, 270, 360);
  line('A-DOOR', 4200, 5600, 4200, 6400); arc('A-DOOR', 4200, 5600, 800, 0, 90);
  line('A-DOOR', 8000, 2600, 8000, 3400); arc('A-DOOR', 8000, 2600, 800, 0, 90);
  line('A-DOOR', 7000, 0, 7000, 1000); arc('A-DOOR', 7000, 0, 1000, 90, 180);
  rect('A-FURN', 500, 5000, 2100, 7000); rect('A-FURN', 7300, 4700, 8700, 6800); rect('A-FURN', 300, 600, 1200, 2900); rect('A-FURN', 1600, 1300, 2400, 2200); rect('A-FURN', 3900, 1600, 5700, 2500);
  rect('A-CASE', 2400, 6450, 3500, 7050); rect('A-CASE', 6200, 3300, 7500, 3900); rect('A-CASE', 8300, 4150, 8900, 4900);
  rect('P-PLMB', 4900, 6600, 5300, 7050); rect('P-PLMB', 3700, 6700, 4300, 7050);
  for (const [x, y, r] of [[4000, 1050, 0], [4650, 1050, 0], [5300, 1050, 0], [4450, 3050, 180], [5100, 3050, 180], [5750, 3050, 180]]) ins('A-FURN', 'CHAIR', x, y, r);
  text('A-TEXT', 1300, 5900, '主臥室'); text('A-TEXT', 6600, 5900, '次臥室'); text('A-TEXT', 4200, 6200, '浴室'); text('A-TEXT', 2600, 3200, '客餐廳 LDK');
  text('A-TEXT', 6150, 600, '玄關'); text('A-TEXT', 7850, 3200, '儲藏室'); text('A-TEXT', 4150, 4700, '走道');
  line('A-DIM', 0, -800, 9000, -800); text('A-DIM', 4300, -700, '9000');
  const blk: string[] = [];
  rect('0', 0, 0, 450, 450, blk);
  return `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\nCHAIR\n70\n0\n10\n0\n20\n0\n30\n0\n${blk.join('\n')}\n0\nENDBLK\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${E.join('\n')}\n0\nENDSEC\n0\nEOF\n`;
}
