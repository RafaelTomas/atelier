---
title: "Widget: Botão"
description: Um comando repetido virado gesto de um clique — e a fila de aprovação para botões propostos por um agente.
sidebar:
  order: 11
---

## Para que serve

Quando um comando se repete o suficiente para incomodar, o Botão é o atalho: um nó pequeno com ícone e rótulo que, ao ser clicado, roda um comando, manda um prompt para um agente conectado ou abre um endereço. Nada roda escondido — o comando é escrito num terminal visível (o alvo, ou um terminal novo que nasce ao lado), então a saída, o erro e o código de saída aparecem ali como em qualquer execução manual.

## Como criar

Escolha o ícone de botão na dock e configure a ação — comando, prompt para um agente, ou URL.

Um agente também pode **propor** um botão com `atelier button propose`, mas **tudo que vem do CLI nasce pendente**: o nó aparece apagado, com o comando à vista e uma faixa **Aceitar / Descartar**. Um botão armado direto por um agente seria rodar comando arbitrário no seu shell disfarçado de interface — o aceite é o clique em que você lê o que vai de fato rodar antes de ativá-lo.

## O que entrega a um agente cabeado

- **`atelier button list`** — rótulo, tipo de ação, um resumo do que ela faz, se está `pending` (proposto, esperando você) ou `armed`, e a id curto.
- **`atelier button propose` / `edit` / `remove`** — propor, ajustar ou remover um botão.

Uma ressalva de escopo: o verbo de botão hoje ainda não respeita o cabo em `list`/`edit`/`remove` — ele enxerga todos os botões do canvas, não só os conectados a quem chamou. Para `propose`, isso não importa, porque o botão nasce e sua aprovação é o controle real.
