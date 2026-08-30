/**
 * Codec do enum NodeContent do Swift.
 *
 * Formato Maestri (INEGOCIÁVEL — o app nativo e o Maestri não leem outra coisa):
 *
 *     { "terminal": { "_0": { … } } }
 *
 * Enum com valor associado do Swift vira sempre { "<caso>": { "_0": <payload> } }.
 * Casos sem payload (StorageMode.managed, PortalSource.none) têm regras próprias,
 * anotadas abaixo.
 */
import type {
  CodeEditorContent,
  DataTableContent,
  FileTreeContent,
  FreehandContent,
  ImageContent,
  NodeContent,
  PortalContent,
  PortalSource,
  SecretVaultContent,
  SecretVaultKeyRef,
  ShapeContent,
  StickyNoteContent,
  StorageMode,
  StrokeContent,
  TerminalContent,
  TextAlignment,
  TextContent,
  UUID,
  WidgetContent,
  FontFamily,
  FontWeight
} from '@shared/types'
import {
  asRecord,
  bool,
  decodeDate,
  decodeOptionalDate,
  decodePoint,
  encodePoint,
  nowISO,
  normalizeUUID,
  num,
  optNum,
  optStr,
  str,
  uuid
} from '../coding'
import { extForImageMime } from '@shared/image'
import { Constants } from '../constants'

const VARIANTS = [
  'terminal',
  'stickyNote',
  'portal',
  'fileTree',
  'codeEditor',
  'text',
  'shape',
  'stroke',
  'freehand',
  'dataTable',
  'image',
  'widget',
  'secretVault'
] as const

// ─── StorageMode ──────────────────────────────────────────────────────────────
// .managed encoda como objeto VAZIO ({}), não como null — ver StorageMode.encode
// em NodeContent.swift.

function encodeStorageMode(mode: StorageMode): unknown {
  return mode.kind === 'managed' ? { managed: {} } : { custom: { _0: mode.path } }
}

function decodeStorageMode(value: unknown): StorageMode {
  const o = asRecord(value)
  if ('custom' in o) {
    const inner = asRecord(o.custom)
    return { kind: 'custom', path: str(inner._0) }
  }
  return { kind: 'managed' }
}

// ─── PortalSource ─────────────────────────────────────────────────────────────
// .none NÃO escreve chave nenhuma (container vazio) — ver PortalSource.encode.

function encodePortalSource(source: PortalSource): unknown {
  return source.kind === 'url' ? { url: { _0: source.url } } : {}
}

function decodePortalSource(value: unknown): PortalSource {
  const o = asRecord(value)
  if ('url' in o) {
    const inner = asRecord(o.url)
    return { kind: 'url', url: str(inner._0) }
  }
  return { kind: 'none' }
}

// ─── Payloads ─────────────────────────────────────────────────────────────────

function decodeTerminal(raw: Record<string, unknown>): TerminalContent {
  return {
    agentType: str(raw.agentType, 'generic_shell'),
    command: str(raw.command),
    name: str(raw.name, 'Terminal'),
    icon: str(raw.icon, 'terminal'),
    color: str(raw.color, '#007AFF'),
    id: normalizeUUID(raw.id),
    shellPath: str(raw.shellPath, defaultShell()),
    workingDirectory: str(raw.workingDirectory),
    status: str(raw.status, 'idle'),
    isManager: bool(raw.isManager),
    monitorWithOmbro: bool(raw.monitorWithOmbro),
    autoScrollLocked: bool(raw.autoScrollLocked),
    shortcutMode: { kind: str(asRecord(raw.shortcutMode).kind, 'automatic') },
    assignedRoleId: raw.assignedRoleId ? normalizeUUID(raw.assignedRoleId) : null,
    scrollbackFile: optStr(raw.scrollbackFile),
    scrollbackLineCount: num(raw.scrollbackLineCount),
    lastActiveAt: decodeOptionalDate(raw.lastActiveAt),
    themeId: optStr(raw.themeId),
    fontFamily: optStr(raw.fontFamily),
    fontSize: optNum(raw.fontSize),
    // Chave nova: terminal gravado antes das contas (ou pelo app nativo) volta
    // como null, que é a conta padrão — o comportamento que ele já tinha.
    claudeAccountId: optStr(raw.claudeAccountId),
    // Sem registro de quem recrutou, o terminal conta como criado pelo usuário
    // — e o `atelier dismiss` recusa removê-lo. É o default seguro.
    recruitedBy: raw.recruitedBy ? normalizeUUID(raw.recruitedBy) : null,
    // Instrução de boot, não estado durável: some no primeiro spawn. Ausente
    // (terminal antigo, ou vindo do app nativo) = null = sessão nova.
    resumeSessionId: raw.resumeSessionId ? normalizeUUID(raw.resumeSessionId) : null
  }
}

