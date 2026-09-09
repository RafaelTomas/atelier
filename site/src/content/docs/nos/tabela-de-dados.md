---
title: Tabela de dados
description: O resultado de uma consulta publicado como nó — mão única, sem os dados voltando para o agente.
sidebar:
  order: 8
---

## Para que serve

Quando um agente roda uma consulta — SQL ou qualquer outra fonte de dados — e você quer ver o resultado no canvas, a Tabela de dados é o nó que recebe essa publicação: título, o formato de origem e as linhas exibidas visualmente.

## Como criar

Só o agente cria: `atelier table create "Título" <dados>`, com `--query` para registrar a consulta de origem e `--format` para o formato (JSON, CSV, TSV). `atelier table append` acrescenta linhas a uma tabela já publicada.

## O que entrega a um agente cabeado

A entrega é **só metadados** — título, contagem de linhas e colunas, se o conteúdo foi truncado. **As linhas nunca voltam para o agente** pelo cabo.

Esse é um fluxo deliberadamente de mão única: o Atelier nunca toca o banco de dados nem qualquer outra fonte por conta própria. O agente executa a consulta com as ferramentas dele, e a tabela é só a vitrine do resultado no canvas — não um canal de leitura de volta.
