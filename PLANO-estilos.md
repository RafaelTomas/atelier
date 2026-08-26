# Plano — refatorar os estilos: tokens, primitivas, um arquivo por área

## Veredito, antes de tudo: **não é Tailwind**

A pergunta era "talvez usando tailwind". A resposta medida é não — e vale
explicar por quê, porque a razão não é gosto.

O `styles.css` deste repositório não tem os problemas que o Tailwind resolve.
Tailwind resolve **naming fatigue** e **escopo global** em bases onde o CSS
cresceu sem convenção. Aqui já existe convenção, e ela é seguida: 360 classes
com prefixo por componente (`git-*`, `fb-*`, `dock-*`, `node-*`) e `is-*` para
estado, 27 seções nomeadas, tema por tokens em três estados, e **quase nenhum
estilo inline** — os 25 `style={{}}` do renderer são todos geometria dinâmica
(transform de nó, posição de menu), que é exatamente onde inline é o certo.

O que o Tailwind custaria aqui:

- **Reescrever ~8.200 linhas de JSX em 35 arquivos** para mover 1.990 linhas de
  CSS. Risco alto de regressão visual, ganho funcional zero.
- **Metade deste CSS não é utilitário.** Canvas, ropes em SVG, minimapa, xterm,
  CodeMirror, `<webview>`, `@keyframes`, pseudo-elementos, `data-*` como
  seletor. Isso continua sendo CSS de verdade depois da migração — então o
  resultado é **dois sistemas** em vez de um.
- **O tema tri-estado seria um retrocesso.** Hoje `system`/`light`/`dark`
  funcionam por redefinição de token (`@media` + `[data-theme]`), e nenhuma cor
  tem definição única dentro de um `@media` — regra que o próprio arquivo
  documenta na linha 1. O variant `dark:` do Tailwind assume uma estratégia só;
  reproduzir os três estados exige variant customizado escrito à mão, para
  chegar no mesmo lugar onde já estamos.
