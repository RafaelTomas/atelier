---
title: O CLI atelier
description: Os comandos que um agente ligado por cabo usa para conversar com o resto do canvas — list, recruit, ask, check, dismiss e mais.
sidebar:
  order: 4
---

Você está dentro de um terminal de agente no canvas e quer saber com quem ele pode falar agora. O primeiro comando a rodar é sempre o mesmo:

```bash
atelier list
```

## Como o CLI chega no terminal

Quando um terminal é conectado por cabo a outro nó, o CLI `atelier` entra automaticamente no `PATH` dele — você não instala nada, não configura nada. Junto com o comando, uma skill de uso é injetada no momento da conexão, então o agente já sabe como usar o CLI sem que você precise explicar.

Todo comando reconhece quem está chamando pelo terminal de origem, e só age dentro do que aquele terminal enxerga por cabo. Não há como um agente pedir informação de um nó que não está ligado a ele.

## Os comandos essenciais

```bash
atelier list                              # o que estou conectado?
atelier ask "Codex" "revisa o diff"       # manda e espera a resposta
atelier check "Codex" 40                  # últimas 40 linhas da saída dele
atelier recruit "Ajudante" --model haiku  # abre outro agente já cabeado a mim
atelier dismiss "Ajudante"                # fecha o que EU recrutei
atelier note read "Spec"                  # lê uma nota conectada
atelier note write "Spec" "conteúdo"      # reescreve
atelier note create "rascunho"            # cria já conectada a mim
atelier portal open localhost:5173        # abre um navegador já conectado a mim
atelier portal read "Dev"                 # o texto visível da página
atelier portal shot "Dev"                 # captura em PNG, devolve o caminho
atelier portal map "Dev"                  # os elementos interativos, numerados
atelier portal click "Dev" 7              # clica na ref 7 do último mapa
atelier role                              # qual é a minha responsabilidade?
atelier role list                         # as responsabilidades disponíveis
atelier projects list [--pending]         # o índice de projetos do usuário
atelier projects info "<caminho>"         # tudo o que o índice sabe de um
atelier debug                             # diagnóstico
```

Cada tipo de nó tem o próprio verbo — `table`, `image`, `todo`, `vault`, `button`, `editor` entre eles. A página seguinte traz a tabela completa, nó por nó.

## Duas regras que valem para o CLI inteiro

**`ask` bloqueia até o outro agente ficar ocioso.** Se o tempo estourar, use `check` em vez de mandar o mesmo prompt de novo — reenviar interrompe quem ainda está no meio do trabalho.

**`recruit` aceita seleção de modelo** com `--model opus|sonnet|haiku` (hoje só no preset Claude Code): o modelo entra direto no comando do nó criado. Trabalho mecânico pede `haiku`; implementação com escopo já dado, `sonnet`; julgamento de arquitetura, o modelo padrão da conta.

## Endereçamento ambíguo nunca escolhe por você

Quando um nome bate com mais de um nó — dois quadros de tarefas com títulos parecidos, por exemplo — o comando não adivinha qual você quis dizer. Ele recusa e lista os candidatos, para você (ou o agente) escolher explicitamente.

## Como isso funciona por baixo

```
Terminal do agente
   │  atelier ask "Codex" "revisa o diff"
   ▼
Unix socket  (macOS/Linux)  ~/.atelier/run/agent.sock
named pipe   (Windows)      \\.\pipe\atelier
   ▼
Servidor IPC     resolve quem está chamando e o que ele enxerga
   ▼
resposta em texto puro, impressa no terminal de origem
```

Tudo roda em `127.0.0.1`. Nada sai da máquina.

Comandos que existiam no app nativo e ainda não foram portados (`connect`, `preset`) respondem com uma mensagem explícita de "não implementado" em vez de falhar em silêncio.
