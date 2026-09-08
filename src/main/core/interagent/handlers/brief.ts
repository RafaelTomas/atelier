/**
 * `atelier brief` — o hook `SessionStart` de TODO nó Claude Code (ver
 * terminal/agent-settings.ts), não só o Artesão, e também o que
 * `ATELIER_BRIEF` aponta no ambiente de TODO PTY (ver
 * terminal/terminal-manager.ts, função `buildTerminalEnv`).
 *
 * FORA de `COMMANDS` no roteador, pelo mesmo motivo do `statusline` e do
 * `artesao` (cli-router.ts:65): quem chama é o próprio Atelier — pelo hook, ou
 * gravando o arquivo no boot do PTY — não é um verbo que um agente digita.
 *
 * ─── O que resolve (G1 do plano de aderência) ───
 *
 * Hoje um nó comum não recebe NADA no boot: três idas e voltas (disparar a
 * skill, ler o manual, rodar `atelier list`) até a primeira ação útil. Este
 * verbo devolve o INVENTÁRIO do que está cabeado — nomes e o verbo que abre
 * cada um — pronto para entrar no contexto da primeira mensagem, sem o agente
 * ter que pedir nada.
 *
 * ─── A doutrina do Artesão é um bloco, não um texto concorrente ───
 *
 * Quando o nó chamador é Artesão, a doutrina completa (`artisanDoctrine()`, a
 * MESMA de `atelier artesao brief`) entra DEPOIS do inventário. Um Artesão
 * continua recebendo a doutrina inteira que recebia antes — o inventário
 * genérico não a substitui, só a antecede.
 *
 * ─── Teto de tamanho ───
 *
 * Sem Artesão, a resposta não passa de ~30 linhas num canvas típico: cada
 * grupo cabeado é UMA linha de nomes e UMA linha de verbo, e um grupo vazio
 * simplesmente não aparece — nada de "Agents: (none)". Um canvas sem nada
 * cabeado sai em 2 linhas. O teto NÃO vale para o bloco do Artesão: a doutrina
 * completa é requisito, não detalhe (ver artisan-doctrine.ts).
 */
import type { CanvasNode, UUID } from '@shared/types'
import { nodeDisplayName } from '../../models/node-content'
import type { WorkspaceManager } from '../../state/workspace-manager'
import { artisanDoctrine } from '../artisan-doctrine'
import { artisanContextFor } from './artesao'
import { connectedNodes, requireTerminalId, workspaceForTerminal } from './context'
import { nodeReference } from './references'

/** Os painéis de leitura global — sem verbo, só referência. */
const PANEL_KINDS = new Set(['git', 'monitor', 'projects'])
/** Botão e relógio: têm verbo próprio, mas nunca apareciam no inventário. */
const GADGET_KINDS = new Set(['button', 'clock'])

const EMPTY = [
  'Atelier canvas brief: nothing wired to this node yet.',
  'Connect this terminal to another node on the canvas first.'
].join('\n')

/**
 * A regra do canvas, para TODO nó — o Artesão recebe a doutrina inteira em
 * lugar dela, e diz a mesma coisa com mais palavras.
 *
 * Três linhas, e elas custam contexto em toda sessão: entraram porque um nó
 * comum, com uma tarefa de canvas na mão, abriu um `Agent(fork)` para executá-la
 * (01/09, sujeito do eval). O trabalho aconteceu numa sessão que não é a dele,
 * sem nó na tela — e a mesma frase que explica por que o Artesão não faz isso
 * vale para qualquer nó. O hook `PreToolUse` recusa de fato; isto é o que evita
 * o agente descobrir a recusa gastando um turno.
 */
const CANVAS_RULE = [
  'Delegation on this canvas is a NODE, never an internal subagent: the Task tool',
  'is denied in this terminal. A node has a face — the user watches it, interrupts',
  'it, and picks it up after a crash. Need help? atelier recruit "Name" --model haiku'
].join('\n')

export function handleBrief(_args: string[], terminalId: UUID | null): string {
  const tid = requireTerminalId(terminalId)
  if (!tid) return EMPTY

  const inventory = renderInventory(connectedNodes(tid), workspaceForTerminal(tid))
  if (!isArtisanCaller(tid)) return [inventory, '', CANVAS_RULE].join('\n')

  return [inventory, '', artisanDoctrine(artisanContextFor(tid))].join('\n')
}

function isArtisanCaller(tid: UUID): boolean {
  const node = workspaceForTerminal(tid)?.node(tid)
  return !!node && node.content.type === 'terminal' && node.content.value.isArtisan
}

