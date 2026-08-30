/**
 * Presets de terminal — os cinco do "Início Rápido".
 *
 * Mora em `shared/` e não no renderer porque tem DOIS consumidores: o diálogo
 * de novo terminal e o `atelier recruit`, que cria o nó a partir do main. Cor,
 * ícone e comando têm que ser os mesmos nos dois caminhos — um agente recrutado
 * pelo CLI que nascesse com outra cor seria outro tipo de nó aos olhos do
 * usuário.
 *
 * O resto de `renderer/terminal-presets.ts` (cores da aba Aparência, temas do
 * xterm) continua lá: é escolha de UI, e o main não tem o que fazer com ela.
 */
export interface QuickStart {
  id: string
  label: string
  agentType: string
  /** Vazio = abre o shell sem rodar nada. */
  command: string
  icon: string
  color: string
  model?: ModelSelector
}

export interface ModelSelector {
  flag: '--model' | '-m'
  aliases: Record<string, string>
}

export const QUICK_STARTS: QuickStart[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    agentType: 'claude_code',
    command: 'claude',
    icon: 'burst',
    color: '#D97757',
    model: {
      flag: '--model',
      aliases: { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' }
    }
  },
  {
    id: 'codex',
    label: 'Codex',
    agentType: 'codex',
    command: 'codex',
    icon: 'brain',
    color: '#10A37F',
    model: {
      flag: '--model',
      aliases: {
        luna: 'gpt-5.6-luna',
        terra: 'gpt-5.6-terra',
        sol: 'gpt-5.6-sol'
      }
    }
  },
  { id: 'antigravity', label: 'Antigravity', agentType: 'antigravity', command: 'agy', icon: 'sparkle', color: '#4285F4' },
  { id: 'opencode', label: 'OpenCode', agentType: 'open_code', command: 'opencode', icon: 'square', color: '#8E8E93' },
  { id: 'shell', label: 'Shell', agentType: 'generic_shell', command: '', icon: 'terminal', color: '#007AFF' }
]

/**
 * A linha de comando roda o Claude Code?
 *
 * Mora aqui, e não no main, porque tem os mesmos DOIS consumidores do resto
 * deste arquivo. É ela que decide, no main, se o terminal ganha o `--settings`
 * com a statusLine e os hooks do Artesão (terminal/agent-settings.ts) — e é ela
 * que o diálogo tem que consultar para habilitar o checkbox do Artesão. Com dois
 * predicados parecidos, um marcaria o que o outro não gravaria, que é a classe
 * de bug que o cabeçalho de models/terminal-draft.ts descreve.
 *
 * O teste é sobre o PRIMEIRO token, não sobre o texto inteiro: o usuário pode
 * ter escrito `claude --resume` ou `claude -p "..."`, e as duas continuam sendo
 * Claude Code. `npx claude` não é — quem sobe ali é o `npx`, e o `--settings`
 * anexado no fim iria para o lugar errado.
 *
 * Distinto do `isClaudeCommand` de `renderer/claude-accounts.ts`, que também
 * aceita o `agentType` e é a pergunta mais larga "este nó é um Claude?" — a de
 * lá decide se o seletor de CONTA aparece, e uma conta faz sentido mesmo num
 * comando que este predicado recusa.
 */
export function isClaudeCommandLine(command: string): boolean {
  // `commandBinary` tira diretório e extensão: `/usr/local/bin/claude` e
  // `claude.cmd` contam.
  return commandBinary(command) === 'claude'
}

/** O primeiro token do comando, sem diretório e sem extensão. */
function commandBinary(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return (first.split(/[\\/]/).pop() ?? '').replace(/\.(cmd|exe|bat|ps1)$/i, '')
}

/** Os binários dos presets que são agentes de IA — o `shell` fica de fora. */
const AGENT_BINARIES = new Set(
  QUICK_STARTS.filter((p) => p.command).map((p) => commandBinary(p.command))
)

/**
 * Este terminal pode ser um Artesão?
 *
 * Qualquer agente de IA pode: Claude, Codex, Antigravity, OpenCode. O que NÃO
 * pode é o shell puro — não há a quem instruir, e um nó de `bash` com badge de
 * Artesão seria enfeite.
 *
 * A FORÇA do Artesão varia, e o diálogo diz qual o usuário está levando: no
 * Claude Code o subagente interno é bloqueado por hook (terminal/agent-settings.ts);
 * nos outros a regra é instruída — chega pelo `ATELIER_ARTESAO` no ambiente e
 * pelo cabeçalho que o `atelier list` passa a trazer — mas não há o que bloqueie.
 * Prometer bloqueio onde não existe seria pior que não oferecer.
 *
 * Duas portas de entrada porque as duas são legítimas: o `agentType` vem do
 * Início Rápido e do `recruit`, e o comando é a rede para quem digitou o binário
 * à mão num terminal genérico.
 */
export function isArtisanCapable(t: { agentType: string; command: string }): boolean {
  if (AGENT_BINARIES.has(commandBinary(t.command))) return true
  return t.agentType !== 'generic_shell' && t.command.trim() !== ''
}

/**
 * A identidade visual do Artesão: o martelo, o verde, e o nome de partida.
 *
 * Mora aqui junto dos presets porque é a mesma natureza — o que um nó veste
 * quando o usuário diz o que ele é. O nome é um PONTO DE PARTIDA: marcar a
 * caixa não sobrescreve um nome que o usuário digitou.
 */
export const ARTISAN_NAME = 'Artesão'
export const ARTISAN_ICON = 'hammer'
export const ARTISAN_COLOR = '#34C759'

/** Preset por `id` (`claude`, `codex`, …). null = id desconhecido. */
export function presetById(id: string): QuickStart | null {
  return QUICK_STARTS.find((p) => p.id === id) ?? null
}
