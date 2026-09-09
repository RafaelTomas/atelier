---
title: Referência de verbos
description: Tabela completa — cada tipo de nó, os comandos do CLI que agem sobre ele e o que ele entrega ao agente conectado.
sidebar:
  order: 5
---

Você tem um nó no canvas e quer saber exatamente quais comandos funcionam nele. Esta página é a tabela de consulta.

## Panorama

| Nó | Cabo | Comandos | O que entrega |
|---|---|---|---|
| Terminal | com outro terminal | `ask` `check` `recruit` `dismiss` `role` | estado e tela do outro agente |
| Nota | `note` | `note` | o markdown inteiro, leitura e escrita |
| Portal | `portal` | `portal` | o mais largo de todos — texto, HTML, screenshot, mapa de elementos |
| Editor de código | `data` | `editor` | buffer e seleção viva, sem verbo de escrita |
| Tabela de dados | `data` | `table` | contagens e o caminho do resultado publicado |
| Imagem | `data` | `image` | dimensões e o caminho do arquivo |
| Cofre de segredos | `secret` | `vault` | nomes das chaves; valor só sob pedido |
| Quadro de tarefas | `data` | `todo` | leitura e escrita dos cartões |
| Botão | `data` | `button` | descrição da ação — o verbo hoje ainda não respeita o cabo |
| Painel de Git | `data` | — | o repositório observado |
| Painel de Monitor | `data` | — | o volume observado |
| Painel de Projetos | `data` | `projects` (índice global) | o projeto fixado |
| Árvore de arquivos | `data` | `node create fileTree` | o caminho raiz |
| Texto | `data` | `node create text` | o texto do rótulo |

## Terminal — o outro agente

```bash
atelier list
atelier ask "Agente" "a tarefa"           # bloqueia até o outro esfriar
atelier check "Agente" [linhas]           # até 500 linhas da tela
atelier recruit "Nome" [--preset claude|codex|antigravity|opencode|shell] \
                       [--command "cmd"] [--cwd /caminho] [--role "Papel"] \
                       [--account "Conta"] [--model opus|sonnet|haiku|…]
atelier dismiss "Nome" [--force]
atelier role                              # a minha responsabilidade
atelier role list                         # as disponíveis no workspace
```

Entrega nome, ciclo de vida (`working`/`waiting`/`idle`/`exited`), o que está sendo pedido quando o outro para, a responsabilidade atribuída, e o scrollback por `check`. Quando o estado é `waiting`, a instrução do outro agente vem antes da tela — reler o diálogo inteiro é o passo que não resolve nada.

## Nota

```bash
atelier note create ["conteúdo"] [--name "Requisito"]
atelier note read "Nota" [offset] [limit]      # offset/limit em linhas
atelier note write "Nota" "conteúdo"           # substitui
atelier note edit "Nota" "velho" "novo"        # troca pontual
```

Único nó com escrita livre nas duas direções — entrega o markdown inteiro do arquivo, ou a faixa de linhas pedida.

## Portal

```bash
atelier portal list
atelier portal open <url> [nome] [--session "Portal" | --shared]
atelier portal go "Portal" <url>
atelier portal read "Portal" [offset] [limit]     # texto da página
atelier portal html "Portal" [seletor]
atelier portal shot "Portal"
atelier portal map "Portal" [--all]              # elementos interativos
atelier portal click "Portal" <ref|--selector S>
atelier portal type "Portal" <ref|--selector S> <texto> [--clear] [--enter]
atelier portal key "Portal" <tecla>
atelier portal scroll / wait [--idle]
atelier portal login "Portal" <ref|--selector "css"> …
atelier portal close "Portal"
```

O `map` é a peça central: cada elemento interativo da página com papel, rótulo, valor e estado, mais a contagem do que está fora da tela. `login` digita uma credencial do cofre direto na página — o valor nunca passa pelo contexto do agente.

## Editor de código

```bash
atelier editor list
atelier editor open <caminho absoluto>
atelier editor read "Arquivo" [offset] [limit] [--selection]
atelier editor close "Arquivo"
```

Entrega o caminho, se há alteração não salva, a linha do cursor ou a faixa selecionada, e o texto do **buffer** — não do disco. Não existe verbo de escrita, por decisão: quem edita o arquivo é o próprio agente, com as ferramentas que já têm diff, permissão e histórico, e o nó recarrega sozinho quando o arquivo muda.

## Tabela de dados

```bash
atelier table create "Título" <dados> [--query "SELECT…"] [--format auto|json|csv|tsv]
atelier table append "Tabela" <dados>
atelier table list
```

Entrega só metadados — título, `N linhas × M colunas`. As linhas nunca voltam ao agente: é mão única, o Atelier nunca toca no banco, quem executa a query é o agente.

## Imagem

```bash
atelier image create "Título" <caminho> [--alt "descrição"]
atelier image list
```

Entrega só metadados — título, dimensões, id. Os pixels não voltam, mesmo raciocínio de mão única da tabela.

## Cofre de segredos

```bash
atelier vault list                       # nomes das chaves, nunca os valores
atelier vault get "Cofre" <chave>        # um valor, com aviso
atelier vault set "Cofre" <CHAVE> <valor>
atelier vault env [--export]             # o que já está injetado neste terminal
```

A escrita do agente é só criar: `set` nasce uma chave inerte, sem entrar no ambiente e sem sobrescrever nada. Editar ou apagar uma chave é gesto do usuário, direto no nó.

## Quadro de tarefas

```bash
atelier todo list ["Quadro"] [--status doing] [--mine]
atelier todo add "Quadro" "Título" [--status …] [--assignee …]
atelier todo move "Quadro" <id> <coluna>
atelier todo done "Quadro" <id>
atelier todo show "Quadro" <id|"prefixo do título">
atelier todo create "Título" [colunas…]
```

Um cartão é endereçado por id ou por prefixo do título; prefixo ambíguo é recusado com a lista de candidatos. Não existe `delete` no CLI — apagar um cartão é sempre gesto do usuário, no nó.

## Botão

```bash
atelier button propose "Rótulo" (--command "npm run dev" | --prompt "texto" --target "Agente" | --url http://…)
atelier button list
atelier button remove "Rótulo"
```

Tudo que um agente propõe nasce **pendente**: o nó aparece apagado, com o comando à vista, esperando o clique de aceite do usuário.

## Painel de Projetos

```bash
atelier projects list [busca] [--pending]
atelier projects info "<caminho ou nome>"
atelier projects describe "<caminho>" "uma frase" --stack "React,TS" --role "api"
```

O único índice que não é limitado pelo cabo — é global, e funciona igual com ou sem o painel no canvas.

## Árvore de arquivos

```bash
atelier node create fileTree <caminho absoluto> [--name "Rótulo"] [--at x,y]
```

Entrega o caminho raiz absoluto. É a entrega completa: o agente varre e lê com as próprias ferramentas.

## Verbos que não são de nenhum nó específico

```bash
atelier node map                          # o canvas todo: tipo, tamanho, posição
atelier node move "Nó" x,y
atelier node group "Título" "Nó" […] [--color]
atelier list                              # o inventário do que está cabeado
atelier debug
```

O bloco de referência que vem a seguir cobre workspaces, o formato de arquivo em disco e como resolver os problemas mais comuns.
