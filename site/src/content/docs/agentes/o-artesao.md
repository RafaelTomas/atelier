---
title: O Artesão
description: Por que um agente marcado como Artesão delega abrindo nós no canvas em vez de usar subagentes invisíveis — e o que muda por trás disso.
sidebar:
  order: 2
---

Você pediu ao seu agente para dividir uma tarefa grande em pedaços e delegar. Ele conhece uma ferramenta de subagente — e é exatamente essa ferramenta que o Atelier quer que ele não use.

## O problema que o Artesão resolve

Um agente como o Claude Code tem, por padrão, uma forma de delegar que abre um ajudante **dentro da própria sessão**. Num terminal isolado isso é conveniente. Num canvas, é o pior dos dois mundos:

- o subagente não ganha nó — você não vê nada acontecendo, não pode interromper, não pode olhar o que ele está fazendo;
- ele herda a identidade do pai no CLI, então se ele tentasse falar com outro nó, pareceria que quem está falando é o agente original;
- e ele morre junto com a sessão do pai, levando embora tudo o que descobriu.

O checkbox **Artesão**, na aba Detalhes do diálogo de terminal, desliga esse caminho. Um agente marcado como Artesão delega **abrindo nós de verdade no canvas** — com os comandos `atelier recruit`, `atelier ask` e `atelier dismiss` do CLI.

## O que muda quando você marca a caixa

Marcar o Artesão veste o nó: ele nasce com o nome **Artesão**, o ícone de martelo e a cor verde, e ganha o badge `ARTESÃO` no cabeçalho. É um ponto de partida, não uma prisão — um nome que você já digitou não é sobrescrito, e a aba Aparência continua valendo depois.

A partir daí, cada ajudante que o Artesão recruta é um **terminal próprio**, visível no canvas, que você acompanha, interrompe ou recarrega como qualquer outro nó. Delegar deixa de ser uma caixa preta.

## O brief injetado

Quando o terminal marcado como Artesão é o **Claude Code**, o Atelier vai além de sugerir o caminho certo — ele fecha a porta do errado:

- um hook de `PreToolUse` **nega** a ferramenta de subagente e ensina, na própria recusa, o comando de `recruit` que resolveria o problema. Bloquear calado só faria o agente tentar de novo sem entender por quê;
- um hook de `SessionStart` injeta a doutrina logo no início da conversa, já com o estado real do canvas: quem está cabeado a ele, quantas vagas de terminal ainda restam antes do teto do `recruit`.

Essa recusa é montada **dentro do próprio CLI**, sem depender do app responder pelo socket — se o Atelier engasgar, um Artesão continua Artesão.

Nos demais agentes — Codex, Antigravity, OpenCode — não existe hook equivalente, então ali a regra é **instruída, não bloqueada**: o terminal recebe a variável `ATELIER_ARTESAO=1` e um cabeçalho correspondente aparece no `atelier list`, que é o comando que qualquer agente roda antes de delegar. Prometer bloqueio onde ele não existe seria pior do que não oferecer nada.

## Quem pode ser Artesão

Vale para **qualquer agente de IA** conectado a um terminal. O único que não pode é o **shell puro**: não há a quem instruir, então a caixa aparece desabilitada no diálogo, com o motivo à vista.

Duas regras completam o quadro:

- **Um agente recrutado por um Artesão não nasce Artesão.** A oficina que se forma é plana, não uma árvore de delegação — o teto de doze terminais por canvas foi pensado para largura, não para profundidade.
- **O Artesão é o único mestre do canvas.** Não há hierarquia paralela por trás disso — a organização do trabalho é sempre visível, nó por nó.

A próxima página trata da ideia que sustenta tudo isso: o cabo como unidade de permissão.