- **Apagaria a documentação.** Comentários como o do `--corner-height` ("o 132 é
  a altura do `<canvas>`; o resto é padding e borda") ou o das scrollbars são o
  *porquê* das decisões. Não cabe em `className`. Neste repo isso é claramente
  um valor cultivado — o custo não é retórico.
- **Bundle e purge não são argumento.** É Electron. Ninguém baixa o CSS.

E o que o Tailwind traria de real — escala imposta e fim do escopo global — se
obtém com **uma camada de tokens e primitivas**, sem dependência nova e quase
sem tocar em JSX que já funciona. (A primeira versão deste plano dizia "CSS
Modules + camada de tokens"; a parte dos modules foi medida e retirada — ver
"Por que os modules foram retirados".)

---

## Os problemas que existem de fato

Medidos no arquivo, não supostos.

### 1. Onze raios de canto diferentes

```
border-radius:  2px · 3px · 4px · 5px · 6px · 7px · 8px · 9px · 10px · 12px · 16px · 999px · 50%
                  2     2     7    12    17     6     7     4     14      2      1      7     7
```

Isso é deriva visual, não intenção. Ninguém decide que um botão tem 7px e o
vizinho 6px — decide-se uma vez, e depois se copia errado. Mesma história em
espaçamento: `10px` aparece 93 vezes, `6px` 89, `8px` 74, `4px` 74, `5px` 49,
`9px` 20, `7px` 17, `3px` 24. Há uma escala escondida aí dentro, e mais quatro
valores que só existem por acidente.

Os tokens de hoje cobrem **cor e nada mais**. Cor era o que o tema exigia; o
resto nunca foi promovido.

### 2. Bloco escuro escrito duas vezes, literalmente

Linhas 39–59 e 63–79: os mesmos 18 tokens, um dentro do `@media`, outro no
`[data-theme='dark']`. A duplicação é consequência correta da regra tri-estado —
mas é frágil do jeito errado: **um token novo adicionado em um só falha em
silêncio**, e só num dos dois modos. Já dá para eliminar sem abrir mão da regra.

### 3. Um arquivo de 1.990 linhas, e o CSS longe do componente

Para mexer no painel de Git você abre `panels/git-panel.tsx` e rola até a linha
1478 de outro arquivo. Pior: git tem **112 classes em duas seções distantes** —
"Aba Git" (1478) e "Git no chrome do canvas" (1660).

Note que isto é uma queixa de **navegação**, não de escopo — e a distinção
importa, porque foi ela que decidiu contra os modules. O escopo tem um problema
próprio e muito menor, com endereço: ver "O vazamento real" na decisão 2.

### 4. Nenhuma primitiva

Botão, campo de texto e painel flutuante foram recriados por seção:
`fb-btn`, `dock-btn`, `git-btn`, `modal-btn`, `candidates-btn`. `display: flex`
aparece 59 vezes; `border: 1px solid var(--border)` 30 vezes; `font-size: 11px`
55 vezes. Não é repetição gratuita — é a mesma peça descrita cinco vezes, o que
significa cinco lugares para consertar quando o hover mudar.

### 5. Quatro classes mortas confirmadas

`.tool-btn` (e seus dois modificadores) · `.project-pending` ·
`.project-pending-actions` · `.project-agent-select`

**Correção de uma contagem anterior deste plano:** eram "seis", com `.is-off`,
`.is-valid` e `.is-invalid` na lista. As três estão **vivas** — `is-off` vem de
`dotKind()` em `git-menu.tsx:367`, e `is-valid`/`is-invalid` do estado da prévia
de conexão em `connection-preview.tsx:97`. Ambas montadas por template.

E é justamente esse o ponto: as outras 24 que uma busca ingênua acusa —
`is-nw`, `git-code-mod`, `fb-row-serif`, `tool-pen` — também são construídas por
template no JSX e também estão vivas. Qualquer varredura automática de CSS morto
neste repo tem que saber disso, senão apaga o que funciona. É o que a etapa 5
resolve na raiz: com as dinâmicas viradas `data-*`, a varredura passou a acusar
**um** nome, `.cm-editor` — que é do CodeMirror e legitimamente estilizado.

---

## O que já existe e vai ser reusado

| Peça | Onde | Para quê |
|---|---|---|
| Camada de tokens de cor | `styles.css:6-79` | Já é a base certa; só falta estender além de cor |
| Regra tri-estado documentada | `styles.css:1-5` | Invariante a preservar, não a revisar |
| Convenção de prefixo + `is-*` | todo o arquivo | Já funciona; fica como está |
| `theme.ts` | `renderer/theme.ts` | Escreve `data-theme`; não muda em nada |
| `@import` e `@layer` nativos | Electron 31 = Chromium 126 | Vite inlina os imports; camada sem plugin nem dependência |
| `npm test` já existente | `package.json` | Os dois guards novos entram nele, não inventam runner |
| `--sidebar-width` escrito por JS | `sidebar.tsx` | Prova que o contrato token↔JS já é usado; mantê-lo |

Nada novo em `package.json`. Isso é deliberado: uma refatoração de estilo que
adiciona toolchain paga duas vezes.

---

## As decisões

### 1. A camada de tokens cresce para geometria, e o escuro para de ser copiado

Primeiro, matar a duplicação. Os tokens de cor de cada tema vão para um lugar
só, e os dois seletores apenas o invocam:

```css
@layer tokens {
  :root, :root[data-theme='light'] { /* claro: a base */ }

  /* Uma definição do escuro, dois gatilhos. */
  @media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { --_dark: 1 } }
  :root[data-theme='dark'] { --_dark: 1 }
}
```

Aqui há uma escolha a fazer, e ela é técnica: CSS não tem "herdar um bloco".
As duas saídas honestas são **(a)** manter os dois seletores mas gerar o corpo
de um `@import` compartilhado no build, ou **(b)** aceitar a duplicação e
protegê-la com um teste que compara as chaves dos dois blocos e falha se
divergirem. **Recomendo (b)**: 15 linhas em `scripts/`, entra no `npm test` que
já existe, resolve o modo de falha real (token esquecido) sem inventar build
step. A duplicação deixa de ser um risco quando é verificada.

Depois, a escala. Os números de hoje colapsam para:

```css
--r-sm: 4px;  --r-md: 6px;  --r-lg: 10px;  --r-xl: 16px;  --r-pill: 999px;
--s-1: 4px;  --s-2: 6px;  --s-3: 8px;  --s-4: 12px;  --s-5: 16px;  --s-6: 24px;
--fs-2xs: 9px; --fs-xs: 10px; --fs-sm: 11px; --fs-md: 12px; --fs-base: 13px;
--dur-fast: 140ms;  --dur-base: 220ms;
```

Cinco raios em vez de treze, e não quatro como este plano dizia antes: o
**modal** não cabia no `lg`. Ele é a única superfície que não encosta em nada, e
16px ali é intenção, não deriva — daí `--r-xl`, um token para um uso só. Mesma
correção do outro lado da escala: `font-size: 9px` tem seis ocorrências, todas
etiqueta em caixa alta, e por isso virou `--fs-2xs` em vez de literal.

Os `5px`/`7px`/`9px`/`12px` **não** ganham token — são para eliminar, e cada um
vira uma decisão consciente de subir ou descer. Isso muda pixels na tela; é o
ponto. Deriva não se documenta, se resolve.

A atribuição é por **papel**, não por valor: `sm` é detalhe dentro de um
controle, `md` é o controle, `lg` é a superfície. Foi o que decidiu os `8px`
ambíguos — `.context-menu` subiu para 10 (é superfície), `.icon-cell` desceu
para 6 (é controle). `50%` fica literal onde aparece: aquilo é a FORMA, não um
raio da escala.

Um token de geometria só nasce quando **três** ocorrências o pedem. Abaixo
disso, o literal é mais legível que a indireção — foi por essa regra que o
`padding: 6px 14px` do `.btn` **não** foi tokenizado: 14px não tem passo na
escala, e forçá-lo a 12 ou 16 estreitaria ou alargaria todo botão do app.

### 2. Um arquivo por área, e o escopo tratado onde ele de fato vaza

**Esta decisão substitui a que estava aqui antes ("CSS Modules por
componente"). A troca não foi de gosto — foi medição, e está registrada abaixo
em "Por que os modules foram retirados".**

O CSS de componente sai do arquivo único e vira cinco, por área:

```
renderer/styles/
  tokens.css      cor (3 estados) + escala de raio/espaço/corpo/duração
  base.css        reset, scrollbars, documento
  primitives.css  .icon-btn .btn .floating .segmented + formulário
  panels.css      sidebar, painéis, árvore de arquivos, faixas do topo/base
  canvas.css      canvas, chrome, dock, menus da dock, minimapa
  nodes.css       a CASCA de um nó: moldura, card, header, rodapé, alças, badge
  nodes/          um arquivo por TIPO de nó, mesmo nome do .tsx que o renderiza
    terminal-node.css · note-node.css · text-node.css · portal-node.css
    placeholder-node.css · code-editor-node.css
    node-action-bar.css · format-bar.css
  git.css         aba lateral + pílula do chrome, JUNTAS
  dialogs.css     modal, menu de contexto, avisos
```

Os nós ganham um nível a mais porque são a maior área e a mais independente
internamente: o nó Portal e o nó Terminal não compartilham nada além da casca.
A casca vem **antes** dos tipos no import, e por isso um tipo ajusta a casca
escrevendo só a diferença — a mesma lógica das primitivas, sem precisar de
camada.

Três coisas que a divisão por nome revelou, e que valem mais que a arrumação:

- **`file-tree-node` não tem CSS próprio.** Usa `.file-tree` e a primitiva
  `.btn`. O arquivo nasceria vazio, então não existe. Um tipo de nó sem estilo
  próprio é informação, não lacuna.
- **`.file-tree` estava do lado errado.** O componente é compartilhado entre o
  nó e a aba Arquivos, e os outros vinte `.file-tree-*` já viviam em
  `panels.css`. A família toda ficou junta.
- **`.vc-fit` era carona.** É o botão ⤢ do cluster de vista, não tem nada com
  nó — tinha caído em `nodes.css` só por ser a última linha da seção anterior.
  Foi para `canvas.css`, ao lado do `.vc-zoom`, que é o vizinho dele na pílula.

`styles.css` fica só com os `@import`. Quem procura uma regra vai ao arquivo da
área; quem procura a **ordem** abre o ponto de entrada e vê tudo numa tela.

A linha que mais paga é `git.css`: as duas seções que viviam a 180 linhas de
distância — a aba e a pílula do chrome — passam a ser vizinhas. Elas
compartilham `.git-tabs`/`.git-tab` e a caixa de commit, e era exatamente entre
elas que o vazamento era mais provável.

**A ordem dos `@import` é semântica, não estética.** O CSS de componente não
vive em camada, então entre duas regras de mesma especificidade que caem no
mesmo elemento vence quem vem depois. Num arquivo só isso se via rolando;
dividido, virou uma decisão registrada num lugar — e trocá-la muda
comportamento sem mudar nenhuma regra, que é o tipo de mudança que passa em
revisão sem ninguém notar. `canvas` **tem** de vir antes de `nodes`:
`.node.is-connect-target` (canvas) e `.node.is-chromeless` (nodes) têm a mesma
especificidade e coexistem num nó sem moldura que é alvo de conexão.
`scripts/test-css-order.mjs` guarda isso, e também acusa qualquer par NOVO de
mesma especificidade cruzando arquivos, para alguém julgar se ele pode cair no
mesmo elemento.

#### O vazamento real, e a correção de três caracteres

O escopo global é um risco onde uma regra atinge descendente **por tipo**. Das
regras assim, só três tinham mais de um dono — e portanto só três podiam vazar:

```css
.context-menu button { border: 0; background: transparent; … }
.dock-menu button    { … }
.vc-group button     { … }
```

Duas delas já tinham custado algo, documentado no próprio arquivo:

- `.context-menu button` transformou Pull/Push em texto solto, e por isso o
  `.git-popover` teve de ser uma superfície **duplicada** em vez de reusar a
  existente.
- `.vc-group button` obrigava `.git-menu-btn` e três botões do popover a se
  qualificarem com um seletor extra só para vencê-la.

A correção não é `.menu-item` em quarenta `className`, como uma versão anterior
deste plano supôs. O bug é sempre **pegar neto**: os itens de um menu são
filhos diretos — sempre —, e o que vazava era o botão dentro de um componente
aninhado. Então:

```css
.context-menu > button { … }
```

O `>` não perde nada e fecha a porta. E derruba os workarounds: os quatro
seletores que existiam só para vencer `.vc-group button` voltaram a ser simples.

As regras descendente-por-tipo que sobraram (`.portal-error button`,
`.git-branch-menu button`, `.git-popover-branches button`, `.theme-menu
button`…) têm **um dono só**. Não podem vazar entre componentes, e trocá-las por
classe seria cerimônia sem risco correspondente.

#### As classes dinâmicas continuam virando `data-*`

Isso valia com modules e vale sem: uma classe montada por template
(`is-${edge}`, `tool-${tool}`, `git-code-${s}`) é um atributo escrito como
classe.

```tsx
<div data-resize-handle={edge} />
```
```css
[data-resize-handle] { … }
[data-resize-handle='nw'] { cursor: nwse-resize }
```

No caso das alças havia até informação duplicada: o `data-resize-handle` já
existia para o hit-test (`closest('[data-resize-handle]')` em
`canvas/canvas-view.tsx`), com uma classe ao lado dizendo o mesmo.

E o ganho maior é colateral: **a varredura de CSS morto ficou confiável.** Antes
ela acusava 25 falsos positivos e 4 nomes reais, indistinguíveis sem inspeção
manual. Agora acusa um nome — `.cm-editor`, do CodeMirror, legitimamente
estilizado.

### 3. Primitivas antes de mover qualquer coisa

`.icon-btn`, `.btn`, `.floating`, `.segmented` e o vocabulário de formulário.

`.icon-btn` é a que mais rendeu: o mesmo botão estava descrito **cinco** vezes
— `.ghost-btn`, `.node-btn`, `.portal-btn`, `.action-btn`, `.fb-btn` — cada uma
repetindo borda zero, fundo transparente, centralização e o par
hover/disabled. E as cinco divergiam justamente no que não deveria divergir:
duas apagavam no hover para `--border`, duas para `--surface-2`, e só uma
tratava `:disabled`. Agora cada nome sobrevive só com sua geometria.

`.dock-btn` ficou **fora** de propósito, e isso é o critério funcionando: ela
usa a paleta do vidro (`--dock-fg`, `--dock-hover`), não a do tema. Herdar da
primitiva trocaria a cor dos ícones sobre o vidro por uma que não foi pensada
para ele.

`.floating` não define **borda**, o que parece uma omissão e não é: a sidebar
tem borda só à direita, o grupo do Git não tem nenhuma, e os outros têm as
quatro. Um valor padrão ali só criaria um `border: 0` para desfazer em dois
lugares.

A ordem importa: extrair primitivas **primeiro** significa que cada arquivo de
área já nasce em cima delas. Na ordem inversa, move-se a duplicação e depois se
desfaz — o dobro do trabalho e uma janela em que os dois convivem.

---

## A ordem de execução

Cada etapa é um commit que compila, roda e é verificável na tela. Nada de
"refatoração grande" — este arquivo é a fundação visual do app e a única
verificação real é olhar.

| # | Etapa | Escopo | Verificação |
|---|---|---|---|
| 1 | ✅ Apagar as 4 classes mortas | −23 linhas | `npm test`; nada muda na tela |
| 2 | ✅ `tokens.css` + `base.css` + `scripts/test-tokens.mjs` | move, não reescreve | Trocar tema nos 3 estados |
| 3 | ✅ Escala de geometria; 13 raios → 5 | 35 valores | **Passada visual tela por tela** |
| 4 | ✅ `primitives.css`; 5 botões → `.icon-btn` | 40 pontos no JSX | Hover/focus/disabled em cada um |
| 5 | ✅ Classes dinâmicas → `data-*` | 7 famílias, 8 pontos no JSX | Resize, ferramentas de desenho, códigos de git |
| 6 | ✅ `> button` nos 3 seletores com mais de um dono | 11 regras, 0 no JSX | Menu de contexto, menus da dock, cluster de vista, popover do Git |
| 7 | ✅ Divisão em 5 arquivos por área + `test-css-order.mjs` | move, não reescreve | Nada deveria mudar |
| 8 | ✅ `nodes.css` → casca + 8 arquivos por tipo de nó | move, não reescreve | Cada tipo de nó no canvas |

A etapa 3 é a única que muda a aparência de propósito. Vale fazê-la sozinha, num
commit isolado, para que qualquer estranheza reportada depois tenha um lugar
óbvio para ser investigada.

### Por que os modules foram retirados

O plano original terminava com "etapa 6: CSS Modules, componente por
componente". Ela foi cortada depois de medir os dois argumentos que a
sustentavam. Os dois caíram:

**"Detectar classe morta."** Era o argumento principal, e a **etapa 5 já o
resolveu** — sem modules. Com as dinâmicas viradas `data-*`, a varredura passou
de 25 falsos positivos para um nome real. O `typecheck` dos modules entregaria
a mesma garantia por um preço muito maior.

**"Escopo global."** Aqui o plano supôs o risco em vez de medir. Medido: das 22
regras que cruzam fronteira de componente, quase todas são **intencionais e
corretas** — `.sidebar-tabs .segment`, `.git-actions .btn`,
`.file-tree-actions .ghost-btn`. É componente ajustando uma primitiva no
contexto dele, que é exatamente o que as camadas existem para permitir. Com
modules cada uma viraria `:global()` ou `composes`: **mais** cerimônia para
dizer a mesma coisa. E o vazamento de verdade eram três seletores, resolvidos
na etapa 6 com um `>`.

O que torna essa retirada segura de revisar depois: global e modules coexistem
sem conflito. Se um componente novo justificar escopo real, ele nasce
`.module.css` sem migrar nada do que existe. Nunca vai ser uma decisão de
agora-ou-nunca.

---

## O que este plano não faz

- **Não troca de framework.** Sem Tailwind, sem CSS-in-JS, sem dependência nova.
- **Não mexe em `theme.ts`** nem no contrato `data-theme`. Funciona.
- **Não redesenha nada.** Espaçamento e raio se alinham a uma escala; cor,
  tipografia e layout ficam onde estão. Redesign é outra conversa, e mais fácil
  de ter depois que existir uma escala para conversar sobre.
- **Não introduz preprocessador.** Nesting é nativo no Chromium 126.
- **Não usa CSS Modules.** Foi avaliado, medido e retirado — ver acima. Não é
  uma porta fechada: é uma porta que não precisou ser aberta agora.
