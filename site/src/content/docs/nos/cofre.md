---
title: Cofre de segredos
description: Segredos cifrados no canvas, injetáveis no ambiente de um terminal ou usados para logar num Portal — sem passar pelo contexto do agente.
sidebar:
  order: 10
---

## Para que serve

O Cofre guarda segredos — chaves de API, senhas, tokens — cifrados, para você disponibilizá-los a um terminal ou a um portal sem escrevê-los em texto puro em lugar nenhum do canvas.

## Como criar

Escolha o ícone de cofre na dock. A escrita de uma chave nova é sempre gesto seu — o agente não cria nem apaga chaves, só as consulta.

## O que entrega a um agente cabeado

Um cofre conectado por um cabo `secret` — a um terminal ou a um portal — entrega:

- **`atelier vault list`** — os **nomes** das chaves, nunca os valores.
- **`atelier vault get "Cofre" <chave>`** — o valor de **uma** chave por vez, com um aviso explícito de que agora ela está no contexto do agente.
- **`atelier vault env [--export]`** — o que já está injetado no ambiente **deste** terminal especificamente.

Uma chave nasce inerte: sem estar no ambiente de nenhum PTY e sem `origin` (o domínio que autorizaria um `atelier portal login` automático). Ativar isso — injetar no ambiente, ou autorizar o login num site — é gesto seu no próprio nó, não algo que o agente decide sozinho.

O comando `atelier portal login` é o caso em que um segredo é usado sem nunca aparecer no contexto do agente: ele preenche o campo de login diretamente, e o agente só sabe que a ação foi feita, não qual era o valor.
