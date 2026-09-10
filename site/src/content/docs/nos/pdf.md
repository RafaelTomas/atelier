---
title: Documento PDF
description: Um PDF aberto no canvas com o visor nativo do Chromium — na prática, um Portal especializado.
sidebar:
  order: 5
---

## Para que serve

Quando você precisa ter um PDF — uma spec, um manual, um contrato — visível ao lado dos agentes que trabalham com ele, o nó de Documento PDF abre o arquivo com o mesmo visor de PDF do Chromium: zoom, busca e impressão embutidos, dentro do próprio nó.

Por trás da cara própria, não é um tipo de nó novo: é um [Portal](../portal/) apontando para o arquivo local, com a barra de endereço escondida. Isso significa que ele compartilha as mesmas capacidades e limitações do Portal.

## Como criar

O caminho é **Nota → Documento PDF** no menu, que abre um seletor de arquivo. O caminho escolhido fica salvo no workspace, então o nó reabre exatamente no mesmo documento da próxima vez — e mostra o mesmo aviso de falha de um portal comum se o arquivo tiver sumido do disco.

## O que entrega a um agente cabeado

Como é um Portal por baixo, o mesmo conjunto de comandos se aplica — `atelier portal read`, `html`, `shot`. Na prática, o uso típico é ler o texto visível do documento ou tirar uma captura de uma página específica; não há um verbo próprio de "PDF" além dos verbos de portal.
