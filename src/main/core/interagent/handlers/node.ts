/**
 * `atelier node <create|group>` — os nós que ninguém mais sabia criar.
 *
 * O CLI já criava quase tudo, mas cada tipo pelo verbo do RECURSO dele:
 * `note create`, `todo create`, `image create`, `table`, `vault set`,
 * `portal open`, `editor open`, `button propose`, `recruit`. Sobravam três
 * tipos sem dono — `text`, `fileTree` e os `widget` de painel (`projects`,
 * `git`, `monitor`, `clock`) — e a moldura de grupo. São exatamente as peças
 * de que um agente precisa para MONTAR um canvas em vez de só habitar um, e
 * era o que faltava para um canvas de apresentação nascer sem mouse
 * (docs/2026-09-02-PLANO-demo-desenvolvedor.md, fatias F1 e F3).
 *
 * Este verbo NÃO é uma segunda porta para os tipos que já têm a sua: pedir
 * `node create note` responde com o verbo certo, e não cria nada. Duas portas
 * para o mesmo quarto divergem — a de trás nunca ganha o cuidado da da frente
 * (o arquivo `.md` da nota, a allowlist do editor, o pendente do botão).
 */
import { isAbsolute } from 'node:path'
import type { CanvasNode, Rect, UUID } from '@shared/types'
import { boundsForNodes, groupAt } from '@shared/group-geometry'
import { canvasShot } from '../../canvas-shot'
import { isConnectable } from '@shared/types'
import { defaultSize } from '../../node-sizes'
import {
  makeFileTreeContent,
  makeTextContent,
  makeWidgetContent,
  nodeDisplayName
} from '../../models/node-content'
import { makeCanvasNode } from '../../models/workspace'
import { allowedRoots } from '../../projects/allowed-roots'
import { resolveAllowedPath } from '../../projects/fs-access'
import { freeSpotRightOf, nodeAt } from '../../spawn-spot'
import { notifyRenderer } from '../../../ipc/notify'
import { connectedNodes, requireTerminalId, workspaceForTerminal } from './context'

const USAGE = [
  'error: usage:',
  '  atelier node map',
  '  atelier node move "Node" x,y',
  '  atelier node shot [destination.png]',
  '  atelier node create text "content" [--at x,y]',
  '  atelier node create fileTree <absolute path> [--name "Label"] [--at x,y]',
  '  atelier node create widget <projects|git|monitor|clock> [--at x,y]',
  '  atelier node group "Title" "Node" ["Node"…] [--color "#0A84FF"]'
].join('\n')

/**
 * Os tipos que já nascem por outro verbo, e qual é ele.
 *
 * Recusar dizendo o verbo certo é a diferença entre um agente que corrige em
 * uma tentativa e um que conclui que o CLI não cria notas.
 */
const OWNED_ELSEWHERE: Record<string, string> = {
  note: 'atelier note create',
  stickyNote: 'atelier note create',
  terminal: 'atelier recruit "Name"',
  portal: 'atelier portal open <url>',
  codeEditor: 'atelier editor open <path>',
  editor: 'atelier editor open <path>',
  dataTable: 'atelier table create',
  table: 'atelier table create',
  image: 'atelier image create "Title" <path>',
  secretVault: 'atelier vault set',
  vault: 'atelier vault set'
}

/** Painéis que este verbo cria. `todo` e `button` têm verbo próprio. */
const PANEL_KINDS = ['projects', 'git', 'monitor', 'clock']

/**
 * Painéis de que UM basta no canvas.
 *
 * Os três leem o estado global — o índice de projetos, o repo da seleção, a
 * máquina — então dois nós mostram a mesma coisa e o segundo é só ruído. Pedir
 * um que já existe devolve o existente, no mesmo espírito da árvore que já
 * mostra aquela raiz. O `clock` fica FORA: dois relógios são dois timers, e
 * isso é uso legítimo.
 */
const SINGLETON_KINDS = ['projects', 'git', 'monitor']

const KIND_OWNED_ELSEWHERE: Record<string, string> = {
  todo: 'atelier todo create "Title"',
  button: 'atelier button propose "Label" --command "…"'
}

