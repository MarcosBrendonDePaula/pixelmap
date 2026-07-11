/**
 * Pixelmap system (#sheets): a "pixelmap" is a labeled master sheet PNG plus
 * its resource metadata — rows named by content (grass, fence, ...), cells
 * named by variation (0, 1, e1, ...), every cell a tileSize x tileSize square
 * at a known pixel position. Magenta (#ff00ff) inside a cell means empty /
 * transparent, so the sheets stay opaque and editable in any image editor.
 *
 * Three artifacts share this module:
 * - layout JSON (`PixelMapLayout`) — the editable source of truth
 * - cells JSON (`PixelMapCells`, `<sheet>.cells.json` next to each PNG) —
 *   where every (row, label) cell sits in the PNG that is on disk
 * - the PNG itself, rendered by the engine (src/engine.ts)
 *
 * Everything here is pure math shared by the CLI/web editor (render, pixel
 * preservation) and the client loader (frame lookup, UVs), so the two can
 * never disagree about where a cell lives.
 */

export type PixelMapMode = 'free' | 'table';

export interface PixelMapRow {
  name: string;
  /** Free mode: this row's own column labels. Unused in table mode. */
  cells?: string[];
}

/** Editable layout: one JSON drives N sheet PNGs (e.g. one per season). */
export interface PixelMapLayout {
  title: string;
  tileSize: number;
  /** PNG basenames (no extension) rendered next to the layout JSON. */
  sheets: string[];
  /**
   * 'free' (default): each row owns its cells. 'table': `columns` is the one
   * standardized column set (e.g. self/up/down/left/right) shared by every
   * row — editing it restructures the whole sheet at once.
   */
  mode?: PixelMapMode;
  /** Table mode's column labels; required when mode is 'table'. */
  columns?: string[];
  rows: PixelMapRow[];
}

export const pixelMapMode = (layout: PixelMapLayout): PixelMapMode => layout.mode ?? 'free';

/** A row's effective column labels (the shared table columns, or its own). */
export function pixelMapRowCells(layout: PixelMapLayout, row: PixelMapRow): string[] {
  return pixelMapMode(layout) === 'table' ? (layout.columns ?? []) : (row.cells ?? []);
}

export interface PixelMapCell {
  row: string;
  label: string;
  /** Top-left corner of the cell's tile area, in PNG pixels. */
  x: number;
  y: number;
}

/** Sidecar metadata describing the PNG actually on disk (`<sheet>.cells.json`). */
export interface PixelMapCells {
  tileSize: number;
  width: number;
  height: number;
  cells: PixelMapCell[];
}

/** Key color meaning "empty" inside a cell; keyed out to transparent on load. */
export const PIXELMAP_EMPTY_COLOR: readonly [number, number, number] = [255, 0, 255];
/** Manhattan RGB distance below which a pixel counts as the key color. */
export const PIXELMAP_EMPTY_TOLERANCE = 90;

/** Frames are addressed as `row/label` everywhere (loader, editor, packers). */
export const pixelMapFrameName = (row: string, label: string): string => `${row}/${label}`;

// Grid style shared with tools/terrain-master.ts so the sheets look the same
export const PIXELMAP_STYLE = {
  labelHeight: 16,
  padX: 6,
  padY: 10,
  marginTop: 34,
  marginRight: 10,
  marginBottom: 12,
  background: '#20202a',
} as const;

