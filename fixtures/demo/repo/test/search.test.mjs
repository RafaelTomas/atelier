/**
 * Testes de `search()` — hoje VERMELHOS de proposito.
 *
 * O corpo de `search()` e um `// TODO`; estes tres casos so passam depois
 * que o roteiro da demo implementa a funcao ao vivo. Importam o `.mjs`
 * (nao o `.ts`) porque `node --test` roda sem nenhum toolchain.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { search } from '../src/search.mjs'

const ITENS = ['Abacaxi', 'Banana', 'Caqui', 'Damasco', 'Framboesa']

test('busca simples encontra o item pelo trecho', () => {
  assert.deepEqual(search(ITENS, 'ban'), ['Banana'])
})

test('a busca ignora maiusculas e minusculas', () => {
  assert.deepEqual(search(ITENS, 'CAQUI'), ['Caqui'])
})

test('termo vazio devolve a lista inteira', () => {
  assert.deepEqual(search(ITENS, ''), ITENS)
})
