---
title: Terminais e presets
description: Os presets de Início Rápido do diálogo de novo terminal — Claude Code, Codex, Antigravity, OpenCode e Shell — e o que muda entre eles.
sidebar:
  order: 1
---

Ao criar um terminal, o diálogo **Novo Terminal** abre com uma aba **Início Rápido** de cinco opções. Qual delas escolher?

## Os cinco presets

- **Claude Code** — o comando `claude`. Aceita seleção de modelo (`opus`, `sonnet` ou `haiku`) direto no diálogo, e é o único preset com suporte a retomada de sessão: ao reabrir o terminal, dá para escolher continuar uma conversa anterior do Claude em vez de começar do zero.
- **Codex** — o comando `codex`. Também aceita seleção de modelo, com os aliases próprios do Codex (`luna`, `terra`, `sol`).
- **Antigravity** — o comando do agente Antigravity, pronto para uso.
- **OpenCode** — o comando `opencode`.
- **Shell** — um shell comum, sem agente nenhum. Ideal para rodar comandos, ver logs ou navegar o sistema de arquivos ao lado dos agentes.

Cada preset já vem com ícone e cor próprios, e você pode trocar os dois na aba **Aparência** do mesmo diálogo — a escolha do preset não prende a aparência do nó.

Se o agente que você usa não está na lista, digite o comando dele à mão: o Início Rápido é uma conveniência, não uma lista fechada. Qualquer CLI que rode num terminal comum roda dentro de um nó de terminal do Atelier.

## O que é comum a todos

Não importa o preset escolhido, todo nó de terminal é um PTY de verdade — o mesmo processo que rodaria num terminal do sistema, com o mesmo `stdin`/`stdout`. Isso significa que:

- o rodapé do terminal mostra a **linha de status do agente** quando ele imprime uma (tokens da sessão, contexto usado, janelas de limite de uso), lida diretamente do que o agente escreve na tela;
- um terminal ligado a outros nós por cabo ganha o CLI `atelier` no `PATH` automaticamente — é assim que ele passa a poder conversar com o resto do canvas;
- editar comando e diretório de trabalho no diálogo só tem efeito no próximo boot do processo. Um agente que está no meio de uma tarefa não é interrompido por uma edição; quem decide reiniciá-lo é o botão de **recarregar**.

## Contas do Claude Code

Se você usa mais de uma conta do Claude Code, o diálogo deixa escolher qual delas entra no ambiente daquele terminal. Trocar de conta não move nenhum segredo pelo Atelier — quem grava e lê a credencial continua sendo o próprio `claude`.

A próxima página cobre o papel do **Artesão**, que muda a forma como um terminal delega trabalho para outros agentes.
