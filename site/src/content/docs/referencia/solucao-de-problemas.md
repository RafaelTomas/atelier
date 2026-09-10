---
title: Solução de problemas
description: Os problemas mais comuns na instalação e no uso do Atelier, e como resolver cada um.
sidebar:
  order: 3
---

Algo não funcionou como esperado? Comece por aqui — a maioria dos problemas conhecidos tem uma causa específica e uma correção de uma linha.

## Erros ao abrir um terminal

**`posix_spawnp failed.` ao abrir qualquer terminal.** Um componente nativo do projeto às vezes chega sem a permissão de execução correta durante a instalação. A correção roda sozinha: reinstale as dependências, ou execute

```bash
node scripts/fix-native-deps.mjs
```

O script é idempotente — rodar de novo nunca faz mal.

**`exited with signal SIGKILL`, sem mais nenhuma mensagem.** Em algumas versões do Electron no macOS, o sistema pode revogar a notarização e o Gatekeeper mata o processo antes dele conseguir subir. O mesmo comando acima resolve, re-assinando o bundle local.

Se qualquer um dos dois voltar depois de já ter sido corrigido, rode o script de novo — ele não tem efeito colateral em repetir.

## Rodando dentro do VS Code

O terminal integrado do VS Code exporta uma variável de ambiente que faz o Electron subir em modo Node em vez de modo app, e o Atelier falha ao iniciar. Para rodar o projeto a partir de dentro do editor, remova essa variável antes do comando:

```bash
env -u ELECTRON_RUN_AS_NODE npm run dev
```

Ou, mais simples: abra um terminal fora do VS Code para rodar o Atelier.

## `atelier: command not found` dentro de um terminal do canvas

O CLI `atelier` só entra no `PATH` de terminais **conectados** por cabo a algum outro nó. Um terminal sozinho, sem nenhum cabo, não tem o comando disponível. Ligue-o a qualquer outro nó e abra um terminal novo — o comando aparece assim que a conexão existe.

## `atelier ask` estourou o tempo

Isso significa que o destinatário ainda está trabalhando, não que algo quebrou. Não reenvie o mesmo `ask` — isso interrompe o trabalho em andamento no outro agente. Em vez disso, use:

```bash
atelier check "Nome do agente"
```

para ver o que ele está fazendo agora, e decida a partir daí se vale esperar ou intervir.

## Nada disso resolveu?

Rode `atelier debug` de dentro de um terminal conectado para um diagnóstico da conexão. Se o problema persistir, veja a página sobre o [formato de arquivo](../formato-de-arquivo/) — muitos sintomas estranhos ao abrir um workspace específico têm origem ali.
