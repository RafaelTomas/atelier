---
title: Terminal
description: O nó central do Atelier — um PTY de verdade rodando um agente de IA ou qualquer shell.
sidebar:
  order: 1
---

Se você só vai usar um tipo de nó, é este: o terminal é onde um agente de IA — ou qualquer shell — de fato roda.

## Para que serve

Um nó de terminal é um PTY real, renderizado com xterm.js. Rode `claude`, `codex`, ou qualquer CLI de agente que você use, ou simplesmente um shell puro. Não há simulação nem proxy: é o mesmo processo que você teria rodando numa janela de terminal comum, só que posicionado e redimensionável no canvas.

## Como criar

Clique no ícone de terminal na dock e desenhe a área no canvas — isso abre o diálogo **Novo Terminal**, com presets de Início Rápido para Claude Code, Codex, Antigravity, OpenCode e Shell (cada um com cor e ícone próprios), além da opção de digitar qualquer comando. Um agente Artesão cria um terminal novo pelo `atelier recruit`, sem passar pelo diálogo.

Selecionar um terminal existente sobe uma barra de ações acima do card: ligar (o mesmo `⇄` do cabeçalho), editar, recarregar (mata o processo e sobe outro no lugar) e excluir.

O rodapé do terminal mostra a linha de status do próprio agente quando ele a imprime — tokens da sessão, contexto usado, janelas de limite de uso — e fica vermelho quando uma janela passa de 85%.

## O que entrega a um agente cabeado

Um terminal ligado a outro terminal por um cabo `terminal ↔ terminal` dá ao agente:

- **`atelier list`** — o nome, o ciclo de vida (`working` / `waiting` / `idle` / `exited`) e a responsabilidade de cada agente conectado.
- **`atelier ask "Nome" "tarefa"`** — envia um pedido e espera até o outro agente ficar ocioso para responder.
- **`atelier check "Nome" [linhas]`** — lê a tela do outro sem interrompê-lo; é o comando certo quando um `ask` estoura o tempo.
- **`atelier recruit` / `atelier dismiss`** — abre ou fecha um agente ajudante, só disponível para quem está marcado como [Artesão](../../primeiros-passos/conceitos/).
- **`atelier role`** — a própria responsabilidade atribuída.

Quando um terminal está parado esperando alguma coisa (`waiting`), o que exatamente ele está pedindo aparece antes do resto da tela — é a informação que evita reler o diálogo inteiro para entender o que travou.
