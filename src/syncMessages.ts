import type { SyncStatus } from './types'

export interface SyncResultLike { errors: number; pending: number; lastError?: string; /** Sincronización detenida a propósito: no se intentó nada. */ held?: boolean }

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Estado visible tras una sincronización: solo es «sincronizado» si no hubo errores ni quedan operaciones pendientes. */
export function statusAfterSync(result: SyncResultLike, force = false): { status: SyncStatus; message: string } {
  if (result.errors) return { status: 'error', message: `Error al sincronizar · ${result.lastError || 'Quedaron operaciones pendientes'}` }
  if (result.pending > 0) return { status: 'local', message: `${plural(result.pending, 'pendiente', 'pendientes')} de sincronizar` }
  return { status: 'synced', message: force ? 'Actualizado ahora' : 'Sincronizado' }
}

/** Aviso tras guardar o eliminar: nunca dice «sincronizado» si la sincronización no se completó o no se ejecutó. */
export function syncToast(result: SyncResultLike | undefined, labels: { synced: string; local: string; failed: string }) {
  if (result?.held) return `${labels.local}; la sincronización está detenida (modo recuperación): el cambio queda en la cola local y no se enviará hasta que la autorices`
  if (!result) return `${labels.local}; se sincronizará al recuperar la conexión`
  if (result.errors) return labels.failed
  if (result.pending > 0) return `${labels.local}; ${plural(result.pending, 'operación pendiente', 'operaciones pendientes')}`
  return labels.synced
}
