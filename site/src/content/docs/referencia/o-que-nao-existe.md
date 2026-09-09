---
title: O que ainda não existe
description: Uma lista honesta do que o Atelier ainda não faz — para você não planejar em cima de uma capacidade que não está lá.
sidebar:
  order: 4
---

Antes de montar um fluxo de trabalho em cima de uma suposição, vale saber onde a linha está hoje. Esta página existe para isso: dizer com clareza o que o Atelier **não** faz ainda, em vez de deixar você descobrir na hora errada.

## Tipos de nó em placeholder

Formas geométricas, traços de desenho como nó independente e o traço livre como tipo próprio ainda não têm interface no canvas. Eles existem no formato de arquivo — um workspace que já os carrega é lido e regravado sem perder nada — mas não há como criar ou editar um deles diretamente pelo Atelier hoje.

Isso é diferente do desenho à mão livre que você já usa (caneta, marca-texto, borracha): esse recurso funciona normalmente e não depende dos tipos acima.

## O que não existe de jeito nenhum ainda

- **Floors** (organização por git worktree) — não implementado.
- **Routines** (automações agendadas além do que já existe hoje) — não implementado.
- **SSH** — não há nó ou integração para terminais remotos.
- **Tela de configurações dedicada** — as preferências existem, mas não há uma tela central para gerenciá-las.

## Tabela de dados sem atualização automática

Uma tabela publicada no canvas é uma fotografia do resultado no momento em que o agente rodou a query — ela não reexecuta a consulta sozinha nem se atualiza quando os dados de origem mudam. Se você precisa de um número atual, peça ao agente para publicar a tabela de novo.

## Retomada de sessão fora do Claude Code

Hoje só o preset Claude Code sabe retomar uma conversa anterior ao reabrir um terminal. Codex, Antigravity e OpenCode ainda não declaram essa capacidade — reabrir um terminal com esses presets sempre começa uma sessão nova.

## O CLI roda sobre o runtime do Electron

O `atelier` que entra no `PATH` dos seus terminais é hoje um wrapper que depende do runtime do Electron por trás — não é um binário nativo independente. Na prática isso não muda como você o usa, mas é bom saber que ele não roda fora de uma instância do Atelier ativa.

## Por que esta página existe

Nenhuma dessas ausências é segredo, e nenhuma delas é definitiva — são pontos de um projeto em desenvolvimento ativo, registrados aqui para que você não construa um fluxo de trabalho assumindo uma capacidade que ainda não chegou. Se algo daqui virar realidade, esta página é atualizada junto.
