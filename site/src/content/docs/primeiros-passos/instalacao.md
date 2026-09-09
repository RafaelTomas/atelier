---
title: Instalação
description: Como rodar o Atelier no macOS, Windows e Linux — requisitos, npm install e os problemas conhecidos de dependência nativa.
sidebar:
  order: 2
---

O Atelier ainda não tem instalador pronto para baixar — hoje você roda o projeto a partir do código-fonte. É rápido: dois comandos e uma espera do `npm install`. Quando sair a primeira versão publicada, ela vai estar em [/download](/download).

## Requisitos

- **Node 22 ou mais recente**, em qualquer uma das três plataformas.
- No **macOS**, as Command Line Tools:

  ```bash
  xcode-select --install
  ```

## Rodar o projeto

```bash
git clone <url-do-repo> atelier
cd atelier
npm install
npm run dev
```

O `npm install` compila o `node-pty` — a dependência nativa que dá vida aos terminais do canvas — para a sua plataforma. Se aparecer um erro opaco na primeira execução, veja a seção de problemas conhecidos abaixo antes de investigar mais fundo.

`npm run dev` sobe o app com hot reload e isola os dados em `~/.atelier-dev`. Rodar o projeto em modo de desenvolvimento não encosta em nenhum workspace real seu — para trabalhar com seus dados de verdade durante o desenvolvimento, use `npm run dev:realdata` (faça backup antes).

## Empacotar um instalador local

Se quiser gerar um pacote instalável para a sua própria máquina:

```bash
npm run pack:mac      # .dmg + .zip
npm run pack:win      # instalador NSIS
npm run pack:linux    # AppImage + .deb
```

Sem certificado de assinatura, o macOS pede um clique em botão direito → **Abrir** na primeira execução, e o SmartScreen do Windows avisa até o binário ganhar reputação. Isso é esperado — não é sinal de que algo deu errado no empacotamento.

## Problemas conhecidos de dependência nativa

O `postinstall` já roda `scripts/fix-native-deps.mjs` e conserta os dois problemas mais comuns automaticamente. Se ainda assim algo escapar:

| Sintoma | Causa | Correção |
|---|---|---|
| `posix_spawnp failed.` ao abrir qualquer terminal | o `spawn-helper` do node-pty chega sem bit de execução | `chmod +x` no helper |
| `exited with signal SIGKILL`, sem mais nada | a Apple revogou a notarização de alguma versão do Electron | re-assinatura ad-hoc do bundle local do Electron |

Se algum dos dois voltar, rode o script manualmente — ele é idempotente:

```bash
node scripts/fix-native-deps.mjs
```

**Rodando dentro do VS Code:** o terminal integrado exporta `ELECTRON_RUN_AS_NODE=1`, o que faz o Electron subir em modo Node e falhar. Use um terminal fora do editor, ou rode:

```bash
env -u ELECTRON_RUN_AS_NODE npm run dev
```

Com o app aberto, o próximo passo é criar seu primeiro canvas.