export async function handleNode(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  switch (args[1]) {
    case 'map':
      return mapCanvas(tid)
    case 'shot':
      return shotCanvas(args, tid)
    case 'create':
      return createNode(args, tid)
    case 'move':
      return moveNode(args, tid)
    case 'group':
      return createGroup(args, tid)
    default:
      return USAGE
  }
}

interface Flags {
  rest: string[]
  name: string | null
  color: string | null
  /** `--at x,y`. `invalid` distingue "não passou" de "passou torto". */
  at: { x: number; y: number } | 'invalid' | null
}

/** `--name`, `--color` e `--at`, tirados dos argumentos posicionais. */
function takeFlags(args: string[]): Flags {
  const rest: string[] = []
  let name: string | null = null
  let color: string | null = null
  let at: Flags['at'] = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') name = args[++i] ?? ''
    else if (args[i] === '--color') color = args[++i] ?? ''
    else if (args[i] === '--at') at = parsePoint(args[++i] ?? '')
    else rest.push(args[i])
  }
  return { rest, name, color, at }
}

function parsePoint(raw: string): { x: number; y: number } | 'invalid' {
  const parts = raw.split(',').map((p) => Number(p.trim()))
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return 'invalid'
  return { x: parts[0], y: parts[1] }
}

async function createNode(argv: string[], tid: UUID): Promise<string> {
  const { rest, name, at } = takeFlags(argv)
  const type = rest[2]
  if (!type) return USAGE
  if (at === 'invalid') return 'error: --at takes two numbers, as in `--at 12400,8900`.'

  const owner = OWNED_ELSEWHERE[type]
  if (owner) {
    return `error: '${type}' is created by its own verb — use \`${owner}\`.`
  }

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'
  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  switch (type) {
    case 'text':
      return spawn(ws, caller, tid, 'text', makeTextNode(rest[3] ?? ''), {}, at)
    case 'fileTree':
      return createFileTree(ws, caller, tid, rest[3], name, at)
    case 'widget':
      return createWidget(ws, caller, tid, rest[3], at)
    default:
      return `error: unknown node type '${type}'.\n${USAGE}`
  }
}

function makeTextNode(text: string): CanvasNode['content'] {
  return { type: 'text', value: makeTextContent(text) }
}

async function createFileTree(
  ws: NonNullable<ReturnType<typeof workspaceForTerminal>>,
  caller: CanvasNode,
  tid: UUID,
  raw: string | undefined,
  name: string | null,
  at: { x: number; y: number } | null
): Promise<string> {
  if (!raw) return 'error: usage: atelier node create fileTree <absolute path> [--name "Label"]'

  // MESMA allowlist do `editor open`, e não uma checagem mais frouxa de
  // "existe e é pasta". A razão é que `allowedRoots()` INCLUI as raízes dos
  // nós de árvore do canvas: uma árvore criada aqui em `/` passaria a
  // autorizar `editor open` em qualquer arquivo da máquina. A árvore não é o
  // gesto que ALARGA o alcance do canvas — quem alarga é o usuário, indexando
  // um projeto; a árvore só dá uma vista do que ele já autorizou.
  const allowed = await resolveAllowedPath(raw, allowedRoots())
  if (!allowed.ok) {
    if (allowed.reason === 'missing') return `error: no such path: ${raw}`
    return [
      `error: '${raw}' is outside the paths this canvas may open.`,
      'A file tree may only root at an indexed project, the workspace working',
      'directory, or a folder already on the canvas as a tree. Ask the user to',
      'index the project first — adding a root is their gesture, not yours.'
    ].join('\n')
  }

  const existing = ws.nodes.find(
    (n) => n.content.type === 'fileTree' && n.content.value.rootPath === allowed.path
  )
  if (existing) {
    return `'${nodeDisplayName(existing.content)}' already shows ${allowed.path}.`
  }

  const label = name || allowed.path.split(/[\\/]/).filter(Boolean).pop() || 'Files'
  return spawn(
    ws,
    caller,
    tid,
    'fileTree',
    { type: 'fileTree', value: makeFileTreeContent(label, allowed.path) },
    {},
    at
  )
}

