import sharp, { type OverlayOptions } from 'sharp';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PIXELMAP_EMPTY_COLOR,
  PIXELMAP_STYLE,
  indexPixelMapCells,
  isPixelMapEmptyColor,
  pixelMapCells,
  pixelMapFrameName,
  pixelMapGeometry,
  pixelMapLayoutError,
  pixelMapMode,
  pixelMapRowCells,
  type PixelMapCells,
  type PixelMapLayout,
} from './index';

/**
 * Pixelmap sheet engine shared by the CLI (cli.ts) and the web editor
 * (editor/server.ts): renders the labeled skeleton PNGs and
 * applies structural edits while PRESERVING pixels already painted by hand.
 *
 * Preservation works through the `<sheet>.cells.json` sidecar written next to
 * each PNG (see src/index.ts): on re-render the old sidecar is
 * used to lift the painted tiles out of the old PNG and drop them at their
 * new positions; cells that no longer exist are discarded, new cells start as
 * magenta (= empty). The same sidecar is what the game loader reads.
 */

export class SheetError extends Error {}

const raise = (message: string): never => {
  throw new SheetError(message);
};

// ---------------------------------------------------------------------------
// Layout IO
// ---------------------------------------------------------------------------

function validate(layout: PixelMapLayout): void {
  const error = pixelMapLayoutError(layout);
  if (error) raise(error);
}

export function loadLayout(path: string): PixelMapLayout {
  if (!existsSync(path)) raise(`layout not found: ${path}`);
  const layout = JSON.parse(readFileSync(path, 'utf8')) as PixelMapLayout;
  validate(layout);
  return layout;
}

function saveLayout(path: string, layout: PixelMapLayout): void {
  validate(layout);
  writeFileSync(path, JSON.stringify(layout, null, 2) + '\n');
}

function findRow(layout: PixelMapLayout, name: string): PixelMapLayout['rows'][number] {
  const row = layout.rows.find((r) => r.name === name);
  return (
    row ?? raise(`row not found: ${name} (rows: ${layout.rows.map((r) => r.name).join(', ')})`)
  );
}

export const sheetPngPath = (layoutPath: string, sheet: string): string =>
  join(dirname(layoutPath), `${sheet}.png`);

export const sidecarPath = (pngPath: string): string => pngPath.replace(/\.png$/, '.cells.json');

// ---------------------------------------------------------------------------
// Rendering with pixel preservation
// ---------------------------------------------------------------------------

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
}

async function loadRaw(path: string): Promise<RawImage> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

function sliceTile(image: RawImage, x0: number, y0: number, tile: number): Uint8Array {
  const out = new Uint8Array(tile * tile * 4);
  for (let y = 0; y < tile; y++) {
    const src = ((y0 + y) * image.width + x0) * 4;
    out.set(image.data.subarray(src, src + tile * 4), y * tile * 4);
  }
  return out;
}

/** Lift every painted cell out of an existing sheet, keyed by `row/label`. */
async function extractCells(pngPath: string, tile: number): Promise<Map<string, Uint8Array>> {
  const cells = new Map<string, Uint8Array>();
  if (!existsSync(pngPath)) return cells;
  const metaPath = sidecarPath(pngPath);
  if (!existsSync(metaPath)) {
    raise(
      `${pngPath} exists but ${metaPath} is missing — cannot preserve painted tiles.\n` +
        `Move the PNG away (or restore its .cells.json) and run render again.`,
    );
  }
  const sidecar = JSON.parse(readFileSync(metaPath, 'utf8')) as PixelMapCells;
  if (sidecar.tileSize !== tile) {
    raise(`${metaPath}: tileSize ${sidecar.tileSize} does not match layout tileSize ${tile}`);
  }
  const image = await loadRaw(pngPath);
  if (image.width !== sidecar.width || image.height !== sidecar.height) {
    raise(
      `${pngPath}: expected ${sidecar.width}x${sidecar.height} per its sidecar, ` +
        `got ${image.width}x${image.height} — the sheet must not be resized by hand`,
    );
  }
  for (const cell of sidecar.cells) {
    cells.set(pixelMapFrameName(cell.row, cell.label), sliceTile(image, cell.x, cell.y, tile));
  }
  return cells;
}

