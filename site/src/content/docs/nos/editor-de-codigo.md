---
title: Editor de código
description: Um arquivo aberto no canvas com CodeMirror 6 — e por que a escrita continua sendo tarefa do próprio agente.
sidebar:
  order: 7
---

## Para que serve

O Editor de código abre um arquivo com destaque de sintaxe (CodeMirror 6, gramáticas carregadas sob demanda por extensão), para você acompanhar ou editar algo lado a lado com os agentes. `⌘/Ctrl+S` salva; fechar com uma alteração pendente pergunta antes de descartar.

O arquivo é vigiado individualmente: sem alteração local sua, o editor recarrega sozinho quando um agente conectado mexe nele por fora; com uma alteração pendente, ele avisa e deixa a decisão com você em vez de sobrescrever silenciosamente.

## Como criar

Duplo clique num arquivo na árvore de arquivos (ou soltá-lo no canvas) abre este nó. Um agente abre um pelo CLI informando o caminho absoluto — e só consegue abrir caminhos que estejam sob uma raiz de árvore de arquivos já presente no canvas.

## O que entrega a um agente cabeado

- **`atelier editor list`** — os arquivos abertos no momento.
- **`atelier editor read "Arquivo" [offset] [limit] [--selection]`** — o texto do **buffer** que está na tela, não do disco, com um aviso quando há alteração não salva. `--selection` devolve só o trecho selecionado por você.

**Não existe verbo de escrita.** Quem edita o arquivo é o próprio agente, com as ferramentas de edição dele — que já vêm com diff, permissão e histórico — e o file-watcher do editor recarrega o nó sozinho quando isso acontece. O editor aqui é uma janela para o agente ver o que você está olhando, não um canal para ele escrever.
