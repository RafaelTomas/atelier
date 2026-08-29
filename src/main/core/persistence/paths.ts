/**
 * Caminhos em disco. Mantém o layout de ~/.atelier/ do app nativo, com
 * `ATELIER_HOME` como escape para desenvolvimento (npm run dev aponta para
 * ~/.atelier-dev, para nunca tocar nos dados reais do usuário).
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UUID } from '@shared/types'
import { Constants } from '../constants'

/** O caminho padrão, quando `ATELIER_HOME` não foi apontado para outro lugar. */
export function defaultDataDir(): string {
  return join(homedir(), Constants.appDataDirectoryName)
}

export function dataDir(): string {
  const override = process.env.ATELIER_HOME
  if (override && override.trim().length > 0) {
    return override.replace(/^~(?=$|\/|\\)/, homedir())
  }
  return defaultDataDir()
}

/** true quando estamos rodando sobre um `ATELIER_HOME` (o caso do `npm run dev`). */
export function isOverriddenHome(): boolean {
  return dataDir() !== defaultDataDir()
}

export const paths = {
  root: dataDir,
  appState: () => join(dataDir(), 'app-state.json'),
  preferences: () => join(dataDir(), 'preferences.json'),
  manifest: () => join(dataDir(), 'manifest.json'),
  routines: () => join(dataDir(), 'routines.json'),
  projects: () => join(dataDir(), 'projects.json'),
  workspacesDir: () => join(dataDir(), 'workspaces'),
  rolesDir: () => join(dataDir(), 'roles'),
  roleFile: (id: UUID) => join(dataDir(), 'roles', `${id}.json`),
  runDir: () => join(dataDir(), 'run'),
  /** Lista das contas do Claude (rótulo + id). Os segredos não estão aqui. */
  claudeAccounts: () => join(dataDir(), 'claude-accounts.json'),
  claudeAccountsDir: () => join(dataDir(), 'claude-accounts'),
  /**
   * Última leitura de limite (5h/7d) de cada conta. Arquivo próprio, e não uma
   * chave do claude-accounts.json: aquele é a LISTA de contas, escrita quando o
   * usuário cria ou renomeia uma; este é reescrito enquanto os agentes rodam, e
   * misturar as duas cadências arriscaria a lista por causa da telemetria.
   */
  claudeUsage: () => join(dataDir(), 'claude-usage.json'),
  /** O `CLAUDE_CONFIG_DIR` de uma conta — um ~/.claude só dela. */
  claudeAccountDir: (id: string) => join(dataDir(), 'claude-accounts', id),
  /** Arquivos efêmeros — hoje só as imagens coladas dentro de um terminal. */
  tmpDir: () => join(dataDir(), 'tmp'),
  workspaceDir: (id: UUID) => join(dataDir(), 'workspaces', id),
  workspaceFile: (id: UUID) => join(dataDir(), 'workspaces', id, 'workspace.json'),
  notesDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'notes'),
  /** Resultados de query publicados no canvas (`atelier table`). Um JSON por nó. */
  tablesDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'tables'),
  /** Bytes dos nós de imagem. Um arquivo por nó, nomeado pelo id do conteúdo. */
  imagesDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'images'),
  /**
   * Quadros de TODO. Um JSON por nó, pela mesma regra da nota e da tabela: o
   * quadro é reescrito a cada cartão movido, e `WidgetContent.view` é
   * `[String: String]` com proibição explícita de alta frequência.
   */
  todosDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'todos'),
  todoFile: (id: UUID, todoId: string) =>
    join(dataDir(), 'workspaces', id, 'todos', `${todoId}.json`),
  /**
   * Cofres de segredos. Um `.vault` por nó, com o blob cifrado pelo
   * `safeStorage`, mais o `access.log` da auditoria — que NUNCA guarda valor.
   * Fora do workspace.json pela mesma regra da nota e da tabela.
   */
  vaultsDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'vaults'),
  vaultFile: (id: UUID, vaultId: UUID) =>
    join(dataDir(), 'workspaces', id, 'vaults', `${vaultId}.vault`),
  vaultAccessLog: (id: UUID) => join(dataDir(), 'workspaces', id, 'vaults', 'access.log'),
  terminalsDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'terminals'),
  snapshotsDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'snapshots'),
  /** Capturas de portal pedidas pelo agente (`atelier portal shot`). */
  shotsDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'shots'),
  scrollback: (workspaceId: UUID, terminalId: UUID) =>
    join(dataDir(), 'workspaces', workspaceId, 'terminals', `${terminalId}.scrollback`),
  /**
   * O id da sessão do agente daquele nó, para o `--resume` do boot seguinte.
   *
   * Ao lado do `.scrollback` e FORA do workspace.json, pela mesma regra da nota,
   * da tabela, da imagem e do cofre: o que é derivado e descartável não entra no
   * conteúdo do nó. Aqui há uma razão a mais — o app nativo Swift descarta
   * chave que não conhece dentro de `TerminalContent`, e um campo novo ali seria
   * perdido em silêncio no primeiro save de quem abrisse o canvas de lá.
   */
  terminalSession: (workspaceId: UUID, terminalId: UUID) =>
    join(dataDir(), 'workspaces', workspaceId, 'terminals', `${terminalId}.session.json`)
}

/**
 * Endereço do servidor IPC.
 * Unix socket no macOS/Linux, named pipe no Windows — a API do `net` é a mesma.
 *
 * No Unix o caminho já mora dentro do `dataDir()`, então dev e produção não se
 * cruzam. No Windows o nome do named pipe é GLOBAL: sem um sufixo, as duas
 * instâncias disputariam `\\.\pipe\atelier` e só a primeira subiria. O hash do
 * `dataDir()` mantém o nome estável para um mesmo `ATELIER_HOME` e distinto
 * entre instâncias; o caminho padrão segue com o nome curto de sempre.
 */
export function ipcSocketPath(): string {
  if (process.platform === 'win32') {
    if (!isOverriddenHome()) return '\\\\.\\pipe\\atelier'
    const tag = createHash('sha1').update(dataDir()).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\atelier-${tag}`
  }
  return join(dataDir(), 'run', 'agent.sock')
}

/** ~/.claude/skills/ — destino da skill injetada (igual nos três sistemas). */
export function claudeSkillsDir(): string {
  return join(homedir(), '.claude', 'skills')
}

/**
 * ~/.claude — a configuração da conta PADRÃO do Claude Code.
 *
 * NÃO depende de `ATELIER_HOME`: é o diretório do `claude`, não do Atelier, e
 * mesmo o `npm run dev` fala com a instalação real do usuário. As contas extras
 * ficam em `paths.claudeAccountDir()`, aí sim dentro do dado do Atelier.
 */
export function claudeHomeDir(): string {
  return join(homedir(), '.claude')
}
