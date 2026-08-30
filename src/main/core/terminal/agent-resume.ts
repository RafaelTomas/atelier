/**
 * Quais agentes sabem retomar uma sessão, e com que gramática.
 *
 * Uma tabela por `agentType`, e não uma flag por terminal, porque a capacidade é
 * do CLI: ou o binário conhece `--resume`, ou não conhece, e isso não muda de um
 * nó para o outro. Sem essa separação, "retomar" viraria uma ação oferecida em
 * todos os presets, falhando em silêncio em quatro dos cinco — e um shell comum
 * ganharia uma flag que não existe.
 *
 * Hoje só `claude_code` tem entrada. `codex`, `antigravity`, `open_code` e
 * `generic_shell` ficam de fora de propósito: os dois primeiros têm retomada
 * própria com outra gramática, ninguém verificou as flags, e inventá-las daria
 * um comando que morre na largada. Sem entrada, NADA acontece — nem argumento no
 * spawn, nem id gravado, nem ação de retomar no menu.
 *
 * Módulo puro: sem `electron`, sem `node-pty`, e é o que o teste exercita.
 */
import { join } from 'node:path'
import type { UUID } from '@shared/types'

/** Onde o CLI do agente grava a transcrição de uma sessão. */
export interface TranscriptLocation {
  /** O diretório do projeto. Não existir significa "não sei", nunca "não tem". */
  dir: string
  /** Nomes aceitáveis do arquivo. Mais de um porque a caixa do id varia. */
  files: string[]
}

export interface ResumeSupport {
  /** Argumentos que FIXAM o id numa sessão nova. */
  newSession: (id: UUID) => string[]
  /** Argumentos que retomam a sessão daquele id. */
  resume: (id: UUID) => string[]
  /** O agente disse, na PRÓPRIA TELA, que a sessão pedida não existe? */
  resumeFailed: (text: string) => boolean
  /** Onde procurar a transcrição daquele id, antes de pedir para retomá-lo. */
  transcript: (configDir: string, cwd: string, id: UUID) => TranscriptLocation
}

/**
 * O nome que o Claude Code dá à pasta de um projeto: o caminho inteiro com todo
 * caractere que não é letra ou dígito virando `-`. `C:\Users\etass` vira
 * `C--Users-etass`, `E:\Projetos\atelier` vira `E--Projetos-atelier`.
 *
 * A regra é de outro app e pode mudar. Por isso quem usa isto trata "a pasta não
 * existe" como DESCONHECIDO e não como "a sessão não existe" — errar a regra
 * desliga a checagem, nunca a retomada.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * O id é NOSSO, não descoberto.
 *
 * O Atelier gera o UUID e o entrega ao agente no primeiro boot
 * (`--session-id`); o boot seguinte daquele nó pede `--resume` com o mesmo id.
 *
 * A alternativa era descobrir o id depois do fato, varrendo
 * `~/.claude/projects/<slug>/` pelo `.jsonl` mais recente. Ela erra de três
 * maneiras sem conserto: é dado de outro app, num formato que não é nosso; é
 * heurística por `mtime`, que escolhe errado sempre que dois nós rodam no mesmo
 * diretório — o caso NORMAL neste canvas; e falha justamente logo depois de um
 * crash, quando ninguém sabe qual arquivo era de quem.
 */
export const RESUME_SUPPORT: Record<string, ResumeSupport> = {
  claude_code: {
    newSession: (id) => ['--session-id', id],
    resume: (id) => ['--resume', id],
    // A frase que o CLI imprime e some. Casada sem o id porque ele já vem
    // quebrado em duas linhas pela largura do nó — ver terminal-manager.ts.
    resumeFailed: (text) => /No conversation found with session ID/i.test(text),
    transcript: (configDir, cwd, id) => ({
      dir: join(configDir, 'projects', claudeProjectSlug(cwd)),
      // A caixa do id sobrevive como veio no `--session-id`, mas isso é detalhe
      // de outro app: num sistema de arquivos sensível a caixa, checar só uma
      // das formas daria "não existe" para uma sessão que existe.
      files: [`${id}.jsonl`, `${id.toLowerCase()}.jsonl`]
    })
  }
}

export function supportsResume(agentType: string): boolean {
  return agentType in RESUME_SUPPORT
}

/**
 * O comando com os argumentos de sessão anexados.
 *
 * Devolve o comando INTACTO quando o agente não sabe retomar, quando não há
 * comando, ou quando o usuário JÁ escreveu uma flag de sessão à mão — nesse
 * último caso a dele vence, e acrescentar a nossa daria dois `--resume` no
 * mesmo comando, que o CLI recusa.
 */
export function withSession(
  command: string,
  agentType: string,
  sessionId: UUID,
  mode: 'new' | 'resume',
  support: Record<string, ResumeSupport> = RESUME_SUPPORT
): string {
  const entry = support[agentType]
  if (!entry || !command.trim()) return command
  if (/(^|\s)--(resume|session-id|continue)(\s|=|$)/.test(command)) return command
  const args = mode === 'new' ? entry.newSession(sessionId) : entry.resume(sessionId)
  return [command, ...args].join(' ')
}
