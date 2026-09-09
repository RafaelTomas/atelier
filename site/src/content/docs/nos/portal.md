---
title: Portal
description: Um navegador embutido no canvas, com barra de endereço e sessão isolada — e o que um agente enxerga através dele.
sidebar:
  order: 4
---

Quando um agente precisa ver uma página web — conferir um app rodando localmente, inspecionar um site em produção — o Portal é a janela dele para isso.

## Para que serve

O Portal é um navegador embutido de verdade, não uma captura de tela: cada nó carrega sua própria sessão, isolada dos outros portais por padrão (dá para compartilhar cookies entre portais explicitamente, quando faz sentido). Tem barra de endereço com busca, voltar/avançar, recarregar e página inicial.

Um popup aberto de dentro de um portal (`target=_blank`) nasce como um novo nó Portal no canvas, ligado ao pai e herdando a sessão dele — sem isso, um link autenticado abriria numa aba sem login. Você pode preferir que popups naveguem no mesmo nó ou abram no navegador do sistema, dependendo do seu fluxo.

Abaixo de 40% de zoom, ou fora da viewport, o navegador embutido é desmontado e cede lugar a um cartão estático — cada portal aberto custa um processo de renderização, e a virtualização do canvas evita manter dezenas deles de pé ao mesmo tempo.

## Como criar

Escolha o ícone de portal na dock e desenhe a área, ou deixe um agente abrir um com `atelier portal open <url>` — o nó nasce já ligado a quem pediu.

## O que entrega a um agente cabeado

O Portal é o nó com o contexto mais largo de todos:

- **`atelier portal read "Portal"`** — o texto visível da página.
- **`atelier portal html "Portal" [seletor]`** — o HTML, opcionalmente restrito a um seletor.
- **`atelier portal shot "Portal"`** — uma captura em PNG, com o caminho do arquivo.
- **`atelier portal map "Portal"`** — a peça mais importante: cada elemento interativo da página numerado, com papel, rótulo, valor e estado, mais a contagem do que está fora da tela.
- **`atelier portal click` / `type` / `key` / `scroll` / `wait`** — agir sobre os elementos mapeados.
- **`atelier portal login`** — preenche um campo com um segredo vindo de um [cofre](/docs/nos/cofre/) conectado, sem que o valor passe pelo contexto do agente.

Um portal fora da viewport ou com o zoom no fundo é acordado automaticamente só para atender a leitura, e desmontado de novo em seguida — o agente não precisa se preocupar com o estado visual do nó para consultá-lo.
