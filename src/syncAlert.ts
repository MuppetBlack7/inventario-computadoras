/**
 * Alerta contextual de sincronización. Es lógica pura de presentación: no lee ni escribe datos y no ejecuta operaciones.
 * Devuelve `null` cuando todo está en orden (incluida una sincronización detenida a propósito sin cambios pendientes).
 */
export type AlertLevel = 'info' | 'warning' | 'error'

export interface SyncAlert {
  level: AlertLevel
  title: string
  /** Motivos resumidos en una sola alerta, del más grave al menos grave. */
  reasons: string[]
}

export interface SyncAlertInput {
  signedIn: boolean
  /** La sincronización está detenida (todavía no se ha autorizado desde «Sincronizar inventario»). */
  syncHeld: boolean
  /** Conexión del dispositivo. */
  online: boolean
  /** Resultado de la última lectura de Firebase; `undefined` si todavía no se ha intentado. */
  firebaseReachable: boolean | undefined
  /** Cambios locales propios pendientes de enviar. */
  pending: number
  /** Operaciones propias con un error registrado. */
  failedOperations: number
  /** Fotografías propias con un problema real (subida con error). */
  photoProblems: number
  /** La última sincronización terminó con error. */
  lastSyncFailed: boolean
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const RANK: Record<AlertLevel, number> = { info: 0, warning: 1, error: 2 }
const TITLES: Record<AlertLevel, string> = { error: 'Hay un problema con la sincronización', warning: 'Revisa tu sincronización', info: 'Sin conexión' }

export function computeSyncAlert(input: SyncAlertInput): SyncAlert | null {
  if (!input.signedIn) return null
  const found: Array<{ level: AlertLevel; reason: string }> = []
  if (input.failedOperations > 0) found.push({ level: 'error', reason: `${plural(input.failedOperations, 'operación no se pudo sincronizar', 'operaciones no se pudieron sincronizar')}` })
  if (input.online && input.firebaseReachable === false) found.push({ level: 'error', reason: 'No se pudo conectar con Firebase' })
  else if (input.lastSyncFailed && input.failedOperations === 0) found.push({ level: 'error', reason: 'La última sincronización falló' })
  if (input.photoProblems > 0) found.push({ level: 'warning', reason: `${plural(input.photoProblems, 'fotografía necesita', 'fotografías necesitan')} atención` })
  if (input.syncHeld && input.pending > 0) found.push({ level: 'warning', reason: `La sincronización está detenida y hay ${plural(input.pending, 'cambio', 'cambios')} sin enviar` })
  else if (!input.online && input.pending > 0) found.push({ level: 'info', reason: `Sin conexión: ${plural(input.pending, 'cambio se enviará', 'cambios se enviarán')} al recuperarla` })
  if (!found.length) return null
  const level = found.reduce<AlertLevel>((worst, item) => (RANK[item.level] > RANK[worst] ? item.level : worst), 'info')
  return { level, title: TITLES[level], reasons: found.sort((a, b) => RANK[b.level] - RANK[a.level]).map((item) => item.reason) }
}
