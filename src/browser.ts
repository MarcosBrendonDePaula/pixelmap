import { indexPixelMapCells, isPixelMapEmptyColor, type PixelMapCells } from './index';

/**
 * Browser-side pixelmap loading, engine-agnostic: fetches a sheet's
 * `<base>.cells.json` + `<base>.png`, keys the "empty" color out to
 * transparent pixels and returns raw RGBA ready to upload as a texture in
 * any renderer (Babylon, Three, PixiJS, raw WebGL, 2D canvas...).
 *
 * Engine adapters stay in the consuming app — e.g. a Babylon adapter wraps
 * `data` in a RawTexture and derives frame UVs from `cells` + `frames`.
 */
export interface PixelMapImageData {
  cells: PixelMapCells;
  /** Frame lookup: `row/label` -> cell position in the image. */
  frames: ReturnType<typeof indexPixelMapCells>;
  /** RGBA pixels, keyed (empty color -> alpha 0), row 0 = image top. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Decodes the PNG and keys the "empty" color out to transparent pixels. */
export async function decodeKeyedImage(url: string): Promise<ImageData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load ${url}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (isPixelMapEmptyColor(data[i], data[i + 1], data[i + 2])) data[i + 3] = 0;
  }
  return image;
}

/**
 * Loads `<baseUrl>.png` + `<baseUrl>.cells.json` (e.g. `/assets/sheets/props`).
 * Throws when the PNG and its metadata disagree; returns null when either
 * file is missing so callers can treat the sheet as optional.
 */
export async function loadPixelMapImage(baseUrl: string): Promise<PixelMapImageData | null> {
  const metaResponse = await fetch(`${baseUrl}.cells.json`);
  if (!metaResponse.ok) return null;
  const cells = (await metaResponse.json()) as PixelMapCells;
  const image = await decodeKeyedImage(`${baseUrl}.png`);
  if (image.width !== cells.width || image.height !== cells.height) {
    throw new Error(
      `${baseUrl}.png is ${image.width}x${image.height} but its cells.json says ` +
        `${cells.width}x${cells.height} — re-render the sheet`,
    );
  }
  return {
    cells,
    frames: indexPixelMapCells(cells),
    data: image.data,
    width: image.width,
    height: image.height,
  };
}
