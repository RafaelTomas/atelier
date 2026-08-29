/**
 * Início Rápido do diálogo de botão.
 *
 * Arquivo próprio, e não uma lista a mais em terminal-presets.ts: os presets de
 * terminal são sobre qual AGENTE subir (Claude, Codex, shell), os daqui sobre
 * qual COMANDO rodar. Juntá-los faria o outro arquivo mentir sobre o que é.
 *
 * São só um atalho — preenchem rótulo, comando, ícone e cor, e tudo continua
 * editável nas abas.
 */
export interface ButtonPreset {
  id: string
  label: string
  command: string
  icon: string
  color: string
}

export const BUTTON_PRESETS: ButtonPreset[] = [
  { id: 'dev', label: 'npm run dev', command: 'npm run dev', icon: 'play', color: '#34C759' },
  { id: 'test', label: 'npm test', command: 'npm test', icon: 'flask', color: '#AF52DE' },
  { id: 'build', label: 'npm run build', command: 'npm run build', icon: 'package', color: '#FF9500' },
  { id: 'pull', label: 'git pull', command: 'git pull', icon: 'download', color: '#007AFF' },
  { id: 'compose', label: 'docker compose up', command: 'docker compose up', icon: 'server', color: '#5AC8FA' }
]
