/**
 * Verifica a guarda de resposta velha do useGit.
 *
 * O caso: trocar de projeto com um `git status` ainda em voo. A resposta do
 * projeto ANTERIOR chega depois da do novo e, sem a guarda de geração,
 * sobrescreve o estado — o painel passa a mostrar o repositório errado, que é
 * exatamente onde um commit sai no lugar errado.
 *
 * Reproduz a mecânica do hook (contador de geração) em vez de montar React:
 * é a lógica que pode quebrar, e testá-la aqui não exige DOM.
 */
let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ', name) }
  else { fail++; console.log('  FAIL', name, extra ?? '') }
}

// Espelha o refresh() de use-git.ts: incrementa a geração, e descarta a
// resposta se outra chamada começou nesse meio-tempo.
function makeHook() {
  const state = { status: null }
  let generation = 0
  const refresh = async (path, respond) => {
    const gen = ++generation
    const result = await respond(path)
    if (gen !== generation) return 'descartada'
    state.status = result
    return 'aplicada'
  }
  return { state, refresh }
}

const delay = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms))

console.log('\nguarda de resposta velha')
{
  const { state, refresh } = makeHook()
  // Projeto A responde devagar (120ms), projeto B rápido (10ms).
  const slow = refresh('A', () => delay(120, { root: 'A' }))
  const fast = refresh('B', () => delay(10, { root: 'B' }))
  const [aResult, bResult] = await Promise.all([slow, fast])

  check('a resposta rápida (B) é aplicada', bResult === 'aplicada', bResult)
  check('a resposta velha (A) é descartada', aResult === 'descartada', aResult)
  check('estado final é o do projeto atual (B)', state.status?.root === 'B', state.status)
}

console.log('\nsem troca: a resposta normal se aplica')
{
  const { state, refresh } = makeHook()
  const r = await refresh('A', () => delay(5, { root: 'A' }))
  check('resposta única aplicada', r === 'aplicada' && state.status?.root === 'A', state.status)
}

console.log(`\n${pass} passaram, ${fail} falharam`)
process.exit(fail === 0 ? 0 : 1)
