/**
 * Guarda a retomada de sessão do agente.
 *
 * O que quebra aqui não aparece na tela: um id que sobrevive a uma troca de
 * diretório manda o `claude --resume` para o projeto errado; um id gravado para
 * um preset que não sabe retomar vira uma flag que o CLI não conhece e o agente
 * morre na largada; um arquivo corrompido que lançasse impediria o terminal de
 * abrir. Nenhum desses três é visível olhando o canvas.
 *
 * Uso: node scripts/test-session-resume.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

// `paths` lê ATELIER_HOME no import: precisa estar de pé antes do bundle rodar.
const home = await mkdtemp(join(tmpdir(), 'atelier-session-'))
process.env.ATELIER_HOME = home

const outdir = await mkdtemp(join(tmpdir(), 'atelier-session-core-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export {
        RESUME_SUPPORT,
        claudeProjectSlug,
        supportsResume,
        withSession
      } from './src/main/core/terminal/agent-resume.ts'
      export {
        clearSession,
        readSession,
        sessionIsUsable,
        transcriptState,
        writeSession
      } from './src/main/core/terminal/session-store.ts'
      export { listClaudeSessions } from './src/main/core/terminal/claude-sessions.ts'
      export { paths } from './src/main/core/persistence/paths.ts'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['electron'],
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})

const {
  RESUME_SUPPORT,
  claudeProjectSlug,
  supportsResume,
  withSession,
  clearSession,
  readSession,
  sessionIsUsable,
  transcriptState,
  writeSession,
  listClaudeSessions,
  paths
} = await import(pathToFileURL(outfile).href)

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

console.log('\nretomada de sessão\n')

const WS = 'AAAAAAAA-0000-0000-0000-00000000WS01'
const NODE = 'BBBBBBBB-0000-0000-0000-00000000ND01'
const SID = 'CCCCCCCC-0000-0000-0000-0000000SESS1'

// ─── A tabela de capacidade ───────────────────────────────────────────────────

await test('só claude_code sabe retomar — os outros não ganham flag nenhuma', () => {
  assert.equal(supportsResume('claude_code'), true)
  // Não é omissão: codex e antigravity têm retomada com outra gramática que
  // ninguém verificou, e inventar a flag daria um comando que morre na largada.
  for (const t of ['codex', 'antigravity', 'open_code', 'generic_shell', '']) {
    assert.equal(supportsResume(t), false, `${t} não deveria ter suporte`)
  }
})

await test('withSession monta --session-id no primeiro boot e --resume no seguinte', () => {
  assert.equal(withSession('claude', 'claude_code', SID, 'new'), `claude --session-id ${SID}`)
  assert.equal(withSession('claude', 'claude_code', SID, 'resume'), `claude --resume ${SID}`)
  // Argumentos que o usuário já escreveu continuam lá.
  assert.equal(
    withSession('claude --model haiku', 'claude_code', SID, 'new'),
    `claude --model haiku --session-id ${SID}`
  )
})

await test('agente sem suporte sai com o comando intacto', () => {
  assert.equal(withSession('codex', 'codex', SID, 'new'), 'codex')
  assert.equal(withSession('', 'claude_code', SID, 'new'), '')
})

await test('flag de sessão escrita à mão pelo usuário vence a nossa', () => {
  // Dois --resume no mesmo comando é recusado pelo CLI: o agente não abriria.
  const meu = 'claude --resume 42977e34-0000-0000-0000-000000000000'
  assert.equal(withSession(meu, 'claude_code', SID, 'resume'), meu)
  assert.equal(withSession('claude --continue', 'claude_code', SID, 'new'), 'claude --continue')
})

await test('a tabela aceita uma entrada nova sem tocar no resto', () => {
  // O caminho de "agente que suporta" fica exercitável sem depender de nenhum
  // CLI instalado no CI — é para isso que `withSession` recebe a tabela.
  const falsa = {
    fake_agent: {
      newSession: (id) => ['-s', id],
      resume: (id) => ['-r', id],
      resumeFailed: () => false,
      transcript: () => ({ dir: '/nada', files: [] })
    }
  }
  assert.equal(withSession('fake', 'fake_agent', SID, 'resume', falsa), `fake -r ${SID}`)
  assert.equal(RESUME_SUPPORT.fake_agent, undefined, 'a tabela real foi contaminada')
})

// ─── O arquivo de sessão ──────────────────────────────────────────────────────

await test('session.json faz round-trip, ao lado do scrollback', async () => {
  await writeSession(WS, NODE, {
    agentType: 'claude_code',
    sessionId: SID,
    cwd: '/proj',
    startedAt: '2026-08-28T10:00:00.000Z'
  })
  const back = await readSession(WS, NODE)
  assert.deepEqual(back, {
    agentType: 'claude_code',
    sessionId: SID,
    cwd: '/proj',
    startedAt: '2026-08-28T10:00:00.000Z'
  })
  // Fora do workspace.json de propósito: o app nativo Swift descartaria um
  // campo novo dentro de TerminalContent no primeiro save dele.
  assert.ok(paths.terminalSession(WS, NODE).includes('terminals'))
  assert.ok(!paths.terminalSession(WS, NODE).includes('workspace.json'))
})

await test('arquivo ausente devolve null, e null significa "sobe limpo"', async () => {
  assert.equal(await readSession(WS, 'DDDDDDDD-0000-0000-0000-00000000ND99'), null)
})

await test('arquivo corrompido não lança — um terminal não pode deixar de abrir', async () => {
  const path = paths.terminalSession(WS, NODE)
  await writeFile(path, '{ isto não é json', 'utf8')
  assert.equal(await readSession(WS, NODE), null)

  // Campos com o tipo errado também: o arquivo é editável à mão.
  await writeFile(path, JSON.stringify({ agentType: 'claude_code', sessionId: 42 }), 'utf8')
  assert.equal(await readSession(WS, NODE), null)
})

await test('clearSession apaga, e apagar duas vezes não é erro', async () => {
  await writeSession(WS, NODE, {
    agentType: 'claude_code',
    sessionId: SID,
    cwd: '/proj',
    startedAt: ''
  })
  await clearSession(WS, NODE)
  assert.equal(await readSession(WS, NODE), null)
  await clearSession(WS, NODE)
})

// ─── Quando o id vale ─────────────────────────────────────────────────────────

const sess = (over = {}) => ({
  agentType: 'claude_code',
  sessionId: SID,
  cwd: '/proj',
  startedAt: '',
  ...over
})

await test('id vale quando tipo, cwd e suporte batem', () => {
  assert.equal(sessionIsUsable(sess(), 'claude_code', '/proj', supportsResume), true)
})

await test('cwd diferente DESCARTA o id — sessão do Claude é por diretório', () => {
  // Um agente novo é melhor que uma retomada que erra o projeto.
  assert.equal(sessionIsUsable(sess(), 'claude_code', '/outro', supportsResume), false)
})

await test('trocar o agente do nó descarta o id — a gramática é do outro CLI', () => {
  assert.equal(sessionIsUsable(sess(), 'codex', '/proj', supportsResume), false)
})

await test('agente sem suporte nunca retoma, mesmo com arquivo gravado', () => {
  assert.equal(sessionIsUsable(sess({ agentType: 'codex' }), 'codex', '/proj', supportsResume), false)
})

await test('cwd vazio (arquivo de versão antiga) é aceito', () => {
  // O caso comum é o diretório não ter mudado; se tiver, o `--resume` falha
  // rápido e o guarda de saída precoce cai para sessão limpa.
  assert.equal(sessionIsUsable(sess({ cwd: '' }), 'claude_code', '/proj', supportsResume), true)
})

await test('sem arquivo não há retomada', () => {
  assert.equal(sessionIsUsable(null, 'claude_code', '/proj', supportsResume), false)
})

// ─── A sequência de dois boots ────────────────────────────────────────────────

await test('segunda subida usa --resume com o id gravado na primeira', async () => {
  const NODE2 = 'EEEEEEEE-0000-0000-0000-00000000ND02'
  await clearSession(WS, NODE2)

  // Boot 1: nada gravado → o Atelier GERA o id e o entrega ao agente.
  const primeiro = await readSession(WS, NODE2)
  assert.equal(primeiro, null)
  const novo = 'FFFFFFFF-0000-0000-0000-0000000SESS2'
  const cmd1 = withSession('claude', 'claude_code', novo, 'new')
  assert.equal(cmd1, `claude --session-id ${novo}`)
  await writeSession(WS, NODE2, {
    agentType: 'claude_code',
    sessionId: novo,
    cwd: '/proj',
    startedAt: new Date().toISOString()
  })

  // Boot 2: o id está lá e vale → retoma, com o MESMO id.
  const salvo = await readSession(WS, NODE2)
  assert.ok(sessionIsUsable(salvo, 'claude_code', '/proj', supportsResume))
  assert.equal(withSession('claude', 'claude_code', salvo.sessionId, 'resume'), `claude --resume ${novo}`)
})

await test('"Sessão nova" apaga o id, e o boot seguinte gera outro', async () => {
  const NODE3 = 'AAAAAAAA-1111-0000-0000-00000000ND03'
  await writeSession(WS, NODE3, {
    agentType: 'claude_code',
    sessionId: SID,
    cwd: '/proj',
    startedAt: ''
  })
  await clearSession(WS, NODE3)
  assert.equal(await readSession(WS, NODE3), null, 'o id sobreviveu ao descarte')
})

await test('a gravação é atômica — nenhum .tmp fica para trás', async () => {
  const NODE4 = 'AAAAAAAA-2222-0000-0000-00000000ND04'
  await writeSession(WS, NODE4, {
    agentType: 'claude_code',
    sessionId: SID,
    cwd: '/p',
    startedAt: ''
  })
  const alvo = paths.terminalSession(WS, NODE4)
  await readFile(alvo, 'utf8')
  await assert.rejects(() => readFile(`${alvo}.tmp`, 'utf8'))
})

// ─── A sessão que nunca existiu ───────────────────────────────────────────────
//
// O buraco que gerou tudo isto: `--session-id` RESERVA um id, mas o Claude Code
// só grava a transcrição na primeira mensagem. Um nó aberto e nunca usado tinha
// id gravado e nenhuma conversa — e voltava do restart com "No conversation
// found with session ID" e um prompt pelado.

await test('o slug do projeto é o caminho com tudo que não é letra virando "-"', () => {
  assert.equal(claudeProjectSlug('C:\\Users\\etass'), 'C--Users-etass')
  assert.equal(claudeProjectSlug('E:\\Projetos\\atelier'), 'E--Projetos-atelier')
  assert.equal(claudeProjectSlug('/home/eu/proj'), '-home-eu-proj')
})

await test('a transcrição é procurada nas duas caixas do id', () => {
  const loc = RESUME_SUPPORT.claude_code.transcript('/cfg', '/home/eu/proj', SID)
  assert.ok(loc.dir.endsWith(join('projects', '-home-eu-proj')))
  // Num FS sensível a caixa, checar só uma forma daria "não existe" para uma
  // sessão que existe: o id vai gravado como veio no `--session-id`.
  assert.deepEqual(loc.files, [`${SID}.jsonl`, `${SID.toLowerCase()}.jsonl`])
})

await test('transcriptState: existe → yes, pasta sem o arquivo → no', async () => {
  const proj = join(home, 'projects', 'P1')
  await mkdir(proj, { recursive: true })
  const loc = { dir: proj, files: ['x.jsonl', 'X.jsonl'] }
  // A pasta do projeto existe e o arquivo não: o id foi reservado e nunca usado.
  assert.equal(await transcriptState(loc), 'no')
  await writeFile(join(proj, 'x.jsonl'), '{}', 'utf8')
  assert.equal(await transcriptState(loc), 'yes')
})

await test('pasta inexistente é "unknown" — a dúvida RETOMA, não descarta', async () => {
  // A regra de nome é de outro app. Se ela mudar, a checagem se desliga sozinha
  // em vez de matar a retomada de quem tem conversa de verdade; a queda, se
  // vier, é apanhada na tela pelo guarda de `resumeFailed`.
  assert.equal(await transcriptState({ dir: join(home, 'nao-existe'), files: ['a.jsonl'] }), 'unknown')
  assert.equal(await transcriptState(null), 'unknown')
})

// ─── A recusa na tela ─────────────────────────────────────────────────────────
//
// Segunda rede, e a única que funciona no caminho normal: o PTY é o SHELL, e o
// agente é digitado dentro dele. Quando o `--resume` falha quem sai é o
// `claude`; o `cmd.exe` continua vivo e o `onExit` do PTY nunca dispara.

await test('a frase de recusa do Claude Code é reconhecida', () => {
  const tela = [
    'C:\\Users\\etass>claude --resume EF17BA0F-180F-46EE-A1E7-67BD058C43A0',
    'No conversation found with session ID:',
    'EF17BA0F-180F-46EE-A1E7-67BD058C43A0',
    'C:\\Users\\etass>'
  ].join('\n')
  assert.equal(RESUME_SUPPORT.claude_code.resumeFailed(tela), true)
})

await test('a frase é casada SEM o id — o nó quebra a linha no meio dele', () => {
  // Foi exatamente o que aconteceu na tela real: o id partido em duas linhas.
  const partido = 'No conversation found with session ID: EF17BA0F-180F-46EE-A1E7-67BD058'+'\n'+'C43A0'
  assert.equal(RESUME_SUPPORT.claude_code.resumeFailed(partido), true)
})

await test('tela normal de agente não é confundida com recusa', () => {
  for (const tela of ['', 'Claude Code v2.1.251', 'sessao retomada EF17BA0F', 'resume failed?']) {
    assert.equal(RESUME_SUPPORT.claude_code.resumeFailed(tela), false, tela)
  }
})

// ─── A lista de sessões anteriores (o select "Retomar sessão") ────────────────
//
// A fonte é `<configDir>/projects/<slug>/*.jsonl`, diretório de OUTRO app: tudo
// aqui é defensivo. Pasta ausente, arquivo ilegível ou linha de JSON quebrada
// não podem derrubar a lista — no máximo somem dela.

const CFG = join(home, 'cfg')
const CWD = '/proj/atelier'
const projDir = join(CFG, 'projects', claudeProjectSlug(CWD))

const jsonl = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
const userLine = (text) => ({ type: 'user', message: { role: 'user', content: text } })

await test('pasta de projeto inexistente devolve lista vazia, não exceção', async () => {
  assert.deepEqual(await listClaudeSessions(join(home, 'nao-existe'), CWD), [])
})

await test('lista as sessões do cwd, da mais recente para a mais antiga', async () => {
  await mkdir(projDir, { recursive: true })
  const antiga = '11111111-1111-1111-1111-111111111111'
  const nova = '22222222-2222-2222-2222-222222222222'
  await writeFile(join(projDir, `${antiga}.jsonl`), jsonl(userLine('a primeira tarefa')), 'utf8')
  await writeFile(join(projDir, `${nova}.jsonl`), jsonl(userLine('a tarefa de agora')), 'utf8')
  await utimes(join(projDir, `${antiga}.jsonl`), new Date('2026-01-01'), new Date('2026-01-01'))
  await utimes(join(projDir, `${nova}.jsonl`), new Date('2026-08-01'), new Date('2026-08-01'))

  const list = await listClaudeSessions(CFG, CWD)
  assert.deepEqual(
    list.map((s) => s.sessionId),
    [nova, antiga],
    'a ordem não é por mtime decrescente'
  )
  assert.equal(list[0].label, 'a tarefa de agora')
  assert.ok(list[0].modifiedAt.startsWith('2026-08-01'))
})

await test('o rótulo sai da primeira mensagem do usuário, com conteúdo em array', async () => {
  const id = '33333333-3333-3333-3333-333333333333'
  await writeFile(
    join(projDir, `${id}.jsonl`),
    jsonl(
      { type: 'summary', summary: 'ignora isto' },
      { type: 'user', isMeta: true, message: { content: 'linha de meta, não conta' } },
      { type: 'user', message: { content: [{ type: 'text', text: 'refatora o parser' }] } }
    ),
    'utf8'
  )
  const s = (await listClaudeSessions(CFG, CWD)).find((x) => x.sessionId === id)
  assert.equal(s.label, 'refatora o parser')
})

await test('sessão sem mensagem de usuário entra sem rótulo — a UI cai na data', async () => {
  const id = '44444444-4444-4444-4444-444444444444'
  await writeFile(join(projDir, `${id}.jsonl`), jsonl({ type: 'summary', summary: 'x' }), 'utf8')
  const s = (await listClaudeSessions(CFG, CWD)).find((x) => x.sessionId === id)
  assert.equal(s.label, '')
})

await test('arquivo que não é .jsonl de UUID é ignorado', async () => {
  await writeFile(join(projDir, 'notes.txt'), 'nada a ver', 'utf8')
  await writeFile(join(projDir, 'rascunho.jsonl'), jsonl(userLine('sem uuid no nome')), 'utf8')
  const ids = (await listClaudeSessions(CFG, CWD)).map((s) => s.sessionId)
  assert.ok(!ids.includes('notes'))
  assert.ok(!ids.includes('rascunho'))
})

await test('linha de JSON corrompida é pulada; a mensagem seguinte ainda vira rótulo', async () => {
  const id = '55555555-5555-5555-5555-555555555555'
  await writeFile(
    join(projDir, `${id}.jsonl`),
    '{ isto não é json\n' + JSON.stringify(userLine('a segunda linha presta')) + '\n',
    'utf8'
  )
  const s = (await listClaudeSessions(CFG, CWD)).find((x) => x.sessionId === id)
  assert.equal(s.label, 'a segunda linha presta')
})

await test('o limite corta a lista', async () => {
  const many = join(CFG, 'projects', claudeProjectSlug('/proj/many'))
  await mkdir(many, { recursive: true })
  for (let i = 0; i < 5; i++) {
    const id = `6666666${i}-6666-6666-6666-666666666666`
    await writeFile(join(many, `${id}.jsonl`), jsonl(userLine(`tarefa ${i}`)), 'utf8')
  }
  assert.equal((await listClaudeSessions(CFG, '/proj/many', 3)).length, 3)
})

await rm(outdir, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
