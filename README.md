# pixelmap

Folhas mestres rotuladas para arte de tiles: sprite sheets **estrutura-primeiro** que você
reestrutura sem perder pintura.

Um **pixelmap** agrupa o tilemap e os metadados do resource:

- **Layout JSON** — a fonte editável: linhas nomeadas pelo conteúdo (`grass`, `fence`, ...),
  colunas nomeadas pela variação (`0`, `e1`, `self`, `up`, ...), `tileSize` por layout.
- **`<folha>.cells.json`** — tabela com a posição exata de cada célula `(linha, label)` no PNG.
  É o que permite reerguer os tiles pintados após qualquer mudança de estrutura, e é o que o
  jogo carrega em runtime.
- **PNG** da folha — esqueleto gerado pela ferramenta (magenta `#ff00ff` = vazio/transparente),
  pintável em qualquer editor de imagem (Paint incluído; as folhas são opacas).

A garantia central: **mudar a estrutura nunca perde pintura**. Renomear linha/coluna, inserir,
reordenar — os tiles pintados acompanham. Só `remove` e `clear` descartam.

## Dois tipos de layout

- **Livre** (default): cada linha tem suas próprias células.
- **Tabela** (`mode: "table"` + `columns`): um único conjunto de colunas padronizado
  (ex.: `self up down left right`) compartilhado por todas as linhas — editar as colunas
  restrutura a folha inteira de uma vez.

Vários PNGs (ex.: um por estação) compartilham o mesmo layout (`sheets`).

## Animações

Uma linha pode ser uma animação: as células viram os frames, em ordem.

```bash
npm run sheet -- row anim sheets/props.json walk 8        # 8 fps, loop
npm run sheet -- row anim sheets/props.json splash 12 --once
npm run sheet -- row anim sheets/props.json walk off      # remove
```

No editor web: linha → "🎞️ Animação…" (preview ao vivo, fps, loop). O
`cells.json` carrega `animations: { walk: { fps, loop } }` e o loader devolve
`animation('walk')` com `frameAt(t)`/`uvAt(t)` — o relógio é da lib, o
consumidor só passa o tempo.

## Memória

`loadPixelMapImage` cacheia por URL (decodifica uma vez, mesmo com chamadas
concorrentes) e devolve `release()`: chame depois de subir os pixels pra GPU
pra liberar o buffer RGBA do heap — os metadados (frames, UVs, animações)
continuam válidos. Uma folha = uma textura; frames são só coordenadas.

## Uso

```bash
npm install
npm run editor            # editor web em http://localhost:5199 (roda sobre o cwd)
npm run sheet -- create sheets/props.json --title "props" --sheets autumn,winter
npm run sheet -- create sheets/blocks.json --columns self,up,down,left,right  # modo tabela
npm run sheet -- row add sheets/props.json fence --cells 0,1,2
npm run sheet -- info sheets/props.json
```

O editor web tem modais, toasts, abas por folha, reordenação por arraste (em modo tabela o
arraste move a coluna em todas as linhas), upload de PNG direto numa célula
(transparência vira magenta) e download de célula/folha.

## Como biblioteca

- `pixelmap` — núcleo puro (tipos, validação, geometria, índice de células). Zero dependências.
- `pixelmap/engine` — render/edição das folhas com preservação de pixels (Node, usa `sharp`).
- `pixelmap/browser` — carrega PNG + cells.json no navegador com chroma key aplicado; devolve
  RGBA cru + índice de frames, pronto pra virar textura em qualquer engine (Babylon, Three,
  Pixi, WebGL puro). Os adapters de engine ficam no app consumidor.

```ts
import { pixelMapFrameName } from 'pixelmap';
import { loadPixelMapImage } from 'pixelmap/browser';

const sheet = await loadPixelMapImage('/assets/sheets/props');
const cell = sheet?.frames.get(pixelMapFrameName('fence', '0'));
// sheet.data (RGBA), sheet.cells.tileSize, cell.x/cell.y → UVs na sua engine
```
