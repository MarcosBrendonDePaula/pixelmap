import { describe, expect, it } from 'vitest';
import { tintCellPixels } from './browser';

describe('tintCellPixels', () => {
  // 4x4 sheet with one 2x2 cell at (1,1): gray ramp 192/154, one hole
  const width = 4;
  const data = new Uint8ClampedArray(width * 4 * 4);
  const put = (x: number, y: number, v: number, a = 255): void => {
    const i = (y * width + x) * 4;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = a;
  };
  put(1, 1, 192);
  put(2, 1, 154);
  put(1, 2, 255);
  put(2, 2, 0, 0); // transparent hole
  const sheet = { data, width };
  const cell = { x: 1, y: 1 };

  it('multiplies channels by tint/base and clamps, skipping holes', () => {
    const out = tintCellPixels(sheet, cell, 2, '#f6d7b4', 192);
    // base pixel (192) -> exactly the tint color
    expect([...out.slice(0, 4)]).toEqual([246, 215, 180, 255]);
    // shade pixel (154 = 0.8 * 192) -> tint * 0.802
    expect(out[4]).toBe(Math.min(255, Math.round((154 * 246) / 192)));
    // overbright pixel (255 > base) clamps at 255 where the tint allows
    expect(out[8]).toBe(255);
    // hole stays fully transparent
    expect([...out.slice(12, 16)]).toEqual([0, 0, 0, 0]);
  });

  it('copies pixels as-is without a tint and accepts rgb tuples', () => {
    const plain = tintCellPixels(sheet, cell, 2);
    expect([...plain.slice(0, 4)]).toEqual([192, 192, 192, 255]);
    const tuple = tintCellPixels(sheet, cell, 2, [128, 64, 32], 255);
    expect([...tuple.slice(0, 4)]).toEqual([
      Math.round((192 * 128) / 255),
      Math.round((192 * 64) / 255),
      Math.round((192 * 32) / 255),
      255,
    ]);
  });
});
