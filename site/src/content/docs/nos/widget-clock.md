---
title: "Widget: Relógio"
description: Relógio, cronômetro, timer, pomodoro e alarme num só nó — e o cabo que dispara um botão sozinho, no horário.
sidebar:
  order: 14
---

## Para que serve

O widget Relógio é uma única ferramenta com cinco modos, trocáveis no próprio nó: **relógio** (a hora atual), **cronômetro**, **timer** (contagem regressiva), **pomodoro** (foco/pausa alternados) e **alarme** (um horário do dia, com dias da semana em que repete — o modo pensado para automação recorrente, tipo "todo dia às 08:00").

O que faz o alarme interessante não é só marcar a hora: ligado por cabo a um [Botão](/docs/nos/widget-botao/), ele dispara aquele botão sozinho no horário configurado — sem ninguém precisar clicar. Sem nenhum dia marcado, o alarme é de uma vez só: a próxima ocorrência daquele horário, e depois disso ele se desarma sozinho.

Com o app fechado, nada dispara — um alarme vencido enquanto o Atelier estava fechado não roda retroativamente ao reabrir; o nó só registra que perdeu aquela ocorrência, em vez de deixar você achando que algo quebrou.

## Como criar

Escolha o widget de Relógio na dock, ou peça a um agente para criar e configurar um pelo CLI — `atelier clock create ["Rótulo"] --mode alarm --at-time 08:00 --days mon-fri --on "Botão"` monta modo, horário, dias, cor e o alvo numa chamada só. `atelier clock set` ajusta um relógio já existente, e `atelier clock remove` apaga.

## O que entrega a um agente cabeado

- **`atelier clock list`** — modo, resumo legível (`08:00 · seg a sex`, `08:00 · uma vez`, `desarmado`), se está armado ou desarmado, o botão do outro lado do cabo (ou a informação de que não há nenhum), e o id curto.
- **`atelier clock create` / `set`** — configura modo, horário, dias, durações de timer/pomodoro, cor e o botão alvo. Endereçar um botão que está `pending` (proposto por um agente e ainda não aceito por você) ou que exige confirmação a cada execução é recusado — um relógio não pode ser o atalho que burla o aceite que o próprio botão já pede.
- **`atelier clock --off`** — desliga o cabo. **`--disarm`** — desarma sem cortar o cabo.

**Um agente cria, configura e desarma um alarme — mas nunca o arma.** Todo alarme nasce `idle`: mesmo com o cabo já ligado ao botão certo, nada dispara até você apertar **Armar** no próprio nó, onde o resumo (`08:00 · seg a sex → Subir o dev`) está escrito para você conferir antes. É a mesma lógica de um botão proposto por agente nascer pendente — reduzir o que um alarme pode fazer é seguro para o agente decidir sozinho; ligar a execução automática é sempre gesto seu.

### O cabo que deixou de mentir

Até pouco tempo, o diálogo do relógio não dizia nada sobre o cabo: um relógio em modo Relógio ou Cronômetro podia estar ligado a um botão e esse cabo **nunca ia disparar** — porque só os modos Timer, Pomodoro e Alarme de fato emitem o evento que aciona o botão —, sem nenhum aviso na tela. O nó prometia uma automação que não ia acontecer.

Isso foi corrigido: o próprio nó agora mostra a que botão o alarme está conectado e se o disparo está ativo para o modo selecionado, com um aviso explícito quando o modo escolhido nunca vai disparar o cabo. Antes de armar um relógio esperando que ele suba um processo sozinho, confira essa indicação no nó — ela é o que diz se aquele cabo faz alguma coisa.
