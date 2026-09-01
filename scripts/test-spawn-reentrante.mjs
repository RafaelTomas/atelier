/**
 * Guarda a reentrância do spawn e a entrega do comando inicial.
 *
 * O defeito que gerou este teste não aparece no canvas: um nó abria DOIS PTYs
 * — o efeito do renderer chama `spawn` duas vezes sob `<StrictMode>`, e a
 * guarda antiga lia o mapa de sessões três `await` antes de escrever nele. Cada
 * PTY planejava a própria sessão, os dois gravavam no mesmo `session.json`, e
 * vencia o último a escrever: justamente o agente que não subiu. No boot
 * seguinte o `--resume` pedia uma conversa sem transcrição e o nó voltava
 * virgem, com a conversa real órfã em `~/.claude/projects/`.
 *
 * O segundo assunto é o mesmo defeito visto de fora: a linha de boot era
 * digitada no stdin 300ms depois do spawn, e caía dentro do agente vivo do
 * outro PTY. Agora ela nasce como argumento do shell — e as três gramáticas são
 * verificáveis de qualquer máquina, com caminho que tem espaço.
 *
 * Uso: node scripts/test-spawn-reentrante.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const outdir = await mkdtemp(join(tmpdir(), 'atelier-spawn-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { SpawnRegistry } from './src/main/core/terminal/spawn-registry.ts'
      export { bootArgs } from './src/main/core/terminal/boot-command.ts'
      export { buildTerminalEnv } from './src/main/core/terminal/terminal-manager.ts'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['electron', 'node-pty'],
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})

const { SpawnRegistry, bootArgs, buildTerminalEnv } = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
  }
}

console.log('\nspawn reentrante\n')

const NODE = 'D7380F24-8461-4F7D-AA53-8B5C09E84E7A'

/** Uma fábrica que conta chamadas e só assenta quando este teste mandar. */
function deferred() {
  let resolveIt
  let rejectIt
  const promise = new Promise((res, rej) => {
    resolveIt = res
    rejectIt = rej
  })
  return { promise, resolve: resolveIt, reject: rejectIt }
}

// ─── A reserva ────────────────────────────────────────────────────────────────

await test('duas chamadas concorrentes viram uma só abertura', async () => {
  const reg = new SpawnRegistry()
  const d = deferred()
  let chamadas = 0
  const fabrica = () => {
    chamadas++
    return d.promise
  }

  // O <StrictMode> entrega exatamente isto: montar/desmontar/montar, sem que a
  // primeira chamada tenha tido tempo de terminar.
  const a = reg.run(NODE, fabrica)
  const b = reg.run(NODE, fabrica)

  assert.equal(chamadas, 1, 'a fábrica rodou duas vezes — dois PTYs no mesmo nó')
  assert.equal(a, b, 'a segunda chamada recebeu outra promessa')

  d.resolve({ id: NODE })
  assert.deepEqual(await a, { id: NODE })
  assert.deepEqual(await b, { id: NODE }, 'o segundo chamador ficou sem sessão')
})

await test('nós diferentes não compartilham reserva', async () => {
  const reg = new SpawnRegistry()
  let chamadas = 0
  const fabrica = () => {
    chamadas++
    return Promise.resolve(null)
  }
  await Promise.all([reg.run(NODE, fabrica), reg.run('OUTRO-NO', fabrica)])
  assert.equal(chamadas, 2)
})

await test('a reserva é liberada quando a abertura termina', async () => {
  // Sem isto o `recoverClean()` deixa de funcionar: ele apaga a sessão e chama
  // `spawn()` de novo para o mesmo nó, e precisa de um PTY novo de verdade.
  const reg = new SpawnRegistry()
  let chamadas = 0
  const fabrica = () => {
    chamadas++
    return Promise.resolve({ id: NODE })
  }

  await reg.run(NODE, fabrica)
  assert.equal(reg.size, 0, 'o nó ficou preso no registro depois de abrir')
  await reg.run(NODE, fabrica)
  assert.equal(chamadas, 2, 'a segunda subida recebeu a promessa velha')
})

await test('abertura que falha também libera — um erro não tranca o nó', async () => {
  const reg = new SpawnRegistry()
  let chamadas = 0
  const fabrica = () => {
    chamadas++
    return Promise.reject(new Error('node-pty não carregou'))
  }

  await assert.rejects(() => reg.run(NODE, fabrica), /node-pty/)
  assert.equal(reg.size, 0, 'o nó ficou trancado para sempre por uma falha')
  await assert.rejects(() => reg.run(NODE, fabrica))
  assert.equal(chamadas, 2)
})