function createWidget(
  ws: NonNullable<ReturnType<typeof workspaceForTerminal>>,
  caller: CanvasNode,
  tid: UUID,
  kind: string | undefined,
  at: { x: number; y: number } | null
): string {
  if (!kind) {
    return `error: usage: atelier node create widget <${PANEL_KINDS.join('|')}>`
  }
  const owner = KIND_OWNED_ELSEWHERE[kind]
  if (owner) {
    return `error: the '${kind}' widget is created by its own verb — use \`${owner}\`.`
  }
  if (!PANEL_KINDS.includes(kind)) {
    return `error: unknown widget kind '${kind}'. Available: ${PANEL_KINDS.join(', ')}.`
  }

  if (SINGLETON_KINDS.includes(kind)) {
    const existing = ws.nodes.find(
      (n) => n.content.type === 'widget' && n.content.value.kind === kind
    )
    if (existing) {
      const already = ws.connectedNodeIds(tid).includes(existing.id)
      if (!already) {
        ws.addConnection(tid, existing.id)
        notifyRenderer('workspace:changed', { workspaceId: ws.id })
      }
      const how = already ? 'already connected' : 'now connected'
      return `The '${kind}' panel is already on this canvas (${how} to this terminal).`
    }
  }

  return spawn(
    ws,
    caller,
    tid,
    'widget',
    { type: 'widget', value: makeWidgetContent(kind) },
    { kind },
    at
  )
}

/**
 * O caminho comum: acha um lugar livre à direita de quem pediu, cria o nó,
 * cabeia se o tipo aceitar cabo e avisa o renderer.
 *
 * `text` e `fileTree` NÃO aceitam cabo (CONNECTABLE_TYPES em shared/types), e
 * isso não é uma falta: a navegação da árvore é do usuário e o título não tem
 * dado a trocar. A resposta diz que não há cabo em vez de omitir, senão o
 * agente procura o nó novo num `atelier list` que nunca vai listá-lo.
 */
function spawn(
  ws: NonNullable<ReturnType<typeof workspaceForTerminal>>,
  caller: CanvasNode,
  tid: UUID,
  sizeKind: Parameters<typeof defaultSize>[0],
  content: CanvasNode['content'],
  sizeOpts: Record<string, unknown> = {},
  at: { x: number; y: number } | null = null
): string {
  const size = defaultSize(sizeKind, sizeOpts)

  // `--at` coloca exatamente onde foi pedido, e RECUSA se estiver ocupado, em
  // vez de desviar em silêncio. As duas metades importam: sem a primeira, um
  // agente não consegue montar um layout desenhado (a faixa central da demo é
  // um); sem a segunda, `--at` seria a porta que devolve o empilhamento que o
  // resto deste caminho existe para impedir. Quem quer o desvio automático
  // simplesmente não passa a flag.
  if (at) {
    const ocupado = nodeAt(ws, at, size)
    if (ocupado) {
      return [
        `error: (${at.x},${at.y}) is taken by '${nodeDisplayName(ocupado.content)}'`,
        `(${ocupado.content.type}, ${ocupado.id.slice(0, 8)}) at`,
        `(${ocupado.frame.x},${ocupado.frame.y}) ${ocupado.frame.width}×${ocupado.frame.height}.`,
        'Run `atelier node map` for what is where, or drop --at to let the',
        'canvas find a free spot next to this terminal.'
      ].join(' ')
    }
  }

  const spot = at ?? freeSpotRightOf(ws, caller, size)
  const node = makeCanvasNode({ ...spot, ...size }, content)

  ws.addNode(node)
  const cabled = isConnectable(content) ? ws.addConnection(tid, node.id) !== null : false
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  const name = nodeDisplayName(content)
  const how = cabled
    ? 'connected to this terminal'
    : 'not connected — this type takes no cable, and `atelier list` will not show it'
  return `Created ${content.type} '${name}' (${node.id.slice(0, 8)}) at (${node.frame.x},${node.frame.y}), ${how}.`
}

/**
 * A moldura, já com os membros — que vêm por nome ou por id, no alcance de
 * `resolveLayoutTarget`.
 *
 * O frame é ajustado ao conteúdo, com a mesma folga que o app usa quando o
 * usuário agrupa uma seleção. Uma moldura sem membros não teria retângulo a
 * calcular, então a lista vazia é recusa, não um grupo vazio.
 */
