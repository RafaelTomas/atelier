// Guarda a regra do Enter separado: nunca `texto + '\r'` num write só.
//
// O TUI de um agente (Claude Code, Codex) classifica como COLAGEM todo bloco
// que chega grande e de uma vez, e um `\r` grudado no mesmo bloco entra na
// colagem em vez de ser lido como "enviar". O prompt fica parado no campo de
// entrada esperando um Enter humano — que é exatamente o que o `ask` e o botão
// existem para não precisar. Num shell puro os dois caminhos dão no mesmo, e é
// por isso que o defeito passa despercebido em teste manual: só aparece contra
// um agente de verdade, e parece que ele ignorou a mensagem.
//
// Já apareceu duas vezes em lugares diferentes (handlers/ask.ts, e depois o
// botão de prompt na store), então não é descuido de uma pessoa — é a forma
// mais natural de escrever a linha. Uma guarda no fonte é mais barata que a
// terceira.
//
// A regra vale para quem escreve num terminal que pode ser um AGENTE. Quem
// escreve num shell (o comando de um botão sem alvo, injetado no spawn) não
// está coberto aqui: aquele texto vai para o `TerminalManager`, não por
// `terminal.write`.
//
// Uso: node scripts/test-enter-separado.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

let ok = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
    ok++
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`)
    failed++
  }
}

console.log('\nenter separado\n')

// `write(algumaCoisa, `...${x}\r`)` — o template que gruda o Enter no texto.
const GRUDADO = /write\([^)]*`[^`]*\$\{[^}]*\}\\r`/

const ARQUIVOS = [
  'src/renderer/state/store.ts',
  'src/main/core/interagent/handlers/ask.ts',
  'src/main/core/interagent/handlers/button.ts'
]

for (const rel of ARQUIVOS) {
  test(`${rel} não gruda \\r no texto de um write`, () => {
    const src = readFileSync(resolve(ROOT, rel), 'utf8')
    const linhas = src.split('\n')
    const culpadas = linhas
      .map((linha, i) => ({ linha, n: i + 1 }))
      .filter(({ linha }) => GRUDADO.test(linha))
      .map(({ linha, n }) => `${rel}:${n}: ${linha.trim()}`)
    assert.deepEqual(
      culpadas,
      [],
      `Enter grudado no texto — escreva o texto, espere, e mande '\\r' num write separado:\n${culpadas.join('\n')}`
    )
  })
}

test('o helper da store manda o Enter num write próprio, depois de esperar', () => {
  const src = readFileSync(resolve(ROOT, 'src/renderer/state/store.ts'), 'utf8')
  assert.match(src, /private async writePrompt\(/, 'a store perdeu o helper writePrompt')
  const corpo = src.slice(src.indexOf('private async writePrompt('))
  const fim = corpo.indexOf('\n  }')
  const fn = corpo.slice(0, fim)
  assert.match(fn, /ENTER_DELAY_MS/, 'o helper não espera antes do Enter')
  assert.match(fn, /write\(\s*terminalId,\s*'\\r'\s*\)/, 'o Enter não vai num write próprio')
})

test('todo caminho de prompt da store passa pelo helper', () => {
  const src = readFileSync(resolve(ROOT, 'src/renderer/state/store.ts'), 'utf8')
  // Os três: botão de prompt com alvo, reuso do botão de agente, e o prompt
  // de abertura logo depois do spawn.
  const usos = src.match(/this\.writePrompt\(/g) ?? []
  assert.ok(
    usos.length >= 3,
    `esperava os três caminhos de prompt no helper, achei ${usos.length}`
  )
})

console.log(`\ntest-enter-separado: ${ok} ok${failed ? `, ${failed} FALHARAM` : ''}`)
process.exit(failed ? 1 : 0)
