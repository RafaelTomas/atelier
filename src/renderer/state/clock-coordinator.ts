/**
 * O coordenador dos relógios do canvas: UM timeout para todos, nenhum tique na
 * store.
 *
 * Inspirado no amostrador único do monitor (`use-system-stats.ts`) e na escrita
 * direta de `connections-layer.tsx`, e pelas mesmas razões.
 *
 * O que ele NÃO faz, e por quê:
 *
 *  - **Nada de `setInterval` por nó.** Dez relógios no canvas seriam dez
 *    timers, dez reconciliações e dez re-renders por segundo. Aqui é um
 *    `setTimeout` de uma execução, alinhado ao próximo segundo ou ao deadline
 *    mais próximo — o que vier antes.
 *  - **Nada de `store.set()` por tique.** A store notifica TODOS os assinantes,
 *    o canvas incluído: um tique ali re-renderizaria a árvore de nós inteira
 *    por causa de alguns caracteres de um mostrador. O tique escreve DIRETO nos
 *    elementos, por refs guardadas na montagem.
 *  - **Nada de `useState(now)` no widget.** React isolaria parte do trabalho,
 *    mas ainda criaria um timer e uma reconciliação por widget.
 *
 * O que ele faz com a store é raro e semântico: persistir um checkpoint quando
 * um timer termina ou uma fase vira, e executar o botão ligado por cabo.
 *
 * **A virtualização não pode desarmar um timer com ação conectada.** Por isso a
 * AGENDA pertence ao workspace aberto, e não à presença do componente no DOM: um
 * relógio fora do viewport não tem widget montado, continua contando e continua
 * disparando. A montagem só registra para onde ESCREVER.
 */
import type { CanvasNode, Connection, UUID } from '@shared/types'
import type { ClockConfig } from '@shared/clock'
import { SEGMENT_ATTR, segmentMarkup } from '../nodes/seven-segment'
import {
  clockProgress,
  formatClockTime,
  formatDuration,
  formatStopwatch,
  nextWakeMs,
  pomodoroRemainingMs,
  readClockConfig,
  reconcile,
  stopwatchElapsedMs,
  timerRemainingMs,
  writeClockConfig
} from '@shared/clock'

/**
 * Os três elementos que mudam a cada segundo, achados UMA vez na montagem.
 *
 * Uma consulta ao DOM por tique e por nó seria trabalho repetido para responder
 * sempre a mesma coisa; guardá-los aqui é o equivalente de ref do que o widget
 * marcou com `data-clock-*`.
 */
interface ClockRefs {
  container: HTMLElement
  readout: HTMLElement | null
  detail: HTMLElement | null
  progress: HTMLElement | null
}

/** O que o coordenador precisa da store, injetado para o módulo continuar testável. */
export interface ClockHost {
  /** Persiste o checkpoint novo. Raro: só em transição semântica. */
  patchView(nodeId: UUID, view: Record<string, string>): Promise<void>
  /** Executa o botão pelo MESMO núcleo do clique, com origem explícita. */
  runButton(nodeId: UUID, opts: { origin: 'clock' }): Promise<boolean>
  /** Pulso visual no cabo. Runtime puro — não vai para o disco. */
  setConnectionStatus(connectionId: UUID, status: 'idle' | 'communicating' | 'error'): void
  notice(text: string): void
}

/** Quanto tempo o cabo fica pulsando depois de um disparo. */
const PULSE_MS = 1400

interface ClockEntry {
  config: ClockConfig
  /** O `view` cru do nó: é ele que carrega as chaves desconhecidas no save. */
  view: Record<string, string>
  /** O botão ligado por cabo, e o cabo. null = este relógio não dispara nada. */
  target: { buttonNodeId: UUID; connectionId: UUID } | null
}

export class ClockCoordinator {
  private host: ClockHost | null = null
  private workspaceId: UUID | null = null
  private entries = new Map<UUID, ClockEntry>()
  private refs = new Map<UUID, ClockRefs>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private pulses = new Map<UUID, ReturnType<typeof setTimeout>>()

