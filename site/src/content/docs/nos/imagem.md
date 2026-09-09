---
title: Imagem
description: Um gráfico, screenshot ou diagrama publicado por um agente como nó — só metadados voltam pelo cabo.
sidebar:
  order: 9
---

## Para que serve

O nó de Imagem existe para um agente colocar algo visual no canvas — um gráfico gerado, uma captura de tela, um diagrama — sem que isso exija um tipo de arquivo especial ou um passo manual seu.

## Como criar

Só o agente publica: `atelier image create "Título" <caminho> [--alt "descrição"]`, apontando para um arquivo de imagem já existente em disco.

## O que entrega a um agente cabeado

A entrega é **só metadados** — título, dimensões naturais da imagem, id do nó. **Os pixels não voltam** para o agente pelo cabo — o mesmo fluxo de mão única da tabela de dados: quem gerou a imagem já tinha o arquivo; o nó é a vitrine dela no canvas, não um canal de leitura.
