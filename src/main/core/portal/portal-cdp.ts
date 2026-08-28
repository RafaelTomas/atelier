/**
 * A sessão CDP de um Portal — o canal por onde o agente AGE na página.
 *
 * POR QUE CDP E NÃO `executeJavaScript('el.click()')` (Decisão A do
 * PLANO-controle-de-portal.md): um `.click()` de script é evento sintético, e
 * menu nativo, `<select>`, arrastar, canvas, Shadow DOM fechado e qualquer
 * componente que cheque `isTrusted` simplesmente não reagem.
 * `Input.dispatchMouseEvent` entra pelo mesmo lugar que o mouse do usuário — o
 * navegador não distingue. E, principalmente: nada da nossa string chega ao
 * contexto da origem. O CDP fala com o MOTOR do navegador, não com o JS da
 * página, e é isso que mantém a Decisão D do PLANO-portal.md de pé enquanto o
 * agente ganha braços.
 *
 * O DOMÍNIO `Runtime` FICA DESLIGADO, DE PROPÓSITO. É ele que traria
 * `Runtime.evaluate` — avaliação de expressão arbitrária numa sessão
 * autenticada, exatamente a superfície que este projeto não quer. Habilitamos
 * `DOM`, `Page` e `Accessibility`, e `Network` só dentro do `portal wait --idle`.
 *
 * ESTE ARQUIVO NÃO SABE O QUE É `<webview>` (Decisão E). Tudo entra por
 * `wakeGuest(nodeId)`; no dia em que o guest nascer de um `WebContentsView`,
 * nada aqui muda.
 */
import type { WebContents } from 'electron'
import type { UUID } from '@shared/types'
import { log } from '../logger'
import { onGuestUnregistered, wakeGuest } from './portal-registry'

/** Um elemento interativo, do jeito que o `portal map` numerou. */
export interface MapEntry {
  ref: number
  backendNodeId: number
  role: string
  label: string
  value: string | null
  states: string[]
}

interface Session {
  wc: WebContents
  /** Cada `map` incrementa; navegação zera a tabela e incrementa também. */
  generation: number
  entries: Map<number, MapEntry>
  /** Removido no fechamento — senão o guest acumula listener a cada abertura. */
  cleanup: () => void
}

const sessions = new Map<UUID, Session>()

/** Ponto na viewport, em pixels CSS — o que `Input.dispatchMouseEvent` espera. */
export interface Point {
  x: number
  y: number
}

/** Erro com a frase que o agente precisa ler, não o texto cru do Chromium. */
function attachFailure(err: unknown): Error {
  const message = (err as Error)?.message ?? String(err)
  if (/devtools/i.test(message)) {
    return new Error(
      'não consegui assumir o controle: o DevTools deste portal está aberto. ' +
        'Feche-o e tente de novo — só um depurador por página.'
    )
  }
  return new Error(`não consegui assumir o controle deste portal: ${message}`)
}

/**
 * Abre (ou reaproveita) a sessão do nó, acordando o portal se preciso.
 *
 * A sessão vive enquanto o controle está ligado, não por comando: `attach` a
 * cada clique custa handshake e, pior, perde os observadores de navegação que
 * invalidam as referências do mapa (Decisão D).
 */
export async function openSession(nodeId: UUID): Promise<Session> {
  const open = sessions.get(nodeId)
  if (open && !open.wc.isDestroyed()) return open

  const guest = await wakeGuest(nodeId)
  if (!guest) {
    throw new Error(
      `portal ${nodeId.slice(0, 8)} não respondeu: a página pode estar carregando, ou o nó foi removido do canvas`
    )
  }

  if (!guest.debugger.isAttached()) {
    try {
      guest.debugger.attach('1.3')
    } catch (err) {
      throw attachFailure(err)
    }
  }

  const session: Session = {
    wc: guest,
    generation: 0,
    entries: new Map(),
    cleanup: () => {}
  }

  // Navegação invalida TODA referência: o ref 7 da página anterior aponta para
  // um nó que não existe mais, e clicar nele "por sorte" é o pior resultado
  // possível. Só o frame principal conta — subframe trocando não move a página.
  const onMessage = (_e: unknown, method: string, params: Record<string, unknown>): void => {
    if (method !== 'Page.frameNavigated') return
    const frame = params.frame as { parentId?: string } | undefined
    if (frame?.parentId) return
    session.generation++
    session.entries.clear()
  }
  const onDetach = (_e: unknown, reason: string): void => {
    log.info('portal', `CDP de ${nodeId.slice(0, 8)} desanexado (${reason})`)
    sessions.delete(nodeId)
  }
  guest.debugger.on('message', onMessage)
  guest.debugger.on('detach', onDetach)
  session.cleanup = () => {
    guest.debugger.removeListener('message', onMessage)
    guest.debugger.removeListener('detach', onDetach)
  }

  sessions.set(nodeId, session)

  await guest.debugger.sendCommand('DOM.enable')
  await guest.debugger.sendCommand('Page.enable')
  await guest.debugger.sendCommand('Accessibility.enable')
  log.info('portal', `CDP aberto para o nó ${nodeId.slice(0, 8)}`)
  return session
}

/** Fecha e desanexa. Idempotente: chamado no desligamento E no unmount do nó. */
export function closeSession(nodeId: UUID): void {
  const session = sessions.get(nodeId)
  if (!session) return
  sessions.delete(nodeId)
  session.cleanup()
  try {
    if (!session.wc.isDestroyed() && session.wc.debugger.isAttached()) session.wc.debugger.detach()
  } catch {
    // Guest já foi embora: nada a desanexar.
  }
  log.info('portal', `CDP fechado para o nó ${nodeId.slice(0, 8)}`)
}