async function renderSheet(
  layout: PixelMapLayout,
  layoutPath: string,
  sheet: string,
  exclude?: Set<string>,
): Promise<void> {
  const geo = pixelMapGeometry(layout);
  const pngPath = sheetPngPath(layoutPath, sheet);
  const preserved = await extractCells(pngPath, geo.tileSize);
  const { labelHeight, padY, marginTop, background } = PIXELMAP_STYLE;
  const magenta = `#${PIXELMAP_EMPTY_COLOR.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

  const svgParts: string[] = [
    `<rect width="${geo.width}" height="${geo.height}" fill="${background}"/>`,
    `<text x="10" y="22" font-family="Arial" font-size="15" fill="#e8e8e8">${escapeXml(
      `${layout.title} — ${sheet} (magenta = transparente; celulas ${geo.tileSize}x${geo.tileSize})`,
    )}</text>`,
  ];
  const overlays: OverlayOptions[] = [];

  layout.rows.forEach((row, r) => {
    const titleY =
      marginTop + r * (labelHeight + geo.tileSize + padY) + labelHeight + geo.tileSize / 2 + 4;
    svgParts.push(
      `<text x="10" y="${titleY}" font-family="Arial" font-size="13" fill="#9ad">${escapeXml(row.name)}</text>`,
    );
    pixelMapRowCells(layout, row).forEach((label, c) => {
      const { x, y } = geo.cellPos(r, c);
      svgParts.push(
        `<rect x="${x}" y="${y}" width="${geo.tileSize}" height="${geo.tileSize}" fill="${magenta}"/>`,
        `<rect x="${x - 1.5}" y="${y - 1.5}" width="${geo.tileSize + 3}" height="${geo.tileSize + 3}" fill="none" stroke="#555" stroke-width="1"/>`,
        `<text x="${x}" y="${y - 4}" font-family="Arial" font-size="11" fill="#cccccc">${escapeXml(label)}</text>`,
      );
      const key = pixelMapFrameName(row.name, label);
      const tile = exclude?.has(key) ? undefined : preserved.get(key);
      if (tile) {
        overlays.push({
          input: Buffer.from(tile),
          raw: { width: geo.tileSize, height: geo.tileSize, channels: 4 },
          left: x,
          top: y,
        });
      }
    });
  });

  const svg = Buffer.from(
    `<svg width="${geo.width}" height="${geo.height}" xmlns="http://www.w3.org/2000/svg">${svgParts.join('')}</svg>`,
  );
  await sharp(svg)
    .composite(overlays)
    .flatten({ background })
    .png({ compressionLevel: 9 })
    .toFile(pngPath);
  writeFileSync(sidecarPath(pngPath), JSON.stringify(pixelMapCells(layout), null, 2) + '\n');
}

export async function renderAll(
  layout: PixelMapLayout,
  layoutPath: string,
  exclude?: Set<string>,
): Promise<void> {
  for (const sheet of layout.sheets) await renderSheet(layout, layoutPath, sheet, exclude);
}

/** Rewrite (row, label) keys inside every sheet sidecar after a rename. */
function renameInSidecars(
  layout: PixelMapLayout,
  layoutPath: string,
  rename: (cell: { row: string; label: string }) => void,
): void {
  for (const sheet of layout.sheets) {
    const metaPath = sidecarPath(sheetPngPath(layoutPath, sheet));
    if (!existsSync(metaPath)) continue;
    const sidecar = JSON.parse(readFileSync(metaPath, 'utf8')) as PixelMapCells;
    sidecar.cells.forEach(rename);
    writeFileSync(metaPath, JSON.stringify(sidecar, null, 2) + '\n');
  }
}

// ---------------------------------------------------------------------------
// Structural operations (one vocabulary for the CLI and the web editor)
// ---------------------------------------------------------------------------

export type SheetOp =
  | { type: 'setTitle'; title: string }
  | { type: 'setMode'; mode: 'free' | 'table'; columns?: string[] }
  | { type: 'rowAdd'; name: string; cells?: string[]; at?: number }
  | { type: 'rowRemove'; names: string[] }
  | { type: 'rowRename'; from: string; to: string }
  | { type: 'rowMove'; name: string; index: number }
  | { type: 'rowSetAnim'; row: string; anim?: { fps: number; loop?: boolean } }
  | { type: 'cellAdd'; row: string; labels: string[]; at?: number }
  | { type: 'cellRemove'; row: string; labels: string[] }
  | { type: 'cellRename'; row: string; from: string; to: string }
  | { type: 'cellClear'; row: string; labels: string[] }
  | { type: 'cellMove'; row: string; label: string; index: number }
  | { type: 'colAdd'; labels: string[]; at?: number }
  | { type: 'colRemove'; labels: string[] }
  | { type: 'colRename'; from: string; to: string }
  | { type: 'colMove'; label: string; index: number }
  | { type: 'sheetAdd'; names: string[] }
  | { type: 'sheetRemove'; names: string[] };

function insertAt<T>(array: T[], items: T[], at?: number): void {
  const index = at ?? array.length;
  if (!Number.isInteger(index) || index < 0 || index > array.length) {
    raise(`insert position out of range: ${at} (0..${array.length})`);
  }
  array.splice(index, 0, ...items);
}

function moveTo<T>(array: T[], from: number, to: number): void {
  if (!Number.isInteger(to) || to < 0 || to >= array.length) {
    raise(`index out of range: ${to} (0..${array.length - 1})`);
  }
  array.splice(to, 0, ...array.splice(from, 1));
}

/** A row's own editable cells; in table mode edit the shared columns instead. */
function ownCells(layout: PixelMapLayout, row: PixelMapLayout['rows'][number]): string[] {
  if (pixelMapMode(layout) === 'table') {
    raise(`table mode: edit the shared columns (col ...) — they apply to every row`);
  }
  return (row.cells ??= []);
}

/** The shared column set; only meaningful in table mode. */
function tableColumns(layout: PixelMapLayout): string[] {
  if (pixelMapMode(layout) !== 'table') {
    raise('col ops need table mode — this layout is free-form (use cell ops or switch mode)');
  }
  return (layout.columns ??= []);
}

/** Applies one structural edit, saves the layout and re-renders every sheet. */
export async function applyOp(layoutPath: string, op: SheetOp): Promise<PixelMapLayout> {
  const layout = loadLayout(layoutPath);
  let exclude: Set<string> | undefined;

  switch (op.type) {
    case 'setTitle':
      layout.title = op.title;
      break;
    case 'rowAdd':
      if (layout.rows.some((r) => r.name === op.name)) raise(`row already exists: ${op.name}`);
      insertAt(
        layout.rows,
        [
          pixelMapMode(layout) === 'table'
            ? { name: op.name }
            : { name: op.name, cells: op.cells ?? [] },
        ],
        op.at,
      );
      break;
    case 'rowRemove':
      for (const name of op.names) findRow(layout, name);
      layout.rows = layout.rows.filter((r) => !op.names.includes(r.name));
      break;
    case 'rowRename':
      if (layout.rows.some((r) => r.name === op.to)) raise(`row already exists: ${op.to}`);
      findRow(layout, op.from).name = op.to;
      break;
    case 'rowMove':
      findRow(layout, op.name);
      moveTo(
        layout.rows,
        layout.rows.findIndex((r) => r.name === op.name),
        op.index,
      );
      break;
    case 'setMode': {
      if (op.mode === pixelMapMode(layout)) break;
      if (op.mode === 'table') {
        // Painted cells whose labels match the new columns survive (same keys)
        layout.columns = op.columns?.length
          ? op.columns
          : [...pixelMapRowCells(layout, layout.rows[0] ?? { name: '' })];
        for (const row of layout.rows) delete row.cells;
        layout.mode = 'table';
      } else {
        // Every row materializes its own copy of the shared columns
        for (const row of layout.rows) row.cells = [...(layout.columns ?? [])];
        delete layout.columns;
        layout.mode = 'free';
      }
      break;
    }
    case 'rowSetAnim': {
      const row = findRow(layout, op.row);
      if (op.anim) row.anim = op.anim;
      else delete row.anim;
      break;
    }
    case 'cellAdd': {
      const cells = ownCells(layout, findRow(layout, op.row));
      for (const label of op.labels) {
        if (cells.includes(label)) raise(`cell already exists in ${op.row}: ${label}`);
      }
      insertAt(cells, op.labels, op.at);
      break;
    }
    case 'cellRemove': {
      const row = findRow(layout, op.row);
      const cells = ownCells(layout, row);
      for (const label of op.labels) {
        if (!cells.includes(label)) raise(`cell not found in ${op.row}: ${label}`);
      }
      row.cells = cells.filter((label) => !op.labels.includes(label));
      break;
    }
    case 'cellRename': {
      const cells = ownCells(layout, findRow(layout, op.row));
      const index = cells.indexOf(op.from);
      if (index < 0) raise(`cell not found in ${op.row}: ${op.from}`);
      if (cells.includes(op.to)) raise(`cell already exists in ${op.row}: ${op.to}`);
      cells[index] = op.to;
      break;
    }
    case 'cellClear': {
      // A pixel-only op: works in both modes (labels are the effective ones)
      const row = findRow(layout, op.row);
      const cells = pixelMapRowCells(layout, row);
      for (const label of op.labels) {
        if (!cells.includes(label)) raise(`cell not found in ${op.row}: ${label}`);
      }
      exclude = new Set(op.labels.map((label) => pixelMapFrameName(op.row, label)));
      break;
    }
    case 'cellMove': {
      const cells = ownCells(layout, findRow(layout, op.row));
      const from = cells.indexOf(op.label);
      if (from < 0) raise(`cell not found in ${op.row}: ${op.label}`);
      moveTo(cells, from, op.index);
      break;
    }
    case 'colAdd': {
      const columns = tableColumns(layout);
      for (const label of op.labels) {
        if (columns.includes(label)) raise(`column already exists: ${label}`);
      }
      insertAt(columns, op.labels, op.at);
      break;
    }
    case 'colRemove': {
      const columns = tableColumns(layout);
      for (const label of op.labels) {
        if (!columns.includes(label)) raise(`column not found: ${label}`);
      }
      layout.columns = columns.filter((label) => !op.labels.includes(label));
      break;
    }
    case 'colRename': {
      const columns = tableColumns(layout);
      const index = columns.indexOf(op.from);
      if (index < 0) raise(`column not found: ${op.from}`);
      if (columns.includes(op.to)) raise(`column already exists: ${op.to}`);
      columns[index] = op.to;
      break;
    }
    case 'colMove': {
      const columns = tableColumns(layout);
      const from = columns.indexOf(op.label);
      if (from < 0) raise(`column not found: ${op.label}`);
      moveTo(columns, from, op.index);
      break;
    }
    case 'sheetAdd':
      for (const name of op.names) {
        if (layout.sheets.includes(name)) raise(`sheet already exists: ${name}`);
      }
      layout.sheets.push(...op.names);
      break;
    case 'sheetRemove':
      for (const name of op.names) {
        if (!layout.sheets.includes(name)) raise(`sheet not found: ${name}`);
      }
      layout.sheets = layout.sheets.filter((name) => !op.names.includes(name));
      break;
  }

  if (op.type !== 'cellClear') saveLayout(layoutPath, layout);
  // Renames must retag the sidecars BEFORE render, or the painted tiles would
  // be looked up under keys that no longer exist and silently dropped
  if (op.type === 'rowRename') {
    renameInSidecars(layout, layoutPath, (cell) => {
      if (cell.row === op.from) cell.row = op.to;
    });
  }
  if (op.type === 'cellRename') {
    renameInSidecars(layout, layoutPath, (cell) => {
      if (cell.row === op.row && cell.label === op.from) cell.label = op.to;
    });
  }
  if (op.type === 'colRename') {
    // The shared column renames in every row at once
    renameInSidecars(layout, layoutPath, (cell) => {
      if (cell.label === op.from) cell.label = op.to;
    });
  }
  if (op.type !== 'sheetRemove') await renderAll(layout, layoutPath, exclude);
  return layout;
}

export async function createLayout(
  layoutPath: string,
  init: Partial<Pick<PixelMapLayout, 'title' | 'tileSize' | 'sheets' | 'mode' | 'columns'>> & {
    rows?: string[];
  },
): Promise<PixelMapLayout> {
  if (existsSync(layoutPath)) raise(`${layoutPath} already exists`);
  mkdirSync(dirname(layoutPath), { recursive: true });
  const table = init.mode === 'table';
  const layout: PixelMapLayout = {
    title: init.title ?? 'master sheet',
    tileSize: init.tileSize ?? 64,
    sheets: init.sheets?.length ? init.sheets : ['sheet'],
    ...(table ? { mode: 'table' as const, columns: init.columns ?? [] } : {}),
    rows: (init.rows ?? []).map((name) => (table ? { name } : { name, cells: [] })),
  };
  saveLayout(layoutPath, layout);
  await renderAll(layout, layoutPath);
  return layout;
}

// ---------------------------------------------------------------------------
// Per-cell pixel operations (web editor)
// ---------------------------------------------------------------------------

function cellOnDisk(layoutPath: string, sheet: string, row: string, label: string) {
  const pngPath = sheetPngPath(layoutPath, sheet);
  const metaPath = sidecarPath(pngPath);
  if (!existsSync(pngPath) || !existsSync(metaPath)) raise(`sheet not rendered: ${pngPath}`);
  const sidecar = JSON.parse(readFileSync(metaPath, 'utf8')) as PixelMapCells;
  const cell = indexPixelMapCells(sidecar).get(pixelMapFrameName(row, label));
  return { pngPath, sidecar, cell: cell ?? raise(`cell not found in ${sheet}: ${row}/${label}`) };
}

/** Crop one cell out of a sheet PNG (as an opaque PNG buffer). */
export async function cropCellPng(
  layoutPath: string,
  sheet: string,
  row: string,
  label: string,
): Promise<Buffer> {
  const { pngPath, sidecar, cell } = cellOnDisk(layoutPath, sheet, row, label);
  return sharp(pngPath)
    .extract({ left: cell.x, top: cell.y, width: sidecar.tileSize, height: sidecar.tileSize })
    .png()
    .toBuffer();
}

/**
 * Paste an image into one cell. The image is nearest-neighbor resized to the
 * tile size; transparent pixels become magenta (= empty), keeping the sheet
 * opaque per the pixelmap convention.
 */
export async function pasteCellImage(
  layoutPath: string,
  sheet: string,
  row: string,
  label: string,
  image: Buffer,
): Promise<void> {
  const { pngPath, sidecar, cell } = cellOnDisk(layoutPath, sheet, row, label);
  const tile = sidecar.tileSize;
  const { data } = await sharp(image)
    .resize(tile, tile, { kernel: 'nearest', fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data);
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128 || isPixelMapEmptyColor(pixels[i], pixels[i + 1], pixels[i + 2])) {
      pixels[i] = PIXELMAP_EMPTY_COLOR[0];
      pixels[i + 1] = PIXELMAP_EMPTY_COLOR[1];
      pixels[i + 2] = PIXELMAP_EMPTY_COLOR[2];
    }
    pixels[i + 3] = 255;
  }
  const composed = await sharp(pngPath)
    .composite([
      {
        input: Buffer.from(pixels),
        raw: { width: tile, height: tile, channels: 4 },
        left: cell.x,
        top: cell.y,
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(pngPath, composed);
}
