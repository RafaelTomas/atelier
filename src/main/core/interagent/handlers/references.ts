/**
 * A REFERÊNCIA de um nó: o ponteiro que o agente precisa para chegar na coisa.
 *
 * Uma regra, aplicada nó a nó: **o nó entrega o ponteiro, o agente lê o alvo.**
 * A árvore diz o caminho da raiz; a imagem, onde o arquivo está; a tabela, onde
 * o JSON com as linhas está; o painel de git, qual repositório observa. Ler,
 * varrer e abrir são as ferramentas do próprio agente, que são melhores do que
 * qualquer coisa que caberia no socket deste CLI.
 *
 * Conteúdo só vem por verbo próprio, e só nos dois casos em que ele NÃO está em
 * disco (o buffer sujo do editor, a tela de outro agente) ou em que ele é o
 * ponto inteiro do nó (a nota, o quadro). O resto é ponteiro.
 *
 * Nada daqui é gravado no conteúdo do nó — tudo é derivado na leitura. Campo
 * extra em `FileTreeContent` e companhia é descartado na releitura, aqui e no
 * app nativo Swift (ver o comentário de `CodeEditorContent` em shared/types).
 *
 * Consumido por `handlers/list.ts` e `handlers/brief.ts`, que são os dois
 * inventários. Módulo separado porque duas cópias da resolução divergiriam, e
 * divergir aqui faz um dos dois mentir.
 */
import { join } from 'node:path'
import { buttonActionSummary, readButtonConfig, type CanvasNode, type UUID } from '@shared/types'
import { alarmIsArmed, readClockConfig } from '@shared/clock'
import { describeMode } from './clock'
import { paths } from '../../persistence/paths'
import { projectIndex } from '../../state/project-store'
import { selectedProject } from '../../state/selection-registry'
import type { WorkspaceManager } from '../../state/workspace-manager'

/** Períodos aceitos em `view.interval` — espelha readInterval do renderer. */
const DEFAULT_MONITOR_INTERVAL_MS = 2000

/**
 * O caminho do arquivo gerenciado de um nó de imagem ou tabela.
 *
 * Os bytes da imagem moram em `workspaces/<ws>/images/<file>` e as linhas da
 * tabela em `workspaces/<ws>/tables/<file>` desde que os dois tipos existem —
 * só nunca tinham sido DITOS ao agente, que recebia dimensões e contagens e
 * nenhum jeito de chegar no dado. É o caminho que faz `image` e `dataTable`
 * cumprirem a regra sem precisarem de verbo de leitura.
 *
 * `null` quando o nó ainda não tem arquivo (imagem criada sem bytes, tabela
 * criada vazia): dizer um caminho que não existe é pior do que não dizer.
 */
export function managedFilePath(ws: WorkspaceManager, node: CanvasNode): string | null {
  if (node.content.type === 'image') {
    const file = node.content.value.fileName
    return file ? join(paths.imagesDir(ws.id), file) : null
  }
  if (node.content.type === 'dataTable') {
    const file = node.content.value.fileName
    return file ? join(paths.tablesDir(ws.id), file) : null
  }
  return null
}

/**
 * O projeto que um widget observa, resolvido.
 *
 * `projectId` não-nulo é a exceção EXPLÍCITA — um painel fixado num repositório
 * (`types.ts:301`). `null` é o padrão e significa "segue a seleção da
 * aplicação", que mora na store do renderer e chega aqui pelo espelho de
 * `selection-registry`. A mesma resolução que o `GitPanel` faz na tela
 * (`panels/git-panel.tsx:30`), pela mesma razão de sempre: duas cópias da regra
 * divergiriam, e aqui a divergência faria o agente trabalhar no repo errado.
 */
function watchedProject(node: CanvasNode): { path: string; branch: string | null; pinned: boolean } | null {
  if (node.content.type !== 'widget') return null
  const pinned = node.content.value.projectId
  const id: UUID | null = pinned ?? selectedProject()
  if (!id) return null
  const project = projectIndex.all.find((p) => p.id === id)
  if (!project) return null
  return { path: project.path, branch: project.gitBranch ?? null, pinned: pinned !== null }
}

