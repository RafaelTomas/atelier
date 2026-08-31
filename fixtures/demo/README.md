# A demo do Atelier

Um canvas pronto que mostra o produto inteiro em ~10 minutos: três agentes
conversando por cabos, um kanban que anda sozinho, um editor que recarrega, um
portal, um cofre e o monitor. **Sem internet e sem credencial de IA.**

O roteiro dos dez momentos, o inventário dos nós e as decisões estão em
`docs/2026-08-30-PLANO-workspace-de-demonstracao.md`.

## Rodar

```bash
npm run demo          # gera o workspace e abre o Atelier em ~/.atelier-dev
```

Ou, separando os passos:

```bash
ATELIER_HOME=/tmp/demo node scripts/make-demo-workspace.mjs
```

O gerador é **idempotente**: rodar de novo sobrescreve o mesmo workspace
(`DEC0DEC0-…`). Rode antes de cada sessão — é o que limpa o canvas "sujo" da
demo anterior.

Por segurança ele **recusa** gravar no `~/.atelier` real (onde seus dados de
verdade vivem) a menos que receba `--force`. Sem `ATELIER_HOME`, ele usa
`~/.atelier-dev`, o mesmo do `npm run dev`.

## O que tem aqui

| Arquivo | Papel |
|---|---|
| `spec.md` | a nota **Spec — busca**, que os agentes leem com `atelier note read` |
| `todo.json` | o quadro **Sprint da busca**: 5 cartões, um já em *Fazendo* |
| `buscas.json` | o resultado já materializado da query, que vira o nó de tabela |
| `db/demo.sqlite` | de onde aquele resultado saiu (`searches(term, hits)`) |
| `arquitetura.png` | o diagrama que vira o nó de imagem |
| `repo/` | o **demo-repo**: pacote Node de verdade, sem nenhuma dependência |
| `bin/demo-agent.mjs` | o agente roteirizado que substitui `claude`/`codex` no palco |

O gerador copia `repo/` para `<ATELIER_HOME>/demo-repo/`, roda `git init` ali e
registra o caminho no índice de projetos — a árvore, o editor e os terminais
apontam para a **cópia**, nunca para o fixture. Assim a demo pode sujar o repo à
vontade: regenerar restaura tudo.

## O agente roteirizado

`bin/demo-agent.mjs` não é um LLM. Ele imprime um banner com a linha de status
no formato que o Atelier raspa (`31,3k tok · 3% · 5h:80% 7d:58%` — é isso que
faz o rodapé do nó e o Monitor mostrarem número), espera um prompt no PTY,
"trabalha" por um instante e executa os comandos `atelier` do seu roteiro:

```bash
node fixtures/demo/bin/demo-agent.mjs --script artesao      # o apresentador, que delega
node fixtures/demo/bin/demo-agent.mjs --script implementa   # lê a spec, move o cartão, pede revisão
node fixtures/demo/bin/demo-agent.mjs --script revisa       # devolve uma revisão em bullets
```

É **stateless por prompt**: reexecutar o mesmo prompt repete o mesmo passo, em
vez de avançar um contador. Isso é o que salva a demo quando o apresentador
digita fora de ordem.

A troca é deliberada: não é inteligência, é reprodutibilidade — offline, sem
custo, sem risco de um agente real decidir fazer outra coisa no palco. Para
rodar com agentes de verdade, basta trocar o `command` dos três terminais no
diálogo; o resto do canvas é idêntico.

## O cofre

A chave `DEMO_API_KEY` é falsa (`demo-not-a-real-key`), e mesmo assim o `.vault`
é cifrado **pelo chaveiro do sistema**, via um subprocesso Electron — a mesma
técnica que `scripts/make-icon.cjs` usa para renderizar o ícone.

Sem chaveiro (CI headless, máquina sem libsecret), o gerador **não grava
`.vault` nenhum**: o cofre nasce vazio e ele avisa. Um arquivo que o Atelier não
consegue abrir seria pior que um cofre honestamente vazio.

Consequência: o `.vault` é local à máquina que o gerou. Ele não é versionado, e
não adianta copiá-lo para outro computador — regenere lá.

## O que o CI garante

`npm run test:demo` roda o gerador contra um `ATELIER_HOME` descartável e prova
o que a demo precisa para não quebrar no palco: o arquivo satisfaz
`encode(decode(x)) == x` pelo codec do repo, nenhum nó é descartado, o
inventário (14 nós, 11 cabos, 1 grupo, os dez tipos) está lá, os satélites estão
nos caminhos que os leitores do app procuram, e uma segunda passada não duplica
nada.

É o teste que pega uma subida de `schemaVersion` **antes** da plateia.
