import type { RecoveryReport } from './recovery'
import type { SyncStatus } from './types'

export const MAX_VERIFICATION_AGE_MS = 10 * 60 * 1000

export interface SyncDisplayInput {
  online: boolean
  paused: boolean
  pending: number
  failedOperations: number
  photoProblems: number
  syncStatus: SyncStatus
  report?: RecoveryReport
  /** Hubo cambios locales o remotos después de la última comparación. */
  invalidated?: boolean
  now?: number
}

export interface SyncDisplay {
  title: string
  detail: string
  tone: SyncStatus
  dataCurrent: boolean
  paused: boolean
  /** Fotografías que solo otra cuenta puede subir: advertencia independiente, nunca cambios pendientes propios. */
  foreignPhotos: number
  warning?: string
}

/** Solo interpreta el último diagnóstico y los contadores actuales; no lee ni modifica datos. */
export function computeSyncDisplay(input: SyncDisplayInput): SyncDisplay {
  const now = input.now ?? Date.now()
  const checkedAt = input.report ? Date.parse(input.report.generatedAt) : NaN
  const recent = Number.isFinite(checkedAt) && checkedAt <= now + 60_000 && now - checkedAt <= MAX_VERIFICATION_AGE_MS
  const remoteVerified = input.report?.remoteAvailable === true && recent && !input.invalidated
  const conflicts = Boolean(input.report?.rows.some((row) => row.categories.includes('manual-review') || row.categories.includes('probable-duplicate') || row.categories.includes('different') || row.categories.includes('owner-mismatch') || row.categories.includes('owner-missing')))
  const unmirrored = Boolean(input.report?.rows.some((row) => row.categories.includes('local-only') || row.categories.includes('remote-only') || row.categories.includes('remote-unavailable')))
  const photoRows = input.report?.rows.filter((row) => row.categories.includes('photo-pending')) ?? []
  // Solo las fotografías de mi cuenta se pueden enviar; las de otras cuentas son una advertencia aparte.
  const pendingPhotos = photoRows.filter((row) => row.categories.includes('own-record')).length
  const foreignPhotos = photoRows.length - pendingPhotos
  const warning = foreignPhotos ? (foreignPhotos === 1 ? '1 fotografía pertenece a otra cuenta: solo su propietario puede recuperarla.' : `${foreignPhotos} fotografías pertenecen a otras cuentas: solo sus propietarios pueden recuperarlas.`) : undefined
  const hasPending = input.pending > 0 || input.photoProblems > 0 || pendingPhotos > 0
  const visiblePending = input.pending || pendingPhotos || input.photoProblems
  const pendingLabel = `${visiblePending} ${visiblePending === 1 ? 'cambio pendiente' : 'cambios pendientes'}`
  const hasErrors = input.failedOperations > 0 || input.syncStatus === 'error'
  const dataCurrent = input.online && remoteVerified && !hasPending && !hasErrors && !conflicts && !unmirrored
  const pause = input.paused ? 'Sincronización pausada' : 'Sincronización automática activa'

  if (!input.online) return { title: 'Sin conexión', detail: `${pause}${hasPending ? ` · ${pendingLabel}` : ''}`, tone: 'local', dataCurrent: false, paused: input.paused, foreignPhotos, warning }
  if (input.report && !input.report.remoteAvailable) return { title: 'Estado remoto sin verificar', detail: `${pause}${hasPending ? ` · ${pendingLabel}` : ''}`, tone: 'error', dataCurrent: false, paused: input.paused, foreignPhotos, warning }
  if (hasPending) return { title: 'Cambios pendientes', detail: `${pause} · ${input.pending} operaciones sin enviar${pendingPhotos ? ` · ${pendingPhotos} fotos pendientes` : ''}${input.photoProblems ? ` · ${input.photoProblems} fotos con problema` : ''}${hasErrors ? ' · hay errores' : ''}`, tone: hasErrors ? 'error' : 'local', dataCurrent: false, paused: input.paused, foreignPhotos, warning }
  if (hasErrors) return { title: 'Error de sincronización', detail: `${pause} · revisa el último intento`, tone: 'error', dataCurrent: false, paused: input.paused, foreignPhotos, warning }
  if (conflicts || unmirrored) return { title: 'Revisión necesaria', detail: `${pause} · hay diferencias sin resolver`, tone: 'local', dataCurrent: false, paused: input.paused, foreignPhotos, warning }
  if (dataCurrent) return { title: 'Sincronizado', detail: `${pause} · datos al día`, tone: 'synced', dataCurrent: true, paused: input.paused, foreignPhotos, warning }
  if (input.syncStatus === 'syncing' && !input.paused) return { title: 'Sincronizando…', detail: pause, tone: 'syncing', dataCurrent: false, paused: input.paused, foreignPhotos, warning }
  return { title: input.paused ? 'Sincronización pausada' : 'Estado sin verificar', detail: 'No hay una comparación reciente con Firebase que confirme los datos', tone: 'local', dataCurrent: false, paused: input.paused, foreignPhotos, warning }
}
