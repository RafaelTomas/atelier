---
title: "Widget: Tarefas"
description: Um quadro kanban no canvas, escrito por você e pelo agente, sem que ninguém precise contar nada para o outro.
sidebar:
  order: 12
---

## Para que serve

O widget Tarefas é um quadro kanban — lista e kanban são duas vistas da mesma fonte de dados. Cada cartão pode carregar uma origem e um **Plano**, uma sequência de passos com progresso (`pendente`, `em andamento`, `feito`, `bloqueado`, `pulado`).

O valor prático está em não precisar narrar o andamento para ninguém: o cartão anda de "Fazendo" para "Feito" enquanto o agente trabalha, e você lê o progresso olhando o quadro, sem pedir um resumo.

## Como criar

Escolha o widget de Tarefas na dock, ou deixe um agente criar um quadro novo com `atelier todo create "Título"`.

## O que entrega a um agente cabeado

- **`atelier todo list ["Quadro"]`** — as colunas e os cartões (id curto, título, responsável).
- **`atelier todo add` / `move` / `done`** — criar, mover de coluna, ou marcar um cartão como feito.
- **`atelier todo show "Quadro" <id ou prefixo do título>`** — o cartão inteiro: status, responsável, tags, origem, e o plano com o progresso de cada passo.
- **`atelier todo plan` / `atelier todo step`** — escrever ou atualizar o plano de um cartão.

Um cartão é endereçável por id ou por um prefixo do título; um prefixo ambíguo é recusado com a lista de candidatos, nunca resolvido "no primeiro que bate". **Não existe `delete` no CLI** — apagar um cartão é sempre um gesto seu, feito no próprio nó.