await test('fábrica que lança de forma síncrona não reserva nada', async () => {
  const reg = new SpawnRegistry()
  await assert.rejects(
    () =>
      reg.run(NODE, () => {
        throw new Error('explodiu antes de prometer')
      }),
    /explodiu/
  )
  assert.equal(reg.size, 0)
  assert.equal(reg.pending(NODE), undefined)
})

// ─── A entrega do comando ─────────────────────────────────────────────────────
//
// O caminho com ESPAÇO é o ponto: antes o comando era digitado num prompt, e
// agora é argumento. `--settings "C:\\Meus Projetos\\x.json"` é o formato real
// da statusLine, e é o que quebra se as aspas se perderem no caminho.

const CLAUDE = 'claude --session-id ABC --settings "C:\\Meus Projetos\\node.json"'

// O prefixo que repõe o bin do Atelier no PATH, uma vez por gramática. Ele vem
// ANTES do comando em todas as três: o profile do usuário já rodou (o `-i`), e
// é depois dele que a reposição precisa acontecer. Ver boot-command.ts.
const REPATH_POSIX =
  'if [ -n "$ATELIER_BIN" ]; then case ":$PATH:" in *":$ATELIER_BIN:"*) ;; ' +
  '*) PATH="$ATELIER_BIN:$PATH"; export PATH;; esac; fi;'
const REPATH_CMD = 'if defined ATELIER_BIN set "PATH=%ATELIER_BIN%;%PATH%" &'
const REPATH_PS = 'if ($env:ATELIER_BIN) { $env:PATH = "$env:ATELIER_BIN;$env:PATH" };'

await test('cmd.exe recebe /k e a linha inteira, com as aspas intactas', () => {
  const args = bootArgs('C:\\WINDOWS\\system32\\cmd.exe', CLAUDE, 'win32')
  // String, e não vetor: o node-pty monta a linha dele com a regra de aspas do
  // CRT, que o cmd.exe não segue — o caminho sairia partido.
  assert.equal(typeof args, 'string')
  assert.equal(args, `/k ${REPATH_CMD} ${CLAUDE}`)
  assert.ok(args.includes('"C:\\Meus Projetos\\node.json"'))
})

await test('powershell recebe -NoExit -Command', () => {
  assert.equal(
    bootArgs('C:\\...\\powershell.exe', CLAUDE, 'win32'),
    `-NoExit -Command ${REPATH_PS} ${CLAUDE}`
  )
  assert.equal(
    bootArgs('pwsh.exe', 'claude', 'win32'),
    `-NoExit -Command ${REPATH_PS} claude`
  )
})

await test('Git Bash no Windows não recebe /k — ele é um shell POSIX', () => {
  // O shell do nó é escolhido pelo usuário. Mandar `/k` para um bash daria um
  // argumento sem sentido e o agente nunca subiria.
  const args = bootArgs('C:\\Program Files\\Git\\bin\\bash.exe', 'claude', 'win32')
  assert.deepEqual(args, [
    '-i',
    '-c',
    `${REPATH_POSIX} claude; exec 'C:\\Program Files\\Git\\bin\\bash.exe' -i`
  ])
})

await test('posix roda o comando e devolve o shell no lugar dele', () => {
  const args = bootArgs('/bin/zsh', 'claude --session-id ABC', 'darwin')
  assert.deepEqual(args, [
    '-i',
    '-c',
    `${REPATH_POSIX} claude --session-id ABC; exec /bin/zsh -i`
  ])
})

await test('shell posix com espaço no caminho sai entre aspas', () => {
  const args = bootArgs('/opt/my shell/bash', 'claude', 'linux')
  assert.equal(args[2], `${REPATH_POSIX} claude; exec '/opt/my shell/bash' -i`)
})

await test('sem comando, o shell sobe pelado — o nó é só um terminal', () => {
  // Um `generic_shell` não tem comando, e um `/k` vazio deixaria o cmd.exe com
  // um argumento a mais sem nenhum ganho.
  for (const [shell, plat] of [
    ['cmd.exe', 'win32'],
    ['powershell.exe', 'win32'],
    ['bash.exe', 'win32'],
    ['/bin/zsh', 'darwin']
  ]) {
    assert.deepEqual(bootArgs(shell, '', plat), [], `${shell} não subiu pelado`)
    assert.deepEqual(bootArgs(shell, '   ', plat), [], `${shell} aceitou espaço em branco`)
  }
})

// ─── O bin do Atelier sobrevive ao profile do usuário ─────────────────────────
//
// Estes não olham o formato do prefixo, e sim o que ele faz: o defeito era um
// agente digitando `atelier list` e acertando o launcher do app em
// /usr/bin/atelier, porque o ~/.bashrc do usuário faz `export PATH=<lista
// absoluta>` e apaga o que buildTerminalEnv prependou. O prefixo roda DEPOIS do
// profile, e é por isso que ele é a correção.

