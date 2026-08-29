/**
 * O id da sessão do agente de cada nó de terminal.
 *
 * Um arquivo por nó, em `workspaces/<wsId>/terminals/<nodeId>.session.json`, ao
 * lado do `.scrollback` que já mora ali. Fora do `workspace.json` pela regra que
 * a nota, a tabela, a imagem e o cofre já seguem — e, aqui, por uma razão a
 * mais: o app nativo Swift descarta chave desconhecida dentro de
 * `TerminalContent`, então um campo novo ali seria perdido em silêncio no
 * primeiro save de quem abrisse o canvas de lá.
 *
 * O arquivo guarda o mínimo, e o `cwd` está nele por um motivo concreto: as
 * sessões do Claude Code são POR DIRETÓRIO, e retomar de outro `cwd` falha. Se
 * o usuário editar o `workingDirectory` do nó, o id gravado deixa de valer — e
 * um agente novo é melhor que uma retomada que erra o projeto.
 *
 * Módulo sem `electron`: roda no smoke headless.
 */
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { UUID } from '@shared/types'
import { paths } from '../persistence/paths'
import type { TranscriptLocation } from './agent-resume'

export interface TerminalSession {
  agentType: string
  sessionId: UUID
  /** Diretório em que a sessão foi criada. Mudou, o id não vale mais. */
  cwd: string
  startedAt: string
}

/**
 * Leitura DEFENSIVA: o arquivo é editável à mão e sobrevive a versões. Qualquer
 * campo faltando ou com o tipo errado devolve `null` — e `null` aqui significa
 * "sobe uma sessão nova", que é sempre seguro. O caminho de erro nunca lança:
 * um JSON corrompido não pode impedir um terminal de abrir.
 */
export async function readSession(
  workspaceId: UUID,
  nodeId: UUID
): Promise<TerminalSession | null> {
  try {
    const raw = await readFile(paths.terminalSession(workspaceId, nodeId), 'utf8')
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object') return null
    const { agentType, sessionId, cwd, startedAt } = data as Record<string, unknown>
    if (typeof agentType !== 'string' || !agentType) return null
    if (typeof sessionId !== 'string' || !sessionId) return null
    return {
      agentType,
      sessionId: sessionId as UUID,
      cwd: typeof cwd === 'string' ? cwd : '',
      startedAt: typeof startedAt === 'string' ? startedAt : ''
    }
  } catch {
    return null
  }
}

/** Gravação atômica (tmp + rename), como as tabelas: um crash no meio da escrita
 *  deixaria um JSON pela metade, e a leitura seguinte perderia o id. */
export async function writeSession(
  workspaceId: UUID,
  nodeId: UUID,
  session: TerminalSession
): Promise<void> {
  const target = paths.terminalSession(workspaceId, nodeId)
  const tmp = `${target}.tmp`
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(tmp, JSON.stringify(session, null, 2), 'utf8')
    await rename(tmp, target)
  } catch {
    // Não poder gravar o id custa a retomada do próximo boot, e nada mais. Um
    // terminal que se recusasse a abrir por isso seria um preço muito pior.
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

export async function clearSession(workspaceId: UUID, nodeId: UUID): Promise<void> {
  await rm(paths.terminalSession(workspaceId, nodeId), { force: true }).catch(() => undefined)
}

/**
 * O id gravado ainda vale para este boot?
 *
 * Três condições, e cada `false` significa "sobe limpo":
 *
 *  - o agente daquele nó ainda é o mesmo tipo (trocar de `claude` para `codex`
 *    no diálogo invalida o id — ele é da gramática do outro CLI);
 *  - o `cwd` é o mesmo (sessão do Claude Code é por diretório);
 *  - o `agentType` sabe retomar.
 */
export function sessionIsUsable(
  session: TerminalSession | null,
  agentType: string,
  cwd: string,
  supports: (t: string) => boolean
): session is TerminalSession {
  if (!session) return false
  if (session.agentType !== agentType) return false
  if (!supports(agentType)) return false
  // `cwd` vazio no arquivo é de uma versão que não o gravava: aceita, porque o
  // caso comum é o diretório não ter mudado, e o pior que acontece é o
  // `--resume` falhar rápido e cair na sessão limpa pelo guarda de saída precoce.
  if (session.cwd && session.cwd !== cwd) return false
  return true
}

/**
 * A sessão gravada existe do lado do agente?
 *
 * Isto conserta o buraco que fazia o `--resume` falhar no caso mais banal do
 * canvas: `--session-id` apenas RESERVA um id, e o Claude Code só grava a
 * transcrição quando a conversa tem ao menos uma mensagem. Um nó que o usuário
 * abriu e nunca usou voltava, depois de um restart, com "No conversation found
 * with session ID" e um prompt pelado.
 *
 * Três respostas, e não duas, porque a pasta é de OUTRO app:
 *
 *  - `'yes'`     — o arquivo está lá: retoma.
 *  - `'no'`      — a pasta do projeto existe e o arquivo não: sobe limpo.
 *  - `'unknown'` — a pasta não existe, ou o disco não respondeu. Aí a nossa
 *    regra de nome pode simplesmente estar errada, e desligar a retomada por
 *    causa disso seria pior que tentar: retoma, e a queda é apanhada na tela
 *    pelo guarda de `resumeFailed`.
 *
 * Nunca lança: nenhuma resposta daqui pode impedir um terminal de abrir.
 */
export async function transcriptState(
  loc: TranscriptLocation | null
): Promise<'yes' | 'no' | 'unknown'> {
  if (!loc) return 'unknown'
  try {
    for (const file of loc.files) {
      try {
        await access(join(loc.dir, file))
        return 'yes'
      } catch {
        // segue para o próximo nome
      }
    }
    await access(loc.dir)
    return 'no'
  } catch {
    return 'unknown'
  }
}
