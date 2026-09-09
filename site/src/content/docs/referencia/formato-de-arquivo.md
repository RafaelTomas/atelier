---
title: Formato de arquivo
description: Por que o workspace.json abre em versões antigas do Atelier e do app nativo, e o que acontece quando um formato mais novo encontra um leitor mais velho.
sidebar:
  order: 2
---

Você atualizou o Atelier, abriu um workspace antigo, e tudo continua no lugar — nenhum nó sumiu, nenhum cabo desapareceu. Isso não é acidente: é uma regra que o formato do arquivo segue deliberadamente.

## Um formato, duas implementações

O `workspace.json` de cada workspace segue o mesmo formato lido tanto pelo Atelier quanto pelo app nativo original do projeto, escrito em Swift. Manter os dois compatíveis significa seguir, ao pé da letra, as convenções de codificação que o Swift usa — coisas como UUID sempre em maiúsculas, datas sem milissegundos, pontos e retângulos como listas de números. Nada disso sai de graça de uma serialização comum, por isso o Atelier tem um codec escrito à mão para ler e gravar esse formato, com testes dedicados a garantir que nada se perde numa ida e volta.

## O número da versão

O formato carrega um número de versão (`schemaVersion`) que sobe cada vez que um tipo de nó novo entra no vocabulário — o editor de código, a tabela de dados, a imagem, os widgets e o cofre de segredos já subiram esse número mais de uma vez. Cada subida é só um caso a mais na lista de tipos possíveis; nenhum dado existente é transformado.

Isso é o que garante que **nós ainda em construção não são perdidos**: mesmo os tipos que não têm interface completa hoje são lidos e regravados sem perda, então um workspace pode passar pelo Atelier e voltar intacto, mesmo carregando um tipo de nó que a versão atual ainda não sabe desenhar.

## Quando um leitor mais velho encontra um arquivo mais novo

O ponto de atenção real é o caminho contrário: um workspace salvo por uma versão mais nova, aberto por uma mais velha. Os dois leitores existentes reagem de formas diferentes a um nó que eles não reconhecem — um deles recusa abrir o arquivo (barulhento, mas o arquivo continua intacto); o outro descarta o nó desconhecido em silêncio, e o primeiro salvamento automático regravaria o arquivo sem ele.

Duas proteções cobrem esse caso:

- **Backup automático na primeira gravação.** Quando um workspace mais antigo é salvo pela primeira vez pelo Atelier, o arquivo original é copiado para `workspace.v2.backup.json` ao lado — uma cópia, uma única vez na vida daquele arquivo, como rede de segurança para quem precisar voltar.
- **Modo seguro.** Se o Atelier perceber que descartou algum nó ao ler um arquivo, ou que o arquivo declara uma versão mais nova do que ele próprio entende, o workspace abre em modo seguro: autosave desligado, uma faixa de aviso no topo, e gravação só acontece por ação explícita sua. É a proteção de uma classe inteira de problema, não um caso específico de um tipo de nó.

Na prática, o que isso significa para você é simples: abrir um workspace antigo é sempre seguro, e se algo estiver fora do esperado ao abrir um mais novo numa versão desatualizada, o Atelier avisa em vez de apagar silenciosamente.

A próxima página cobre os problemas mais comuns que você pode encontrar, e como resolvê-los.
