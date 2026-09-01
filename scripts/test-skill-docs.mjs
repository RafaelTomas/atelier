/**
 * A skill do agente (M2/M3/M4/M6 do plano de aderência) — as invariantes que
 * docs/eval-aderencia-agentes.md lista para o `skill-optimizer` proteger:
 *
 *   1. Frontmatter válido, com `name: atelier` e `description` não vazia.
 *   2. OWNER_MARKER presente e DEPOIS do frontmatter.
 *   3. Todo verbo documentado (em SKILL.md e em cada reference) existe em
 *      cli-router.ts. Documentar um verbo inexistente é a pior regressão
 *      possível aqui: gera exatamente a falha que o critério E-04 mede.
 *   4. `statusline` e `artesao` nunca aparecem como verbo documentado — não
 *      são comandos que um agente digita (cli-router.ts:65).
 *
 * Mais o que o plano pede para o SKILL.md em si: no máximo 130 linhas, e as
 * oito references (portal, todo, editor, vault, table, button, projects,
 * recruit) de fato escritas por `installSkillsIfNeeded()`.
 *
 * `~/.claude/skills/` não é tocado: `HOME` é sobrescrito para um diretório
 * temporário antes de chamar o instalador, do mesmo jeito que os vizinhos
 * sobrescrevem `ATELIER_HOME` para não gravar no canvas real do usuário.
 *
 * Uso: node scripts/test-skill-docs.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const fakeHome = await mkdtemp(join(tmpdir(), 'atelier-skill-home-'))
process.env.HOME = fakeHome
process.env.ATELIER_HOME = await mkdtemp(join(tmpdir(), 'atelier-skill-data-'))

const outdir = await mkdtemp(join(tmpdir(), 'atelier-skill-docs-'))
const outfile = join(outdir, 'skill-injector.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { SKILL_MD, REFERENCES, SKILL_DESCRIPTION, installSkillsIfNeeded } from './src/main/core/connection/skill-injector.ts'
      export { withAgentSettings } from './src/main/core/terminal/agent-settings.ts'
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

const { SKILL_MD, REFERENCES, SKILL_DESCRIPTION, installSkillsIfNeeded, withAgentSettings } = await import(
  pathToFileURL(outfile).href
)

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
  }
}

async function testAsync(name, fn) {
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

console.log('\nskill docs (atelier)\n')

// Verbos de verdade: extraídos de cli-router.ts, não de uma cópia mantida à
// mão aqui — assim um verbo novo ou removido no router não exige lembrar de
// atualizar este teste também.
const routerSrc = await readFile(join(ROOT, 'src/main/core/interagent/cli-router.ts'), 'utf8')
const ROUTER_VERBS = new Set([...routerSrc.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]))
assert.ok(ROUTER_VERBS.has('list') && ROUTER_VERBS.has('recruit'), 'extração de verbos do router falhou')

const EXPECTED_REFERENCES = [
  'portal.md',
  'todo.md',
  'editor.md',
  'vault.md',
  'table.md',
  'image.md',
  'button.md',
  'projects.md',
  'recruit.md'
]

function verbsCitedEm(texto) {
  return new Set([...texto.matchAll(/\batelier ([a-z]+)/g)].map((m) => m[1]))
}

test('frontmatter tem name e description não vazia', () => {
  const m = SKILL_MD.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/)
  assert.ok(m, 'frontmatter não bate no formato esperado (name/description numa linha cada)')
  assert.equal(m[1], 'atelier')
  assert.ok(m[2].trim().length > 0, 'description vazia')
  assert.equal(m[2], SKILL_DESCRIPTION, 'description no frontmatter difere da constante exportada')
})

test('OWNER_MARKER vem depois do frontmatter', () => {
  const fimFrontmatter = SKILL_MD.indexOf('\n---\n', 4) + 5
  assert.ok(fimFrontmatter > 5, 'não achei o fechamento do frontmatter')
  const posMarker = SKILL_MD.indexOf('<!-- installed-by: atelier -->')
  assert.ok(posMarker > 0, 'OWNER_MARKER ausente')
  assert.ok(posMarker > fimFrontmatter, 'OWNER_MARKER está DENTRO do frontmatter ou antes dele')
})

test('SKILL.md tem no máximo 130 linhas', () => {
  const linhas = SKILL_MD.split('\n').length
  assert.ok(linhas <= 130, `SKILL.md tem ${linhas} linhas, limite é 130`)
})

test('a descrição cobre os dez recursos, não só colaboração entre agentes', () => {
  const gatilhos = [
    'agent',
    'TODO board',
    'sticky note',
    'browser portal',
    'code editor',
    'vault',
    'table node',
    'image',
    'button',
    'development projects'
  ]
  for (const g of gatilhos) {
    assert.ok(SKILL_DESCRIPTION.includes(g), `description não menciona "${g}"`)
  }
})

test('references esperadas batem exatamente com o que o template define', () => {
  const nomes = Object.keys(REFERENCES).sort()
  assert.deepEqual(nomes, [...EXPECTED_REFERENCES].sort())
})

test('todo verbo do mapa recurso→verbo tem sintaxe alcançável a partir do SKILL.md', () => {
  // "Alcançável" = o próprio SKILL.md mostra a sintaxe fora da linha do mapa
  // (list, ask, check, note, role — os pequenos o bastante para ficar aqui),
  // OU alguma reference CITADA PELO NOME na lista de pointers do SKILL.md traz
  // a sintaxe. Achar o verbo só no mapa, sem chegar na sintaxe em lugar nenhum,
  // é o buraco que este teste existe para pegar: o agente sabe que o verbo
  // existe, não sabe como chamar, e adivinha os argumentos — a falha do E-02.
  const mapaMatch = SKILL_MD.match(/## Resource → verb map\n\n([\s\S]+?)\n\nDetails, syntax/)
  assert.ok(mapaMatch, 'não achei a tabela do mapa recurso→verbo')
  const linhasDoMapa = mapaMatch[1]
  const verbosDoMapa = [...linhasDoMapa.matchAll(/\| `atelier ([a-z]+)` \|/g)].map((m) => m[1])
  assert.ok(verbosDoMapa.length >= 10, `só achei ${verbosDoMapa.length} verbos no mapa — a extração provavelmente quebrou`)

  // Referências citadas PELO NOME em algum lugar do SKILL.md (a lista de
  // pointers, ou um "see references/x.md" pontual) — uma reference que existe
  // mas não é nomeada em lugar nenhum não conta, porque o agente nunca chegaria
  // nela lendo só o SKILL.md.
  const referenciasCitadas = Object.keys(REFERENCES).filter((nome) => SKILL_MD.includes(nome))

  const foraDoMapa = SKILL_MD.replace(linhasDoMapa, '')
  const semSintaxe = []
  for (const verbo of verbosDoMapa) {
    const padrao = new RegExp(`atelier ${verbo}\\b`)
    const naPropriaSkill = padrao.test(foraDoMapa)
    const numaReference = referenciasCitadas.some((nome) => padrao.test(REFERENCES[nome]))
    if (!naPropriaSkill && !numaReference) semSintaxe.push(verbo)
  }
  assert.deepEqual(semSintaxe, [], `verbo(s) do mapa sem sintaxe alcançável: ${semSintaxe.join(', ')}`)
})

test('toda reference existente é citada pelo nome no SKILL.md', () => {
  for (const nome of Object.keys(REFERENCES)) {
    assert.ok(SKILL_MD.includes(nome), `${nome} existe em REFERENCES mas não é citado em SKILL.md — órfã inalcançável`)
  }
})

test('nenhum verbo documentado em SKILL.md é inexistente em cli-router.ts', () => {
  for (const verbo of verbsCitedEm(SKILL_MD)) {
    assert.ok(ROUTER_VERBS.has(verbo), `SKILL.md cita 'atelier ${verbo}', que cli-router.ts não roteia`)
  }
})

test('nenhum verbo documentado nas references é inexistente em cli-router.ts', () => {
  for (const [nome, conteudo] of Object.entries(REFERENCES)) {
    for (const verbo of verbsCitedEm(conteudo)) {
      assert.ok(ROUTER_VERBS.has(verbo), `${nome} cita 'atelier ${verbo}', que cli-router.ts não roteia`)
    }
  }
})

test('statusline e artesao não viram verbo documentado (cli-router.ts:65)', () => {
  const textos = [SKILL_MD, ...Object.values(REFERENCES)]
  for (const t of textos) {
    assert.doesNotMatch(t, /\batelier statusline\b/)
    assert.doesNotMatch(t, /\batelier artesao\b/)
  }
})

test('os quatro comandos ausentes de propósito aparecem como contra-exemplo, com o motivo', () => {
  for (const ausente of ['editor write', 'portal eval', 'todo delete', 'vault delete']) {
    assert.ok(SKILL_MD.includes(`\`${ausente}\``), `contra-exemplo "${ausente}" não está no SKILL.md`)
  }
})

await testAsync('installSkillsIfNeeded() escreve SKILL.md e as oito references em disco', async () => {
  await installSkillsIfNeeded()
  const dir = join(fakeHome, '.claude', 'skills', 'atelier')
  const skillFile = await readFile(join(dir, 'SKILL.md'), 'utf8')
  assert.equal(skillFile, SKILL_MD)

  const refsDir = join(dir, 'references')
  const presentes = (await readdir(refsDir)).sort()
  assert.deepEqual(presentes, [...EXPECTED_REFERENCES].sort())
  for (const nome of EXPECTED_REFERENCES) {
    const conteudo = await readFile(join(refsDir, nome), 'utf8')
    assert.equal(conteudo, REFERENCES[nome])
  }
})

await testAsync('references órfãs de uma versão anterior são removidas', async () => {
  const home2 = await mkdtemp(join(tmpdir(), 'atelier-skill-home2-'))
  const dir = join(home2, '.claude', 'skills', 'atelier')
  const refsDir = join(dir, 'references')
  await mkdir(refsDir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), SKILL_MD, 'utf8')
  await writeFile(join(refsDir, 'vault-antigo.md'), 'conteúdo de uma reference removida', 'utf8')

  process.env.HOME = home2
  try {
    // O módulo já rodou installSkillsIfNeeded() uma vez (idempotente, guarda
    // `installed` em módulo) — reimporta um bundle novo para forçar de novo.
    const outfile2 = join(outdir, 'skill-injector-2.mjs')
    await esbuild.build({
      stdin: {
        contents: `export { installSkillsIfNeeded } from './src/main/core/connection/skill-injector.ts'`,
        resolveDir: ROOT,
        loader: 'ts'
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      external: ['electron'],
      outfile: outfile2,
      logLevel: 'silent',
      alias: { '@shared': join(ROOT, 'src/shared') }
    })
    const { installSkillsIfNeeded: instalarDeNovo } = await import(pathToFileURL(outfile2).href)
    await instalarDeNovo()

    const presentes = (await readdir(refsDir)).sort()
    assert.deepEqual(presentes, [...EXPECTED_REFERENCES].sort(), 'orphan não foi removida, ou uma reference esperada sumiu')
  } finally {
    process.env.HOME = fakeHome
    await rm(home2, { recursive: true, force: true })
  }
})

await testAsync(
  'o settings do nó aponta para o diretório que o instalador REALMENTE criou',
  async () => {
    // O acoplamento que este teste protege: `agent-settings.ts` monta o caminho
    // da skill por conta própria (importar o injector traria o SKILL.md inteiro
    // para um módulo carregado no spawn de todo nó), e um dos dois lados pode
    // mudar de diretório sem o outro saber. O sintoma seria mudo: o diálogo
    // `Allow reads outside the working directories?` de volta, e o agente
    // parando ao abrir uma reference.
    await installSkillsIfNeeded()
    const instalado = join(fakeHome, '.claude', 'skills', 'atelier')
    // Pré-condição: o instalador escreveu onde este teste acha que escreveu.
    await readFile(join(instalado, 'SKILL.md'), 'utf8')

    const { command } = await withAgentSettings('claude', '11111111-2222-3333-4444-555555555555')
    const arquivo = command.match(/--settings "([^"]+)"/)[1]
    const cfg = JSON.parse(await readFile(arquivo, 'utf8'))

    assert.ok(cfg.permissions, 'o settings do nó não declarou permissão nenhuma')
    assert.ok(
      cfg.permissions.additionalDirectories.includes(instalado),
      `o settings aponta para ${JSON.stringify(cfg.permissions.additionalDirectories)}, e a skill está em ${instalado}`
    )
  }
)

await testAsync('diretório de skill que não existe fica FORA da lista', async () => {
  // Declarar caminho inexistente é pedir um erro num lugar onde o sintoma seria
  // "o nó não sobe". A conta aqui não tem skill instalada.
  const semSkill = await mkdtemp(join(tmpdir(), 'atelier-conta-sem-skill-'))
  try {
    const { command } = await withAgentSettings(
      'claude',
      '66666666-7777-8888-9999-aaaaaaaaaaaa',
      { claudeConfigDir: semSkill }
    )
    const cfg = JSON.parse(await readFile(command.match(/--settings "([^"]+)"/)[1], 'utf8'))
    const dirs = cfg.permissions?.additionalDirectories ?? []
    assert.ok(
      !dirs.some((d) => d.startsWith(semSkill)),
      `entrou um diretório inexistente: ${JSON.stringify(dirs)}`
    )
  } finally {
    await rm(semSkill, { recursive: true, force: true })
  }
})

await rm(fakeHome, { recursive: true, force: true }).catch(() => {})
await rm(process.env.ATELIER_HOME, { recursive: true, force: true }).catch(() => {})

if (failed) {
  console.error(`\ntest-skill-docs: ${failed} falha(s), ${passed} ok`)
  process.exit(1)
}
console.log(`\ntest-skill-docs: ${passed} ok`)