/**
 * O volume que um painel de monitor observa.
 *
 * `view.disk` vazio significa o `workingDirectory` do workspace — é o que o
 * painel documenta (`monitor-panel.tsx:43`) e o que o main já usa ao amostrar.
 * Imprimimos o caminho EFETIVO, resolvido: uma string vazia no inventário não é
 * uma referência, é uma lacuna com aparência de resposta.
 */
function watchedVolume(ws: WorkspaceManager, node: CanvasNode): string | null {
  if (node.content.type !== 'widget') return null
  const disk = node.content.value.view.disk?.trim()
  return disk || ws.payload.workingDirectory || null
}

function monitorInterval(node: CanvasNode): number {
  if (node.content.type !== 'widget') return DEFAULT_MONITOR_INTERVAL_MS
  const raw = Number(node.content.value.view.interval)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MONITOR_INTERVAL_MS
}

/**
 * A referência de um nó em UMA linha, ou `null` quando o tipo não tem ponteiro
 * a dar (terminal, nota, quadro, cofre — esses entregam por verbo próprio).
 *
 * `null` também para o painel cuja referência não pôde ser resolvida; quem
 * imprime decide o texto da ausência, porque a frase honesta depende do tipo:
 * um painel de git sem projeto selecionado não é a mesma lacuna de uma imagem
 * sem arquivo.
 */
export function nodeReference(ws: WorkspaceManager, node: CanvasNode): string | null {
  switch (node.content.type) {
    case 'fileTree':
      return node.content.value.rootPath || null
    case 'codeEditor':
      return node.content.value.filePath || null
    case 'text':
      return node.content.value.text.trim() || null
    case 'image':
    case 'dataTable':
      return managedFilePath(ws, node)
    case 'widget':
      return widgetReference(ws, node)
    default:
      return null
  }
}

/**
 * A referência de cada painel — a resposta para "o que este widget me dá".
 *
 * Os três painéis não têm verbo, e é de propósito: o agente roda `git`, `df` e
 * `top` no shell dele muito melhor do que qualquer verbo que caberia aqui. O
 * que ele não tem como descobrir sozinho é EM QUE repositório e EM QUE volume o
 * usuário está olhando — e isso é uma linha.
 */
function widgetReference(ws: WorkspaceManager, node: CanvasNode): string | null {
  if (node.content.type !== 'widget') return null
  switch (node.content.value.kind) {
    case 'git': {
      const p = watchedProject(node)
      if (!p) return 'no project selected — ask the user which repo this panel should watch'
      const how = p.pinned ? 'pinned' : 'follows the app selection'
      return `${p.path}${p.branch ? `  (branch ${p.branch})` : ''}  [${how}]`
    }
    case 'projects': {
      const p = watchedProject(node)
      if (!p) return 'follows the app selection — nothing selected right now'
      return p.pinned ? `${p.path}  [pinned]` : `${p.path}  [follows the app selection]`
    }
    case 'monitor': {
      const volume = watchedVolume(ws, node)
      const every = `every ${Math.round(monitorInterval(node) / 1000)}s`
      return volume ? `volume ${volume}  (${every})` : `this machine  (${every})`
    }
    // Botão e relógio já tinham verbo, e nenhuma linha no inventário: um agente
    // que só leu o brief não sabia que existia um botão no canvas. O que sai
    // aqui é a MESMA frase do verbo próprio, pela razão de sempre — duas
    // descrições do mesmo nó divergiriam.
    case 'button': {
      const config = readButtonConfig(node.content.value.view)
      const state = config.pending ? 'pending' : 'armed'
      return `[${config.action}] ${buttonActionSummary(config)}  (${state}${config.unattended ? ', unattended' : ''})`
    }
    case 'clock': {
      const config = readClockConfig(node.content.value.view)
      const state = config.mode === 'alarm' ? (alarmIsArmed(config) ? 'armed' : 'disarmed') : null
      return `${describeMode(config)}${state ? `  (${state})` : ''}`
    }
    default:
      // O quadro de TODO fica fora: o que ele entrega não é ponteiro, é a
      // contagem por coluna, e quem imprime já a monta lendo o arquivo.
      return null
  }
}
