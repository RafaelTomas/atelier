/**
 * O comando inicial do nó entra como ARGUMENTO do shell, não pelo stdin.
 *
 * Antes ele era digitado 300ms depois do spawn, e a escrita era resolvida pelo
 * nodeId no mapa de sessões. Bastava existir um segundo PTY no mesmo nó para a
 * linha de boot cair dentro de um agente já vivo — foi assim que um Claude Code
 * recém-aberto apareceu com a própria linha de comando escrita na caixa de
 * prompt, sem executar.
 *
 * Como argumento não existe mais aposta de tempo nem destino para errar: o
 * shell nasce com o comando. De quebra ele aparece no `argv`, o que torna o
 * problema visível num `tasklist` da próxima vez.
 *
 * Módulo puro, e o `platform` é parâmetro justamente para o teste poder olhar as
 * três gramáticas de qualquer máquina.
 */

/**
 * No Windows a linha vai como STRING, e não como vetor.
 *
 * O `node-pty` monta a linha de comando dele quando recebe um vetor, seguindo a
 * regra de aspas do CRT — que o `cmd.exe` não segue. Um `--settings
 * "C:\Meus Projetos\x.json"` sairia de lá com `\"` escapado e o `cmd` receberia
 * o caminho partido. Entregando a linha pronta, o que o shell vê é o que
 * escrevemos.
 */
export function bootArgs(
  shell: string,
  command: string,
  platform: NodeJS.Platform = process.platform
): string[] | string {
  const cmd = command.trim()
  if (!cmd) return []

  if (platform === 'win32') {
    if (isPowerShell(shell)) return `-NoExit -Command ${cmd}`
    // Um Git Bash escolhido como shell do nó continua sendo um shell POSIX: um
    // `/k` viraria argumento sem sentido e o comando nunca subiria. Só o
    // `cmd.exe` fala `cmd.exe`; o resto cai na gramática de baixo.
    if (isCmd(shell)) return `/k ${cmd}`
  }

  // O `-c` termina quando o comando termina; o `exec` devolve o shell no lugar
  // dele, para o nó continuar sendo um terminal depois que o agente sair.
  return ['-i', '-c', `${cmd}; exec ${quotePosix(shell)} -i`]
}

function shellName(shell: string): string {
  return shell.split(/[\\/]/).pop()?.toLowerCase() ?? ''
}

function isPowerShell(shell: string): boolean {
  const base = shellName(shell)
  return base.startsWith('powershell') || base.startsWith('pwsh')
}

function isCmd(shell: string): boolean {
  const base = shellName(shell)
  return base === 'cmd.exe' || base === 'cmd'
}

function quotePosix(path: string): string {
  if (/^[\w@%+=:,./-]+$/.test(path)) return path
  // Aspa simples dentro de aspas simples só existe fechando, escapando, e
  // reabrindo: `'` vira `'\''`.
  return `'${path.split("'").join("'\\''")}'`
}
