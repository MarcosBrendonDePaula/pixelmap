import { describe, expect, it } from 'vitest';
import {
  indexPixelMapCells,
  pixelMapCellUV,
  isPixelMapEmptyColor,
  pixelMapCells,
  pixelMapFrameName,
  pixelMapGeometry,
  pixelMapLayoutError,
  pixelMapRowCells,
  PIXELMAP_STYLE,
  type PixelMapLayout,
} from './index';

const layout = (over: Partial<PixelMapLayout> = {}): PixelMapLayout => ({
  title: 'test',
  tileSize: 64,
  sheets: ['autumn'],
  rows: [
    { name: 'water', cells: ['0', '1', 'b0'] },
    { name: 'grass', cells: ['0', 'e1', 'e2', 'e3'] },
  ],
  ...over,
});

describe('pixelMapLayoutError', () => {
  it('accepts a sound layout', () => {
    expect(pixelMapLayoutError(layout())).toBeNull();
  });

  it('rejects duplicate rows, duplicate labels and bad sheet names', () => {
    expect(
      pixelMapLayoutError(
        layout({
          rows: [
            { name: 'a', cells: [] },
            { name: 'a', cells: [] },
          ],
        }),
      ),
    ).toMatch(/duplicate row/);
    expect(pixelMapLayoutError(layout({ rows: [{ name: 'a', cells: ['x', 'x'] }] }))).toMatch(
      /duplicate cell/,
    );
    expect(pixelMapLayoutError(layout({ sheets: ['bad name'] }))).toMatch(/sheet/);
    expect(pixelMapLayoutError(layout({ tileSize: 0 }))).toMatch(/tileSize/);
  });

  it('validates table mode (one shared column set per layout)', () => {
    const columns = ['self', 'up', 'down', 'left', 'right'];
    expect(
      pixelMapLayoutError(
        layout({ mode: 'table', columns, rows: [{ name: 'stone' }, { name: 'wood' }] }),
      ),
    ).toBeNull();
    expect(
      pixelMapLayoutError(
        layout({ mode: 'table', columns, rows: [{ name: 'stone', cells: ['extra'] }] }),
      ),
    ).toMatch(/must not have its own cells/);
    expect(pixelMapLayoutError(layout({ mode: 'table', columns: ['x', 'x'], rows: [] }))).toMatch(
      /duplicate cell label in columns/,
    );
    expect(pixelMapLayoutError(layout({ columns: ['a'] }))).toMatch(/only valid in table mode/);
  });
});

describe('pixelMapRowCells', () => {
  it('resolves the shared columns in table mode and own cells in free mode', () => {
    const table = layout({
      mode: 'table',
      columns: ['self', 'up', 'down'],
      rows: [{ name: 'stone' }, { name: 'wood' }],
    });
    expect(pixelMapRowCells(table, table.rows[0])).toEqual(['self', 'up', 'down']);
    expect(pixelMapRowCells(table, table.rows[1])).toEqual(['self', 'up', 'down']);
    const free = layout();
    expect(pixelMapRowCells(free, free.rows[0])).toEqual(['0', '1', 'b0']);
    // Table rows are positioned exactly like free-form rows
    const cells = pixelMapCells(table);
    expect(cells.cells.filter((c) => c.row === 'stone')).toHaveLength(3);
    expect(indexPixelMapCells(cells).get('stone/up')).toBeDefined();
    expect(indexPixelMapCells(cells).get('wood/up')).toBeDefined();
  });
});

describe('pixelMapGeometry', () => {
  it('positions cells on the label+tile pitch grid', () => {
    const geo = pixelMapGeometry(layout());
    const { labelHeight, padX, padY, marginTop } = PIXELMAP_STYLE;
    const first = geo.cellPos(0, 0);
    expect(first).toEqual({ x: geo.marginLeft, y: marginTop + labelHeight });
    const below = geo.cellPos(1, 2);
    expect(below.x).toBe(geo.marginLeft + 2 * (64 + padX));
    expect(below.y).toBe(marginTop + (labelHeight + 64 + padY) + labelHeight);
  });

  it('sizes the sheet to the widest row and grows with the longest name', () => {
    const geo = pixelMapGeometry(layout());
    const gridWidth =
      geo.marginLeft +
      4 * (64 + PIXELMAP_STYLE.padX) -
      PIXELMAP_STYLE.padX +
      PIXELMAP_STYLE.marginRight;
    // Width covers the cell grid, but never narrower than the header line
    expect(geo.width).toBeGreaterThanOrEqual(gridWidth);
    const wider = pixelMapGeometry(
      layout({ rows: [{ name: 'grass', cells: Array.from({ length: 20 }, (_, i) => `${i}`) }] }),
    );
    expect(wider.width).toBe(
      wider.marginLeft +
        20 * (64 + PIXELMAP_STYLE.padX) -
        PIXELMAP_STYLE.padX +
        PIXELMAP_STYLE.marginRight,
    );
    const wide = pixelMapGeometry(layout({ rows: [{ name: 'a'.repeat(30), cells: ['0'] }] }));
    expect(wide.marginLeft).toBeGreaterThan(geo.marginLeft);
  });

  it('keeps room for the header on a narrow layout', () => {
    const narrow = pixelMapGeometry(layout({ rows: [{ name: 'x', cells: [] }] }));
    expect(narrow.width).toBeGreaterThan(300);
  });
});

describe('pixelMapCells / indexPixelMapCells', () => {
  it('emits one positioned cell per (row, label) and indexes by frame name', () => {
    const cells = pixelMapCells(layout());
    expect(cells.tileSize).toBe(64);
    expect(cells.cells).toHaveLength(7);
    const index = indexPixelMapCells(cells);
    const geo = pixelMapGeometry(layout());
    expect(index.get(pixelMapFrameName('grass', 'e2'))).toMatchObject(geo.cellPos(1, 2));
    expect(index.has('grass/nope')).toBe(false);
  });
});

describe('isPixelMapEmptyColor', () => {
  it('keys out magenta with tolerance but keeps real colors', () => {
    expect(isPixelMapEmptyColor(255, 0, 255)).toBe(true);
    expect(isPixelMapEmptyColor(230, 20, 240)).toBe(true);
    expect(isPixelMapEmptyColor(200, 30, 40)).toBe(false);
    expect(isPixelMapEmptyColor(255, 255, 255)).toBe(false);
  });
});

describe('pixelMapCellUV', () => {
  it('turns shipped cell positions into texture coordinates', () => {
    const cells = { tileSize: 32, width: 128, height: 64, cells: [] };
    const cell = { row: 'stone', label: 'self', x: 32, y: 0 };
    const uv = pixelMapCellUV(cells, cell);
    expect(uv).toEqual({ u0: 0.25, u1: 0.5, v0: 1, v1: 0.5 });
    const flat = pixelMapCellUV(cells, cell, { invertY: false });
    expect(flat).toEqual({ u0: 0.25, u1: 0.5, v0: 0, v1: 0.5 });
    const inset = pixelMapCellUV(cells, cell, { inset: 0.35, invertY: false });
    expect(inset.u0).toBeCloseTo((32 + 0.35) / 128);
    expect(inset.v1).toBeCloseTo((32 - 0.35) / 64);
  });
});