function decodeStickyNote(raw: Record<string, unknown>): StickyNoteContent {
  return {
    color: str(raw.color, Constants.noteDefaultColor),
    fileName: optStr(raw.fileName),
    fontSize: num(raw.fontSize, 14),
    hasCustomName: bool(raw.hasCustomName),
    isPreviewing: bool(raw.isPreviewing),
    storageMode: decodeStorageMode(raw.storageMode),
    // Campos de formatação novos: notas gravadas pelo app nativo não os têm,
    // então o default tem de reproduzir a aparência antiga.
    textColor: optStr(raw.textColor),
    fontFamily: fontFamily(raw.fontFamily, 'mono'),
    alignment: alignment(raw.alignment)
  }
}

function decodePortal(raw: Record<string, unknown>): PortalContent {
  return {
    id: normalizeUUID(raw.id),
    name: str(raw.name, 'Portal'),
    currentURL: str(raw.currentURL),
    source: decodePortalSource(raw.source),
    status: str(raw.status, 'idle'),
    chromeHidden: bool(raw.chromeHidden),
    storageScope: str(raw.storageScope, 'isolated'),
    // `bool` dá false para ausente — e é exatamente o que se quer aqui: portal
    // gravado antes deste campo (ou pelo app nativo) NUNCA volta dirigível.
    controlEnabled: bool(raw.controlEnabled)
  }
}

function decodeFileTree(raw: Record<string, unknown>): FileTreeContent {
  return {
    name: str(raw.name, 'Files'),
    rootPath: str(raw.rootPath),
    viewMode: str(raw.viewMode, 'list')
  }
}

function decodeCodeEditor(raw: Record<string, unknown>): CodeEditorContent {
  return { filePath: str(raw.filePath) }
}

function decodeDataTable(raw: Record<string, unknown>): DataTableContent {
  return {
    id: normalizeUUID(raw.id),
    title: str(raw.title, 'Resultado'),
    fileName: optStr(raw.fileName),
    query: optStr(raw.query),
    dialect: optStr(raw.dialect),
    rowCount: num(raw.rowCount, 0),
    columnCount: num(raw.columnCount, 0),
    truncated: bool(raw.truncated),
    executedAt: decodeDate(raw.executedAt)
  }
}

function decodeImage(raw: Record<string, unknown>): ImageContent {
  return {
    id: normalizeUUID(raw.id),
    fileName: optStr(raw.fileName),
    title: str(raw.title, 'Imagem'),
    mimeType: str(raw.mimeType, 'image/png'),
    naturalWidth: num(raw.naturalWidth, 0),
    naturalHeight: num(raw.naturalHeight, 0),
    alt: str(raw.alt),
    addedAt: decodeDate(raw.addedAt)
  }
}

/**
 * O `kind` NÃO é validado contra a lista conhecida, ao contrário de fontFamily
 * e alignment. A diferença é o que cada valor estranho faz: uma fonte
 * desconhecida cairia no CSS e quebraria o layout, enquanto um widget
 * desconhecido só precisa ser renderizado inerte e gravado de volta como veio.
 * Estreitar aqui trocaria o widget de uma versão mais nova por outro no
 * primeiro save — perda silenciosa, que é exatamente o que este arquivo evita.
 */
