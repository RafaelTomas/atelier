/** Codecs de manifest.json, app-state.json e preferences.json. */
import type {
  AppStateData,
  PortalPopupMode,
  Preferences,
  TerminalTheme,
  WorkspaceEntry,
  WorkspaceManifest
} from '@shared/types'
import {
  DOCK_PLACEMENT_DEFAULT,
  MONITOR_PLACEMENT_DEFAULT,
  PORTAL_POPUP_MODES,
  RAIL_PLACEMENT_DEFAULT,
  formatPlacement,
  parsePlacement
} from '@shared/types'
import { asRecord, bool, decodeDate, decodeOptionalDate, normalizeUUID, num, str } from '../coding'
import { nowISO, uuid } from '../coding'

// ─── manifest.json ────────────────────────────────────────────────────────────

export function makeWorkspaceEntry(name: string, workingDirectory: string, id = uuid()): WorkspaceEntry {
  return {
    id,
    name,
    workingDirectory,
    icon: 'folder',
    color: 'blue',
    isPinned: false,
    locationType: 'local',
    createdAt: nowISO(),
    lastOpenedAt: null
  }
}

function decodeWorkspaceEntry(value: unknown): WorkspaceEntry {
  const o = asRecord(value)
  return {
    id: normalizeUUID(o.id),
    name: str(o.name, 'Workspace'),
    workingDirectory: str(o.workingDirectory),
    icon: str(o.icon, 'folder'),
    color: str(o.color, 'blue'), // ausente em arquivos antigos
    isPinned: bool(o.isPinned),
    locationType: str(o.locationType, 'local'),
    createdAt: decodeDate(o.createdAt),
    lastOpenedAt: decodeOptionalDate(o.lastOpenedAt)
  }
}

export function makeManifest(): WorkspaceManifest {
  return {
    schemaVersion: 1,
    type: 'appState', // sim, "appState" — herança do formato Maestri
    app: 'atelier',
    appVersion: '1.0.0',
    dataFormat: 2,
    workspaces: [],
    files: {}
  }
}

export function decodeManifest(value: unknown): WorkspaceManifest {
  const o = asRecord(value)
  const base = makeManifest()
  return {
    schemaVersion: num(o.schemaVersion, base.schemaVersion),
    type: str(o.type, base.type),
    app: str(o.app, base.app),
    appVersion: str(o.appVersion, base.appVersion),
    dataFormat: num(o.dataFormat, base.dataFormat),
    workspaces: Array.isArray(o.workspaces) ? o.workspaces.map(decodeWorkspaceEntry) : [],
    files: (o.files && typeof o.files === 'object' ? o.files : {}) as Record<string, string>
  }
}

// ─── app-state.json ───────────────────────────────────────────────────────────

export function makeAppStateData(): AppStateData {
  return {
    schemaVersion: 1,
    type: 'appState',
    activeWorkspaceId: null,
    hasCompletedOnboarding: false,
    hasSeenFloorOnboarding: false,
    cleanShutdown: true,
    lastOpenedAt: null,
    recentWorkspaceIds: []
  }
}

export function decodeAppStateData(value: unknown): AppStateData {
  const o = asRecord(value)
  const base = makeAppStateData()
  return {
    schemaVersion: num(o.schemaVersion, base.schemaVersion),
    type: str(o.type, base.type),
    activeWorkspaceId: o.activeWorkspaceId ? normalizeUUID(o.activeWorkspaceId) : null,
    hasCompletedOnboarding: bool(o.hasCompletedOnboarding),
    hasSeenFloorOnboarding: bool(o.hasSeenFloorOnboarding),
    cleanShutdown: bool(o.cleanShutdown, true),
    lastOpenedAt: decodeOptionalDate(o.lastOpenedAt),
    recentWorkspaceIds: Array.isArray(o.recentWorkspaceIds)
      ? o.recentWorkspaceIds.filter((x): x is string => typeof x === 'string').map((x) => x.toUpperCase())
      : []
  }
}

// ─── preferences.json ─────────────────────────────────────────────────────────

export function makePreferences(): Preferences {
  return {
    canvasBackground: 'grid',
    language: 'system',
    fontSize: 13,
    fontFamily: 'system',
    theme: 'system',
    sidebarCollapsed: false,
    sidebarWidth: 220,
    autoScanOnLaunch: true,
    terminalThemes: [],
    portalPopups: 'node',
    dockPlacement: formatPlacement(DOCK_PLACEMENT_DEFAULT),
    railPlacement: formatPlacement(RAIL_PLACEMENT_DEFAULT),
    monitorPlacement: formatPlacement(MONITOR_PLACEMENT_DEFAULT),
    monitorDockVisible: true
  }
}

function decodeTerminalTheme(value: unknown): TerminalTheme {
  const o = asRecord(value)
  return {
    id: str(o.id, 'custom'),
    name: str(o.name, 'Personalizado'),
    background: str(o.background, '#101014'),
    foreground: str(o.foreground, '#e6e6e6')
  }
}

export function decodePreferences(value: unknown): Preferences {
  const o = asRecord(value)
  const base = makePreferences()
  return {
    canvasBackground: str(o.canvasBackground, base.canvasBackground),
    language: str(o.language, base.language),
    fontSize: num(o.fontSize, base.fontSize),
    fontFamily: str(o.fontFamily, base.fontFamily),
    theme: str(o.theme, base.theme),
    sidebarCollapsed: bool(o.sidebarCollapsed, base.sidebarCollapsed),
    // Ausente em preferences.json escrito antes do painel redimensionável
    sidebarWidth: num(o.sidebarWidth, base.sidebarWidth),
    autoScanOnLaunch: bool(o.autoScanOnLaunch, base.autoScanOnLaunch),
    // Ausente em preferences.json escrito antes dos temas de terminal
    terminalThemes: Array.isArray(o.terminalThemes)
      ? o.terminalThemes.map(decodeTerminalTheme)
      : [],
    // Ausente em preferences.json escrito antes do popup virar nó
    portalPopups: PORTAL_POPUP_MODES.includes(o.portalPopups as PortalPopupMode)
      ? (o.portalPopups as PortalPopupMode)
      : base.portalPopups,
    // Ausentes em preferences.json escrito antes das pílulas móveis — e também
    // depois de um save do app nativo, que não conhece estas chaves e as apaga.
    // Os dois casos caem no padrão pelo mesmo caminho, que é o ponto de
    // `parsePlacement` nunca lançar: nenhum estado em disco pode esconder a dock.
    dockPlacement: formatPlacement(parsePlacement(o.dockPlacement, DOCK_PLACEMENT_DEFAULT)),
    railPlacement: formatPlacement(parsePlacement(o.railPlacement, RAIL_PLACEMENT_DEFAULT)),
    monitorPlacement: formatPlacement(parsePlacement(o.monitorPlacement, MONITOR_PLACEMENT_DEFAULT)),
    // O padrão aqui é `true` de propósito: chave ausente, apagada pelo app
    // nativo ou com lixo dentro deixa a tira VISÍVEL. O contrário esconderia a
    // peça sem deixar como trazê-la de volta.
    monitorDockVisible: bool(o.monitorDockVisible, base.monitorDockVisible)
  }
}
