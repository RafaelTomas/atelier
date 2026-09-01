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
    if (isPowerShell(shell)) return `-NoExit -Command ${REPATH.powershell} ${cmd}`
    // Um Git Bash escolhido como shell do nó continua sendo um shell POSIX: um
    // `/k` viraria argumento sem sentido e o comando nunca subiria. Só o
    // `cmd.exe` fala `cmd.exe`; o resto cai na gramática de baixo.
    if (isCmd(shell)) return `/k ${REPATH.cmd} ${cmd}`
  }

  // O `-c` termina quando o comando termina; o `exec` devolve o shell no lugar
  // dele, para o nó continuar sendo um terminal depois que o agente sair.
  return ['-i', '-c', `${REPATH.posix} ${cmd}; exec ${quotePosix(shell)} -i`]
}

/**
 * Repõe o bin do Atelier no PATH, DENTRO do comando de boot.
 *
 * `buildTerminalEnv` já prepende o diretório no ambiente do PTY, e não basta: o
 * `-i` logo abaixo faz o shell carregar o profile do usuário, e um profile que
 * faz `export PATH=<lista absoluta>` — o desta máquina faz, e é o padrão em
 * qualquer máquina gerenciada — apaga o que foi prependado. O agente que
 * digitava `atelier list` acertava o launcher do app em /usr/bin/atelier e
 * tentava subir uma segunda instância.
 *
 * Aqui é depois do profile, então é o que fica. Duas condições valem por si:
 *
 *   - o guarda de vazio não é zelo. `PATH="$ATELIER_BIN:$PATH"` com a variável
 *     ausente deixa um `:` na frente, e um PATH que começa com `:` inclui o
 *     DIRETÓRIO ATUAL — qualquer `ls` plantado no cwd passaria a ser executável.
 *   - repor duas vezes é inofensivo (o mesmo caminho na frente duas vezes), mas
 *     acontece a cada `exec` do shell de baixo, e um PATH que só cresce é o tipo
 *     de coisa que ninguém percebe até ficar grande. O `case` sai fora quando o
 *     caminho já está lá.
 */
const REPATH = {
  posix:
    'if [ -n "$ATELIER_BIN" ]; then case ":$PATH:" in *":$ATELIER_BIN:"*) ;; ' +
    '*) PATH="$ATELIER_BIN:$PATH"; export PATH;; esac; fi;',
  // No `cmd` o separador é `;` e o `&` encadeia sem exigir sucesso do anterior.
  cmd: 'if defined ATELIER_BIN set "PATH=%ATELIER_BIN%;%PATH%" &',
  powershell: 'if ($env:ATELIER_BIN) { $env:PATH = "$env:ATELIER_BIN;$env:PATH" };'
} as const

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
