import {
  indexPixelMapCells,
  isPixelMapEmptyColor,
  pixelMapAnimationIndex,
  pixelMapCellUV,
  pixelMapFrameName,
  type PixelMapCell,
  type PixelMapCells,
  type PixelMapUVOptions,
  type PixelMapUVRect,
} from './index';

/**
 * Browser-side pixelmap loading, engine-agnostic: fetches a sheet's
 * `<base>.cells.json` + `<base>.png`, keys the "empty" color out to
 * transparent pixels and returns raw RGBA ready to upload as a texture in
 * any renderer (Babylon, Three, PixiJS, raw WebGL, 2D canvas...).
 *
 * Engine adapters stay in the consuming app — e.g. a Babylon adapter wraps
 * `data` in a RawTexture and derives frame UVs from `cells` + `frames`.
 */
export interface PixelMapAnimationPlayback {
  fps: number;
  loop: boolean;
  /** The row's cells in frame order. */
  frames: PixelMapCell[];
  /** Frame index at a time (ms since the animation started). */
  frameAt: (timeMs: number) => number;
  /** UV rect of the frame playing at a time — feed it straight to the quad. */
  uvAt: (timeMs: number, options?: PixelMapUVOptions) => PixelMapUVRect;
}

export interface PixelMapImageData {
  cells: PixelMapCells;
  /** Frame lookup: `row/label` -> cell position in the image. */
  frames: ReturnType<typeof indexPixelMapCells>;
  /** RGBA pixels, keyed (empty color -> alpha 0), row 0 = image top. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /**
   * Texture coordinates of a frame, straight from the shipped positioning —
   * consumers never compute sheet layout themselves. Null for unknown frames.
   */
  frameUV: (row: string, label: string, options?: PixelMapUVOptions) => PixelMapUVRect | null;
  /** Playback for an animated row (anim set in the layout), else null. */
  animation: (row: string) => PixelMapAnimationPlayback | null;
  /**
   * Frees the CPU-side pixels and drops this sheet from the load cache —
   * call it right after uploading `data` to the GPU. Metadata (frames, UVs,
   * animations) stays usable; a later load re-decodes from the network/disk.
   */
  release: () => void;
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
  // Release the canvas backing store right away (we only keep the ImageData)
  canvas.width = 0;
  canvas.height = 0;
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (isPixelMapEmptyColor(data[i], data[i + 1], data[i + 2])) data[i + 3] = 0;
  }
  return image;
}

/**
 * In-flight/loaded sheets by baseUrl: loading the same sheet twice reuses
 * one decode and one pixel buffer (RAM), including concurrent calls.
 * `release()` evicts an entry so its memory can actually be reclaimed.
 */
const sheetCache = new Map<string, Promise<PixelMapImageData | null>>();

/**
 * Loads `<baseUrl>.png` + `<baseUrl>.cells.json` (e.g. `/assets/sheets/props`).
 * Throws when the PNG and its metadata disagree; returns null when either
 * file is missing so callers can treat the sheet as optional. Results are
 * cached by baseUrl — see `release()` for the memory contract.
 */
export function loadPixelMapImage(baseUrl: string): Promise<PixelMapImageData | null> {
  const cached = sheetCache.get(baseUrl);
  if (cached) return cached;
  const loading = loadSheet(baseUrl).catch((error: unknown) => {
    sheetCache.delete(baseUrl); // failed loads must not poison the cache
    throw error;
  });
  sheetCache.set(baseUrl, loading);
  return loading;
}

async function loadSheet(baseUrl: string): Promise<PixelMapImageData | null> {
  const metaResponse = await fetch(`${baseUrl}.cells.json`);
  if (!metaResponse.ok) {
    sheetCache.delete(baseUrl);
    return null;
  }
  const cells = (await metaResponse.json()) as PixelMapCells;
  const image = await decodeKeyedImage(`${baseUrl}.png`);
  if (image.width !== cells.width || image.height !== cells.height) {
    throw new Error(
      `${baseUrl}.png is ${image.width}x${image.height} but its cells.json says ` +
        `${cells.width}x${cells.height} — re-render the sheet`,
    );
  }
  const frames = indexPixelMapCells(cells);
  const sheet: PixelMapImageData = {
    cells,
    frames,
    data: image.data,
    width: image.width,
    height: image.height,
    frameUV: (row, label, options) => {
      const cell = frames.get(pixelMapFrameName(row, label));
      return cell ? pixelMapCellUV(cells, cell, options) : null;
    },
    animation: (row) => {
      const anim = cells.animations?.[row];
      if (!anim) return null;
      const rowFrames = cells.cells.filter((cell) => cell.row === row);
      return {
        fps: anim.fps,
        loop: anim.loop ?? true,
        frames: rowFrames,
        frameAt: (timeMs) => pixelMapAnimationIndex(rowFrames.length, anim, timeMs),
        uvAt: (timeMs, options) =>
          pixelMapCellUV(
            cells,
            rowFrames[pixelMapAnimationIndex(rowFrames.length, anim, timeMs)],
            options,
          ),
      };
    },
    release: () => {
      // Drop the (large) pixel buffer and let a future load re-decode
      sheet.data = new Uint8ClampedArray(0);
      sheetCache.delete(baseUrl);
    },
  };
  return sheet;
}
