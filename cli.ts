import {
  SheetError,
  applyOp,
  createLayout,
  loadLayout,
  renderAll,
  type SheetOp,
} from './src/engine';
import { pixelMapGeometry, pixelMapMode, pixelMapRowCells } from './src/index';

/**
 * Pixelmap master sheet CLI — thin wrapper over src/engine.ts (the web
 * editor `npm run editor` drives the same engine). See that module and
 * src/index.ts for the format and the preservation rules.
 *
 *   npx npm run sheet -- create sheets/props.json --sheets autumn,winter
 *   npx npm run sheet -- row add sheets/props.json fence --cells 0,1,2
 *   ... paint cells in any image editor, then keep editing the structure:
 *   npx npm run sheet -- row rename sheets/props.json fence wood_fence
 */

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/** Pull `--flag value` options out of argv, returning the positional rest. */
function takeFlags(
  argv: string[],
  flags: string[],
): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const found = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!flags.includes(name)) fail(`unknown flag: ${arg}`);
      const value = argv[++i];
      if (value === undefined) fail(`flag ${arg} needs a value`);
      found.set(name, value);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags: found };
}

function intFlag(flags: Map<string, string>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) fail(`--${name} must be an integer, got ${raw}`);
  return value;
}

const USAGE = `usage: npm run sheet -- <command> ...

  create <layout.json> [--title T] [--tile 64] [--sheets a,b] [--rows n1,n2]
         [--columns self,up,down]              --columns creates the layout in TABLE mode
  render <layout.json>                        re-render all sheets (preserves painted cells)
  info   <layout.json>                        print the layout grid
  mode   <layout.json> <table|free> [--columns a,b,c]   switch modes (paint preserved by label)

  row add    <layout.json> <name> [--cells 0,1,2] [--at N]   (table mode: name only)
  row remove <layout.json> <name...>          discards the row's painted cells
  row rename <layout.json> <old> <new>        keeps painted cells
  row move   <layout.json> <name> <index>

  cell ops (FREE mode — each row owns its cells):
  cell add    <layout.json> <row> <label...> [--at N]
  cell remove <layout.json> <row> <label...>  discards those painted cells
  cell rename <layout.json> <row> <old> <new> keeps the painted cell
  cell clear  <layout.json> <row> <label...>  resets cells back to magenta (works in both modes)
  cell move   <layout.json> <row> <label> <index>

  col ops (TABLE mode — one column set shared by every row):
  col add    <layout.json> <label...> [--at N]
  col remove <layout.json> <label...>         discards that column in every row
  col rename <layout.json> <old> <new>        keeps painted cells in every row
  col move   <layout.json> <label> <index>

  sheet add    <layout.json> <name...>        new PNG(s) sharing this layout
  sheet remove <layout.json> <name...>        stops rendering (PNG kept on disk)

Web editor with the same engine: npm run editor
`;

