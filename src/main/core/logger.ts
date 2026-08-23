/** Substituto do OSLog: prefixo por categoria, silencioso em produção no nível debug. */
const isDev = process.env.NODE_ENV === 'development'

function emit(level: 'debug' | 'info' | 'warn' | 'error', category: string, msg: string, extra?: unknown) {
  if (level === 'debug' && !isDev) return
  const line = `[${new Date().toISOString()}] [${level}] [${category}] ${msg}`
  if (level === 'error') console.error(line, extra ?? '')
  else if (level === 'warn') console.warn(line, extra ?? '')
  else console.log(line, extra ?? '')
}

export const log = {
  debug: (category: string, msg: string, extra?: unknown) => emit('debug', category, msg, extra),
  info: (category: string, msg: string, extra?: unknown) => emit('info', category, msg, extra),
  warn: (category: string, msg: string, extra?: unknown) => emit('warn', category, msg, extra),
  error: (category: string, msg: string, extra?: unknown) => emit('error', category, msg, extra)
}
