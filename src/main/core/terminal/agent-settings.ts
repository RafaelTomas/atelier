/**
 * O `settings.json` que o Atelier gera para CADA terminal, e entrega ao agente
 * pelo `--settings`.
 *
 * ─── Por que um módulo só para isto ───
 *
 * `--settings` é UM arquivo. Enquanto a `statusLine` do monitor era a única
 * coisa que o Atelier tinha a dizer ao Claude Code, ela podia ser dona dele
 * (era, em terminal/status-line.ts). O Artesão trouxe o segundo dono: os hooks
 * que desligam o subagente interno e injetam a doutrina. Dois módulos escrevendo
 * o mesmo caminho é a receita para um sobrescrever o outro — o monitor perderia
 * a barra, ou o Artesão perderia a recusa, conforme a ordem do dia.
 *
 * Então a posse do arquivo mora aqui, e cada feature contribui um BLOCO:
 * `statusLineBlock()` vem do status-line, os hooks vêm daqui.
 *
 * ─── Por que `--settings`, e não o ~/.claude do usuário ───
 *
 * O `claude` aceita `--settings <arquivo>`, que sobrepõe apenas as chaves
 * passadas e vale só para AQUELA sessão. Escrever no settings.json da conta
 * seria uma alteração permanente na configuração do usuário, feita por um app de
 * canvas, que sobreviveria ao Atelier fechado e apareceria nos terminais que ele
 * abre por fora. O arquivo gerado aqui vive no diretório de dados do Atelier, um
 * por terminal, e é reescrito a cada boot do PTY.
 *
 * ─── O diretório mudou de nome ───
 *
 * Era `<dados>/statusline/`, quando a barra era tudo que havia. Ficou
 * `<dados>/agent-settings/`, porque não é mais. A pasta antiga fica para trás com
 * arquivos que ninguém lê: são alguns KB inertes, reescritos no lugar novo a cada
 * boot, e apagá-los custaria um passo de migração para não ganhar nada.
 *
 * Módulo sem `electron` — o smoke headless exercita a montagem.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UUID } from '@shared/types'
import { isClaudeCommandLine } from '@shared/terminal-presets'
import { cliCommand } from '../interagent/cli-install'
import { dataDir } from '../persistence/paths'
import { statusLineBlock } from './status-line'

/** Onde mora o settings gerado deste terminal. */
export function agentSettingsPath(terminalId: UUID): string {
  return join(dataDir(), 'agent-settings', `${terminalId}.json`)
}

/**
 * Os hooks que TODO nó Claude Code ganha, Artesão ou não.
 *
 * `SessionStart` é o canal desenhado para "acrescente isto ao contexto no
 * início da sessão", e é aqui — não só no Artesão — que o G1 do plano de
 * aderência se resolve: sem este hook, um nó comum não recebe NADA no boot, e
 * o aviso de `injectSkillInto()` (skill-injector.ts) aparece na TELA do
 * usuário, nunca no contexto do agente. `atelier brief` devolve o inventário
 * do canvas — quem está cabeado, o verbo que abre cada um — e a doutrina do
 * Artesão entra como um BLOCO dele quando o nó é um (ver
 * interagent/handlers/brief.ts); não é mais um texto concorrente instalado só
 * para o Artesão.
 */
function sessionStartHook(): { SessionStart: object[] } {
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: cliCommand('brief') }] }]
  }
}

/**
 * `Notification` — o sinal AUTORITATIVO de que o agente parou para pedir algo.
 *
 * Sem ele, a única fonte é a tela, e a tela mente nos dois sentidos: um TUI
 * animado nunca fica calado (quem trabalha parece travado) e um diálogo de
 * permissão congela a tela (quem está travado parece pronto). O Claude Code
 * publica este evento de propósito quando precisa de atenção, e a mensagem vem
 * inteira — enquanto a tela chega com os espaços comidos pelo redesenho.
 *
 * Vale para TODO nó Claude Code, e não só para o Artesão: quem lê o estado é
 * quem coordena, mas quem PRODUZ o estado é o nó que parou, seja ele quem for.
 *
 * `atelier waiting` não imprime nada (ver handlers/waiting.ts). `Notification`
 * não injeta contexto, e escrever aqui só sujaria a tela de quem já está parado.
 */
function notificationHook(): { Notification: object[] } {
  return {
    Notification: [{ hooks: [{ type: 'command', command: cliCommand('waiting') }] }]
  }
}

/**
 * O bloqueio do Artesão — só ele ganha isto.
 *
 * O bloqueio vale para TODO nó Claude Code, e não só para o Artesão.
 *
 * Começou exclusivo do Artesão, com o argumento de que ligar o Artesão num nó
 * não devia mudar o comportamento dos outros. O que mudou de ideia foi ver um nó
 * comum fazer o que o Artesão é impedido de fazer: um sujeito do eval recebeu
 * uma tarefa de canvas e abriu um `Agent(fork)` para executá-la. O trabalho
 * aconteceu, e ficou invisível — outra sessão, outro transcript, nenhum nó na
 * tela. O argumento da doutrina nunca foi sobre o papel de quem delega, é sobre
 * o CANVAS: trabalho que acontece fora dele o usuário não vê, não interrompe e
 * não retoma.
 *
 * `PreToolUse` com matcher `Task` é o bloqueio, e é ele — não uma regra em
 * `permissions.deny` — porque a recusa precisa ENSINAR: o `atelier artesao
 * guard` responde `deny` com a razão, e a razão é o caminho do canvas
 * (`atelier recruit` + `atelier ask`). Uma regra de deny bloquearia calada, e um
 * agente que não sabe por que perdeu a ferramenta tenta de novo.
 *
 * O matcher é `Task`, e não `Agent`, apesar de a ferramenta aparecer na tela do
 * agente como **Agent**: verificado contra o Claude Code 2.1.251, o hook casa
 * pelo nome canônico. Trocar por `Agent` desliga o bloqueio inteiro em silêncio,
 * e o teste que pegaria isso não é o de unidade — é rodar o `claude` de verdade.
 * O matcher também é ESTREITO: com ele instalado, Read, Bash e o resto passam
 * sem tocar no hook.
 */
