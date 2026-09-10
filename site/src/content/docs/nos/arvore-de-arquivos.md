---
title: Árvore de arquivos
description: Um projeto navegável no canvas — e por que ele entrega só o caminho da raiz a um agente, não os arquivos.
sidebar:
  order: 6
---

## Para que serve

O nó de árvore de arquivos coloca uma pasta do seu sistema no canvas, navegável — expansão preguiçosa (só lê o que você abre), filtro automático de `.gitignore`, e o mesmo menu de contexto da aba Arquivos: renomear inline, duplicar no primeiro nome livre, mover para a lixeira do sistema (nunca apagar direto) e arrastar entre pastas.

Arrastar um arquivo da árvore **para dentro de um terminal** cola o caminho na linha de comando, sem apertar Enter — é o gesto para completar um comando que o agente já está digitando. Soltar o arquivo no canvas, em vez disso, abre um [Editor de código](../editor-de-codigo/).

## Como criar

Leve um nó de árvore para o canvas a partir de um projeto na aba **Projetos** do painel lateral, ou escolha o ícone na dock e desenhe a área apontando para uma pasta. Um agente também cria uma pelo CLI, informando o caminho absoluto — pedir uma raiz que já está na tela devolve aquela árvore cabeada a ele, em vez de abrir uma segunda.

## O que entrega a um agente cabeado

A entrega é **só o caminho absoluto da raiz** (o `rootPath`) — não o conteúdo dos arquivos. Isso é proposital: o agente varre e lê o que precisa com as próprias ferramentas (`ls`, `grep`, `find`), que fazem isso melhor do que qualquer verbo que um CLI poderia oferecer. Ter a raiz no inventário do agente é o que faz `atelier editor open` funcionar para arquivos abaixo dela, sem precisar repetir o caminho inteiro toda vez.