function createGroup(argv: string[], tid: UUID): string {
  const { rest, color } = takeFlags(argv)
  const title = rest[2]
  const names = rest.slice(3)
  if (!title || names.length === 0) {
    return 'error: usage: atelier node group "Title" "Node" ["Node"…] [--color "#0A84FF"]'
  }

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'
  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  const members: CanvasNode[] = []
  const missing: string[] = []
  for (const name of names) {
    const found = resolveLayoutTarget(ws, caller, tid, name)
    if (!found) missing.push(name)
    else if (!members.some((m) => m.id === found.id)) members.push(found)
  }
  if (missing.length > 0) {
    return [
      `error: not found: ${missing.map((m) => `'${m}'`).join(', ')}.`,
      'Name reaches what is cabled to you, this terminal, and text/file-tree',
      'nodes; anything else needs the 8-char id that `node create` printed.'
    ].join('\n')
  }

  const frame = boundsForNodes(members.map((m) => m.frame)) as Rect
  const group = ws.createGroup(
    title,
    frame,
    members.map((m) => m.id)
  )
  if (color) ws.updateGroup(group.id, { color })
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  const listed = members.map((m) => nodeDisplayName(m.content)).join(', ')
  return `Created group '${title}' around ${members.length} node(s): ${listed}.`
}

/**
 * Move um nó para onde o usuário quer que ele esteja.
 *
 * Fecha o ciclo de montar canvas: sem isto, um agente cria e nunca corrige —
 * e a primeira coisa que ele faz de errado fica no canvas até alguém arrastar.
 *
 * Duas regras, as duas emprestadas de vizinhos que já as tinham:
 *
 *   • **destino ocupado recusa**, dizendo quem está lá, igual ao `--at` do
 *     `create`. Mover para cima de alguém é o mesmo dano que criar em cima.
 *   • **a moldura segue a geometria**, pela MESMA função que decide isso no fim
 *     de um arrasto (`groupAt`, em shared/group-geometry). Um nó que sai do
 *     retângulo sai do grupo, e um que entra é adotado — senão o CLI deixaria
 *     membros fora da moldura e a vista mentiria sobre quem é do time.
 */
function moveNode(argv: string[], tid: UUID): string {
  const { rest, at } = takeFlags(argv)
  const alvo = rest[2]
  const destino = at ?? (rest[3] !== undefined ? parsePoint(rest[3]) : null)
  if (!alvo || destino === null) {
    return 'error: usage: atelier node move "Node" x,y'
  }
  if (destino === 'invalid') {
    return 'error: the destination takes two numbers, as in `node move "Git" 11169,9494`.'
  }

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'
  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  const node = resolveLayoutTarget(ws, caller, tid, alvo)
  if (!node) {
    return [
      `error: '${alvo}' not found.`,
      'Name reaches what is cabled to you, this terminal, and text/file-tree',
      'nodes; anything else needs the 8-char id from `atelier node map`.'
    ].join('\n')
  }

  const size = { width: node.frame.width, height: node.frame.height }
  const ocupado = ws.nodes.find(
    (n) =>
      n.id !== node.id &&
      destino.x < n.frame.x + n.frame.width &&
      destino.x + size.width > n.frame.x &&
      destino.y < n.frame.y + n.frame.height &&
      destino.y + size.height > n.frame.y
  )
  if (ocupado) {
    return [
      `error: (${destino.x},${destino.y}) is taken by '${nodeDisplayName(ocupado.content)}'`,
      `(${ocupado.content.type}, ${ocupado.id.slice(0, 8)}) at`,
      `(${ocupado.frame.x},${ocupado.frame.y}) ${ocupado.frame.width}×${ocupado.frame.height}.`,
      'Run `atelier node map` for what is where.'
    ].join(' ')
  }

  const antes = groupOf(ws, node.id)
  ws.updateFrame(node.id, { ...destino, ...size })

  const agora = groupAt(ws.payload.groups, { ...destino, ...size })
  if ((agora?.id ?? null) !== (antes?.id ?? null)) {
    ws.setNodeGroup(node.id, agora?.id ?? null)
  }
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  const nome = nodeDisplayName(node.content)
  const moldura =
    agora && !antes
      ? ` It is now inside '${agora.title}'.`
      : antes && !agora
        ? ` It left '${antes.title}'.`
        : antes && agora && antes.id !== agora.id
          ? ` It moved from '${antes.title}' to '${agora.title}'.`
          : ''
  return `Moved '${nome}' to (${destino.x},${destino.y}).${moldura}`
}

