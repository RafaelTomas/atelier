---
title: Seu primeiro canvas
description: Do canvas vazio a dois agentes conversando entre si — um passo a passo de dois minutos.
sidebar:
  order: 3
---

Com o Atelier aberto, este é o caminho mais curto do canvas vazio até dois agentes trabalhando juntos. Leva uns dois minutos.

## 1. Crie dois terminais

Na dock — a pill de ícones na base do canvas — clique no ícone de terminal. Isso abre o diálogo **Novo Terminal**. No **Início Rápido**, escolha `Claude Code` para o primeiro e `Codex` para o segundo (ou digite o comando de qualquer CLI de agente que você já use — nenhum preset é obrigatório).

O clique arma o modo **desenhe a área**: o próximo arrasto no canvas define onde e de que tamanho o terminal nasce. Um clique seco, sem arrastar, usa o tamanho padrão no ponto clicado.

## 2. Ligue um no outro

Clique no `⇄` no cabeçalho do primeiro terminal e depois clique no segundo. Um cabo tracejado azul segue o cursor entre os dois cliques e vira um cabo de verdade assim que você conecta.

A partir daqui, os dois agentes podem falar um com o outro.

## 3. Crie uma nota com os requisitos

Botão direito no vazio do canvas cria uma nota rápida. Escreva ali o que você quer que os dois agentes façam, e ligue a nota aos dois terminais do mesmo jeito que você ligou os terminais entre si.

## 4. Dê uma responsabilidade a cada um (opcional)

Na aba **Agente** do diálogo de terminal, **+ Novo** cria uma responsabilidade — "Frontend", "Backend", o que fizer sentido para o seu caso. O texto que você escrever ali é o que o agente lê quando roda `atelier role`.

## 5. Peça ao primeiro agente para falar com o segundo

No terminal do primeiro agente, escreva algo como:

```
Leia a nota "Spec" e peça ao Codex para revisar o que você implementou.
```

O agente vai resolver isso sozinho, rodando:

```bash
atelier note read "Spec"
atelier ask "Codex" "revisa o que implementei"
```

Ele não precisa que você explique o CLI `atelier` — o comando já está no `PATH` dele, e a skill de uso é injetada automaticamente no momento em que o cabo é criado.

## O cabo é o que define o alcance

A partir deste ponto, a regra que vale para todo o resto do app é simples: **um agente só enxerga aquilo em que está ligado por um cabo**. Se você quiser que um terceiro agente entre na conversa, ou que um deles pare de ver a nota, a mudança é sempre no cabo — desenhar um novo ou apagar um existente.

A página de [conceitos](../conceitos/) detalha o vocabulário — nó, cabo, workspace, Artesão — que você vai usar para descrever o que monta no canvas.
