/**
 * Ícones da dock — SVG inline, traço de 1.5px em currentColor.
 *
 * Desenhados em uma grade de 24 e sem preenchimento: é o que dá o visual
 * "outline" da dock. Nada de emoji aqui — emoji não herda cor do tema e cada
 * plataforma renderiza num peso diferente, o que quebra o alinhamento da pill.
 */
interface IconProps {
  size?: number
}

function Svg({ size = 18, children }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Cursor de seleção — o único ícone preenchido, como na referência. */
export function IconCursor(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 3.5 18.5 12 12 13 9.5 20Z" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/**
 * Mão aberta — o modo em que o arrasto move o quadro em vez de selecionar.
 * Outline, ao contrário do IconCursor: os dois se alternam no mesmo botão da
 * dock, e o contraste cheio/vazado deixa claro qual está ativo.
 */
export function IconHand(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 11V4.75a1.25 1.25 0 0 1 2.5 0V11" />
      <path d="M11.5 10.5V3.75a1.25 1.25 0 0 1 2.5 0V11" />
      <path d="M14 11V5.75a1.25 1.25 0 0 1 2.5 0V13" />
      <path d="M9 11V9.75a1.25 1.25 0 0 0-2.5 0V14c0 3.6 2.4 6.5 5.75 6.5S18.5 17.6 18.5 14v-3.25a1.25 1.25 0 0 0-2.5 0" />
    </Svg>
  )
}

export function IconTerminal(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M7 10.5 9.5 13 7 15.5M12.5 16h4" />
    </Svg>
  )
}

export function IconNote(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 3.5h11a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6" />
      <path d="M6 3.5a2 2 0 0 0 0 4M6 20.5a2 2 0 0 0 0-4h2" />
      <path d="M10 8.5h5M10 12h5" />
    </Svg>
  )
}

export function IconClip(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M17.5 7 9 15.5a2.5 2.5 0 0 0 3.5 3.5l7-7a4.5 4.5 0 0 0-6.5-6.5l-7 7a6.5 6.5 0 0 0 9 9L21 15" />
    </Svg>
  )
}

export function IconFolder(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 7.5a2 2 0 0 1 2-2h3.8l1.7 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Svg>
  )
}

/**
 * Quatro quadros numa grade 2×2 — a mesma leitura do logo do Windows, que é o
 * ícone universal de "os seus espaços, escolha um". Vazado como o resto do
 * conjunto: preenchido, brigaria com o azul do estado ativo.
 */
export function IconWindows(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Svg>
  )
}

/**
 * Caixa fechada — o projeto como unidade, não como pasta. A distinção importa
 * porque a aba ao lado é justamente a de pastas e arquivos.
 */
export function IconCube(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 3 20.5 7.5v9L12 21l-8.5-4.5v-9z" />
      <path d="m3.5 7.5 8.5 4.5 8.5-4.5M12 12v9" />
    </Svg>
  )
}

/**
 * Ramo saindo do tronco e voltando — o glifo que todo mundo já lê como Git.
 * Os três círculos são commits; sem eles a forma vira só uma chave.
 */
export function IconBranch(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="7" cy="5.5" r="2.2" />
      <circle cx="7" cy="18.5" r="2.2" />
      <circle cx="17" cy="7.5" r="2.2" />
      <path d="M7 7.7v8.6" />
      <path d="M17 9.7v1.8a4 4 0 0 1-4 4H7" />
    </Svg>
  )
}

export function IconGlobe(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
    </Svg>
  )
}

/** "Aa" — texto. Desenhado como glifo para casar com o peso dos outros. */
export function IconText({ size = 18 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="14"
        fontFamily="-apple-system, system-ui, sans-serif"
        fill="currentColor"
      >
        Aa
      </text>
    </svg>
  )
}

/** Modo desenho: círculo com um traço atravessando, como na referência. */
/**
 * Grupo: uma moldura tracejada com dois blocos dentro — a leitura que a
 * ferramenta produz no canvas, e não um ícone de "pasta", que já é a árvore de
 * arquivos.
 */
export function IconGroup(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" strokeDasharray="3 2.5" />
      <rect x="6.5" y="8" width="4.5" height="8" rx="1" />
      <rect x="13" y="8" width="4.5" height="5" rx="1" />
    </Svg>
  )
}

export function IconDraw(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M16.5 7.5 7.5 16.5" />
    </Svg>
  )
}

