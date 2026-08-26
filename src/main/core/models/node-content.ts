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
  FileTreeContent,
  FreehandContent,
  NodeContent,
  PortalContent,
  PortalSource,
  ShapeContent,
  StickyNoteContent,
  StorageMode,
  StrokeContent,
  TerminalContent,
  TextAlignment,
  TextContent,
  FontFamily,
  FontWeight
} from '@shared/types'
import {
  asRecord,
  bool,
  decodeOptionalDate,
  decodePoint,
  encodePoint,
  normalizeUUID,
  num,
  optNum,
  optStr,
  str,
  uuid
} from '../coding'
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
  'freehand'
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
    fontSize: optNum(raw.fontSize)
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
    storageScope: str(raw.storageScope, 'isolated')
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
    ...opts
  }
}

export function makeStickyNoteContent(name: string): StickyNoteContent {
  return {
    color: Constants.noteDefaultColor,
    fileName: `${name}.md`,
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
    storageScope: 'isolated'
  }
}

export function makeFileTreeContent(name: string, rootPath: string): FileTreeContent {
  return { name, rootPath, viewMode: 'list' }
}

export function makeCodeEditorContent(filePath: string): CodeEditorContent {
  return { filePath }
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
    case 'text':
      return content.value.text.slice(0, 24) || 'Text'
    default:
      return content.type
  }
}

/** Último componente do caminho. O main tem `path`, mas o Windows usa `\`. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? ''
}
