# Spec — busca

Implementar a função `search(itens, termo)` do `demo-repo`
(`src/search.ts`, espelhada em `src/search.mjs`).

## Assinatura

```ts
search(itens: string[], termo: string): string[]
```

Recebe uma lista de textos e um termo procurado; devolve os itens que
correspondem, **na mesma ordem** em que aparecem na lista de entrada.

## Requisitos

1. **Filtro por trecho.** Um item corresponde quando `termo` aparece em
   qualquer posição dele (subcadeia), não só no início.
2. **Sem diferenciar maiúsculas de minúsculas.** `"CAQUI"`, `"caqui"` e
   `"Caqui"` encontram o mesmo item.
3. **Termo vazio devolve tudo.** `termo === ""` retorna a lista inteira,
   preservando a ordem — nunca uma cópia filtrada.
4. **Ordem preservada.** O resultado segue a ordem de `itens`; a função
   não ordena nem remove duplicatas.
5. **Sem efeitos colaterais.** Não altera `itens`; devolve um array novo.

## Casos que os testes cobrem

Catálogo: `['Abacaxi', 'Banana', 'Caqui', 'Damasco', 'Framboesa']`

| Entrada             | Saída esperada                                            |
|---------------------|----------------------------------------------------------|
| `search(ITENS, 'ban')`   | `['Banana']` — trecho no meio da palavra, minúsculas |
| `search(ITENS, 'CAQUI')` | `['Caqui']` — igual ignorando a caixa               |
| `search(ITENS, '')`      | `['Abacaxi', 'Banana', 'Caqui', 'Damasco', 'Framboesa']` — lista inteira |

## Pronto quando

`cd fixtures/demo/repo && npm test` fica verde nos três casos.
