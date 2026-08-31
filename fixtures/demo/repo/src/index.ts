/**
 * Exemplo de uso do CLI do `demo-repo`.
 *
 * Ilustrativo: mostra como `search()` seria chamada por um comando de
 * linha. Nao roda no palco (o pacote nao tem toolchain) — o que a demo
 * exercita e `npm test` e `npm run docs`. Fica em `.ts` para o no Editor
 * ter contexto ao redor de `search.ts`.
 */
import { search } from './search'

// Um catalogo qualquer, como se viesse de um arquivo ou de um banco.
const FRUTAS = ['Abacaxi', 'Banana', 'Caqui', 'Damasco', 'Framboesa']

// `process.argv[2]` e o termo digitado: `demo-repo buscar banana`.
const termo = process.argv[2] ?? ''
const achados = search(FRUTAS, termo)

console.log(
  termo
    ? `Busca por "${termo}": ${achados.join(', ') || '(nada)'}`
    : `Sem termo — catalogo inteiro: ${achados.join(', ')}`,
)
