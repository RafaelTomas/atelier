// Guarda a ORDEM dos @import de estilos.css.
//
// O CSS de componente não vive em camada, então entre duas regras de mesma
// especificidade que caem no mesmo elemento quem vence é quem vem depois. Com o
// CSS num arquivo só isso era visível ao rolar; dividido em cinco, a ordem
// passou a ser uma decisão registrada num lugar só — e trocá-la muda
// comportamento sem mudar nenhuma regra, que é o tipo de mudança que passa em
// revisão sem ninguém notar.
//
// Duas verificações:
//   1. A ordem dos @import é a esperada, com o motivo escrito ao lado.
//   2. Nenhum par NOVO de mesma especificidade cruzando arquivos — se aparecer,
//      alguém precisa dizer se ele pode cair no mesmo elemento. Os pares já
//      julgados estão em CONHECIDOS, com o veredito.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'src/renderer/styles')

// A ordem, e por que é esta.
const ESPERADA = [
  ['panels',  'ANTES de rail: a rail ajusta a densidade dos painéis que hospeda, e ajuste vem depois do que ele ajusta.'],
  ['rail',    'DEPOIS de panels (ver acima). Só a casca da rail — o conteúdo das colunas é panels.'],
  ['canvas',  'ANTES de nodes: .node.is-connect-target (canvas) e .node.is-chromeless (nodes) têm a mesma especificidade e caem no mesmo elemento — um nó sem moldura que é alvo de conexão. Hoje o is-chromeless vence, e é o esperado.'],
  ['nodes',   'DEPOIS de canvas (ver acima) e ANTES de todo nodes/*: a casca comum vem primeiro para um tipo de nó poder ajustá-la escrevendo só a diferença.'],
  ['nodes/terminal-node',    'depois da casca'],
  ['nodes/note-node',        'depois da casca'],
  ['nodes/text-node',        'depois da casca'],
  ['nodes/portal-node',      'depois da casca'],
  ['nodes/placeholder-node', 'depois da casca'],
  ['nodes/code-editor-node', 'depois da casca'],
  ['nodes/data-table-node',  'depois da casca'],
  ['nodes/image-node',       'depois da casca; sem dependência de ordem com os outros nós'],
  ['nodes/markdown-view',    'depois da casca; sem dependência de ordem com os outros nós'],
  ['nodes/node-action-bar',  'depois da casca'],
  ['nodes/format-bar',       'depois da casca'],
  ['git',     'sem dependência de ordem com as outras'],
  ['dialogs', 'sem dependência de ordem com as outras']
]

// Pares de mesma especificidade que cruzam arquivos e já foram julgados.
// A chave é normalizada (os dois seletores em ordem alfabética), então a ordem
// em que estão escritos aqui não importa.
const CONHECIDOS = new Map(([
  ['.code-editor-actions .ghost-btn|.git-file-actions .ghost-btn',
   'elementos distintos: um botão está em um container ou no outro, nunca nos dois'],
  ['.file-tree-row.is-selected|.quick-card.is-selected',
   'elementos distintos: uma linha de árvore nunca é um cartão de início rápido'],
  ['.file-tree-row.is-selected|.icon-cell.is-selected',
   'elementos distintos: uma linha de árvore nunca é uma célula de ícone'],
  ['.file-tree-actions .ghost-btn|.git-file-actions .ghost-btn',
   'elementos distintos: containers diferentes'],
  ['.file-tree-actions .ghost-btn|.code-editor-actions .ghost-btn',
   'elementos distintos: containers diferentes'],
  ['.data-table-actions .ghost-btn|.file-tree-actions .ghost-btn',
   'elementos distintos: containers diferentes'],
  ['.data-table-actions .ghost-btn|.code-editor-actions .ghost-btn',
   'elementos distintos: containers diferentes'],
  ['.data-table-actions .ghost-btn|.git-file-actions .ghost-btn',
   'elementos distintos: containers diferentes'],
  ['.image-node-actions .ghost-btn|.data-table-actions .ghost-btn',
   'elementos distintos: containers diferentes'],
  ['.image-node-actions .ghost-btn|.file-tree-actions .ghost-btn',
   'elementos distintos: containers diferentes'],
  ['.image-node-actions .ghost-btn|.code-editor-actions .ghost-btn',
   'elementos distintos: containers diferentes'],
  ['.image-node-actions .ghost-btn|.git-file-actions .ghost-btn',
   'elementos distintos: containers diferentes'],
  ['.git-actions .btn|.git-popover-row .btn',
   'elementos distintos: containers diferentes'],
  ['.file-tree.is-empty|.code-editor.is-empty',
   'elementos distintos: a árvore vazia não é o editor vazio'],
  ['.theme-preview.is-add|.role-card.is-add',
   'elementos distintos: prévia de tema não é cartão de responsabilidade'],
  ['.canvas-chip.is-open|.rail-btn.is-open',
   'elementos distintos: o chip do workspace não é um botão da rail'],
  ['.dock-btn.is-open|.rail-btn.is-open',
   'elementos distintos: um botão está na dock ou na rail, nunca nos dois — mas o par é INTENCIONAL, é o mesmo estado "menu aberto" com a mesma aparência nas duas pílulas'],
  ['.ghost-btn.is-active|.workspace-item.is-active',
   'elementos distintos: o botão fantasma não é o item da lista'],
  ['.ghost-btn.is-active|.git-tab.is-active',
   'elementos distintos'],
  ['.workspace-item.is-active|.git-tab.is-active',
   'elementos distintos'],
  ['.quick-card.is-selected|.icon-cell.is-selected', 'elementos distintos'],
  ['.quick-card.is-selected|.theme-card.is-selected', 'elementos distintos'],
  ['.quick-card.is-selected|.role-card.is-selected', 'elementos distintos'],
  ['.icon-cell.is-selected|.theme-card.is-selected', 'elementos distintos'],
  ['.icon-cell.is-selected|.role-card.is-selected', 'elementos distintos'],
  ['.icon-cell.is-selected|.file-tree-row.is-selected', 'elementos distintos'],
  ['.theme-card.is-selected|.role-card.is-selected', 'elementos distintos'],
  ['.git-branch-menu > button.is-current|.git-popover-branches button.is-current',
   'elementos distintos: menus diferentes'],
  ['.git-feedback.is-error|.git-popover-feedback.is-error', 'elementos distintos'],
  ['.node.is-connect-target|.node.is-chromeless',
   'PODEM coexistir — é o par que fixa a ordem canvas→nodes (ver ESPERADA)']
]).map(([par, motivo]) => [par.split('|').sort().join('|'), motivo]))

