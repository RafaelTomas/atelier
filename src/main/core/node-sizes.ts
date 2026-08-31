/**
 * Piso e tamanho padrão de cada tipo de nó novo.
 *
 * Vivia dentro de bridge.ts, e saiu de lá por duas razões. A primeira é o
 * botão: o widget responde 240×180, tamanho de PAINEL, e um botão nasceria
 * quatro vezes maior do que é — então o tamanho deixou de ser função só do
 * tipo e passou a consultar os `opts`, que é a mesma consulta que `contentFor`
 * já fazia (o preço de o discriminador do widget morar no payload, e barato
 * comparado a uma subida de schemaVersion). A segunda é que bridge.ts importa
 * `electron`, e o smoke headless não pode importá-lo — aqui, o tamanho que o
 * `node:add` devolve fica testável.
 */
import { Constants } from './constants'

export type NewNodeKind =
  | 'terminal'
  | 'note'
  | 'text'
  | 'portal'
  | 'fileTree'
  | 'codeEditor'
  | 'dataTable'
  | 'image'
  | 'widget'
  | 'secretVault'

/** Um widget de kind `button` é um alvo de clique, não uma coluna. */
function isButton(opts: Record<string, unknown>): boolean {
  return opts.kind === 'button'
}

/**
 * O monitor é o segundo kind com tamanho próprio, e pela mesma razão do botão:
 * o padrão do widget (380×460) é medida de COLUNA de painel, e o monitor são
 * duas listas curtas empilhadas — nasceria com metade do nó vazia.
 *
 * O PISO continua o do widget: o monitor é um painel, e abaixo de 240×180 as
 * linhas do bloco IA não cabem.
 */
function isMonitor(opts: Record<string, unknown>): boolean {
  return opts.kind === 'monitor'
}

/** O quadro é mais LARGO que um painel: as colunas do kanban ficam lado a lado. */
function isTodo(opts: Record<string, unknown>): boolean {
  return opts.kind === 'todo'
}

/**
 * O relógio nasce COMPACTO, pela mesma razão do botão e do monitor: o padrão do
 * widget é medida de coluna de painel, e o mostrador com poucos controles
 * nasceria com metade do nó vazia. Tem piso próprio, mais baixo que o do widget.
 */
function isClock(opts: Record<string, unknown>): boolean {
  return opts.kind === 'clock'
}

/**
 * Piso por tipo. A área é desenhada pelo usuário, e um retângulo de 20px
 * criaria um terminal onde nem o cabeçalho cabe.
 */
export function minSize(
  kind: NewNodeKind,
  opts: Record<string, unknown> = {}
): { width: number; height: number } {
  switch (kind) {
    case 'terminal':
      return { width: Constants.terminalMinWidth, height: Constants.terminalMinHeight }
    case 'note':
      return { width: Constants.noteMinWidth, height: Constants.noteMinHeight }
    case 'portal':
      return { width: 240, height: 180 }
    case 'fileTree':
      return { width: 180, height: 140 }
    case 'codeEditor':
      return { width: 240, height: 160 }
    case 'dataTable':
      return { width: Constants.tableMinWidth, height: Constants.tableMinHeight }
    case 'image':
      return { width: Constants.imageMinWidth, height: Constants.imageMinHeight }
    case 'widget':
      if (isButton(opts))
        return { width: Constants.buttonMinWidth, height: Constants.buttonMinHeight }
      if (isClock(opts))
        return { width: Constants.clockMinWidth, height: Constants.clockMinHeight }
      return { width: Constants.widgetMinWidth, height: Constants.widgetMinHeight }
    case 'secretVault':
      return { width: Constants.vaultMinWidth, height: Constants.vaultMinHeight }
    case 'text':
      return { width: 80, height: 32 }
  }
}

export function defaultSize(
  kind: NewNodeKind,
  opts: Record<string, unknown> = {}
): { width: number; height: number } {
  switch (kind) {
    case 'terminal':
      return { width: 560, height: 360 }
    case 'note':
      return { width: Constants.noteDefaultWidth, height: Constants.noteDefaultHeight }
    case 'text':
      return { width: 240, height: 48 }
    case 'portal':
      return { width: 640, height: 440 }
    case 'fileTree':
      return { width: 300, height: 420 }
    case 'codeEditor':
      return { width: 620, height: 440 }
    case 'dataTable':
      return { width: Constants.tableDefaultWidth, height: Constants.tableDefaultHeight }
    case 'image':
      return { width: Constants.imageDefaultWidth, height: Constants.imageDefaultHeight }
    case 'widget':
      if (isButton(opts))
        return { width: Constants.buttonDefaultWidth, height: Constants.buttonDefaultHeight }
      if (isMonitor(opts))
        return { width: Constants.monitorDefaultWidth, height: Constants.monitorDefaultHeight }
      if (isTodo(opts))
        return { width: Constants.todoDefaultWidth, height: Constants.todoDefaultHeight }
      if (isClock(opts))
        return { width: Constants.clockDefaultWidth, height: Constants.clockDefaultHeight }
      return { width: Constants.widgetDefaultWidth, height: Constants.widgetDefaultHeight }
    case 'secretVault':
      return { width: Constants.vaultDefaultWidth, height: Constants.vaultDefaultHeight }
  }
}
