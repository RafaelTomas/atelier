---
title: Conceitos
description: O vocabulário do Atelier — nó, cabo, workspace e o Artesão — para descrever com precisão o que você monta no canvas.
sidebar:
  order: 4
---

Depois de montar seu primeiro canvas, vale fixar quatro palavras que aparecem em toda a documentação e na própria interface.

## Nó

Um **nó** é qualquer coisa que você coloca no canvas: um terminal, uma nota, um navegador embutido, uma árvore de arquivos, um botão. A ideia central é que um nó não é uma representação — é o processo ou o arquivo de verdade. Um nó de terminal é um PTY de verdade, rodando o comando que você escolheu. Um nó de nota é um arquivo `.md` de verdade em disco, que você pode abrir em qualquer editor fora do Atelier.

Nada no canvas é simulado. Isso é o que permite que um agente conectado a uma nota realmente leia e escreva o arquivo, e não uma cópia dele.

## Cabo

Um **cabo** liga dois nós. Você o cria clicando no `⇄` no cabeçalho de um nó e depois no nó de destino — um cabo tracejado segue o cursor entre os dois cliques, com física de verdade (ele balança, assenta e adormece quando para de se mexer).

O cabo é a unidade de permissão do Atelier: **um agente só enxerga e só conversa com aquilo em que está ligado por um cabo**. Não existe alcance implícito. Se um terminal não está ligado a uma nota, o agente dentro dele não sabe que a nota existe — mesmo que ela esteja visível ali do lado no canvas.

Na prática, o cabo é o que dá acesso ao CLI `atelier`: comandos como `atelier ask`, `atelier note read` ou `atelier portal open` só enxergam os nós conectados ao terminal que os chamou.

## Workspace

Um **workspace** é o conjunto de nós e cabos que compõe um canvas — o equivalente a um "projeto" ou "sessão de trabalho" no Atelier. Cada workspace é salvo em disco, de forma atômica, e o Atelier suporta múltiplos workspaces abertos.

Dentro de um workspace, as notas ficam como arquivos `.md` de verdade e o restante do estado (nós, cabos, posições) fica num `workspace.json` versionado com um schema próprio.

## O Artesão

O **Artesão** é o papel que resolve um problema específico de delegação. Um agente de IA como o Claude Code tem, por padrão, uma ferramenta de subagente que abre um ajudante *dentro da própria sessão* — e no canvas isso é o pior dos dois mundos: o subagente não ganha nó próprio, então você não vê nada acontecendo nele; ele herda a identidade do pai, então qualquer coisa que ele mande pelo CLI parece vir do pai; e ele desaparece junto com a sessão do pai, levando junto o que descobriu.

Marcar um terminal como **Artesão** (aba Detalhes do diálogo) muda essa forma de delegar: em vez de subagentes invisíveis, o Artesão abre **nós de verdade no canvas** — com `atelier recruit`, `atelier ask`, `atelier dismiss`. Cada ajudante que ele recruta ganha seu próprio terminal, visível, que você pode acompanhar e interromper como qualquer outro nó.

Marcar a caixa veste o nó com o nome **Artesão**, um ícone de martelo, verde, e o badge `ARTESÃO` no cabeçalho — um ponto de partida que você ainda pode personalizar depois.

Alguns detalhes importantes sobre como isso funciona:

- **Vale para qualquer agente de IA** — Claude Code, Codex, Antigravity, OpenCode. O único que não pode ser Artesão é o shell puro, porque não há a quem instruir; a caixa aparece desabilitada com o motivo à vista.
- **A força da regra varia por agente.** No Claude Code o bloqueio é real: um hook nega a ferramenta de subagente e ensina o comando de `recruit` que resolveria o problema, e outro hook injeta a doutrina no início da conversa já com o estado do canvas. Nos demais agentes não há hook equivalente, então a regra é instruída — via uma variável de ambiente e um cabeçalho no `atelier list` — mas não bloqueada.
- **Um agente recrutado por um Artesão não nasce Artesão.** A oficina que se forma é plana, não uma árvore de delegação — o teto de doze terminais por canvas foi pensado para isso.

O bloco seguinte de documentação cobre navegação, criação de nós e os atalhos que você vai usar todo dia.
