---
title: Navegação
description: Pan, zoom, voltar a 100%, seleção e marquee — como se mover pelo canvas infinito do Atelier.
sidebar:
  order: 1
---

Com um canvas de dezenas de nós, a primeira coisa que você precisa é se mover por ele sem perder a mão. O Atelier trata pan e zoom como gestos de primeira classe, não um extra.

## Mover e ampliar

| Ação | Como |
|---|---|
| Pan | Scroll |
| Pan com a mão | Segurar `espaço` e arrastar |
| Zoom | `⌘/Ctrl` + scroll |
| Voltar a 100% | `⌘0` |

Não existe limite de área — o canvas é infinito nas duas direções. Você pode espalhar um projeto grande sem esbarrar numa borda.

## Selecionar

| Ação | Como |
|---|---|
| Selecionar um nó | Clique |
| Selecionar vários | `Shift` + clique, ou arrastar no vazio (marquee) |
| Apagar a seleção | `Delete` |

Um nó selecionado ganha um anel tracejado azul em volta. Selecionar um terminal também sobe uma barra de ações logo acima do card, com atalhos para ligar, editar, recarregar e excluir aquele nó específico.

## Por que o canvas não engasga com muitos nós

Só o que está dentro da viewport — mais uma margem de 200px — existe de fato no DOM. Um nó fora dessa área é desmontado até você rolar de volta até ele. Isso é o que permite ter centenas de nós num workspace sem o app travar: o custo de renderização é proporcional ao que está na tela, não ao tamanho do projeto.

Uma consequência prática: um terminal fora da viewport continua rodando o processo dele (o PTY não é pausado), mas a tela dele só volta a se atualizar visualmente quando ele reentra na área visível.
