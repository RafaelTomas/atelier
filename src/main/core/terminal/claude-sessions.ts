/**
 * As sessões anteriores do Claude Code num diretório de trabalho.
 *
 * O diálogo de novo terminal usa isto para oferecer "Retomar sessão": em vez de
 * o nó começar uma conversa nova, ele sobe com `--resume <id>` sobre uma que já
 * existe naquele projeto — inclusive uma tocada fora do Atelier, direto no
 * terminal.
 *
 * A fonte é `<configDir>/projects/<slug>/*.jsonl`, o mesmo diretório que
 * `agent-resume.ts` já mira. E, como lá, a regra de nome da pasta é de OUTRO
 * app: tudo aqui é defensivo — pasta inexistente, arquivo ilegível ou linha de
 * JSON quebrada devolvem lista vazia ou entram sem rótulo, NUNCA uma exceção.
 * Uma falha na leitura não pode impedir o diálogo de abrir.
 *
 * Módulo puro: sem `electron`, sem `node-pty`. É o que o teste exercita.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClaudeSessionSummary, UUID } from '@shared/types'
import { claudeProjectSlug } from './agent-resume'

export type { ClaudeSessionSummary }

/** Só lê o começo do arquivo: a primeira mensagem do usuário está sempre no topo. */
const HEAD_BYTES = 64 * 1024
/** Rótulo comprido vira ruído no select — o resto está na data ao lado. */
const LABEL_MAX = 120
/** O `.jsonl` é nomeado pelo UUID da sessão; qualquer outra coisa na pasta não é nossa. */
const SESSION_FILE = /^([0-9a-fA-F-]{36})\.jsonl$/

/**
 * As sessões de `cwd`, da mais recente para a mais antiga, no máximo `limit`.
 *
 * `configDir` é `CLAUDE_CONFIG_DIR` da conta escolhida, ou `~/.claude` na conta
 * padrão — a mesma resolução que o spawn faz.
 */
export async function listClaudeSessions(
  configDir: string,
  cwd: string,
  limit = 20
): Promise<ClaudeSessionSummary[]> {
  const dir = join(configDir, 'projects', claudeProjectSlug(cwd))

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // Pasta inexistente: ou o projeto nunca teve sessão, ou a regra de nome
    // mudou. Nos dois casos o diálogo simplesmente não mostra o select.
    return []
  }

  const found = await Promise.all(
    names.map(async (name): Promise<ClaudeSessionSummary | null> => {
      const match = SESSION_FILE.exec(name)
      if (!match) return null
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (!info.isFile()) return null
        return {
          sessionId: match[1] as UUID,
          modifiedAt: info.mtime.toISOString(),
          label: await readFirstUserMessage(path)
        }
      } catch {
        // Arquivo sumiu entre o readdir e o stat, ou o disco não respondeu:
        // uma sessão a menos na lista não é motivo para derrubar as outras.
        return null
      }
    })
  )

  return found
    .filter((s): s is ClaudeSessionSummary => s !== null)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, limit)
}

/** O texto da primeira linha `type: "user"` com conteúdo legível, ou `''`. */
async function readFirstUserMessage(path: string): Promise<string> {
  let head: string
  try {
    const handle = await open(path, 'r')
    try {
      const buf = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0)
      head = buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }

  // A última linha do trecho pode estar cortada ao meio pelo teto de bytes —
  // `JSON.parse` a rejeita e ela é ignorada, como qualquer linha corrompida.
  for (const line of head.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    const text = userText(obj)
    if (text) return shorten(text)
  }
  return ''
}

/**
 * O texto de uma linha da transcrição, quando ela é uma mensagem escrita pelo
 * usuário. `null` para tudo o mais — linha de resumo, saída de ferramenta,
 * evento de meta —, que não serve de rótulo.
 */
function userText(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  if (rec.type !== 'user' || rec.isMeta === true) return null
  const message = rec.message
  if (!message || typeof message !== 'object') return null
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string'
      ) {
        return (block as Record<string, unknown>).text as string
      }
    }
  }
  return null
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat
}
