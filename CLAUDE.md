# pixelmap — guidance for AI assistants

Labeled master sheets for tile art: structure-first sprite sheets you can
restructure without losing paint. Ships as TS **source** (no build step):
`main`/`exports` point at `.ts`; consumers need a TS-aware toolchain
(vite, tsx, bundlers). README.md has the user-facing overview.

## Module map

| Entry              | File                                     | Runs on        | Role                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pixelmap`         | `src/index.ts`                           | anywhere       | Pure core: types, validation (`pixelMapLayoutError`), geometry, `pixelMapCells`, frame index, UV math (`pixelMapCellUV`), animation clock (`pixelMapAnimationIndex`). Zero deps.                                                                   |
| `pixelmap/engine`  | `src/engine.ts`                          | Node (sharp)   | Render sheets, structural ops (`applyOp`/`SheetOp`), `createLayout`, `pasteCellImage`, `pasteSheetImage`, `cropCellPng`. Throws `SheetError`.                                                                                                      |
| `pixelmap/browser` | `src/browser.ts`                         | browser        | `loadPixelMapImage(baseUrl)`: fetches `<base>.cells.json` + `<base>.png`, chroma-keys magenta→alpha, returns RGBA + `frames` + `frameUV()` + `animation()` + `composeLayers()` (layered sprites with per-layer tint) + `release()`. Caches by URL. |
| CLI                | `cli.ts`                                 | Node           | `npm run sheet -- <cmd>`; thin argv→`SheetOp` mapping. Run without args for usage.                                                                                                                                                                 |
| Editor             | `editor/server.ts` + `editor/index.html` | Node + browser | `npm run editor`; local dev tool rooted at `process.cwd()` (path-guarded, no auth). Single-file vanilla JS + Tailwind CDN frontend.                                                                                                                |

## Core invariants (do not break)

- **Sidecar contract**: `<sheet>.cells.json` describes the PNG on disk
  exactly. Every render rewrites it; the engine REFUSES to touch a PNG whose
  dimensions mismatch its sidecar or whose sidecar is missing (that's the
  paint-preservation safety net).
- **Preservation semantics**: structural ops re-lift painted tiles via the
  OLD sidecar keyed by `row/label`. Renames (`rowRename`, `cellRename`,
  `colRename`) must retag sidecar keys BEFORE rendering — see `applyOp`;
  keep that ordering.
- **Magenta = empty** (`PIXELMAP_EMPTY_COLOR`, tolerance 90 Manhattan).
  Sheets are opaque PNGs; alpha appears only after browser keying.
- `tileSize` is square and per layout. Frames are addressed `row/label`
  everywhere (`pixelMapFrameName`).
- **Modes**: free (row-owned `cells`) vs table (layout `columns`, rows are
  names only). Cell ops raise in table mode (use `col*` ops); `cellClear`
  works in both. `setMode` converts preserving paint by label.
- Layout/sidecar JSON is written with `JSON.stringify(_, null, 2)` — that
  formatting is canonical output; don't run prettier over generated files in
  consumer repos (ignore them instead).
- **Memory**: browser loads are cached per URL; `release()` frees the RGBA
  and evicts the cache entry (metadata stays usable). Adapters should call
  it right after the GPU upload — EXCEPT sheets used with `composeLayers`,
  which needs the CPU pixels alive.
- **Layer composition**: `composeLayers(ctx, layers, {x,y,scale})` stamps
  cells in order; per-layer `tint` multiplies channels by `tint/base`
  (neutral gray ramps painted around `base` reproduce shading factors
  exactly; values above `base` overbrighten, clamped). Pure math lives in
  `tintCellPixels` (node-testable).

## Dev commands

```bash
npm test            # vitest (src/index.test.ts — pure core)
npm run build       # tsc --noEmit (strict; includes cli + editor server)
npm run format      # prettier --check .
npm run sheet -- …  # exercise the CLI against a scratch layout
npm run editor      # editor at :5199 rooted at the cwd
```

Verify UI changes in a real browser (the editor is served per-request, so
HTML edits need no restart; `editor/server.ts` or `src/*` changes do).

## Known consumers

The inValley game (`MarcosBrendonDePaula/invalley`) vendors this repo as the
`packages/pixelmap` submodule and depends on it via `file:`; its terrain
pack tool, crop/character generators and Babylon adapter build on
`pixelmap/engine` + `pixelmap/browser`. Breaking `SheetOp`, the sidecar
shape, or the UV/animation APIs breaks that game — check it when changing
public surface.

## Publishing (future)

Before publishing to npm, add a build (tsup/tsc → `dist/` + `.d.ts`) and
point `exports` at compiled JS — plain Node consumers can't import `.ts`.
Until then this stays a source-first package for TS toolchains.