function decodeWidget(raw: Record<string, unknown>): WidgetContent {
  const view = asRecord(raw.view)
  return {
    kind: str(raw.kind, 'projects'),
    projectId: raw.projectId ? normalizeUUID(raw.projectId) : null,
    // Só as entradas de texto sobrevivem: `view` é [String: String] no Swift, e
    // um número aqui faria o decoder de lá lançar no arquivo que gravamos.
    view: Object.fromEntries(
      Object.entries(view).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
  }
}

/**
 * Cofre. A regra deste decoder é uma só, e é o ponto do nó inteiro: `value`
 * NÃO existe aqui. Um workspace.json que trouxesse um campo de valor — vindo de
 * um arquivo editado à mão, de um bug ou de uma versão futura descuidada — o
 * perde na releitura, porque só os campos abaixo são copiados, e nenhum deles é
 * o segredo: nome, env, origem, nota, quando foi gravado e por quem.
 *
 * `keys` é ordenada e sem repetição: ela é a projeção da lista de entradas do
 * `.vault`, e duas linhas com o mesmo nome deixariam a UI oferecer duas
 * remoções para a mesma chave.
 */
function decodeSecretVault(raw: Record<string, unknown>): SecretVaultContent {
  const list = Array.isArray(raw.keys) ? raw.keys : []
  const seen = new Set<string>()
  const keys: SecretVaultKeyRef[] = []
  for (const item of list) {
    const o = asRecord(item)
    const key = str(o.key)
    if (!key || seen.has(key)) continue
    seen.add(key)
    keys.push({
      key,
      inEnv: bool(o.inEnv),
      origin: optStr(o.origin),
      note: optStr(o.note),
      updatedAt: str(o.updatedAt),
      // Ausente vale 'user': cofre gravado antes deste campo não é cofre cheio
      // de chave de agente.
      source: o.source === 'agent' ? 'agent' : 'user'
    })
  }
  return {
    id: normalizeUUID(raw.id),
    name: str(raw.name, 'Cofre'),
    keys,
    locked: bool(raw.locked)
  }
}

// ─── Enums de tipografia ──────────────────────────────────────────────────────
// Validamos em vez de fazer cast: um valor estranho vindo do disco (ou de uma
// versão futura do app nativo) cairia direto no CSS e quebraria o layout.

const FONT_FAMILIES: FontFamily[] = ['sans', 'serif', 'mono', 'rounded']
const FONT_WEIGHTS: FontWeight[] = ['light', 'regular', 'medium', 'semibold', 'bold']
const ALIGNMENTS: TextAlignment[] = ['left', 'center', 'right']

function fontFamily(value: unknown, fallback: FontFamily): FontFamily {
  const v = str(value, fallback)
  return FONT_FAMILIES.includes(v as FontFamily) ? (v as FontFamily) : fallback
}

function fontWeight(value: unknown): FontWeight {
  const v = str(value, 'regular')
  return FONT_WEIGHTS.includes(v as FontWeight) ? (v as FontWeight) : 'regular'
}

function alignment(value: unknown): TextAlignment {
  const v = str(value, 'left')
  return ALIGNMENTS.includes(v as TextAlignment) ? (v as TextAlignment) : 'left'
}

function decodeText(raw: Record<string, unknown>): TextContent {
  return {
    text: str(raw.text),
    fontSize: num(raw.fontSize, 18),
    fontWeight: fontWeight(raw.fontWeight),
    color: str(raw.color, '#1a1a1a'),
    alignment: alignment(raw.alignment),
    fontFamily: fontFamily(raw.fontFamily, 'sans'),
    isItalic: bool(raw.isItalic),
    isUnderlined: bool(raw.isUnderlined),
    isStrikethrough: bool(raw.isStrikethrough),
    backgroundColor: optStr(raw.backgroundColor),
    lineHeight: num(raw.lineHeight, 1.3),
    letterSpacing: num(raw.letterSpacing, 0)
  }
}

function decodeShape(raw: Record<string, unknown>): ShapeContent {
  return {
    shapeType: str(raw.shapeType, 'rect') as ShapeContent['shapeType'],
    fillColor: str(raw.fillColor, 'blue'),
    strokeColor: str(raw.strokeColor, 'blue'),
    strokeWidth: num(raw.strokeWidth, 2),
    strokeStyle: str(raw.strokeStyle, 'solid') as ShapeContent['strokeStyle'],
    fillStyle: str(raw.fillStyle, 'solid') as ShapeContent['fillStyle'],
    text: str(raw.text),
    fontSize: num(raw.fontSize, 16),
    rotation: num(raw.rotation)
  }
}

function decodeStroke(raw: Record<string, unknown>): StrokeContent {
  return {
    strokeType: str(raw.strokeType, 'line') as StrokeContent['strokeType'],
    startPoint: decodePoint(raw.startPoint, { x: 0, y: 0.5 }),
    endPoint: decodePoint(raw.endPoint, { x: 1, y: 0.5 }),
    controlPoint: raw.controlPoint === undefined || raw.controlPoint === null
      ? null
      : decodePoint(raw.controlPoint, { x: 0.5, y: 0.5 }),
    strokeColor: str(raw.strokeColor, 'blue'),
    strokeWidth: num(raw.strokeWidth, 2),
    strokeStyle: str(raw.strokeStyle, 'solid') as StrokeContent['strokeStyle']
  }
}

function decodeFreehand(raw: Record<string, unknown>): FreehandContent {
  const type = str(raw.freehandType, 'pen') as FreehandContent['freehandType']
  const points = Array.isArray(raw.points) ? raw.points.map((p) => decodePoint(p)) : []
  return {
    freehandType: type,
    points,
    strokeColor: str(raw.strokeColor, 'blue'),
    strokeWidth: num(raw.strokeWidth, type === 'highlighter' ? 12 : 3),
    opacity: num(raw.opacity, type === 'highlighter' ? 0.4 : 1),
    rotation: num(raw.rotation)
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

export function decodeNodeContent(value: unknown): NodeContent | null {
  const o = asRecord(value)
  const variant = VARIANTS.find((v) => v in o)
  if (!variant) return null
  const payload = asRecord(asRecord(o[variant])._0)

  switch (variant) {
    case 'terminal':
      return { type: 'terminal', value: decodeTerminal(payload) }
    case 'stickyNote':
      return { type: 'stickyNote', value: decodeStickyNote(payload) }
    case 'portal':
      return { type: 'portal', value: decodePortal(payload) }
    case 'fileTree':
      return { type: 'fileTree', value: decodeFileTree(payload) }
    case 'codeEditor':
      return { type: 'codeEditor', value: decodeCodeEditor(payload) }
    case 'text':
      return { type: 'text', value: decodeText(payload) }
    case 'shape':
      return { type: 'shape', value: decodeShape(payload) }
    case 'stroke':
      return { type: 'stroke', value: decodeStroke(payload) }
    case 'freehand':
      return { type: 'freehand', value: decodeFreehand(payload) }
    case 'dataTable':
      return { type: 'dataTable', value: decodeDataTable(payload) }
    case 'image':
      return { type: 'image', value: decodeImage(payload) }
    case 'widget':
      return { type: 'widget', value: decodeWidget(payload) }
    case 'secretVault':
      return { type: 'secretVault', value: decodeSecretVault(payload) }
  }
}

export function encodeNodeContent(content: NodeContent): unknown {
  const payload = ((): unknown => {
    switch (content.type) {
      case 'stickyNote':
        return { ...content.value, storageMode: encodeStorageMode(content.value.storageMode) }
      case 'portal':
        return { ...content.value, source: encodePortalSource(content.value.source) }
      case 'stroke': {
        const s = content.value
        return {
          ...s,
          startPoint: encodePoint(s.startPoint),
          endPoint: encodePoint(s.endPoint),
          ...(s.controlPoint ? { controlPoint: encodePoint(s.controlPoint) } : {})
        }
      }
      case 'freehand':
        return { ...content.value, points: content.value.points.map(encodePoint) }
      default:
        return content.value
    }
  })()

  return { [content.type]: { _0: payload } }
}

// ─── Construtores ─────────────────────────────────────────────────────────────

export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe'
  return process.env.SHELL ?? '/bin/zsh'
}

export function makeTerminalContent(
  name: string,
  opts: Partial<TerminalContent> = {}
): TerminalContent {
  return {
    agentType: 'generic_shell',
    command: '',
    name,
    icon: 'terminal',
    color: '#007AFF',
    id: uuid(),
    shellPath: defaultShell(),
    workingDirectory: '',
    status: 'idle',
    isManager: false,
    monitorWithOmbro: false,
    autoScrollLocked: false,
    shortcutMode: { kind: 'automatic' },
    assignedRoleId: null,
    scrollbackFile: null,
    scrollbackLineCount: 0,
    lastActiveAt: null,
    themeId: null,
    fontFamily: null,
    fontSize: null,
    claudeAccountId: null,
    recruitedBy: null,
    resumeSessionId: null,
    ...opts
  }
}

/**
 * O `.md` é a identidade da nota em disco — duas notas com o mesmo arquivo
 * escrevem uma por cima da outra e, na reabertura, aparecem com o mesmo texto.
 * Numera até achar um nome livre entre os já usados (nós do canvas + arquivos
 * que sobraram de notas apagadas, que também não devem ser reaproveitados).
 */
export function uniqueNoteFileName(base: string, taken: Iterable<string> = []): string {
  const used = new Set(taken)
  if (!used.has(`${base}.md`)) return `${base}.md`
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}.md`
    if (!used.has(candidate)) return candidate
  }
}

export function makeStickyNoteContent(
  name: string,
  taken: Iterable<string> = []
): StickyNoteContent {
  return {
    color: Constants.noteDefaultColor,
    fileName: uniqueNoteFileName(name, taken),
    fontSize: 14,
    hasCustomName: false,
    isPreviewing: false,
    storageMode: { kind: 'managed' },
    textColor: null,
    fontFamily: 'mono',
    alignment: 'left'
  }
}

export function makeTextContent(text = ''): TextContent {
  return {
    text,
    fontSize: 18,
    fontWeight: 'regular',
    color: '#1a1a1a',
    alignment: 'left',
    fontFamily: 'sans',
    isItalic: false,
    isUnderlined: false,
    isStrikethrough: false,
    backgroundColor: null,
    lineHeight: 1.3,
    letterSpacing: 0
  }
}

export function makePortalContent(name: string, url = ''): PortalContent {
  return {
    id: uuid(),
    name,
    currentURL: url,
    source: url ? { kind: 'url', url } : { kind: 'none' },
    status: 'idle',
    chromeHidden: false,
    storageScope: 'isolated',
    controlEnabled: false
  }
}

export function makeFileTreeContent(name: string, rootPath: string): FileTreeContent {
  return { name, rootPath, viewMode: 'list' }
}

export function makeCodeEditorContent(filePath: string): CodeEditorContent {
  return { filePath }
}

export function makeDataTableContent(title: string): DataTableContent {
  const id = uuid()
  return {
    id,
    title,
    fileName: `${id}.json`,
    query: null,
    dialect: null,
    rowCount: 0,
    columnCount: 0,
    truncated: false,
    executedAt: nowISO()
  }
}

export function makeImageContent(
  title: string,
  opts: Partial<Pick<ImageContent, 'mimeType' | 'naturalWidth' | 'naturalHeight' | 'alt'>> = {}
): ImageContent {
  const id = uuid()
  const mimeType = opts.mimeType || 'image/png'
  return {
    id,
    fileName: `${id}.${extForImageMime(mimeType)}`,
    title,
    mimeType,
    naturalWidth: opts.naturalWidth ?? 0,
    naturalHeight: opts.naturalHeight ?? 0,
    alt: opts.alt ?? '',
    addedAt: nowISO()
  }
}

/**
 * O widget nasce seguindo a seleção global (`projectId: null`). Fixar num
 * projeto é ato posterior e explícito do usuário — o cadeado no cabeçalho.
 */
export function makeWidgetContent(
  kind: string,
  projectId: UUID | null = null,
  // O botão nasce configurado num único `addNode`, em vez de um `patchContent`
  // logo atrás — que gravaria o workspace duas vezes e deixaria, entre as duas,
  // um botão sem ação no canvas.
  view: Record<string, string> = {}
): WidgetContent {
  return { kind, projectId, view }
}

/**
 * Cofre novo: identidade e nada mais. O `.vault` correspondente só passa a
 * existir quando a primeira chave é gravada — um cofre vazio não tem segredo
 * nenhum a proteger, e um arquivo cifrado sem entradas seria só ruído no disco.
 */
export function makeSecretVaultContent(name: string): SecretVaultContent {
  return { id: uuid(), name, keys: [], locked: false }
}

/** Nome exibido no header do nó, por tipo. */
export function nodeDisplayName(content: NodeContent): string {
  switch (content.type) {
    case 'terminal':
      return content.value.name
    case 'stickyNote':
      return content.value.fileName?.replace(/\.md$/, '') ?? 'Note'
    case 'portal': {
      // Mesmo critério do header no renderer: host em vez de "Portal" repetido.
      const { name, currentURL } = content.value
      if (name && name !== 'Portal') return name
      if (!currentURL) return 'Portal'
      try {
        return new URL(currentURL).host.replace(/^www\./, '')
      } catch {
        return currentURL
      }
    }
    case 'fileTree':
      return content.value.name
    case 'codeEditor':
      return fileNameOf(content.value.filePath) || 'Arquivo'
    case 'dataTable':
      return content.value.title
    case 'image':
      return content.value.title || 'Imagem'
    case 'widget':
      return widgetTitle(content.value.kind, content.value.view)
    case 'secretVault':
      return content.value.name || 'Cofre'
    case 'text':
      return content.value.text.slice(0, 24) || 'Text'
    default:
      return content.type
  }
}

/** Rótulo do painel hospedado. Um kind desconhecido responde o próprio kind —
 *  é mais informativo que "Widget" e não finge que o nó é outra coisa.
 *
 *  O botão é o único que precisa do `view`: o nome dele é o rótulo que o
 *  usuário escreveu, e é por esse nome que o CLI o encontra. */
export function widgetTitle(kind: string, view: Record<string, string> = {}): string {
  switch (kind) {
    case 'projects':
      return 'Projetos'
    case 'git':
      return 'Git'
    case 'button':
      return view.label || 'Botão'
    case 'monitor':
      return 'Monitor'
    case 'todo':
      // O título do QUADRO, quando o nó já sabe qual é: dois quadros no canvas
      // chamados "Tarefas" não se distinguem no cabeçalho nem no `atelier list`.
      return view.title || 'Tarefas'
    default:
      return kind
  }
}

/** Último componente do caminho. O main tem `path`, mas o Windows usa `\`. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? ''
}
