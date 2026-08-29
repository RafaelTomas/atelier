/** Porte de Sources/Shared/Constants.swift */
export const Constants = {
  schemaVersion: 7,
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
  /** Nó de cofre: piso e tamanho padrão. Estreito — é uma lista de nomes. */
  vaultMinWidth: 220,
  vaultMinHeight: 140,
  vaultDefaultWidth: 320,
  vaultDefaultHeight: 280,
  /** Revelar valor na UI: teto de revelações por minuto, por cofre. */
  vaultRevealPerMinute: 10,
  /** Botão (widget de kind `button`): um alvo de clique, não um painel. */
  buttonMinWidth: 56,
  buttonMinHeight: 56,
  buttonDefaultWidth: 88,
  buttonDefaultHeight: 88,
  /**
   * Monitor (widget de kind `monitor`): três blocos empilhados, não uma coluna
   * de painel — nasce menor que o `widgetDefault*`, como o botão.
   *
   * A altura cresceu com o bloco de perfis: são uma linha de título e uma por
   * conta do Claude. Com 300 o painel nascia já rolando na configuração padrão
   * (PC + IA + contas), e um monitor que precisa de scroll para ser lido não é
   * um monitor.
   */
  monitorDefaultWidth: 340,
  monitorDefaultHeight: 380,
  /**
   * Período de amostragem do monitor. 2s é o meio-termo: 1s deixa a barra
   * nervosa demais para ler, 5s perde o pico de um build.
   */
  systemSampleIntervalMs: 2000,
  /** Anel de histórico do sparkline: 120 × 2s = 4 minutos de gráfico. */
  systemHistorySize: 120,
  /**
   * precisam caber lado a lado — abaixo de ~420px o painel cai sozinho para a
   * vista de lista.
   */
  /** Teto de cartões por quadro. Acima disso o kanban deixa de ser legível. */
  /** Abaixo desta largura o quadro mostra a lista, sem mudar o `view` gravado. */
  /** Colagens de imagem no terminal com mais que isto (ms) são apagadas no boot. */
  imageTmpMaxAgeMs: 24 * 60 * 60 * 1000,
  agentIdleTimeoutMs: 2000,
  /** Teto de terminais por canvas para o `atelier recruit` — ver handlers/recruit.ts. */
  recruitMaxTerminals: 12,
  askResponseTimeoutMs: 30_000
} as const

/** Margem de clipping do viewport, em pontos de canvas (espelha o app nativo). */
export const VIEWPORT_CULL_MARGIN = 200
