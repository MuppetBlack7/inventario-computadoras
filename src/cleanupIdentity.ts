import type { ComputerRecord } from './types'

// Campos que existen únicamente en el dispositivo o describen el estado de sincronización.
const localOnly = new Set([
  'id', 'cloudId', 'sharedCloud', 'photo', 'photoStoredLocally', 'photoNeedsUpload',
  'photoUploadStatus', 'photoUploadError', 'photoLocalRevision', 'photoPath',
  'syncStatus', 'syncError'
])

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stable(entry)])
  )
  return value
}

/** Identidad completa del documento persistente, incluidos campos nuevos no conocidos por esta versión. */
export function cleanupContent(record: ComputerRecord): string {
  return JSON.stringify(stable(Object.fromEntries(
    Object.entries(record).filter(([key, value]) => !localOnly.has(key) && value !== undefined)
  )))
}

/** Estado local que debe permanecer idéntico hasta la eliminación transaccional. */
export function cleanupLocalState(record: ComputerRecord): string {
  return JSON.stringify(stable({
    id: record.id, cloudId: record.cloudId, ownerId: record.ownerId,
    content: cleanupContent(record), photoRemote: record.photoRemote,
    photoName: record.photoName, photoLocalRevision: record.photoLocalRevision,
    photoSize: record.photo?.size ?? null, photoType: record.photo?.type ?? null,
    photoStoredLocally: record.photoStoredLocally, photoNeedsUpload: record.photoNeedsUpload,
    photoUploadStatus: record.photoUploadStatus, syncStatus: record.syncStatus
  }))
}