await test('buildTerminalEnv publica ATELIER_BIN — o diretório, não o arquivo', () => {
  // Sem o diretório no ambiente o prefixo do boot não tem o que repor:
  // ATELIER_CLI é o arquivo, e `PATH=<arquivo>` não resolve nada.
  const env = buildTerminalEnv({
    terminalId: '11111111-1111-4111-8111-111111111111',
    serverPort: 0
  })
  assert.ok(env.ATELIER_BIN, 'ATELIER_BIN ausente')
  assert.equal(env.ATELIER_CLI, join(env.ATELIER_BIN, 'atelier'))
  assert.equal(env.PATH.split(':')[0], env.ATELIER_BIN, 'o bin não entrou na frente')
})

await test('um cofre não consegue sequestrar ATELIER_BIN', () => {
  // A chave é um PATH executável do agente: quem a define escolhe qual binário
  // atende por `atelier`. Ela cai na mesma trava de ATELIER_SOCKET.
  const env = buildTerminalEnv({
    terminalId: '11111111-1111-4111-8111-111111111111',
    serverPort: 0,
    extraEnv: { ATELIER_BIN: '/bin/do-atacante' }
  })
  assert.notEqual(env.ATELIER_BIN, '/bin/do-atacante')
})

await test('o prefixo vem antes do comando, nas três gramáticas', () => {
  // Se vier depois, o agente já subiu com o PATH errado e não adianta mais.
  const posix = bootArgs('/bin/bash', 'claude', 'linux')
  assert.ok(posix[2].indexOf('ATELIER_BIN') < posix[2].indexOf('claude'))
  assert.ok(bootArgs('cmd.exe', 'claude', 'win32').indexOf('ATELIER_BIN') < 
    bootArgs('cmd.exe', 'claude', 'win32').indexOf('claude'))
  assert.ok(bootArgs('pwsh.exe', 'claude', 'win32').indexOf('ATELIER_BIN') <
    bootArgs('pwsh.exe', 'claude', 'win32').indexOf('claude'))
})

if (process.platform !== 'win32') {
  // Um bash de verdade, com um profile de verdade que apaga o PATH — que é
  // exatamente o que a máquina do defeito faz.
  const fakeHome = await mkdtemp(join(tmpdir(), 'atelier-profile-'))
  const fakeBin = await mkdtemp(join(tmpdir(), 'atelier-bin-'))
  await writeFile(join(fakeHome, '.bashrc'), 'export PATH=/usr/bin:/bin\n')

  // O prefixo isolado: o `exec` do fim penduraria o processo do teste.
  const prefixOf = (cmd) => bootArgs('/bin/bash', cmd, 'linux')[2].split('; exec ')[0]

  const runBash = (env) =>
    execFileSync('/bin/bash', ['-i', '-c', prefixOf('printf %s "$PATH"')], {
      env: { HOME: fakeHome, PATH: '/usr/bin:/bin', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })

  await test('com ATELIER_BIN, o bin volta na frente mesmo com o profile apagando o PATH', () => {
    const out = runBash({ ATELIER_BIN: fakeBin })
    assert.equal(out.split(':')[0], fakeBin, `o profile venceu: ${out}`)
  })

  await test('rodar duas vezes não duplica a entrada — o PATH não cresce', () => {
    // O nó reexecuta o shell (`exec ... -i`) quando o agente sai. Um PATH que
    // só cresce é o tipo de coisa que ninguém percebe até ficar grande.
    const twice = prefixOf('true') + '; ' + prefixOf('printf %s "$PATH"')
    const out = execFileSync('/bin/bash', ['-i', '-c', twice], {
      env: { HOME: fakeHome, PATH: '/usr/bin:/bin', ATELIER_BIN: fakeBin },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    assert.equal(out.split(':').filter((p) => p === fakeBin).length, 1, out)
  })

  await test('sem ATELIER_BIN o PATH fica intacto — nada de `:` na frente', () => {
    // `PATH=":$PATH"` inclui o DIRETÓRIO ATUAL: qualquer `ls` plantado no cwd
    // viraria executável. O guarda de vazio é segurança, não zelo.
    const out = runBash({})
    assert.ok(!out.startsWith(':'), `PATH com entrada vazia na frente: ${out}`)
    assert.ok(!out.includes('::'), `PATH com entrada vazia no meio: ${out}`)
    assert.equal(out, '/usr/bin:/bin')
  })

  await rm(fakeHome, { recursive: true, force: true })
  await rm(fakeBin, { recursive: true, force: true })
}

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
