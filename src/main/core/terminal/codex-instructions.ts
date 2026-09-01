/**
 * O brief do canvas entra no Codex pelo argv daquele PTY, e em lugar nenhum mais.
 *
 * ─── Por que `-c developer_instructions=`, e não um AGENTS.md ───
 *
 * O Claude Code tem hook de `SessionStart`; o Codex não tem hook nenhum. O que
 * ele tem é `-c <chave>=<valor TOML>`, que sobrepõe a config só naquele
 * processo. Com `developer_instructions` o texto chega como a PRIMEIRA mensagem
 * do prompt, `role: developer`, antes de skills, permissões e contexto de
 * ambiente — a mesma posição estrutural que o `additionalContext` do
 * `SessionStart` ocupa no Claude Code. Verificado com
 * `codex debug prompt-input` no `codex-cli 0.151.0`, que renderiza a lista de
 * mensagens sem chamar o modelo.
 *
 * As alternativas foram recusadas, e por motivo, não por gosto
 * (docs/2026-09-01-canais-de-brief-por-preset.md):
 *
 *  - `AGENTS.md` do repositório tem escopo de ÁRVORE DE DIRETÓRIOS, então todo
 *    nó aberto no mesmo repositório leria o mesmo texto. O brief é por nó, por
 *    definição — dois nós no mesmo repo têm cabos diferentes.
 *  - `AGENTS.md` global escreve em `~/.codex`, que é exatamente o que o
 *    cabeçalho de terminal/agent-settings.ts recusa fazer para o Claude Code:
 *    um app de canvas não altera a config permanente do usuário.
 *  - o argumento posicional (`codex "texto"`) entra como turno de USUÁRIO, e
 *    diluiria o brief como se ele tivesse digitado aquilo.
 *
 * Nada é escrito em `~/.codex`. O `developer_instructions` existe enquanto
 * durar o processo — mata o nó, o texto some, igual ao `--settings`.
 *
 * ─── Por que UMA LINHA, com `\n` escapado ───
 *
 * O TOML tem string tripla, e ela aceita newline literal — mas o valor viaja
 * dentro de um ARGUMENTO DE SHELL, e a linha de boot tem três gramáticas
 * (`bootArgs`, em terminal/boot-command.ts). Newline literal dentro de
 * argumento é onde `cmd.exe` desiste. Uma string TOML de linha única com `\n`
 * escapado sai igual do outro lado e não depende de qual shell abriu o nó:
 * medido, o texto volta com os newlines no lugar.
 */

import { handleBrief } from '../interagent/handlers/brief'
import type { UUID } from '@shared/types'
import { isCodexCommandLine } from '@shared/terminal-presets'
import { quotePosix } from './boot-command'

/**
 * O brief como string TOML basic de linha única, aspas incluídas.
 *
 * O que se escapa, e por quê — o brief carrega NOMES DE NÓS, que o usuário
 * digita, então isto é texto de usuário indireto indo para dentro de uma string
 * TOML dentro de um argumento de shell:
 *
 *  - `\` primeiro, sempre. Escapar depois de introduzir barras próprias
 *    escaparia as nossas.
 *  - toda `"`, não só as que formariam `"""`. O brief é cheio delas
 *    (`atelier ask "Name" "the task"`), e decidir quais escapar por vizinhança
 *    é a espécie de regra que erra no caso que ninguém testou.
 *  - os controles, um a um, por `\uXXXX`. TOML proíbe controle cru numa basic
 *    string, e `\r` entra aqui junto: sozinho ele só é legal como metade de um
 *    CRLF, e um brief que passou por editor do Windows tem CR sozinho.
 *  - newline e tab viram `\n` e `\t`, que é o ponto de tudo isto.
 *
 * Um valor mal escapado NÃO derruba o nó: medido no 0.151.0, o Codex cai para
 * a string literal crua quando o TOML não parseia. O que se perde é a
 * legibilidade — o brief chegaria numa linha só, com as barras à mostra — e é
 * por isso que o escape é completo em vez de suficiente.
 */
export function tomlSingleLine(text: string): string {
  const escaped = text
    .split('\\')
    .join('\\\\')
    .split('"')
    .join('\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (c) => {
      return `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`
    })
  return `"${escaped}"`
}

/**
 * Devolve o comando com `-c developer_instructions=…` anexado, ou intacto.
 *
 * Intacto em quatro casos, e cada um é recusa deliberada — o irmão exato de
 * `withAgentSettings`, que faz a mesma coisa para o Claude Code:
 *
 *  - não é Codex. O predicado é o do primeiro token, o mesmo que decide o
 *    `--settings` do Claude, para os dois não discordarem sobre o que é o quê;
 *  - o comando JÁ traz um `developer_instructions` — o do usuário vence, e
 *    sobrepor em silêncio trocaria o que ele escreveu à mão;
 *  - Windows. A citação aqui é `quotePosix`, e o valor é obrigatoriamente cheio
 *    de `"`: as aspas do `cmd.exe` não são as do POSIX nem as do CRT, e as do
 *    PowerShell escapam a aspa simples dobrando-a, não com `'\''`. Nenhuma das
 *    duas foi MEDIDA, e anexar às cegas entrega um brief partido ou um nó que
 *    não abre. Um brief que não chega é melhor que um nó que não sobe, e nesses
 *    nós o canal universal (`ATELIER_BRIEF` no ambiente) continua de pé;
 *  - o brief está vazio. Num canvas sem nada cabeado ele é só o cabeçalho, e
 *    gastar a primeira mensagem do prompt com isso é pior que não gastar.
 */
export function withCodexInstructions(
  command: string,
  terminalId: UUID,
  platform: NodeJS.Platform = process.platform
): string {
  if (!command || !isCodexCommandLine(command)) return command
  if (/developer_instructions\s*=/.test(command)) return command
  if (platform === 'win32') return command

  let brief: string
  try {
    // A MESMA função que atende `atelier brief` pelo socket, igual ao
    // `writeBriefFile`: o texto no argv é idêntico ao que o nó receberia
    // perguntando pelo CLI.
    brief = handleBrief(['brief'], terminalId).trim()
  } catch {
    // Mesma regra do `writeBriefFile`: um brief que não pôde ser renderizado
    // não é motivo para o PTY não subir.
    return command
  }
  if (!brief) return command

  return `${command} -c ${quotePosix(`developer_instructions=${tomlSingleLine(brief)}`)}`
}
