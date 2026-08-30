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
}

export const QUICK_STARTS: QuickStart[] = [
  { id: 'claude', label: 'Claude Code', agentType: 'claude_code', command: 'claude', icon: 'burst', color: '#D97757' },
  { id: 'codex', label: 'Codex', agentType: 'codex', command: 'codex', icon: 'brain', color: '#10A37F' },
  { id: 'antigravity', label: 'Antigravity', agentType: 'antigravity', command: 'agy', icon: 'sparkle', color: '#4285F4' },
  { id: 'opencode', label: 'OpenCode', agentType: 'open_code', command: 'opencode', icon: 'square', color: '#8E8E93' },
  { id: 'shell', label: 'Shell', agentType: 'generic_shell', command: '', icon: 'terminal', color: '#007AFF' }
]

/** Preset por `id` (`claude`, `codex`, …). null = id desconhecido. */
export function presetById(id: string): QuickStart | null {
  return QUICK_STARTS.find((p) => p.id === id) ?? null
}