/** Maps a parsed command line onto a structural op, or null for non-ops. */
function parseOp(command: string, rest: string[]): { layoutPath: string; op: SheetOp } | null {
  const need = (...values: (string | undefined)[]): string[] => {
    if (values.some((v) => v === undefined || v === '')) fail(USAGE);
    return values as string[];
  };
  switch (command) {
    case 'row add': {
      const { positional, flags } = takeFlags(rest, ['cells', 'at']);
      const [layoutPath, name] = need(positional[0], positional[1]);
      return {
        layoutPath,
        op: {
          type: 'rowAdd',
          name,
          cells: flags.get('cells')?.split(','),
          at: intFlag(flags, 'at'),
        },
      };
    }
    case 'row remove': {
      const [layoutPath, ...names] = rest;
      if (!layoutPath || names.length === 0) fail(USAGE);
      return { layoutPath, op: { type: 'rowRemove', names } };
    }
    case 'row rename': {
      const [layoutPath, from, to] = need(rest[0], rest[1], rest[2]);
      return { layoutPath, op: { type: 'rowRename', from, to } };
    }
    case 'row move': {
      const [layoutPath, name, index] = need(rest[0], rest[1], rest[2]);
      return { layoutPath, op: { type: 'rowMove', name, index: Number(index) } };
    }
    case 'cell add': {
      const { positional, flags } = takeFlags(rest, ['at']);
      const [layoutPath, row] = need(positional[0], positional[1]);
      const labels = positional.slice(2);
      if (labels.length === 0) fail(USAGE);
      return { layoutPath, op: { type: 'cellAdd', row, labels, at: intFlag(flags, 'at') } };
    }
    case 'cell remove':
    case 'cell clear': {
      const [layoutPath, row] = need(rest[0], rest[1]);
      const labels = rest.slice(2);
      if (labels.length === 0) fail(USAGE);
      const type = command === 'cell clear' ? ('cellClear' as const) : ('cellRemove' as const);
      return { layoutPath, op: { type, row, labels } };
    }
    case 'cell rename': {
      const [layoutPath, row, from, to] = need(rest[0], rest[1], rest[2], rest[3]);
      return { layoutPath, op: { type: 'cellRename', row, from, to } };
    }
    case 'cell move': {
      const [layoutPath, row, label, index] = need(rest[0], rest[1], rest[2], rest[3]);
      return { layoutPath, op: { type: 'cellMove', row, label, index: Number(index) } };
    }
    case 'mode': {
      const { positional, flags } = takeFlags(rest, ['columns']);
      const [layoutPath, mode] = need(positional[0], positional[1]);
      if (mode !== 'table' && mode !== 'free') fail(USAGE);
      return {
        layoutPath,
        op: { type: 'setMode', mode, columns: flags.get('columns')?.split(',') },
      };
    }
    case 'col add': {
      const { positional, flags } = takeFlags(rest, ['at']);
      const [layoutPath] = need(positional[0], positional[1]);
      return {
        layoutPath,
        op: { type: 'colAdd', labels: positional.slice(1), at: intFlag(flags, 'at') },
      };
    }
    case 'col remove': {
      const [layoutPath] = need(rest[0], rest[1]);
      return { layoutPath, op: { type: 'colRemove', labels: rest.slice(1) } };
    }
    case 'col rename': {
      const [layoutPath, from, to] = need(rest[0], rest[1], rest[2]);
      return { layoutPath, op: { type: 'colRename', from, to } };
    }
    case 'col move': {
      const [layoutPath, label, index] = need(rest[0], rest[1], rest[2]);
      return { layoutPath, op: { type: 'colMove', label, index: Number(index) } };
    }
    case 'sheet add':
    case 'sheet remove': {
      const [layoutPath] = need(rest[0], rest[1]);
      const names = rest.slice(1);
      const type = command === 'sheet add' ? ('sheetAdd' as const) : ('sheetRemove' as const);
      return { layoutPath, op: { type, names } };
    }
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const grouped = ['row', 'cell', 'sheet', 'col'].includes(argv[0]);
  const command = grouped ? `${argv[0]} ${argv[1]}` : argv[0];
  const rest = argv.slice(grouped ? 2 : 1);

  const done = (layoutPath: string): void => {
    process.stdout.write(`ok — sheets re-rendered next to ${layoutPath}\n`);
  };

  const parsed = parseOp(command, rest);
  if (parsed) {
    await applyOp(parsed.layoutPath, parsed.op);
    done(parsed.layoutPath);
    return;
  }

  switch (command) {
    case 'create': {
      const { positional, flags } = takeFlags(rest, ['title', 'tile', 'sheets', 'rows', 'columns']);
      const [layoutPath] = positional;
      if (!layoutPath) fail(USAGE);
      const columns = flags.get('columns')?.split(',');
      await createLayout(layoutPath, {
        title: flags.get('title'),
        tileSize: intFlag(flags, 'tile'),
        sheets: flags.get('sheets')?.split(','),
        rows: flags.get('rows')?.split(','),
        mode: columns ? 'table' : undefined,
        columns,
      });
      done(layoutPath);
      break;
    }
    case 'render': {
      const [layoutPath] = rest;
      if (!layoutPath) fail(USAGE);
      await renderAll(loadLayout(layoutPath), layoutPath);
      done(layoutPath);
      break;
    }
    case 'info': {
      const [layoutPath] = rest;
      if (!layoutPath) fail(USAGE);
      const layout = loadLayout(layoutPath);
      const geo = pixelMapGeometry(layout);
      process.stdout.write(
        `${layout.title} — tile ${layout.tileSize}px, sheet ${geo.width}x${geo.height}, ` +
          `sheets: ${layout.sheets.join(', ') || '(none)'}\n`,
      );
      if (pixelMapMode(layout) === 'table') {
        process.stdout.write(`  [mode table — columns]: ${(layout.columns ?? []).join(' ')}\n`);
        for (const row of layout.rows) process.stdout.write(`  ${row.name}\n`);
      } else {
        for (const row of layout.rows) {
          const cells = pixelMapRowCells(layout, row);
          process.stdout.write(`  ${row.name} (${cells.length}): ${cells.join(' ')}\n`);
        }
      }
      break;
    }
    default:
      process.stderr.write(USAGE);
      process.exit(1);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof SheetError) fail(error.message);
  throw error;
}