function taskGuardHook(): { PreToolUse: object[] } {
  return {
    PreToolUse: [
      {
        matcher: 'Task',
        hooks: [{ type: 'command', command: cliCommand('artesao guard') }]
      }
    ]
  }
}

/**
 * O conteúdo do arquivo.
 *
 * Os quatro blocos valem para TODO nó Claude Code: `statusLine`,
 * `hooks.SessionStart` (o brief), `hooks.Notification` (o sinal de espera) e
 * `hooks.PreToolUse` (o bloqueio do subagente).
 *
 * O `opts.artisan` sobrevive porque o BRIEF continua diferente — o Artesão
 * recebe a doutrina inteira —, mas ele não decide mais quem pode abrir
 * subagente. Ver o comentário do bloqueio: trabalho fora do canvas é trabalho
 * que o usuário não vê, venha de qual nó vier.
 */
export function agentSettings(opts: { artisan: boolean } = { artisan: false }): string {
  const hooks = {
    ...sessionStartHook(),
    ...notificationHook(),
    ...taskGuardHook()
  }
  return JSON.stringify({ ...statusLineBlock(), hooks }, null, 2)
}

/**
 * Grava o settings do terminal e devolve o comando com `--settings` anexado.
 *
 * Devolve o comando INTACTO em três casos, e cada um é uma recusa deliberada:
 *
 *  - não é Claude Code — não há `statusLine` nem hook para instalar, e é aqui
 *    que o Artesão de um nó Codex deixa de existir na prática;
 *  - o comando já traz um `--settings` — o do usuário vence, e sobrepor o dele
 *    em silêncio trocaria a configuração que ele escreveu à mão. Consequência
 *    honesta: nesse nó o Artesão não se instala, mesmo marcado;
 *  - a gravação falhou — um `--settings` apontando para arquivo inexistente
 *    faria o `claude` recusar-se a subir, e nem o monitor nem o Artesão valem um
 *    agente que não abre.
 */
export async function withAgentSettings(
  command: string,
  terminalId: UUID,
  opts: {
    /** `CLAUDE_CONFIG_DIR` da conta, ou ausente para a conta padrão (~/.claude). */
    claudeConfigDir?: string
    artisan?: boolean
  } = {}
): Promise<{ command: string; innerCommand: string | null }> {
  if (!command || !isClaudeCommandLine(command)) return { command, innerCommand: null }
  if (/(^|\s)--settings(\s|=)/.test(command)) return { command, innerCommand: null }

  const path = agentSettingsPath(terminalId)
  try {
    await mkdir(join(dataDir(), 'agent-settings'), { recursive: true })
    await writeFile(path, agentSettings({ artisan: opts.artisan === true }), 'utf8')
  } catch {
    return { command, innerCommand: null }
  }

  // Aspas duplas: o comando é DIGITADO no shell do PTY, que pode ser sh, zsh,
  // PowerShell ou cmd. As quatro entendem aspas duplas em volta de um caminho
  // com espaço — o `~` do Windows ("C:\Users\Meu Nome\...") é o caso comum.
  return {
    command: `${command} --settings "${path}"`,
    innerCommand: await existingStatusLine(opts.claudeConfigDir)
  }
}

/**
 * A `statusLine` que o usuário já tinha, se tinha.
 *
 * Vai para `ATELIER_STATUSLINE_INNER`, e o CLI a executa com o mesmo stdin,
 * imprimindo a saída dela: quem já configurou uma barra de status continua
 * vendo a MESMA barra dentro do Atelier. Sem isto, ligar o monitor apagaria em
 * silêncio um pedaço da interface que o usuário montou.
 *
 * Só o tipo `command` é encadeado. Qualquer outra forma que a chave venha a
 * aceitar é ignorada em vez de adivinhada — executar às cegas o que está numa
 * chave que não entendemos é pior do que não encadear.
 */
async function existingStatusLine(claudeConfigDir?: string): Promise<string | null> {
  const dir = claudeConfigDir || join(homedir(), '.claude')
  try {
    const raw = await readFile(join(dir, 'settings.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const line = (parsed as Record<string, unknown>).statusLine
    if (!line || typeof line !== 'object') return null
    const { type, command } = line as Record<string, unknown>
    if (type !== 'command' || typeof command !== 'string' || !command) return null
    // O nosso próprio comando não se encadeia consigo: um usuário que copiou
    // `atelier statusline` para o settings dele criaria um laço infinito de
    // processos, cada um esperando o stdin do seguinte.
    if (/\batelier\b.*\bstatusline\b/.test(command)) return null
    return command
  } catch {
    return null
  }
}