/** Um comando CDP no portal, com a sessão aberta sob demanda. */
export async function send<T = Record<string, unknown>>(
  nodeId: UUID,
  method: string,
  params?: Record<string, unknown>
): Promise<T> {
  const session = await openSession(nodeId)
  return (await session.wc.debugger.sendCommand(method, params)) as T
}

/** Guarda a tabela `ref → elemento` do último `map` e devolve a geração dela. */
export async function rememberMap(nodeId: UUID, entries: MapEntry[]): Promise<number> {
  const session = await openSession(nodeId)
  session.generation++
  session.entries.clear()
  for (const entry of entries) session.entries.set(entry.ref, entry)
  return session.generation
}

/**
 * A referência, se ela ainda vale.
 *
 * Ref de mapa velho (a página navegou, ou nunca houve mapa) devolve erro
 * pedindo um `map` novo — nunca acerta outro elemento por coincidência.
 *
 * NÃO ABRE SESSÃO. Sem mapa não há o que resolver, e acordar o portal só para
 * descobrir isso trocaria a mensagem certa ("rode map") pela errada ("o portal
 * não respondeu") toda vez que o agente pulasse o mapa.
 */
export function lookupRef(nodeId: UUID, ref: number): MapEntry {
  const entries = sessions.get(nodeId)?.entries
  if (!entries || entries.size === 0) {
    throw new Error(
      `nenhum mapa válido para este portal (a página pode ter navegado, ou nunca houve mapa). ` +
        `Rode 'atelier portal map' primeiro.`
    )
  }
  const entry = entries.get(ref)
  if (!entry) {
    throw new Error(
      `ref ${ref} não está no mapa atual (1–${entries.size}). Rode 'atelier portal map' de novo.`
    )
  }
  return entry
}

/**
 * Centro do elemento em coordenadas de viewport, pronto para o `Input`.
 *
 * `DOM.getBoxModel` devolve quads em pixels CSS já relativos à viewport visual,
 * e `Input.dispatchMouseEvent` lê pixels CSS da mesma viewport — nos dois lados
 * o `zoomFactor` do Electron já está aplicado, então no caso normal não há
 * conversão nenhuma a fazer. A exceção é `pageScaleFactor ≠ 1` (pinça de
 * toque/emulação móvel), onde a viagem visual e a de layout se separam: aí a
 * correção é a que está aqui, e é a incógnita 2 da Etapa 0 do plano.
 */
export async function pointOf(nodeId: UUID, backendNodeId: number): Promise<Point> {
  // Rolar antes de medir: elemento fora da tela tem box, mas o clique na
  // coordenada dele acerta o que estiver por cima.
  await send(nodeId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })

  const { model } = await send<{ model?: { content: number[] } }>(nodeId, 'DOM.getBoxModel', {
    backendNodeId
  })
  if (!model) throw new Error('o elemento não tem caixa visível na página')

  const q = model.content
  const x = (q[0] + q[2] + q[4] + q[6]) / 4
  const y = (q[1] + q[3] + q[5] + q[7]) / 4

  const metrics = await send<{
    cssVisualViewport?: { pageX: number; pageY: number; scale?: number }
  }>(nodeId, 'Page.getLayoutMetrics')
  const vv = metrics.cssVisualViewport
  const scale = vv?.scale ?? 1
  if (!vv || scale === 1) return { x, y }
  return { x: (x - vv.pageX) * scale, y: (y - vv.pageY) * scale }
}

/**
 * Espera a página assentar: nada de rede em voo por `quietMs` seguidos.
 *
 * `Network` é habilitado SÓ AQUI e desligado no fim — é um domínio barulhento,
 * e o resto do controle não precisa dele. Sem esta espera o agente clica, lê
 * antes da resposta chegar e conclui que o clique falhou; é o erro que mais
 * aparece em agente de navegador.
 */
export async function waitForNetworkIdle(
  nodeId: UUID,
  quietMs: number,
  timeoutMs: number
): Promise<'idle' | 'timeout'> {
  const session = await openSession(nodeId)
  let inFlight = 0

  return new Promise<'idle' | 'timeout'>((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | null = null

    const settle = (result: 'idle' | 'timeout'): void => {
      if (quiet) clearTimeout(quiet)
      clearTimeout(deadline)
      session.wc.debugger.removeListener('message', onMessage)
      void session.wc.debugger.sendCommand('Network.disable').catch(() => {})
      resolve(result)
    }

    const arm = (): void => {
      if (quiet) clearTimeout(quiet)
      if (inFlight > 0) return
      quiet = setTimeout(() => settle('idle'), quietMs)
      quiet.unref?.()
    }

    const onMessage = (_e: unknown, method: string): void => {
      if (method === 'Network.requestWillBeSent') {
        inFlight++
        if (quiet) clearTimeout(quiet)
        return
      }
      if (
        method === 'Network.loadingFinished' ||
        method === 'Network.loadingFailed' ||
        method === 'Page.loadEventFired'
      ) {
        if (method !== 'Page.loadEventFired') inFlight = Math.max(0, inFlight - 1)
        arm()
      }
    }

    const deadline = setTimeout(() => settle('timeout'), timeoutMs)
    deadline.unref?.()

    session.wc.debugger.on('message', onMessage)
    void session.wc.debugger.sendCommand('Network.enable').then(arm, () => settle('timeout'))
  })
}

/**
 * Liga o fechamento automático ao ciclo de vida do guest. Chamado uma vez no
 * boot, junto do resto do armamento do Portal.
 *
 * Sem isto, um nó desmontado pelo culling deixaria a sessão pendurada num
 * webContents morto — e o próximo comando falharia com o erro errado.
 */
export function armPortalCDP(): void {
  onGuestUnregistered((nodeId) => closeSession(nodeId))
}
