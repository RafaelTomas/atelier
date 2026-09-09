---
title: Grupos e minimapa
description: Como agrupar nós sob uma moldura com título e usar o minimapa para se orientar num canvas grande.
sidebar:
  order: 3
---

Quando um canvas cresce além de meia dúzia de nós, duas ferramentas ajudam a manter a organização: agrupar o que pertence junto, e enxergar o todo de uma vez.

## Grupos

Selecione vários nós — com `Shift`+clique ou marquee — e agrupe-os para que ganhem uma moldura comum com um título. O grupo é um jeito de tratar vários nós como uma unidade visual:

- **Mover o grupo** move todos os nós dentro dele juntos.
- **Focar o grupo** centraliza a visão nele.

Por baixo, o que existe de verdade são os nós membros — o grupo é a geometria que os envolve, não um contêiner com identidade própria. Isso significa que apagar o grupo não é a forma de apagar o conteúdo: os membros continuam existindo até você removê-los individualmente.

Um agente também pode montar um grupo pelo CLI, o que é útil para emoldurar visualmente o que ele acabou de criar — por exemplo, os três nós de uma tarefa que ele publicou.

## Minimapa

O minimapa mostra o canvas inteiro em miniatura, com um retângulo marcando exatamente o que está na sua viewport agora. É a ferramenta certa para dois momentos: perceber que você tem nós muito distantes uns dos outros, e saltar para uma região do canvas sem precisar dar zoom out manualmente até encontrá-la.
