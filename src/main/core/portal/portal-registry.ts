/**
 * Registro `nodeId → webContents do <webview>` de cada Portal.
 *
 * É a peça que as três funcionalidades do Portal usam (ver 2026-08-26-PLANO-portal.md):
 * abrir popup como nó, ler a página pelo agente e criar portal pelo CLI. Todas
 * precisam da mesma coisa — falar com o webContents convidado (*guest*) de um nó
 * — e nenhuma consegue por conta própria: o guest do `<webview>` é um processo
 * separado que não herda handler nenhum do host.
 *
 * POR QUE NÃO UM ROUND-TRIP PARA O RENDERER: a alternativa seria
 * main → renderer → webview.executeJavaScript → renderer → main, com requestId,
 * mapa de promessas e timeout. Não precisa existir: o elemento `<webview>` expõe
 * `getWebContentsId()`, e no main `webContents.fromId()` devolve o guest. Uma
 * linha de IPC em cada ponta no lugar de um protocolo.
 *
 * POR QUE O `import('electron')` É DINÂMICO: mesma razão do ipc/notify.ts — fora
 * do app (smoke headless, CI) este módulo precisa importar sem quebrar. Só o
 * número do webContents fica guardado aqui; resolver o número em objeto é que
 * exige o electron, e isso acontece na chamada, não na importação.
 */
import type { WebContents } from 'electron'
import type { UUID } from '@shared/types'
import { log } from '../logger'
import { notifyRenderer } from '../../ipc/notify'

/**
 * Tempo que `wake` espera o renderer montar um portal adormecido. O escape por
 * variável existe pelo mesmo motivo do ATELIER_HOME: o smoke headless não tem
 * renderer nenhum, e esperar cinco segundos pelo caminho de timeout é o teste
 * inteiro parado.
 */
const WAKE_TIMEOUT_MS = Number(process.env.ATELIER_PORTAL_WAKE_MS) || 5000

const guests = new Map<UUID, number>()
const waiters = new Map<UUID, ((id: number) => void)[]>()
const listeners: ((nodeId: UUID) => void)[] = []
const goneListeners: ((nodeId: UUID) => void)[] = []

/**
 * Avisa quando um guest novo aparece. É por aqui que o tratamento de popup se
 * arma (core/portal/portal-popup.ts) sem que este módulo precise conhecer
 * workspace, preferências ou criação de nó.
 */
export function onGuestRegistered(cb: (nodeId: UUID) => void): void {
  listeners.push(cb)
}

/**
 * Avisa quando um guest some (unmount por zoom, culling ou remoção do nó). É
 * por aqui que a sessão CDP se fecha (core/portal/portal-cdp.ts) sem que este
 * módulo precise conhecer o depurador.
 */
export function onGuestUnregistered(cb: (nodeId: UUID) => void): void {
  goneListeners.push(cb)
}

/**
 * Chamado pelo renderer no `dom-ready` do webview. Idempotente: `dom-ready`
 * dispara a cada navegação, e o id do guest não muda entre elas.
 */
export function registerGuest(nodeId: UUID, webContentsId: number): void {
  const known = guests.get(nodeId)
  guests.set(nodeId, webContentsId)
  if (known === webContentsId) return

  log.info('portal', `guest ${webContentsId} registrado para o nó ${nodeId.slice(0, 8)}`)

  const pending = waiters.get(nodeId)
  if (pending) {
    waiters.delete(nodeId)
    for (const resolve of pending) resolve(webContentsId)
  }

  for (const cb of listeners) cb(nodeId)
}

/** Chamado no unmount do nó (zoom, virtualização, remoção). */
export function unregisterGuest(nodeId: UUID): void {
  if (!guests.delete(nodeId)) return
  for (const cb of goneListeners) cb(nodeId)
}

/** Só o número — o que dá para saber sem depender do electron. */
export function guestIdFor(nodeId: UUID): number | null {
  return guests.get(nodeId) ?? null
}

/**
 * O caminho inverso: de qual nó é este guest?
 *
 * Existe porque o tratamento de popup se arma na CRIAÇÃO do webContents, antes
 * do renderer ter dito de quem ele é — se esperasse o dom-ready, uma página que
 * chama window.open no carregamento escaparia pela janela nativa.
 */
export function nodeIdForGuest(webContentsId: number): UUID | null {
  for (const [nodeId, id] of guests) if (id === webContentsId) return nodeId
  return null
}

/**
 * O guest vivo, ou null. Um id órfão (guest destruído sem o renderer avisar,
 * caso de crash da página) é descartado aqui em vez de virar erro no chamador.
 */
export async function guestFor(nodeId: UUID): Promise<WebContents | null> {
  const id = guests.get(nodeId)
  if (id === undefined) return null
  try {
    const { webContents } = await import('electron')
    const wc = webContents.fromId(id)
    if (!wc || wc.isDestroyed()) {
      guests.delete(nodeId)
      return null
    }
    return wc
  } catch {
    return null
  }
}

/**
 * O guest, acordando o nó se preciso.
 *
 * Um portal fora da viewport ou com zoom abaixo do congelamento não tem webview
 * montado — e para um agente "não montado" é o mesmo que não funcionar. Então o
 * main pede ao renderer que monte o nó (`portal:wake`) e espera o `registerGuest`
 * chegar. Ver a Decisão C do 2026-08-26-PLANO-portal.md: acordar sob demanda custa um
 * processo pelo tempo da leitura, contra N processos vivos o tempo todo.
 */
export async function wakeGuest(nodeId: UUID, timeoutMs = WAKE_TIMEOUT_MS): Promise<WebContents | null> {
  const existing = await guestFor(nodeId)
  if (existing) return existing

  const arrived = new Promise<boolean>((resolve) => {
    const list = waiters.get(nodeId) ?? []
    list.push(() => resolve(true))
    waiters.set(nodeId, list)
    setTimeout(() => resolve(false), timeoutMs).unref?.()
  })

  notifyRenderer('portal:wake', { nodeId })
  if (!(await arrived)) {
    log.warn('portal', `nó ${nodeId.slice(0, 8)} não respondeu ao wake em ${timeoutMs}ms`)
    return null
  }
  return guestFor(nodeId)
}

/** Só para teste headless: esvazia o registro entre casos. */
export function resetGuests(): void {
  guests.clear()
  waiters.clear()
}