function renderInventory(nodes: CanvasNode[], ws: WorkspaceManager | null): string {
  if (nodes.length === 0) return EMPTY

  const lines: string[] = ['Atelier canvas brief — wired to this node:']
  const names = (group: CanvasNode[]): string => group.map((n) => nodeDisplayName(n.content)).join(', ')

  const agents = nodes.filter((n) => n.content.type === 'terminal')
  if (agents.length > 0) {
    lines.push('', `Agents: ${names(agents)}`)
    lines.push('  atelier ask "Name" "the task"    atelier check "Name" 40')
  }

  const notes = nodes.filter((n) => n.content.type === 'stickyNote')
  if (notes.length > 0) {
    lines.push('', `Notes: ${names(notes)}`)
    lines.push('  atelier note read "Name"')
  }

  const portals = nodes.filter((n) => n.content.type === 'portal')
  if (portals.length > 0) {
    lines.push('', `Portals: ${names(portals)}`)
    lines.push('  atelier portal read "Name"')
  }

  // Editores levam o CAMINHO ABSOLUTO, um por linha — é o dado que destrava as
  // ferramentas de arquivo do próprio agente. Ver o mesmo raciocínio em
  // handlers/list.ts.
  const editors = nodes.filter((n) => n.content.type === 'codeEditor')
  if (editors.length > 0) {
    lines.push('', 'Editors:')
    for (const n of editors) {
      const path = n.content.type === 'codeEditor' ? n.content.value.filePath : ''
      lines.push(`  ${nodeDisplayName(n.content)}  ${path}`)
    }
    lines.push('  atelier editor read "Name"    (edit the file with your own tools)')
  }

  const vaults = nodes.filter((n) => n.content.type === 'secretVault')
  if (vaults.length > 0) {
    lines.push('', `Vaults: ${names(vaults)}`)
    lines.push('  atelier vault list')
  }

  // A tabela leva o CAMINHO do JSON, um por linha, pela mesma razão do editor: é
  // o ponteiro que destrava as ferramentas do agente. `atelier table` não tem
  // verbo de leitura, e é este caminho que faz isso ser suficiente.
  const tables = nodes.filter((n) => n.content.type === 'dataTable')
  if (tables.length > 0) {
    lines.push('', 'Tables:')
    for (const n of tables) {
      const ref = ws ? nodeReference(ws, n) : null
      lines.push(`  ${nodeDisplayName(n.content)}  ${ref ?? '(no file yet)'}`)
    }
    lines.push('  atelier table list    (read the rows from that JSON yourself)')
  }

  // ─── Os que entregam a REFERÊNCIA ──────────────────────────────────────────
  //
  // Árvore, imagem, tabela, painel, botão, relógio e título: sete tipos que não
  // apareciam neste brief nem no `atelier list`. Um agente que só leu o brief
  // não sabia que havia um repositório, uma pasta ou um botão cabeado nele.
  //
  // A forma respeita o TETO deste arquivo (ver o cabeçalho): grupo vazio não
  // aparece, e cada nó é UMA linha com o ponteiro — nada de bloco por tipo com
  // linha de verbo, que é o que faria sete grupos novos dobrarem a resposta.
  const referenced: [string, CanvasNode[]][] = [
    ['Trees', nodes.filter((n) => n.content.type === 'fileTree')],
    ['Images', nodes.filter((n) => n.content.type === 'image')],
    ['Panels', nodes.filter((n) => n.content.type === 'widget' && PANEL_KINDS.has(n.content.value.kind))],
    ['Buttons & clocks', nodes.filter((n) => n.content.type === 'widget' && GADGET_KINDS.has(n.content.value.kind))],
    ['Text', nodes.filter((n) => n.content.type === 'text')]
  ]
  for (const [label, group] of referenced) {
    if (group.length === 0) continue
    lines.push('', `${label}:`)
    for (const n of group) {
      const ref = ws ? nodeReference(ws, n) : null
      lines.push(`  ${nodeDisplayName(n.content)}  ${ref ?? ''}`.trimEnd())
    }
  }
  if (referenced.some(([, g]) => g.length > 0)) {
    lines.push('  These give you a pointer, not their content — read the target with your own tools.')
  }

  const boards = nodes.filter((n) => n.content.type === 'widget' && n.content.value.kind === 'todo')
  if (boards.length > 0) {
    lines.push('', `Boards: ${names(boards)}`)
    // O exemplo leva o NOME do quadro, e leva um verbo que não é `list`.
    //
    // Ele mostrava `atelier todo list`, seco. Só que `list` é o único verbo que
    // aceita omitir o quadro, e o brief é a última coisa que o nó lê sobre
    // quadros antes de agir — nenhuma corrida do eval abriu a reference de
    // `todo`. Nos ciclos 2 e 3 as seis corridas do S4 foram para
    // `atelier todo move <id> doing`, sem o quadro, copiando a forma curta daqui;
    // cinco tentativas perdidas em seis corridas, e um critério junto no ciclo 2.
    //
    // O nome do primeiro quadro entra literal porque um exemplo com o nome de
    // verdade é copiável e um `"Board"` genérico convida a apagar o argumento.
    const first = nodeDisplayName(boards[0].content)
    lines.push(`  atelier todo list "${first}"`)
    lines.push(`  atelier todo move "${first}" <id> doing    (every verb but list needs the board)`)
  }

  return lines.join('\n')
}
