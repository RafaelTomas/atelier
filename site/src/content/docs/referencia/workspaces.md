---
title: Workspaces e persistência
description: Onde ficam seus dados em disco, como o Atelier salva sem risco de corromper um arquivo, e como manter o ambiente de desenvolvimento isolado dos dados reais.
sidebar:
  order: 1
---

Você fechou o Atelier no meio de uma sessão com três agentes trabalhando. Ao reabrir, tudo está exatamente como estava — canvas, cabos, notas. Onde isso mora, e por que dá para confiar nele?

## O que é um workspace

Um **workspace** é o conjunto de nós e cabos que compõe um canvas — o equivalente a um projeto ou uma sessão de trabalho. O Atelier suporta múltiplos workspaces, com um chip de troca no topo do canvas, e cada um é salvo em disco de forma independente.

## Onde os dados ficam

```
~/.atelier/
├── manifest.json                   índice de workspaces
├── preferences.json
├── app-state.json                  workspace ativo + flag de shutdown limpo
├── projects.json                   o índice de projetos (global)
├── bin/atelier                     o CLI injetado nos terminais
├── roles/{UUID}.json               as responsabilidades (um arquivo cada)
├── run/agent.sock                  socket do CLI (recriado a cada boot)
└── workspaces/{UUID}/
    ├── workspace.json              nós e cabos
    ├── notes/*.md                  as notas, como arquivos de verdade
    └── terminals/*.scrollback
```

Duas coisas valem destacar aqui. As **notas** são arquivos `.md` comuns — dá para abri-las, editá-las e versioná-las em git com qualquer ferramenta fora do Atelier, porque elas não são uma representação, são o arquivo em si. E o **índice de projetos** (`projects.json`) não pertence a workspace nenhum: é global, o mesmo em qualquer canvas que você abrir.

## Como o Atelier salva sem corromper

Toda escrita em disco segue o mesmo caminho: grava um arquivo temporário, garante que ele está fisicamente no disco, e só então renomeia por cima do arquivo anterior. Se o processo cair no meio de um salvamento — queda de energia, crash, o que for — o arquivo anterior continua íntegro. Nunca sobra um JSON pela metade.

Autosave, o indicador de mudanças não salvas e a recuperação após um fechamento inesperado usam essa mesma garantia por baixo.

## Desenvolvimento não toca nos seus dados

Se você roda o Atelier a partir do código-fonte (`npm run dev`), o app aponta para `~/.atelier-dev` em vez de `~/.atelier` — um ambiente completamente isolado dos seus workspaces reais. Rodar o projeto em modo de desenvolvimento nunca encosta no que você já tem salvo.

A próxima página explica o formato do `workspace.json` em si, e por que um workspace antigo continua abrindo depois de uma atualização.