  /**
   * A identidade do último evento tratado, por nó.
   *
   * Em memória de propósito: o checkpoint persistido (`firedGeneration` /
   * `firedSequence`) é a verdade que sobrevive ao fechamento, e este mapa só
   * cobre a janela entre um tique e o seguinte — quando um `patchView` ainda
   * está a caminho e o tique já poderia ler o `view` antigo.
   */
  private handled = new Map<UUID, string>()

  /**
   * O primeiro cálculo de um workspace recém-aberto reconcilia SEM disparar.
   *
   * Não é sobre duração: é sobre se havia processo e intenção de automação
   * quando o tempo passou. Um timer que venceu com o app fechado reabre em
   * `finished` e não roda o comando; um que vence com o Atelier aberto —
   * inclusive atravessando uma suspensão da máquina — dispara.
   */
  private live = false

  attach(host: ClockHost): void {
    this.host = host
  }

  /**
   * A lista de relógios e de cabos do workspace. Chamado a cada mudança do
   * workspace na store — barato, porque só reindexa.
   *
   * Trocar de workspace CANCELA a agenda anterior e zera o que foi tratado: os
   * ids do canvas anterior não têm mais o que agendar nem o que disparar.
   */
  setWorkspace(workspaceId: UUID | null, nodes: CanvasNode[], connections: Connection[]): void {
    if (workspaceId !== this.workspaceId) {
      this.workspaceId = workspaceId
      this.handled.clear()
      this.refs.clear()
      this.live = false
    }

    const cables = new Map<UUID, { buttonNodeId: UUID; connectionId: UUID }>()
    for (const conn of connections) {
      if (conn.kind !== 'clockAction') continue
      // A orientação é canônica desde o WorkspaceManager: o relógio é sempre o
      // lado A. Confiar nela aqui é o que permite uma consulta só.
      cables.set(conn.nodeIdA, { buttonNodeId: conn.nodeIdB, connectionId: conn.id })
    }

    const next = new Map<UUID, ClockEntry>()
    for (const node of nodes) {
      if (node.content.type !== 'widget' || node.content.value.kind !== 'clock') continue
      const view = node.content.value.view
      next.set(node.id, {
        config: readClockConfig(view),
        view,
        target: cables.get(node.id) ?? null
      })
    }
    this.entries = next

    if (!workspaceId || next.size === 0) {
      this.cancel()
      return
    }
    this.tick()
  }

  /** O widget montou. Só registra PARA ONDE escrever — a agenda não é dele. */
  register(nodeId: UUID, container: HTMLElement | null): void {
    if (!container) return
    this.refs.set(nodeId, {
      container,
      readout: container.querySelector<HTMLElement>('[data-clock-readout]'),
      detail: container.querySelector<HTMLElement>('[data-clock-detail]'),
      progress: container.querySelector<HTMLElement>('[data-clock-progress]')
    })
    // Um nó que acabou de aparecer no viewport não pode esperar até o próximo
    // segundo para mostrar um número: ele nasceria em branco.
    const entry = this.entries.get(nodeId)
    if (entry) this.paint(nodeId, entry.config, Date.now())
  }

  /**
   * O widget desmontou (culling do viewport, ou o nó saiu). Some o destino da
   * escrita — NÃO a contagem nem o disparo, que continuam aqui.
   */
  unregister(nodeId: UUID): void {
    this.refs.delete(nodeId)
  }

  /**
   * A máquina voltou de uma suspensão, ou a janela voltou ao foco.
   *
   * Aqui o processo e a intenção de automação continuaram vivos, então este é o
   * caminho que DISPARA: um timer que atravessou zero gera um evento; um
   * pomodoro que atravessou várias fronteiras gera um só, coalescido.
   *
   * Depender de o próximo `setTimeout` eventualmente acordar funciona na
   * maioria das máquinas, mas deixaria a reconciliação refém do comportamento
   * do Chromium em cada plataforma — daí o sinal explícito do `powerMonitor`,
   * com `focus`/`visibilitychange` como guardas adicionais.
   */
  resume(): void {
    if (!this.workspaceId) return
    this.tick()
  }

