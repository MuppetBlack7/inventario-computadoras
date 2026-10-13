import { needsRecoveryReview, type RecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'

/**
 * Estado de la recuperación. Solo `authorized` permite sincronizar o aplicar cambios remotos.
 * Un diagnóstico, sea cual sea su resultado, nunca produce `authorized`: eso exige `authorizeRecovery`,
 * que solo se invoca desde una acción explícita de la persona usuaria.
 */
export type RecoveryPhase = 'checking' | 'review' | 'ready' | 'local-only' | 'authorized'

export interface RecoveryState {
  phase: RecoveryPhase
  report?: RecoveryReport
  local?: RecoverySnapshot
  remote?: RemoteRecoverySnapshot | null
}

export const CHECKING: RecoveryState = { phase: 'checking' }

/** Resultado de un diagnóstico: `review` si hay algo que revisar y `ready` si salió limpio. En ambos casos la sincronización sigue detenida. */
export function afterDiagnostic(report: RecoveryReport, local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, needsReview: boolean): RecoveryState {
  return { phase: needsReview || needsRecoveryReview(local, remote, report) ? 'review' : 'ready', report, local, remote }
}

export function authorizeRecovery(state: RecoveryState, accountId: string): RecoveryState {
  // Nunca se autoriza en bloque una cola antigua ni conflictos: requieren un plan por registro.
  if (state.phase !== 'ready' || state.report?.accountId !== accountId) return state
  return { ...state, phase: 'authorized' }
}

export const syncAllowed = (state: RecoveryState) => state.phase === 'authorized'

/**
 * «Mantener detenida la sincronización»: se puede usar la aplicación (editar solo registros propios, en local) sin autorizar nada.
 * La sincronización sigue bloqueada; los cambios locales solo se encolan.
 */
export function keepSyncStopped(state: RecoveryState): RecoveryState {
  if (state.phase !== 'review' && state.phase !== 'ready') return state
  return { ...state, phase: 'local-only' }
}

/**
 * El inventario siempre es utilizable (registrar, editar y consultar equipos), esté la sincronización detenida o no y haya
 * terminado o no el diagnóstico. La sincronización es una sección aparte: nunca sustituye ni bloquea la pantalla principal.
 */
export const appUsable = (_state: RecoveryState) => true

/**
 * Incorpora un diagnóstico nuevo sin cambiar el permiso de sincronización: una comparación de solo lectura nunca revoca
 * una autorización ni activa una.
 */
export function mergeDiagnostic(previous: RecoveryState, report: RecoveryReport, local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, needsReview: boolean): RecoveryState {
  const fresh = afterDiagnostic(report, local, remote, needsReview)
  return previous.phase === 'authorized' || previous.phase === 'local-only' ? { ...fresh, phase: previous.phase } : fresh
}
