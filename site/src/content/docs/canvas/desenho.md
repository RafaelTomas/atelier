---
title: Desenho à mão livre
description: Caneta, marca-texto e borracha para anotar diretamente no canvas — e por que os traços não são nós.
sidebar:
  order: 4
---

Às vezes o jeito mais rápido de explicar algo é circular um nó ou sublinhar um trecho, sem sair para outra ferramenta. O Atelier tem desenho à mão livre embutido no próprio canvas.

## As ferramentas

| Ferramenta | Atalho |
|---|---|
| Caneta | `P` |
| Marca-texto | `M` |
| Borracha | `E` |
| Voltar à seleção | `V` ou `Esc` |

Com uma ferramenta de desenho ativa, o arrasto no canvas vira traço em vez de pan ou seleção — a paleta de cores e a espessura aparecem numa barra enquanto você desenha.

## Por que um traço não é um nó

Os traços que você desenha **não entram no z-index dos nós**: não aceitam cabo, não podem ser selecionados como um nó, e vivem numa camada própria, desenhada entre a grade de fundo e os nós — nunca por cima de um terminal ou de um portal, o que esconderia o conteúdo deles.

Essa distinção importa para o que você pode esperar do desenho: ele é uma anotação visual, útil para circular, sublinhar ou rabiscar uma seta entre dois nós — não uma forma de criar conteúdo que um agente possa ler ou que aceite conexão. Para isso, o nó certo é uma nota ou um texto solto.