/** Validates a layout, returning an error message or null when it is sound. */
export function pixelMapLayoutError(layout: PixelMapLayout): string | null {
  if (!Number.isInteger(layout.tileSize) || layout.tileSize < 4) {
    return `tileSize must be an integer >= 4, got ${layout.tileSize}`;
  }
  const badName = (name: string): boolean => name.length === 0 || /[\n\r]/.test(name);
  const checkLabels = (owner: string, cells: string[]): string | null => {
    const labels = new Set<string>();
    for (const label of cells) {
      if (badName(label)) return `invalid cell label: ${JSON.stringify(label)}`;
      if (labels.has(label)) return `duplicate cell label in ${owner}: ${label}`;
      labels.add(label);
    }
    return null;
  };
  const table = pixelMapMode(layout) === 'table';
  if (layout.mode !== undefined && layout.mode !== 'free' && layout.mode !== 'table') {
    return `mode must be "free" or "table", got ${JSON.stringify(layout.mode)}`;
  }
  if (table) {
    const error = checkLabels('columns', layout.columns ?? []);
    if (error) return error;
  } else if (layout.columns !== undefined) {
    return 'columns is only valid in table mode';
  }
  const rowNames = new Set<string>();
  for (const row of layout.rows) {
    if (badName(row.name)) return `invalid row name: ${JSON.stringify(row.name)}`;
    if (rowNames.has(row.name)) return `duplicate row name: ${row.name}`;
    rowNames.add(row.name);
    if (table) {
      if (row.cells?.length) return `table mode: row ${row.name} must not have its own cells`;
    } else {
      const error = checkLabels(`row ${row.name}`, row.cells ?? []);
      if (error) return error;
    }
  }
  const sheets = new Set<string>();
  for (const sheet of layout.sheets) {
    if (!/^[\w.-]+$/.test(sheet)) return `invalid sheet name (filename-safe only): ${sheet}`;
    if (sheets.has(sheet)) return `duplicate sheet name: ${sheet}`;
    sheets.add(sheet);
  }
  return null;
}

export interface PixelMapGeometry {
  tileSize: number;
  marginLeft: number;
  width: number;
  height: number;
  cellPos: (rowIndex: number, colIndex: number) => { x: number; y: number };
}

/** Sheet geometry derived from the layout alone — deterministic everywhere. */
export function pixelMapGeometry(layout: PixelMapLayout): PixelMapGeometry {
  const { labelHeight, padX, padY, marginTop, marginRight, marginBottom } = PIXELMAP_STYLE;
  const tileSize = layout.tileSize;
  const pitchX = tileSize + padX;
  const pitchY = labelHeight + tileSize + padY;
  // Left margin fits the longest row title (rough 8px/char at font-size 13)
  const maxName = layout.rows.reduce((max, row) => Math.max(max, row.name.length), 0);
  const marginLeft = Math.max(70, maxName * 8 + 20);
  const maxCells = layout.rows.reduce(
    (max, row) => Math.max(max, pixelMapRowCells(layout, row).length),
    1,
  );
  // Never narrower than the header line ("<title> — <sheet> (magenta = ...)")
  const maxSheet = layout.sheets.reduce((max, sheet) => Math.max(max, sheet.length), 0);
  const titleFit = 20 + (layout.title.length + maxSheet + 45) * 8;
  return {
    tileSize,
    marginLeft,
    width: Math.max(marginLeft + maxCells * pitchX - padX + marginRight, titleFit),
    height: marginTop + Math.max(layout.rows.length, 1) * pitchY + marginBottom,
    cellPos: (rowIndex, colIndex) => ({
      x: marginLeft + colIndex * pitchX,
      y: marginTop + rowIndex * pitchY + labelHeight,
    }),
  };
}

/** The cells metadata a freshly rendered sheet of this layout will carry. */
export function pixelMapCells(layout: PixelMapLayout): PixelMapCells {
  const geometry = pixelMapGeometry(layout);
  const cells: PixelMapCell[] = [];
  layout.rows.forEach((row, rowIndex) => {
    pixelMapRowCells(layout, row).forEach((label, colIndex) => {
      const { x, y } = geometry.cellPos(rowIndex, colIndex);
      cells.push({ row: row.name, label, x, y });
    });
  });
  return { tileSize: layout.tileSize, width: geometry.width, height: geometry.height, cells };
}

/** Frame lookup map: `row/label` -> cell position. */
export function indexPixelMapCells(cells: PixelMapCells): Map<string, PixelMapCell> {
  return new Map(cells.cells.map((cell) => [pixelMapFrameName(cell.row, cell.label), cell]));
}

/** True when an RGB pixel is the "empty" key color (within tolerance). */
export function isPixelMapEmptyColor(r: number, g: number, b: number): boolean {
  const [kr, kg, kb] = PIXELMAP_EMPTY_COLOR;
  return Math.abs(r - kr) + Math.abs(g - kg) + Math.abs(b - kb) < PIXELMAP_EMPTY_TOLERANCE;
}
