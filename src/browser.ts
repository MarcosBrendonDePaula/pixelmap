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

/** One layer of a composed sprite: a cell, optionally tinted. */
export interface PixelMapLayerSpec {
  row: string;
  label: string;
  /**
   * Multiplies the layer's pixels by this color ('#rrggbb' or [r,g,b]);
   * omit to stamp the cell as-is. Layers meant for tinting are usually
   * painted as neutral gray ramps — see `base`.
   */
  tint?: string | readonly [number, number, number];
  /**
   * Neutral ramp base the tint divides by: out = src * tint / base. A ramp
   * painted around gray `base` reproduces shading factors exactly (values
   * above `base` overbrighten, clamped at 255). Defaults to 255.
   */
  base?: number;
}

export interface PixelMapComposeOptions {
  /** Destination offset (canvas pixels). */
  x?: number;
  y?: number;
  /** Integer scale, nearest-neighbor (pixel art). Defaults to 1. */
  scale?: number;
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
   * Layer composition: stamps each layer's cell in order onto `ctx`
   * (transparent pixels skipped), tinting per layer — the generic engine
   * behind layered sprites like the game character. Unknown frames are
   * skipped. Requires the CPU pixels (do not `release()` sheets you compose
   * from).
   */
  composeLayers: (
    ctx: CanvasRenderingContext2D,
    layers: readonly PixelMapLayerSpec[],
    options?: PixelMapComposeOptions,
  ) => void;
  /**
   * Frees the CPU-side pixels and drops this sheet from the load cache —
   * call it right after uploading `data` to the GPU. Metadata (frames, UVs,
   * animations) stays usable; a later load re-decodes from the network/disk.
   */
  release: () => void;
}

/** '#rrggbb' or [r,g,b] -> [r,g,b]. */
function tintRgb(tint: string | readonly [number, number, number]): [number, number, number] {
  if (typeof tint !== 'string') return [tint[0], tint[1], tint[2]];
  const n = parseInt(tint.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Pure layer-tint math (exported for tests and non-canvas consumers): lifts
 * one tileSize² cell out of the sheet pixels, multiplying each channel by
 * tint/base (clamped). Alpha is binarized (>0 -> 255).
 */
export function tintCellPixels(
  sheet: { data: Uint8ClampedArray; width: number },
  cell: { x: number; y: number },
  tileSize: number,
  tint?: string | readonly [number, number, number],
  base = 255,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(tileSize * tileSize * 4);
  const rgb = tint === undefined ? null : tintRgb(tint);
  for (let y = 0; y < tileSize; y++) {
    const src = ((cell.y + y) * sheet.width + cell.x) * 4;
    for (let x = 0; x < tileSize; x++) {
      const s = src + x * 4;
      if (sheet.data[s + 3] === 0) continue;
      const d = (y * tileSize + x) * 4;
      if (rgb) {
        out[d] = Math.min(255, Math.round((sheet.data[s] * rgb[0]) / base));
        out[d + 1] = Math.min(255, Math.round((sheet.data[s + 1] * rgb[1]) / base));
        out[d + 2] = Math.min(255, Math.round((sheet.data[s + 2] * rgb[2]) / base));
      } else {
        out[d] = sheet.data[s];
        out[d + 1] = sheet.data[s + 1];
        out[d + 2] = sheet.data[s + 2];
      }
      out[d + 3] = 255;
    }
  }
  return out;
}

// Lazy scratch canvas shared by composeLayers (created on first use so the
// module stays importable in non-DOM environments, e.g. node tests)
let scratch: { ctx: CanvasRenderingContext2D; size: number } | null = null;
function composeScratch(size: number): CanvasRenderingContext2D | null {
  if (!scratch || scratch.size !== size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    scratch = { ctx, size };
  }
  return scratch.ctx;
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
    composeLayers: (ctx, layers, options) => {
      const tile = cells.tileSize;
      const scale = options?.scale ?? 1;
      const dx = options?.x ?? 0;
      const dy = options?.y ?? 0;
      const scratchCtx = composeScratch(tile);
      if (!scratchCtx) return;
      ctx.imageSmoothingEnabled = false;
      for (const layer of layers) {
        const cell = frames.get(pixelMapFrameName(layer.row, layer.label));
        if (!cell) continue; // unknown frame: skip, compose the rest
        const pixels = tintCellPixels(sheet, cell, tile, layer.tint, layer.base);
        const image = scratchCtx.createImageData(tile, tile);
        image.data.set(pixels);
        scratchCtx.putImageData(image, 0, 0);
        ctx.drawImage(scratchCtx.canvas, 0, 0, tile, tile, dx, dy, tile * scale, tile * scale);
      }
    },
    release: () => {
      // Drop the (large) pixel buffer and let a future load re-decode
      sheet.data = new Uint8ClampedArray(0);
      sheetCache.delete(baseUrl);
    },
  };
  return sheet;
}
