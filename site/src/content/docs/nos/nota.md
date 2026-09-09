---
title: Nota
description: Um arquivo .md de verdade no canvas — o jeito mais simples de dar requisitos a um agente.
sidebar:
  order: 2
---

Quando você precisa dar contexto por escrito a um ou mais agentes ao mesmo tempo, a nota é o nó certo.

## Para que serve

Uma nota é um arquivo `.md` de verdade, gravado em disco no workspace — não uma caixa de texto que só existe dentro do app. Você pode editá-la no canvas, abri-la em qualquer editor externo, ou versioná-la em git como qualquer outro arquivo do projeto.

## Como criar

Botão direito no vazio do canvas cria uma nota rápida — o atalho mais curto do app. Também dá para escolher o ícone de nota na dock e desenhar a área. Um agente cria uma nota já conectada a si mesmo com `atelier note create`.

## O que entrega a um agente cabeado

A nota é o único nó com **escrita livre nas duas direções** — o agente lê e escreve o arquivo inteiro, não só metadados:

- **`atelier note read "Nota" [offset] [limit]`** — o conteúdo da nota, com offset e limite em linhas para ler só um trecho.
- **`atelier note write "Nota" "conteúdo"`** — substitui o conteúdo inteiro.
- **`atelier note edit "Nota" "velho" "novo"`** — troca um trecho pontual sem reescrever o arquivo todo.

Isso torna a nota o lugar natural para uma spec compartilhada entre dois agentes: os dois leem e escrevem o mesmo arquivo, e cada edição de um lado fica visível para o outro.