let falhas = 0
const fail = (m) => { console.error(`  ✗ ${m}`); falhas++ }

// ── 1. ordem dos imports ─────────────────────────────────────────────────────
const entrada = readFileSync(join(root, 'src/renderer/styles.css'), 'utf8')
const areas = [...entrada.matchAll(/@import '\.\/styles\/([\w-]+(?:\/[\w-]+)?)\.css';/g)]
  .map((m) => m[1])
  .filter((n) => !['tokens', 'base', 'primitives'].includes(n))

const esperada = ESPERADA.map(([n]) => n)
if (areas.join(',') !== esperada.join(',')) {
  fail(`ordem dos @import mudou.\n     esperada: ${esperada.join(' → ')}\n     achada:   ${areas.join(' → ')}`)
  for (const [n, por] of ESPERADA) console.error(`       ${n}: ${por}`)
} else {
  console.log(`  ✓ ordem dos @import: ${areas.join(' → ')}`)
}

// ── 2. pares novos cruzando arquivos ────────────────────────────────────────
const spec = (s) => [
  (s.match(/#/g) || []).length,
  (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length,
  (s.match(/(?:^|[\s>+~])[a-z][\w-]*/g) || []).length
].join('.')
const classesDe = (s) => new Set([...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1]))

const regras = []
for (const area of areas) {
  const css = readFileSync(join(dir, `${area}.css`), 'utf8')
  for (const m of css.matchAll(/(^|\})\s*([^{}@/][^{}]*?)\{([^{}]*)\}/gm)) {
    const props = new Set(
      m[3].split(';').filter((d) => d.includes(':')).map((d) => d.split(':')[0].trim())
    )
    for (const sel of m[2].split(',')) regras.push({ area, sel: sel.trim(), props })
  }
}

const novos = []
for (let i = 0; i < regras.length; i++) {
  for (let j = i + 1; j < regras.length; j++) {
    const a = regras[i], b = regras[j]
    if (a.area === b.area || a.sel === b.sel) continue
    if (spec(a.sel) !== spec(b.sel)) continue
    const compartilha = [...classesDe(a.sel)].some((c) => classesDe(b.sel).has(c))
    if (!compartilha) continue
    if (![...a.props].some((p) => b.props.has(p))) continue
    const chave = [a.sel, b.sel].sort().join('|')
    if (!CONHECIDOS.has(chave)) novos.push(`${chave}  (${a.area} × ${b.area})`)
  }
}
const unicos = [...new Set(novos)]
for (const n of unicos) {
  fail(`par novo de mesma especificidade cruzando arquivos: ${n}\n     Decida se caem no mesmo elemento. Se não, some em CONHECIDOS com o motivo.`)
}
if (!unicos.length) console.log(`  ✓ nenhum par novo cruzando arquivos (${CONHECIDOS.size} já julgados)`)

if (falhas) { console.error(`\ntest-css-order: ${falhas} falha(s)`); process.exit(1) }
console.log('test-css-order: ok')
