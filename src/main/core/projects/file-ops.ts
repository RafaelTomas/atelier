/**
 * Operações de arquivo do editor e da árvore: ler, gravar, renomear, duplicar.
 *
 * Nada aqui checa permissão — quem chama SEMPRE resolve o caminho por
 * `resolveAllowedPath` antes (ver fs-access.ts e os canais em ipc/bridge.ts).
 * Este módulo não importa `electron` de propósito: é o que mantém o smoke
 * headless capaz de exercitar as regras abaixo, que é onde elas valem alguma
 * coisa. Por isso a lixeira NÃO mora aqui — `shell.trashItem` é do Electron.
 *
 * Duas decisões que não são detalhe:
 *
 *   1. Arquivo acima do teto é ERRO, não leitura parcial. O editor devolve o
 *      buffer inteiro no save; abrir 2 MB de um arquivo de 400 MB e salvar
 *      truncaria o arquivo em disco. O plano previa `{ text, truncated }` — um
 *      texto truncado editável é uma máquina de destruir dados, então virou
 *      recusa com motivo.
 *   2. Renomear e mover nunca sobrescrevem. `fs.rename` substitui o destino em
 *      silêncio, e "arrastei para a pasta errada" apagaria o homônimo de lá.
 */
import { copyFile, cp, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { FileOpError } from '@shared/types'

export type { FileOpError }

/** Acima disto o arquivo não é texto de trabalho — e trava o renderer. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Só o começo é inspecionado: byte nulo em arquivo de texto é anomalia. */
const SNIFF_BYTES = 8 * 1024

export interface ReadTextResult {
  text: string
  bytes: number
}

function errnoTo(err: unknown): FileOpError {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return 'missing'
  if (code === 'EACCES' || code === 'EPERM') return 'denied'
  if (code === 'EEXIST') return 'exists'
  if (code === 'EISDIR') return 'not-a-file'
  return 'error'
}

/**
 * Lê o arquivo inteiro como UTF-8, ou recusa com o motivo.
 *
 * A recusa de binário olha os primeiros 8 KB atrás de byte nulo: é o mesmo
 * critério que o `git` usa para decidir se um arquivo é texto, e custa uma
 * leitura curta antes de trazer o resto.
 */
export async function readTextFile(
  path: string
): Promise<ReadTextResult | { error: FileOpError }> {
  let handle
  try {
    const info = await stat(path)
    if (!info.isFile()) return { error: 'not-a-file' }
    if (info.size > MAX_TEXT_BYTES) return { error: 'too-large' }

    handle = await open(path, 'r')
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, info.size))
    if (head.length > 0) {
      await handle.read(head, 0, head.length, 0)
      if (head.includes(0)) return { error: 'binary' }
    }

    const buffer = await handle.readFile()
    return { text: buffer.toString('utf8'), bytes: buffer.byteLength }
  } catch (err) {
    return { error: errnoTo(err) }
  } finally {
    await handle?.close()
  }
}

/**
 * Escrita atômica: `.tmp` no mesmo diretório, fsync e rename.
 *
 * O padrão é o do PersistenceManager (persistence-manager.ts:52) e a razão é a
 * mesma: uma queda no meio da escrita não pode deixar meio arquivo no lugar do
 * arquivo do usuário. O método de lá é privado e amarrado aos arquivos do app,
 * então o padrão é repetido em vez de exportado.
 */
export async function writeTextFile(
  path: string,
  text: string
): Promise<{ ok: true } | { error: FileOpError }> {
  const tmp = `${path}.${process.pid}.atelier-tmp`
  try {
    const info = await stat(path)
    if (!info.isFile()) return { error: 'not-a-file' }

    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    return { ok: true }
  } catch (err) {
    await rm(tmp, { force: true })
    return { error: errnoTo(err) }
  }
}

/**
 * Renomeia ou move. Destino existente é recusado — nunca sobrescrito.
 *
 * A checagem de existência antes do rename é uma corrida (TOCTOU) em teoria;
 * na prática o alvo é o disco de um usuário mexendo em arquivos à mão, e a
 * alternativa (`link` + `unlink`) não funciona entre sistemas de arquivos nem
 * para diretórios.
 */
export async function renameEntry(
  from: string,
  to: string
): Promise<{ ok: true; path: string } | { error: FileOpError }> {
  if (from === to) return { ok: true, path: to }
  try {
    if (await exists(to)) return { error: 'exists' }
    await mkdir(dirname(to), { recursive: true })
    await rename(from, to)
    return { ok: true, path: to }
  } catch (err) {
    return { error: errnoTo(err) }
  }
}

/**
 * Copia ao lado, no primeiro nome livre: `app.ts` → `app copy.ts`,
 * `app copy 2.ts`, e assim por diante. O sufixo entra ANTES da extensão para o
 * arquivo continuar sendo do mesmo tipo — `app.ts copy` não é TypeScript.
 */
export async function duplicateEntry(
  path: string
): Promise<{ ok: true; path: string } | { error: FileOpError }> {
  try {
    const info = await stat(path)
    const target = await freeCopyName(path)
    if (!target) return { error: 'exists' }

    if (info.isDirectory()) await cp(path, target, { recursive: true })
    else await copyFile(path, target)
    return { ok: true, path: target }
  } catch (err) {
    return { error: errnoTo(err) }
  }
}

/** Teto de tentativas: 100 cópias do mesmo arquivo é engano, não intenção. */
const MAX_COPY_ATTEMPTS = 100

async function freeCopyName(path: string): Promise<string | null> {
  const dir = dirname(path)
  const name = basename(path)
  // Extensão só conta se não for o nome inteiro: `.gitignore` não tem extensão.
  const ext = extname(name)
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name
  const suffix = ext && ext !== name ? ext : ''

  for (let i = 1; i <= MAX_COPY_ATTEMPTS; i++) {
    const label = i === 1 ? 'copy' : `copy ${i}`
    const candidate = join(dir, `${stem} ${label}${suffix}`)
    if (!(await exists(candidate))) return candidate
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