  /** Troca de workspace e unload: nada de timer sobrevivendo ao canvas. */
  dispose(): void {
    this.cancel()
    for (const timer of this.pulses.values()) clearTimeout(timer)
    this.pulses.clear()
    this.entries.clear()
    this.refs.clear()
    this.handled.clear()
    this.workspaceId = null
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Um tique: reconciliar, disparar o que precisa, pintar, reagendar.
   *
   * O callback pode chegar tarde — o event loop estava ocupado, a máquina
   * dormiu. Isso não importa: ele lê `Date.now()` de novo e cada valor é
   * derivado do relógio absoluto, então um atraso de 380 ms desenha o valor
   * certo em vez de carregar 380 ms de erro para o resto da sessão.
   */
  private tick = (): void => {
    this.cancel()
    const now = Date.now()
    const live = this.live
    // A partir daqui o processo está vivo: só o PRIMEIRO cálculo de um
    // workspace recém-aberto é retroativamente mudo.
    this.live = true

    let soonest: number | null = null
    for (const [nodeId, entry] of this.entries) {
      const result = reconcile(entry.config, now, { live })
      if (result.changed) {
        entry.config = result.config
        // O checkpoint vai para o disco ANTES de a ação rodar. Se o app cair na
        // janela estreita entre as duas coisas, a ação se perde — execução no
        // MÁXIMO uma vez, e não "pelo menos uma vez". Repetir um comando, um
        // prompt ou uma URL de efeito externo é o risco maior dos dois.
        const view = writeClockConfig(result.config, entry.view)
        entry.view = view
        void this.host?.patchView(nodeId, view)
      }
      if (result.event) {
        const identity = `${result.event.kind}:${result.event.generation}:${result.event.sequence}`
        if (this.handled.get(nodeId) !== identity) {
          this.handled.set(nodeId, identity)
          void this.fire(nodeId, entry)
        }
      }

      this.paint(nodeId, entry.config, now)

      const wake = nextWakeMs(entry.config, now)
      if (wake !== null && (soonest === null || wake < soonest)) soonest = wake
    }

    if (soonest === null) return
    // Piso de 16 ms: um `soonest` de 0 (deadline exatamente agora, ou relógio
    // do sistema que saltou) faria o timeout reentrar sem folga nenhuma.
    this.timer = setTimeout(this.tick, Math.max(16, soonest))
  }

  /**
   * O disparo. Passa pelo MESMO executor do clique, com origem explícita — o
   * botão continua sendo o único dono das três ações, das regras de alvo, de
   * diretório, de aceite e de erro.
   */
  private async fire(clockNodeId: UUID, entry: ClockEntry): Promise<void> {
    const host = this.host
    const target = entry.target
    // Relógio sem cabo é o caso comum: ele conta e não dispara nada.
    if (!host || !target) return

    const pulse = (status: 'communicating' | 'error'): void => {
      host.setConnectionStatus(target.connectionId, status)
      const previous = this.pulses.get(target.connectionId)
      if (previous) clearTimeout(previous)
      this.pulses.set(
        target.connectionId,
        setTimeout(() => {
          this.pulses.delete(target.connectionId)
          host.setConnectionStatus(target.connectionId, 'idle')
        }, status === 'error' ? 4000 : PULSE_MS)
      )
    }

    pulse('communicating')
    // `runButton` recusa sozinho um botão pendente ou com confirmação vindo
    // daqui: disparar sem a confirmação burlaria a promessa da configuração, e
    // abrir um diálogo no relógio quando o usuário pode estar longe não seria
    // automação. O evento é suprimido e o cabo entra em erro — a ação NÃO fica
    // enfileirada para disparar inesperadamente mais tarde.
    const ok = await host.runButton(target.buttonNodeId, { origin: 'clock' })
    if (!ok) pulse('error')
    void clockNodeId
  }

  /**
   * A escrita visual. Texto, progresso e atributo acessível, direto no elemento.
   *
   * O trabalho continua O(n) nos relógios VISÍVEIS — cada mostrador precisa
   * trocar seus caracteres —, mas não há n timers, n pushes de IPC nem render do
   * canvas. Pan e zoom seguem no caminho imperativo que já usam.
   */
  private paint(nodeId: UUID, config: ClockConfig, now: number): void {
    const refs = this.refs.get(nodeId)
    if (!refs) return
    // O nó pode ter sido desmontado entre o registro e este tique (culling no
    // meio de um pan). Escrever num elemento solto é trabalho jogado fora.
    if (!refs.container.isConnected) {
      this.refs.delete(nodeId)
      return
    }

    const { readout, detail } = readoutFor(config, now)
    if (refs.readout && refs.readout.dataset.clockValue !== readout) {
      // O valor vai para um `data-`, e não é lido de volta do texto: num
      // mostrador de sete segmentos o conteúdo é SVG, e `textContent` não
      // descreveria mais o que está na tela. Comparar contra o `data-` mantém a
      // escrita ociosa fora do caminho nos dois modos de pintura.
      refs.readout.dataset.clockValue = readout
      // Quem manda no formato é o ELEMENTO, não o coordenador: um readout que
      // pede segmentos recebe segmentos, e qualquer outro continua recebendo
      // texto. Assim o mostrador pode mudar de desenho sem mexer aqui.
      if (refs.readout.hasAttribute(SEGMENT_ATTR)) {
        refs.readout.innerHTML = segmentMarkup(readout)
      } else {
        refs.readout.textContent = readout
      }
      // O mostrador é `role="timer"` com `aria-live="off"`: um leitor de tela
      // que anunciasse cada segundo seria inutilizável. O texto acessível
      // acompanha o visível para quem consultar o nó sob demanda — e num
      // mostrador de segmentos ele é a ÚNICA leitura possível, já que o SVG é
      // `aria-hidden`.
      refs.readout.setAttribute('aria-label', `${readout}${detail ? `, ${detail}` : ''}`)
    }
    if (refs.detail && refs.detail.textContent !== detail) refs.detail.textContent = detail

    if (refs.progress) {
      const progress = clockProgress(config, now)
      if (progress === null) {
        refs.progress.style.width = ''
        refs.progress.removeAttribute('aria-valuenow')
      } else {
        const pct = Math.round(progress * 100)
        refs.progress.style.width = `${pct}%`
        refs.progress.setAttribute('aria-valuenow', String(pct))
      }
    }
  }
}

/**
 * O que o mostrador diz, derivado de `now` e do checkpoint. Exportado porque o
 * widget precisa do MESMO texto no primeiro render — dois cálculos diferentes
 * fariam o nó piscar um valor errado até o primeiro tique.
 */
export function readoutFor(
  config: ClockConfig,
  now: number
): { readout: string; detail: string } {
  switch (config.mode) {
    case 'stopwatch': {
      const laps = config.stopwatch.laps.length
      return {
        readout: formatStopwatch(stopwatchElapsedMs(config, now)),
        detail: laps > 0 ? `${laps} ${laps === 1 ? 'volta' : 'voltas'}` : ''
      }
    }
    case 'timer': {
      const remaining = timerRemainingMs(config, now)
      return {
        readout: formatDuration(remaining),
        detail:
          config.timer.state === 'finished'
            ? 'terminou'
            : config.timer.state === 'paused'
              ? 'pausado'
              : ''
      }
    }
    case 'pomodoro': {
      const p = config.pomodoro
      const fase = p.phase === 'focus' ? 'foco' : 'pausa'
      const ciclos = p.cycles === 1 ? '1 ciclo' : `${p.cycles} ciclos`
      return {
        readout: formatDuration(pomodoroRemainingMs(config, now)),
        detail: `${fase} · ${ciclos}`
      }
    }
    default:
      return { readout: formatClockTime(now, config.hour12), detail: '' }
  }
}

/**
 * Um por janela. Como o `viewport`, é um singleton de módulo: o canvas é um só,
 * e passar a instância por contexto até o nó só acrescentaria cerimônia.
 */
export const clockCoordinator = new ClockCoordinator()
