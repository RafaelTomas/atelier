/** Porte de Sources/Shared/Constants.swift */
export const Constants = {
  schemaVersion: 2,
  appDataDirectoryName: '.atelier',
  defaultFontSize: 13,
  defaultFontFamily: 'system',
  autosaveIntervalMs: 30_000,
  backupIntervalMs: 3_600_000,
  canvasInitialOrigin: { x: 9800, y: 8500 },
  canvasMinZoom: 0.1,
  canvasMaxZoom: 3.0,
  canvasZoomStep: 0.25,
  canvasGridSpacing: 16,
  ropeControlPointCount: 21,
  ropeBendRatioMin: 1.08,
  ropeBendRatioMax: 1.15,
  interAgentServerHost: '127.0.0.1',
  terminalMinWidth: 200,
  terminalMinHeight: 100,
  noteMinWidth: 120,
  noteMinHeight: 80,
  noteDefaultWidth: 260,
  noteDefaultHeight: 150,
  noteDefaultColor: '#FEFDE8',
  agentIdleTimeoutMs: 2000,
  askResponseTimeoutMs: 30_000
} as const

/** Margem de clipping do viewport, em pontos de canvas (espelha o app nativo). */
export const VIEWPORT_CULL_MARGIN = 200