function groupOf(
  ws: NonNullable<ReturnType<typeof workspaceForTerminal>>,
  nodeId: UUID
): { id: UUID; title: string } | null {
  return ws.payload.groups.find((g) => g.nodeIds.includes(nodeId)) ?? null
}

/**
 * A planta do canvas: o que existe, de que tipo, de que tamanho e ONDE.
 *
 * É a resposta para o buraco que a montagem da demo expôs. Um agente criava nó
 * às cegas: não havia como saber que já existia um painel de git, nem que o
 * lugar à direita estava ocupado. Ele só descobria depois, olhando o
 * `workspace.json` no disco — que é autosave, portanto às vezes velho.
 *
 * **O NOME segue a regra de sempre; a GEOMETRIA, não.** Nós cabeados a quem
 * chama (mais o próprio, mais os que nunca aceitam cabo) aparecem com nome; o
 * resto aparece só como tipo, tamanho e posição. A separação é deliberada: a
 * geometria é o que um agente precisa para não empilhar, e não conta nada sobre
 * o trabalho de ninguém. O nome de uma nota, sim — e uma nota que o usuário não
 * cabeou a este terminal não é assunto dele.
 */
function mapCanvas(tid: UUID): string {
  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  const nomeavel = new Set<UUID>([tid])
  for (const n of connectedNodes(tid)) nomeavel.add(n.id)
  for (const n of ws.nodes) if (!isConnectable(n.content)) nomeavel.add(n.id)

  const linhas = ws.nodes
    .map((n) => ({
      id: n.id.slice(0, 8),
      tipo: n.content.type,
      nome: nomeavel.has(n.id) ? nodeDisplayName(n.content) : '—',
      x: Math.round(n.frame.x),
      y: Math.round(n.frame.y),
      w: Math.round(n.frame.width),
      h: Math.round(n.frame.height)
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x)

  if (linhas.length === 0) return 'Canvas is empty.'

  const out = [`${linhas.length} node(s) on this canvas, top-left to bottom-right:`]
  const larguraTipo = Math.max(...linhas.map((l) => l.tipo.length))
  const larguraNome = Math.min(32, Math.max(...linhas.map((l) => l.nome.length)))
  for (const l of linhas) {
    const nome = l.nome.length > 32 ? `${l.nome.slice(0, 31)}…` : l.nome
    out.push(
      `  ${l.id}  ${l.tipo.padEnd(larguraTipo)}  ${nome.padEnd(larguraNome)}  ` +
        `at (${l.x},${l.y})  ${l.w}×${l.h}`
    )
  }

  for (const g of ws.payload.groups) {
    out.push(
      `  group '${g.title}' at (${Math.round(g.frame.x)},${Math.round(g.frame.y)}) ` +
        `${Math.round(g.frame.width)}×${Math.round(g.frame.height)}, ${g.nodeIds.length} member(s)` +
        `${g.isCollapsed ? ', collapsed' : ''}`
    )
  }

  // Sobreposições, ditas em voz alta.
  //
  // Uma lista de coordenadas TEM a informação e não a entrega: são catorze nós,
  // e achar dois retângulos que se cruzam de cabeça é conta que ninguém faz.
  // O que descobriu as duas primeiras foi uma FOTO do canvas — e a foto precisa
  // de permissão, enquanto isto não precisa de nada. Um nó debaixo de outro é o
  // único estado do canvas que é sempre um defeito: ninguém empilha de
  // propósito, e o de baixo fica invisível.
  const cobertos = overlappingPairs(ws.nodes)
  if (cobertos.length > 0) {
    out.push('')
    out.push(`${cobertos.length} overlap(s) — one node is hidden under another:`)
    for (const [a, b] of cobertos) {
      const nomeA = nomeavel.has(a.id) ? `'${nodeDisplayName(a.content)}'` : a.content.type
      const nomeB = nomeavel.has(b.id) ? `'${nodeDisplayName(b.content)}'` : b.content.type
      out.push(`  ${a.id.slice(0, 8)} ${nomeA}  under/over  ${b.id.slice(0, 8)} ${nomeB}`)
    }
    out.push('Fix one with `atelier node move "Node" x,y`.')
  }

  out.push('')
  out.push("'—' means the node is not cabled to you: position only, no name.")
  out.push('Create at a spot with `--at x,y`; without it the canvas picks a free')
  out.push('one next to this terminal.')
  return out.join('\n')
}

/**
 * A foto da janela, se o usuário deu essa permissão a ESTE nó.
 *
 * A recusa NÃO abre diálogo, pelo mesmo motivo dos verbos que agem no portal
 * (Decisão C do 2026-08-27-PLANO-controle-de-portal.md): o agente pode estar
 * rodando sem ninguém olhando, e um diálogo travaria o main esperando um
 * clique que não vem. Ela explica onde ficar o interruptor e aponta o `map`,
 * que responde sem foto quase tudo que se pergunta a uma.
 */
async function shotCanvas(argv: string[], tid: UUID): Promise<string> {
  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  const caller = ws.node(tid)
  if (!caller || caller.content.type !== 'terminal') {
    return 'error: calling terminal is not on this canvas'
  }
  if (!caller.content.value.canvasShotEnabled) {
    return [
      'error: this terminal may not photograph the canvas.',
      'The shot captures the WHOLE window — the neighbour\'s note, a file open in',
      'an editor, an unlocked vault — so it is off until the user turns it on:',
      'the "Fotografar o canvas" switch in this node\'s dialog.',
      'For what exists and where, `atelier node map` needs no permission.'
    ].join('\n')
  }

  const destination = argv[2]
  if (destination && !isAbsolute(destination)) {
    return 'error: use an absolute path for the destination, or none at all.'
  }

  try {
    const file = await canvasShot(ws.id, destination)
    return `Canvas captured to ${file}. Read it with your own image tool.`
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Quem um comando de LAYOUT (`group`, `move`) pode endereçar por nome.
 *
 * O alcance é o de sempre — o que está cabeado a quem chama, mais o próprio
 * chamador — com uma abertura: os tipos que NUNCA aceitam cabo (`text`,
 * `fileTree`) também respondem por nome. Sem ela, um agente que acabou de
 * escrever o título do canvas não conseguiria emoldurá-lo nem endireitá-lo,
 * hoje nem nunca.
 *
 * Por ID (8 caracteres) qualquer nó responde — é o id que o `node map` e o
 * `node create` imprimem. Layout é geometria: não lê o conteúdo de ninguém, e
 * o usuário vê acontecer na tela.
 */
/**
 * Os pares de nós cujos retângulos se cruzam. PURA sobre a lista de nós, para
 * o teste poder montar o arranjo sem canvas.
 */
function overlappingPairs(nodes: CanvasNode[]): [CanvasNode, CanvasNode][] {
  const pares: [CanvasNode, CanvasNode][] = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].frame
      const b = nodes[j].frame
      if (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
      ) {
        pares.push([nodes[i], nodes[j]])
      }
    }
  }
  return pares
}

function resolveLayoutTarget(
  ws: NonNullable<ReturnType<typeof workspaceForTerminal>>,
  caller: CanvasNode,
  tid: UUID,
  name: string
): CanvasNode | null {
  const needle = name.toLowerCase().trim()
  const reachable = [caller, ...connectedNodes(tid), ...ws.nodes.filter((n) => !isConnectable(n.content))]

  const exact = reachable.find((n) => nodeDisplayName(n.content).toLowerCase() === needle)
  if (exact) return exact
  const partial = reachable.find((n) => nodeDisplayName(n.content).toLowerCase().includes(needle))
  if (partial) return partial
  return ws.nodes.find((n) => n.id.toLowerCase().startsWith(needle.slice(0, 8))) ?? null
}
