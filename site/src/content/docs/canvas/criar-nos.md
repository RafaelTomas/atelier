---
title: Criar nós
description: A dock, o gesto de desenhar a área e o menu de contexto — as três formas de colocar um nó novo no canvas.
sidebar:
  order: 2
---

Todo nó do Atelier — terminal, nota, portal, o que for — nasce do mesmo gesto. Depois de aprender uma vez, você já sabe criar qualquer um dos treze tipos.

## A dock

A dock é a pill de ícones ancorada numa das bordas do canvas — por padrão, embaixo. Cada ícone é um tipo de nó. Clicar num deles **não cria o nó na hora**: ele arma o modo **desenhe a área**.

- **Arraste no canvas** para definir onde e de que tamanho o nó nasce.
- **Clique seco**, sem arrastar, usa o tamanho padrão daquele tipo no ponto clicado.
- **`Esc`** cancela o modo antes de soltar.

No terminal e no documento PDF, a área vem antes de qualquer diálogo: primeiro você desenha o espaço, depois escolhe o que vai dentro dele (o preset do agente, ou o arquivo a abrir).

## Docks móveis

A dock de criação e a rail de ações não estão fixas embaixo — são pílulas que você pode arrastar para qualquer uma das quatro bordas do canvas. A orientação dos ícones e a direção dos menus acompanham a borda escolhida, e a preferência fica salva entre sessões.

## Menu de contexto

Botão direito no vazio do canvas cria uma nota rápida — o atalho mais curto para anotar algo sem passar pela dock. Botão direito **sobre um nó** abre as ações daquele tipo específico (por exemplo, renomear ou duplicar num nó de árvore de arquivos).

## O que um agente cria sozinho

Criar nós não é só um gesto seu: um agente cabeado a você pode criar a maioria dos tipos de nó pelo CLI `atelier`, e o nó nasce já ligado por um cabo a quem pediu. Isso é o que permite um agente publicar o resultado de uma consulta como uma tabela, ou abrir um navegador para conferir algo, sem que você precise desenhar a área para ele.

As páginas do bloco [Os nós](/docs/nos/terminal/) detalham, tipo por tipo, o que cada um entrega a um agente conectado a ele.
