import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * O Atelier tem cadastro próprio de contas do Claude (`core/claude/accounts`),
 * mas nenhum do Codex: a conta do Codex é a do CLI, e quem a guarda é o próprio
 * `codex`, num `auth.json` dentro do CODEX_HOME. Este módulo é a única pergunta
 * que o Atelier faz sobre isso — "existe conta aqui?" — e ela decide duas
 * coisas de uma vez:
 *
 *   1. se o App Server deve ser levantado (sem conta, o `spawn` só produz um
 *      `ENOENT` por tentativa no shell do usuário, como o da máquina que abriu
 *      este caminho: `codex` nem instalado estava);
 *   2. se o monitor deve desenhar a seção Codex (sem conta, ela é uma linha
 *      permanentemente vazia — "sem leitura", dois anéis cinzas — que só ocupa
 *      espaço ao lado das contas que o usuário de fato tem).
 *
 * O teste é a existência do arquivo, não sua leitura: o conteúdo tem token, e
 * nada aqui precisa dele. Um `auth.json` corrompido ainda conta como conta
 * cadastrada — quem reclama disso é o App Server, na voz dele.
 */

/** CODEX_HOME manda; senão `~/.codex`, o padrão do CLI. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.CODEX_HOME?.trim()
  return custom ? custom : join(homedir(), '.codex')
}

export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), 'auth.json')
}

/** true = há credencial do Codex no disco. Nenhuma rede, nenhum subprocesso. */
export async function hasCodexAccount(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    await access(codexAuthPath(env))
    return true
  } catch {
    return false
  }
}
