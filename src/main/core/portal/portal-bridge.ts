/**
 * O que o agente consegue ver de dentro de um Portal.
 *
 * Tudo passa por `wakeGuest`: um portal fora da viewport ou com zoom abaixo do
 * congelamento não tem webview montado, e para um agente "não montado" é o mesmo
 * que não funcionar. Acordar sob demanda custa um processo pelo tempo da leitura
 * — contra N processos vivos o tempo todo (Decisão C do plano).
 *
 * NÃO EXISTE `eval` AQUI, DE PROPÓSITO. Executar JavaScript arbitrário numa
 * sessão autenticada, ainda mais com a partição herdada do popup, transforma um
 * prompt mal formulado em ação autenticada. Ler é o caso real: o agente quer ver
 * o que o usuário está vendo.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UUID } from '@shared/types'
import { log } from '../logger'
import { paths } from '../persistence/paths'
import { wakeGuest } from './portal-registry'

/** Teto do que volta para o terminal. Página grande vira scrollback inútil. */
const MAX_CHARS = 200_000

export interface PortalInfo {
  url: string
  title: string
  loading: boolean
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text
  return `${text.slice(0, MAX_CHARS)}\n\n[… truncado em ${MAX_CHARS} caracteres]`
}

/** Mensagem única para o caso "não consegui falar com este portal". */
function asleep(nodeId: UUID): Error {
  return new Error(
    `portal ${nodeId.slice(0, 8)} não respondeu: a página pode estar carregando, ou o nó foi removido do canvas`
  )
}

/** Texto visível da página — o que o usuário leria, não o HTML. */
export async function portalText(nodeId: UUID): Promise<string> {
  const guest = await wakeGuest(nodeId)
  if (!guest) throw asleep(nodeId)

  const text = (await guest.executeJavaScript(
    'document.body ? document.body.innerText : ""'
  )) as string

  // PDF, imagem e afins são renderizados por um plugin do Chromium: há página,
  // mas não há DOM para ler. Dizer isso vale mais que devolver string vazia.
  if (!text || text.trim().length === 0) {
    const info = await portalInfo(nodeId)
    return `[sem texto legível em ${info.url} — se for PDF ou imagem, use 'atelier portal shot']`
  }
  return truncate(text)
}

/** HTML da página inteira, ou só do primeiro elemento que casar com o seletor. */
export async function portalHTML(nodeId: UUID, selector?: string): Promise<string> {
  const guest = await wakeGuest(nodeId)
  if (!guest) throw asleep(nodeId)

  const code = selector
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : null })()`
    : 'document.documentElement.outerHTML'

  const html = (await guest.executeJavaScript(code)) as string | null
  if (html === null) throw new Error(`nenhum elemento casa com '${selector}'`)
  return truncate(html)
}

export async function portalInfo(nodeId: UUID): Promise<PortalInfo> {
  const guest = await wakeGuest(nodeId)
  if (!guest) throw asleep(nodeId)
  return { url: guest.getURL(), title: guest.getTitle(), loading: guest.isLoading() }
}

/**
 * Captura em PNG. Devolve o CAMINHO, não base64: o agente lê a imagem com a
 * ferramenta dele, e o terminal não engasga com um blob de dois megabytes.
 */
export async function portalShot(
  nodeId: UUID,
  workspaceId: UUID,
  destination?: string
): Promise<string> {
  const guest = await wakeGuest(nodeId)
  if (!guest) throw asleep(nodeId)

  const image = await guest.capturePage()
  if (image.isEmpty()) throw new Error('a captura voltou vazia — o portal pode estar minimizado')

  let file = destination
  if (!file) {
    const dir = paths.shotsDir(workspaceId)
    await mkdir(dir, { recursive: true })
    file = join(dir, `${nodeId.slice(0, 8)}-${Date.now()}.png`)
  }

  await writeFile(file, image.toPNG())
  log.info('portal', `captura de ${nodeId.slice(0, 8)} em ${file}`)
  return file
}
