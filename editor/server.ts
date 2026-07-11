import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SheetError,
  applyOp,
  createLayout,
  cropCellPng,
  loadLayout,
  pasteCellImage,
  renderAll,
  sheetPngPath,
  type SheetOp,
} from '../src/engine';
import { PIXELMAP_STYLE, pixelMapCells, pixelMapGeometry, type PixelMapLayout } from '../src/index';

/**
 * Web editor for pixelmap master sheets — same engine as the CLI (cli.ts),
 * plus web-only niceties: paste an image straight into
 * a cell, crop/download single cells, live preview.
 *
 *   npm run editor          # http://localhost:5199
 *
 * The server is a dev tool: it reads and writes layout JSONs, sheet PNGs and
 * their .cells.json sidecars anywhere under the repo root (never outside it).
 */

const ROOT = resolve(process.cwd());
const PORT = Number(process.env.PORT ?? 5199);
const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), 'index.html');

/** Resolves a client-supplied repo-relative path, refusing escapes. */
function safePath(rel: string, extension: string): string {
  const abs = resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep))
    throw new SheetError(`path escapes repo: ${rel}`);
  if (!abs.endsWith(extension)) throw new SheetError(`expected a ${extension} path: ${rel}`);
  return abs;
}

/** Shallow scan for pixelmap layout JSONs under the working dir (depth-limited). */
function listLayouts(): { path: string; title: string; sheets: number; rows: number }[] {
  const found: { path: string; title: string; sheets: number; rows: number }[] = [];
  const skip = new Set(['node_modules', '.git', 'dist']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const abs = join(dir, entry);
      const stats = statSync(abs);
      if (stats.isDirectory()) {
        walk(abs, depth + 1);
      } else if (entry.endsWith('.json')) {
        try {
          const data = JSON.parse(readFileSync(abs, 'utf8')) as Partial<PixelMapLayout>;
          if (
            typeof data.tileSize === 'number' &&
            Array.isArray(data.sheets) &&
            Array.isArray(data.rows) &&
            data.rows.every((row) => typeof row?.name === 'string' && Array.isArray(row?.cells))
          ) {
            found.push({
              path: relative(ROOT, abs).replaceAll(sep, '/'),
              title: String(data.title ?? entry),
              sheets: data.sheets.length,
              rows: data.rows.length,
            });
          }
        } catch {
          // not JSON we care about
        }
      }
    }
  };
  walk(ROOT, 0);
  return found;
}

function stateOf(layoutPath: string, layout: PixelMapLayout) {
  return {
    path: relative(ROOT, layoutPath).replaceAll(sep, '/'),
    layout,
    geometry: pixelMapGeometry(layout),
    cells: pixelMapCells(layout),
    style: PIXELMAP_STYLE,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32 * 1024 * 1024) throw new SheetError('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const match = /^data:image\/[\w+.-]+;base64,(.+)$/.exec(dataUrl);
  if (!match) throw new SheetError('expected a base64 image data URL');
  return Buffer.from(match[1], 'base64');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query = (name: string): string => {
    const value = url.searchParams.get(name);
    if (!value) throw new SheetError(`missing query param: ${name}`);
    return value;
  };

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(HTML_PATH));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/layouts') {
    sendJson(res, 200, { layouts: listLayouts() });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const layoutPath = safePath(query('path'), '.json');
    sendJson(res, 200, stateOf(layoutPath, loadLayout(layoutPath)));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/png') {
    const layoutPath = safePath(query('path'), '.json');
    const layout = loadLayout(layoutPath);
    const sheet = query('sheet');
    if (!layout.sheets.includes(sheet)) throw new SheetError(`sheet not found: ${sheet}`);
    const pngPath = sheetPngPath(layoutPath, sheet);
    if (!existsSync(pngPath)) throw new SheetError(`sheet not rendered: ${pngPath}`);
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(readFileSync(pngPath));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/cell.png') {
    const layoutPath = safePath(query('path'), '.json');
    const png = await cropCellPng(layoutPath, query('sheet'), query('row'), query('label'));
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(png);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/create') {
    const body = JSON.parse(await readBody(req)) as {
      path: string;
      title?: string;
      tileSize?: number;
      sheets?: string[];
      rows?: string[];
      mode?: 'free' | 'table';
      columns?: string[];
    };
    const layoutPath = safePath(body.path, '.json');
    const layout = await createLayout(layoutPath, body);
    sendJson(res, 200, stateOf(layoutPath, layout));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/op') {
    const body = JSON.parse(await readBody(req)) as { path: string; op: SheetOp };
    const layoutPath = safePath(body.path, '.json');
    const layout = await applyOp(layoutPath, body.op);
    sendJson(res, 200, stateOf(layoutPath, layout));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/render') {
    const body = JSON.parse(await readBody(req)) as { path: string };
    const layoutPath = safePath(body.path, '.json');
    const layout = loadLayout(layoutPath);
    await renderAll(layout, layoutPath);
    sendJson(res, 200, stateOf(layoutPath, layout));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/cell/image') {
    const body = JSON.parse(await readBody(req)) as {
      path: string;
      sheet: string;
      row: string;
      label: string;
      dataUrl: string;
    };
    const layoutPath = safePath(body.path, '.json');
    await pasteCellImage(
      layoutPath,
      body.sheet,
      body.row,
      body.label,
      dataUrlToBuffer(body.dataUrl),
    );
    sendJson(res, 200, stateOf(layoutPath, loadLayout(layoutPath)));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    const known = error instanceof SheetError || error instanceof SyntaxError;
    if (!known) console.error(error);
    sendJson(res, known ? 400 : 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}).listen(PORT, () => {
  process.stdout.write(`pixelmap sheet editor: http://localhost:${PORT} (root: ${ROOT})\n`);
});
