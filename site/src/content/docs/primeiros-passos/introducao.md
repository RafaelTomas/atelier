---
title: Introdução
description: O que é o Atelier e o problema que ele resolve — o canvas onde agentes de IA trabalham lado a lado e conversam entre si.
sidebar:
  order: 1
---

Você já rodou dois ou três agentes de IA ao mesmo tempo e percebeu que virou o gargalo? Lê a saída de um, resume, cola no outro, espera, traz de volta. Quanto mais agentes você soma, mais tempo você gasta sendo a ponte entre eles em vez de fazer o trabalho em si.

O Atelier tira você desse meio de campo. Em vez de janelas de terminal isoladas, os agentes ficam num **canvas infinito**, lado a lado. Você liga um no outro com um cabo, e eles passam a se falar direto — sem precisar de você para carregar contexto de um lado para o outro.

## Um canvas, não uma lista de janelas

Pense no canvas como uma mesa de trabalho sem limite de espaço. Cada coisa com que você trabalha — um agente, uma nota com requisitos, um navegador embutido, uma árvore de arquivos — é um **nó** que você posiciona, redimensiona e organiza visualmente. Dá para afastar e ver o projeto inteiro de uma vez, ou aproximar para acompanhar um agente de perto.

Isso não é cosmético: cada nó é um processo de verdade. Um nó de terminal é um PTY de verdade rodando `claude`, `codex` ou qualquer CLI que você use. Uma nota é um arquivo `.md` de verdade, gravado em disco. Nada ali é simulado ou é só uma representação visual — é a coisa em si, desenhada no canvas.

## O cabo é a permissão

O elemento que faz o Atelier diferente de "vários terminais abertos" é o **cabo**. Clique no `⇄` no cabeçalho de um nó, depois clique no nó de destino, e um cabo aparece entre os dois — com física de verdade, então ele balança e assenta como um cabo real assentaria.

O cabo não é decoração. **Ele é a permissão.** Um agente só enxerga e só consegue conversar com aquilo em que está ligado por um cabo. Ligue um terminal a uma nota, e o agente passa a poder ler e escrever nela. Ligue dois terminais entre si, e os dois agentes passam a poder se pedir coisas um ao outro, sem passar por você.

```
Claude ⇄ Codex        (os dois podem se falar)
Claude ⇄ Spec.md       (Claude pode ler e escrever a nota)
Codex  ⇄ Spec.md       (Codex também pode)
```

Na prática, um agente ligado a outro passa a rodar comandos como:

```bash
atelier ask "Codex" "revisa o diff em src/auth"
atelier note read "Spec"
```

Esses comandos usam o CLI `atelier`, que entra automaticamente no `PATH` de todo terminal conectado. Você não precisa instruir o agente a "conversar com o outro" toda vez — uma vez que o cabo existe, a capacidade existe, e uma skill injetada no momento da conexão ensina o agente a usá-la.

## Por que isso importa

A consequência prática é que a coordenação deixa de ser um trabalho seu. Você monta a topologia — quem fala com quem, quem lê o quê — uma vez, olhando o canvas, e depois os agentes trabalham dentro dela sem precisar de você como intermediário. Se um projeto pede um agente de frontend e um de backend compartilhando a mesma spec, você desenha exatamente essa forma: dois terminais, uma nota, três cabos.

Isso também é o que torna o alcance de um agente **legível**: olhando o canvas, dá para ver exatamente o que cada agente pode tocar, porque é exatamente o que está ligado a ele por um cabo. Não há acesso implícito nem escopo escondido em configuração.

As próximas páginas cobrem a instalação e o primeiro canvas na prática — em poucos minutos você tem dois agentes conversando entre si.
