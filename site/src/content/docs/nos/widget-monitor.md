---
title: "Widgets: Monitor, Git e Projetos"
description: Os três painéis de referência do canvas — o que entregam a um agente é sempre onde ele deve olhar, não o dado em si.
sidebar:
  order: 13
---

Estes três widgets têm uma coisa em comum: nenhum deles tem verbo próprio de leitura no CLI, porque o agente já roda `git`, `df` ou `top` no shell dele muito melhor do que qualquer comando que um CLI pudesse oferecer. O que eles entregam é a informação que o agente não teria como descobrir sozinho: **em qual repositório, em qual volume, em qual projeto** você está olhando agora.

## Monitor de recursos

Painel e tira na borda do canvas, com três blocos: **PC** (CPU, memória e disco, com histórico em sparkline), **IA** (tokens, contexto e custo somados de todos os terminais do canvas, com a janela da sessão à vista) e **Perfis** (os limites de 5h e 7 dias, que são da conta, não do terminal — dois agentes na mesma conta dividem a mesma janela).

Um agente conectado ao Monitor recebe, no inventário, **o volume observado** (ou o diretório de trabalho do workspace, quando nenhum disco específico está fixado) e o período de amostragem — não os números do painel, que ele já consegue com as próprias ferramentas de sistema.

## Git

Painel lateral e widget fixável no canvas: status do projeto selecionado, arquivos alterados, histórico de commits, e os ícones de buscar/pull/push. Por padrão o projeto observado segue a seleção feita na lista de Projetos; fixar o widget no canvas trava a observação num repositório específico.

Um agente conectado ao painel de Git recebe **o caminho do repositório observado**, o branch atual, e se o painel está fixado ou seguindo a seleção da aplicação — de novo, a referência para ele rodar `git log`, `git diff` ou `git status` sozinho, não o resultado desses comandos.

## Projetos

A aba Projetos é o índice global dos seus repositórios — não pertence a workspace nenhum, e funciona com ou sem um painel dele aberto no canvas. A varredura considera projeto qualquer pasta com `.git`, parando no primeiro repositório encontrado (um monorepo com `backend/` e `frontend/` aparece como uma entrada, a dele).

Ao contrário do Monitor e do Git, o **verbo aqui existe** porque o índice é global, não amarrado ao painel:

- **`atelier projects list [busca] [--pending]`** — nome, tipo, branch e caminho de até 100 projetos.
- **`atelier projects info "<caminho>"`** — a ficha completa: nome, caminho, tipo, linguagem, git, stack, descrição, papel, quando foi descrito pela última vez.
- **`atelier projects describe "<caminho>" "uma frase" --stack "..." --role "..."`** — escreve a descrição de um projeto.

O identificador preferido é sempre o **caminho** — nomes de pasta se repetem, e um `describe` por nome ambíguo é recusado com a lista de caminhos candidatos, em vez de descrever o projeto errado em silêncio.
