/**
 * Testa o runner de git contra repositórios reais, sem subir o Electron.
 *
 * Repositórios temporários e o próprio atelier: o que quebra este módulo são
 * casos de borda de repositório de verdade — repo sem nenhum commit, nome de
 * arquivo com espaço, arquivo chamado `--force`, HEAD solto — e nenhum deles
 * aparece num mock.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const outdir = mkdtempSync(join(tmpdir(), 'gittest-'))
await build({
  entryPoints: ['src/main/core/git/git.ts', 'src/main/core/git/actions.ts'],
  bundle: true, platform: 'node', format: 'esm', outdir,
  external: ['electron'],
  alias: { '@shared': new URL('./src/shared', import.meta.url).pathname }
})
const { status, parsePorcelain, repoRoot } = await import(join(outdir, 'git.js'))
const actions = await import(join(outdir, 'actions.js'))

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ', name) }
  else { fail++; console.log('  FAIL', name, extra ?? '') }
}

// ── parsePorcelain: nomes hostis ────────────────────────────────────────────
console.log('\nparsePorcelain')
{
  const raw = ' M src/a.ts\0?? novo com espaço.txt\0R  new.ts\0old.ts\0UU conflito.ts\0A  staged.ts\0'
  const files = parsePorcelain(raw)
  check('conta 5 registros (rename consome 2)', files.length === 5, files.length)
  const rename = files.find(f => f.path === 'new.ts')
  check('rename guarda a origem', rename?.from === 'old.ts', rename?.from)
  check('conflito detectado', files.find(f => f.path === 'conflito.ts')?.isConflicted === true)
  check('untracked com espaço no nome', files.find(f => f.path === 'novo com espaço.txt')?.isUntracked === true)
  check('conflito vem primeiro na ordem', files[0].isConflicted === true, files[0].path)
  check('staged reconhecido', files.find(f => f.path === 'staged.ts')?.isStaged === true)
  check('modificado não-staged', files.find(f => f.path === 'src/a.ts')?.isStaged === false)
}

// ── repositório real ────────────────────────────────────────────────────────
console.log('\nrepositório real (temporário)')
const repo = mkdtempSync(join(tmpdir(), 'repo-'))
const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
g('init', '-q', '-b', 'main')
g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T')

{
  const st = await status(repo)
  check('repo vazio: sem erro', !('error' in st), st.error)
  check('branch main', st.branch === 'main', st.branch)
  check('sem upstream', st.upstream === null)
  check('sem arquivos', st.files.length === 0)
}

writeFileSync(join(repo, 'a.txt'), 'um\n')
mkdirSync(join(repo, 'sub'))
writeFileSync(join(repo, 'sub', 'arquivo com espaço.txt'), 'dois\n')
{
  const st = await status(repo)
  check('2 não-rastreados (untracked=all entra em subpasta)', st.files.length === 2, st.files.map(f=>f.path))
  check('caminho com espaço intacto', st.files.some(f => f.path === 'sub/arquivo com espaço.txt'), st.files.map(f=>f.path))
}

// stage + commit
{
  const r = await actions.stageAll(repo)
  check('stageAll ok', r.ok, r.message)
  const st = await status(repo)
  check('tudo staged', st.files.every(f => f.isStaged), st.files)

  const c = await actions.commit(repo, 'primeiro commit\n\ncorpo com quebra')
  check('commit ok', c.ok, c.message)
  const st2 = await status(repo)
  check('árvore limpa após commit', st2.files.length === 0, st2.files)
}

// log
{
  const l = await actions.log(repo, 10)
  check('log traz 1 commit', l.commits?.length === 1, JSON.stringify(l).slice(0,120))
  check('assunto correto (só a primeira linha)', l.commits?.[0].subject === 'primeiro commit', l.commits?.[0].subject)
}

// unstage
{
  writeFileSync(join(repo, 'b.txt'), 'tres\n')
  await actions.stage(repo, ['b.txt'])
  check('staged após stage', (await status(repo)).files[0].isStaged === true)
  const u = await actions.unstage(repo, ['b.txt'])
  check('unstage ok (sem HEAD-reset)', u.ok, u.message)
  check('voltou a untracked', (await status(repo)).files[0].isUntracked === true)
}

// discard
{
  const d = await actions.discard(repo, [], ['b.txt'])
  check('discard untracked ok', d.ok, d.message)
  check('sumiu do status', (await status(repo)).files.length === 0)

  writeFileSync(join(repo, 'a.txt'), 'ALTERADO\n')
  const d2 = await actions.discard(repo, ['a.txt'], [])
  check('discard tracked ok', d2.ok, d2.message)
  check('árvore limpa de novo', (await status(repo)).files.length === 0)
}

// branches
{
  const cb = await actions.createBranch(repo, 'feature/x')
  check('createBranch ok', cb.ok, cb.message)
  const b = await actions.branches(repo)
  check('lista os dois branches', b.names?.length === 2, b.names)
  check('current é o novo', b.current === 'feature/x', b.current)
  const sw = await actions.switchBranch(repo, 'main')
  check('switch de volta', sw.ok, sw.message)
}

// arquivo chamado como flag
{
  writeFileSync(join(repo, '--force'), 'x\n')
  const r = await actions.stage(repo, ['--force'])
  check('arquivo chamado --force é tratado como arquivo', r.ok, r.message)
  await actions.unstageAll(repo)
  await actions.discard(repo, [], ['--force'])
}

// HEAD solto: o único caso que deve mesmo devolver branch null
{
  const head = g('rev-parse', 'HEAD').trim()
  g('checkout', '-q', head)
  const st = await status(repo)
  check('HEAD solto devolve branch null', st.branch === null, st.branch)
  g('checkout', '-q', 'main')
  const st2 = await status(repo)
  check('volta a nomear o branch', st2.branch === 'main', st2.branch)
}

// não-repo
{
  const nr = mkdtempSync(join(tmpdir(), 'norepo-'))
  const st = await status(nr)
  check('fora de repo devolve not-a-repo', st.error === 'not-a-repo', st.error)
}

// push sem remoto não deve travar
{
  const t0 = Date.now()
  const p = await actions.push(repo, 'main', false)
  check('push sem remoto falha rápido', !p.ok && Date.now() - t0 < 30000, `${p.message} (${Date.now()-t0}ms)`)
}

// repo de verdade: o próprio atelier
console.log('\nrepositório do atelier')
{
  const st = await status(process.cwd())
  check('status do atelier ok', !('error' in st), st.error)
  check('branch preenchido', typeof st.branch === 'string', st.branch)
  check('root é o repositório', st.root === process.cwd(), st.root)
  console.log(`       branch=${st.branch} upstream=${st.upstream} ahead=${st.ahead} behind=${st.behind} arquivos=${st.files.length}`)
  for (const f of st.files.slice(0, 8)) console.log(`       [${f.index}${f.worktree}] ${f.path}`)
}

console.log(`\n${pass} passaram, ${fail} falharam`)
process.exit(fail === 0 ? 0 : 1)
