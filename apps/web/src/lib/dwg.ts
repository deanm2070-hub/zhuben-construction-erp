import { drawingFromDwg, type DwgDatabase, type DxfDrawing } from '@cloud-modeler/core';

/**
 * Reads a DWG file in the browser with LibreDWG compiled to WebAssembly.
 * The reader (about 10 MB) is only downloaded the first time a DWG is opened.
 */
export async function readDwg(buf: ArrayBuffer, version: string): Promise<DxfDrawing> {
  const { LibreDwg, Dwg_File_Type } = await import('@mlightcad/libredwg-web');
  const lib = await LibreDwg.create();
  const dwg = lib.dwg_read_data(buf, Dwg_File_Type.DWG);
  if (!dwg) throw new Error('無法讀取這個 DWG 檔');
  try {
    return drawingFromDwg(lib.convert(dwg) as unknown as DwgDatabase, version);
  } finally {
    lib.dwg_free(dwg);
  }
}
