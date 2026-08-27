/** Porte de Sources/Shared/Constants.swift */
export const Constants = {
  schemaVersion: 6,
  /** Versão do índice de projetos (projects.json) — independente do workspace. */
  projectIndexSchemaVersion: 1,
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
  /** Nó de resultado SQL: piso, tamanho padrão e tetos da fase 1 (snapshot). */
  tableMinWidth: 240,
  tableMinHeight: 140,
  tableDefaultWidth: 520,
  tableDefaultHeight: 360,
  tableMaxRows: 2000,
  tableMaxCells: 200_000,
  /** Nó de imagem: teto de bytes, piso e tamanho padrão do nó no canvas. */
  imageMaxBytes: 25 * 1024 * 1024,
  imageMinWidth: 80,
  imageMinHeight: 60,
  imageDefaultWidth: 360,
  imageDefaultHeight: 260,
  /** Nó de widget (painel do app no canvas): piso e tamanho padrão. */
  widgetMinWidth: 240,
  widgetMinHeight: 180,
  widgetDefaultWidth: 380,
  widgetDefaultHeight: 460,
  /** Colagens de imagem no terminal com mais que isto (ms) são apagadas no boot. */
  imageTmpMaxAgeMs: 24 * 60 * 60 * 1000,
  agentIdleTimeoutMs: 2000,
  askResponseTimeoutMs: 30_000
} as const

/** Margem de clipping do viewport, em pontos de canvas (espelha o app nativo). */
export const VIEWPORT_CULL_MARGIN = 200
