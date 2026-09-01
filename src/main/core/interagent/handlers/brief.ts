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
import { artisanDoctrine } from '../artisan-doctrine'
import { artisanContextFor } from './artesao'
import { connectedNodes, requireTerminalId, workspaceForTerminal } from './context'

const EMPTY = [
  'Atelier canvas brief: nothing wired to this node yet.',
  'Connect this terminal to another node on the canvas first.'
].join('\n')

export function handleBrief(_args: string[], terminalId: UUID | null): string {
  const tid = requireTerminalId(terminalId)
  if (!tid) return EMPTY

  const inventory = renderInventory(connectedNodes(tid))
  if (!isArtisanCaller(tid)) return inventory

  return [inventory, '', artisanDoctrine(artisanContextFor(tid))].join('\n')
}

function isArtisanCaller(tid: UUID): boolean {
  const node = workspaceForTerminal(tid)?.node(tid)
  return !!node && node.content.type === 'terminal' && node.content.value.isArtisan
}

function renderInventory(nodes: CanvasNode[]): string {
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

  const tables = nodes.filter((n) => n.content.type === 'dataTable')
  if (tables.length > 0) {
    lines.push('', `Tables: ${names(tables)}`)
    lines.push('  atelier table list')
  }

  const boards = nodes.filter((n) => n.content.type === 'widget' && n.content.value.kind === 'todo')
  if (boards.length > 0) {
    lines.push('', `Boards: ${names(boards)}`)
    lines.push('  atelier todo list')
  }

  return lines.join('\n')
}