export function IconPen(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 20l4-1 10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 15.5Z" />
      <path d="M13.5 6.5 17.5 10.5" />
    </Svg>
  )
}

export function IconHighlighter(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 14.5l6.5-8a2 2 0 0 1 3 0l1.5 1.8a2 2 0 0 1-.3 2.9L11.5 17Z" />
      <path d="M9 14.5 7 19h5l-.5-2M4 21.5h16" />
    </Svg>
  )
}

export function IconEraser(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8.5 19.5 4 15a1.5 1.5 0 0 1 0-2.2l8.3-8.3a1.5 1.5 0 0 1 2.2 0l5 5a1.5 1.5 0 0 1 0 2.2l-7.8 7.8Z" />
      <path d="M9.5 7.5 16.5 14.5M9 19.5h11" />
    </Svg>
  )
}

/** Traço reto. */
export function IconLine(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4.5 19.5 19.5 4.5" />
    </Svg>
  )
}

export function IconArrow(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4.5 19.5 19 5M13 5h6v6" />
    </Svg>
  )
}

export function IconRect(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="4" y="6" width="16" height="12" rx="2" />
    </Svg>
  )
}

export function IconEllipse(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
    </Svg>
  )
}

export function IconTrash(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />
    </Svg>
  )
}

/** Revelar um segredo. */
export function IconEye(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </Svg>
  )
}

/** Esconder de volta: o mesmo olho, cortado. O corte é o que se lê de relance. */
export function IconEyeOff(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8M6.3 7.4A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5c1.5 0 2.8-.4 4-1" />
      <path d="M10 10a2.8 2.8 0 0 0 4 4" />
      <path d="m4 4 16 16" />
    </Svg>
  )
}

/** Copiar: as duas folhas sobrepostas. */
export function IconCopy(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </Svg>
  )
}

/** Confirmação efêmera — o "copiado" do cofre. */
export function IconCheck(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Svg>
  )
}

/** Trocar este segredo: a seta de rotação, com o ponto do alerta no meio. */
export function IconRotateKey(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.8-6.3" />
      <path d="M20.5 3.5V9H15" />
      <path d="M12 9v3.5" />
      <circle cx="12" cy="16" r=".9" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Ligar: as duas setas do cabeçalho do nó, no mesmo traço da dock. */
export function IconConnect(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 9h16m-3.5-3.5L20 9M20 15H4m3.5 3.5L4 15" />
    </Svg>
  )
}

export function IconPencil(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="M14.5 7.5 17 10" />
    </Svg>
  )
}

/** Recarregar: seta circular com a ponta aberta, como o ↻ do Portal. */
export function IconPlus(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  )
}

export function IconSearch(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </Svg>
  )
}

/** Três pontos na vertical: "mais opções". Preenchidos — o traço de 1.5px em
 *  pontos de 1px vira três borrões cinzas. */
export function IconMore(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Alfinete: "fixar no canvas". */
export function IconPin(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 17v5" />
      <path d="M5 17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.7a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2Z" />
    </Svg>
  )
}

/** Cadeado fechado: o widget está preso a UM projeto. */
export function IconLock(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  )
}

/** Cadeado aberto: o widget segue a seleção global. A haste solta à direita é
 *  a única diferença — e é ela que o usuário lê de relance. */
export function IconUnlock(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.9-.8" />
    </Svg>
  )
}

export function IconReload(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </Svg>
  )
}

export function IconChevronDown({ size = 10 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.5 4.5 6 8l3.5-3.5" />
    </svg>
  )
}

/** Fetch — baixa até a linha, sem aplicar: consulta o remoto e para aí. */
export function IconFetch(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 4v9" />
      <path d="M8.5 9.5 12 13l3.5-3.5" />
      <path d="M5 18h14" />
    </Svg>
  )
}

/** Pull — traz de lá para cá. */
export function IconPull(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 4v14" />
      <path d="M6.5 12.5 12 18l5.5-5.5" />
    </Svg>
  )
}

/** Push — manda daqui para lá. */
export function IconPush(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 20V6" />
      <path d="M6.5 11.5 12 6l5.5 5.5" />
    </Svg>
  )
}

/** Play da dock — a entrada do botão configurável. */
export function IconPlay(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8 5.2 18.4 12 8 18.8z" />
    </Svg>
  )
}
