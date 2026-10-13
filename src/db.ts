import { openDB, type DBSchema, type IDBPObjectStore, type IDBPTransaction } from 'idb'
import type { ComputerRecord, ImageKitPhotoReference, InventorySession, PhotoCleanupReason, SyncQueueItem, SyncStatus } from './types'
import { normalizeKey } from './utils'

interface InventoryDB extends DBSchema {
  sessions: {
    key: string
    value: InventorySession
    indexes: { 'by-date': string }
  }
  computers: {
    key: string
    value: ComputerRecord
    indexes: {
      'by-session': string
      'by-serial': string
      'by-inventory': string
    }
  }
  syncQueue: {
    key: string
    value: SyncQueueItem
    indexes: { 'by-created': string }
  }
}

const DB_NAME = 'inventario-computadoras-db'

export const getDatabase = () =>
  openDB<InventoryDB>(DB_NAME, 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const sessions = database.createObjectStore('sessions', { keyPath: 'id' })
        sessions.createIndex('by-date', 'date')
        const computers = database.createObjectStore('computers', { keyPath: 'id' })
        computers.createIndex('by-session', 'sessionId')
        computers.createIndex('by-serial', 'serialNormalized')
        computers.createIndex('by-inventory', 'inventoryNormalized')
      }
      if (oldVersion < 2) {
        const queue = database.createObjectStore('syncQueue', { keyPath: 'id' })
        queue.createIndex('by-created', 'createdAt')
      }
    }
  })

const queueKey = (operation: SyncQueueItem['operation'], entityId: string, photoFileId?: string) =>
  operation === 'cleanup-photo'
    ? `photo:${photoFileId || entityId}`
    : `${operation.includes('session') ? 'session' : 'computer'}:${entityId}`

const queueItem = (operation: SyncQueueItem['operation'], entityId: string, ownerId?: string, remoteId?: string, photoFileId?: string, previous?: SyncQueueItem, extras: Partial<SyncQueueItem> = {}): SyncQueueItem => ({
  id: queueKey(operation, entityId, photoFileId),
  operation,
  entityId,
  remoteId,
  ownerId,
  photoFileId,
  createdAt: previous?.createdAt || new Date().toISOString(),
  revision: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
  attempts: 0,
  nextAttemptAt: undefined,
  lastError: undefined,
  retryable: undefined,
  ...extras
})

const sameQueueRevision = (current: SyncQueueItem | undefined, expected: SyncQueueItem) =>
  Boolean(current) && (expected.revision ? current?.revision === expected.revision : current?.createdAt === expected.createdAt && current?.operation === expected.operation)

/** Error de guardado local con un mensaje seguro para mostrar al usuario. */
export class LocalSaveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LocalSaveError'
  }
}

const sniffImageType = (bytes: Uint8Array) => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}

/**
 * Lee los bytes de la fotografía y devuelve un Blob nuevo, en memoria y sin vínculo con su origen.
 * Un Blob que proviene de un archivo (File de la cámara) o de una lectura previa de IndexedDB conserva una
 * referencia a su almacenamiento original; si ese origen ya no es legible, el navegador falla al guardarlo con
 * "Error preparing Blob/File data to be stored in object store". Leerlo antes de abrir la transacción evita
 * ese fallo a mitad de la escritura y permite informar el problema con claridad.
 */
export async function preparePhotoForStorage(photo: Blob): Promise<Blob> {
  if (!(photo instanceof Blob)) throw new LocalSaveError('La fotografía no tiene un formato válido. Vuelve a tomarla o adjuntarla.')
  let buffer: ArrayBuffer
  try {
    buffer = await photo.arrayBuffer()
  } catch (cause) {
    throw new LocalSaveError('No se pudo leer la fotografía en este dispositivo. Vuelve a tomarla o adjuntarla e inténtalo de nuevo.', { cause })
  }
  if (!buffer.byteLength) throw new LocalSaveError('La fotografía está vacía. Vuelve a tomarla o adjuntarla.')
  const type = photo.type || sniffImageType(new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength)))
  if (!type) throw new LocalSaveError('El archivo seleccionado no es una imagen compatible.')
  return new Blob([buffer], { type })
}

const describeStorageFailure = (error: unknown) => {
  if (error instanceof LocalSaveError) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'QuotaExceededError') return new LocalSaveError('No hay espacio suficiente en el dispositivo para guardar el registro.', { cause: error })
  const detail = error instanceof Error ? error.message : 'error desconocido'
  return new LocalSaveError(`El navegador no pudo guardar el registro en este dispositivo (${detail}).`, { cause: error })
}

export async function listSessions() {
  const database = await getDatabase()
  return (await database.getAll('sessions')).sort((a, b) => b.date.localeCompare(a.date))
}

export async function listVisibleSessions(ownerId: string | null) {
  return ownerId ? listSessions() : []
}

type QueueStore = Pick<IDBPObjectStore<InventoryDB, ['syncQueue'], 'syncQueue', 'readwrite'>, 'get' | 'put'>

const enqueueSessionUpsert = async (queue: QueueStore, prepared: InventorySession) => {
  const previous = await queue.get(queueKey('upsert-session', prepared.id))
  await queue.put(queueItem('upsert-session', prepared.id, prepared.ownerId, prepared.cloudId, undefined, previous))
}

const prepareSession = (session: InventorySession): InventorySession =>
  ({ ...session, syncStatus: 'local' as const, syncError: undefined, updatedAt: new Date().toISOString() })

export async function saveSession(session: InventorySession, enqueue = true) {
  const database = await getDatabase()
  const prepared = enqueue ? prepareSession(session) : session
  const transaction = database.transaction(['sessions', 'syncQueue'], 'readwrite')
  await transaction.objectStore('sessions').put(prepared)
  if (enqueue) await enqueueSessionUpsert(transaction.objectStore('syncQueue'), prepared)
  await transaction.done
  return prepared
}

export async function deleteSessionAndComputers(sessionId: string, ownerId?: string, enqueue = true) {
  const database = await getDatabase()
  const existingSession = await database.get('sessions', sessionId)
  const existingComputers = await database.getAllFromIndex('computers', 'by-session', sessionId)
  const transaction = database.transaction(['sessions', 'computers', 'syncQueue'], 'readwrite')
  await transaction.objectStore('sessions').delete(sessionId)
  const computerKeys = await transaction.objectStore('computers').index('by-session').getAllKeys(sessionId)
  await Promise.all(computerKeys.map((key) => transaction.objectStore('computers').delete(key)))
  if (enqueue) {
    const queue = transaction.objectStore('syncQueue')
    for (const computer of existingComputers) {
      const key = queueKey('delete-computer', computer.id)
      const previous = await queue.get(key)
      await queue.put(queueItem('delete-computer', computer.id, ownerId, computer.cloudId, computer.photoRemote?.fileId, previous, { sessionId }))
      if (computer.photoRemote?.fileId) {
        const cleanupKey = queueKey('cleanup-photo', computer.id, computer.photoRemote.fileId)
        const previousCleanup = await queue.get(cleanupKey)
        await queue.put(queueItem('cleanup-photo', computer.id, ownerId, computer.cloudId, computer.photoRemote.fileId, previousCleanup, {
          sessionId,
          cleanupReason: 'deleted-computer',
          blockedByQueueItemId: key
        }))
      }
    }
    // Los equipos se eliminan antes que la sesión remota para no dejar registros huérfanos si se interrumpe la sincronización.
    const sessionKey = queueKey('delete-session', sessionId)
    const previous = await queue.get(sessionKey)
    await queue.put(queueItem('delete-session', sessionId, ownerId, existingSession?.cloudId, undefined, previous))
  }
  await transaction.done
}

export async function listComputers(sessionId?: string) {
  const database = await getDatabase()
  const computers = sessionId
    ? await database.getAllFromIndex('computers', 'by-session', sessionId)
    : await database.getAll('computers')
  return computers.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function listVisibleComputers(ownerId: string | null, sessionId?: string) {
  return ownerId ? listComputers(sessionId) : []
}

export async function getComputer(id: string) {
  const database = await getDatabase()
  return database.get('computers', id)
}

const buildPreparedComputer = (computer: ComputerRecord, photo: Blob | undefined, enqueue: boolean): ComputerRecord => {
  const localPhotoRevision = computer.photoNeedsUpload && photo
    ? computer.photoLocalRevision || crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`
    : computer.photoLocalRevision
  return {
    ...computer,
    photo,
    inventoryNormalized: normalizeKey(computer.inventoryId),
    serialNormalized: normalizeKey(computer.serialNumber),
    updatedAt: enqueue ? new Date().toISOString() : computer.updatedAt,
    syncStatus: enqueue ? 'local' : computer.syncStatus,
    syncError: enqueue ? undefined : computer.syncError,
    photoLocalRevision: localPhotoRevision
  }
}

const enqueueComputerUpsert = async (queue: QueueStore, prepared: ComputerRecord) => {
  const previous = await queue.get(queueKey('upsert-computer', prepared.id))
  const samePhoto = previous?.photoCandidate && previous.photoSourceRevision === prepared.photoLocalRevision
  const next = queueItem('upsert-computer', prepared.id, prepared.ownerId, prepared.cloudId, prepared.photoRemote?.fileId, previous, {
    sessionId: prepared.sessionId,
    photoCandidate: samePhoto ? previous.photoCandidate : undefined,
    photoSourceRevision: samePhoto ? previous.photoSourceRevision : prepared.photoLocalRevision
  })
  await queue.put(next)
  if (previous?.photoCandidate && !samePhoto) {
    const cleanupKey = queueKey('cleanup-photo', prepared.id, previous.photoCandidate.fileId)
    const previousCleanup = await queue.get(cleanupKey)
    await queue.put(queueItem('cleanup-photo', prepared.id, prepared.ownerId, prepared.cloudId, previous.photoCandidate.fileId, previousCleanup, {
      sessionId: prepared.sessionId,
      cleanupReason: 'orphan-upload',
      blockedByQueueItemId: next.id
    }))
  }
}

export async function saveComputer(computer: ComputerRecord, enqueue = true) {
  // La fotografía se valida y se copia a un Blob propio antes de abrir la transacción.
  const photo = computer.photo ? await preparePhotoForStorage(computer.photo) : undefined
  const prepared = buildPreparedComputer(computer, photo, enqueue)
  let transaction: IDBPTransaction<InventoryDB, ['computers', 'syncQueue'], 'readwrite'> | undefined
  try {
    const database = await getDatabase()
    transaction = database.transaction(['computers', 'syncQueue'], 'readwrite')
    const done = transaction.done
    done.catch(() => undefined)
    await transaction.objectStore('computers').put(prepared)
    if (enqueue) await enqueueComputerUpsert(transaction.objectStore('syncQueue'), prepared)
    // Solo se considera guardado cuando la transacción termina; si falla, el registro y la cola no cambian.
    await done
  } catch (error) {
    try { transaction?.abort() } catch { /* la transacción ya terminó o se abortó */ }
    throw describeStorageFailure(error)
  }
  return prepared
}

const enqueueComputerDelete = async (queue: QueueStore, id: string, ownerId: string | undefined, existing: ComputerRecord | undefined) => {
  const key = queueKey('delete-computer', id)
  const previous = await queue.get(key)
  await queue.put(queueItem('delete-computer', id, ownerId, existing?.cloudId, existing?.photoRemote?.fileId, previous, { sessionId: existing?.sessionId }))
  if (existing?.photoRemote?.fileId) {
    const cleanupKey = queueKey('cleanup-photo', id, existing.photoRemote.fileId)
    const previousCleanup = await queue.get(cleanupKey)
    await queue.put(queueItem('cleanup-photo', id, ownerId, existing.cloudId, existing.photoRemote.fileId, previousCleanup, {
      sessionId: existing.sessionId,
      cleanupReason: 'deleted-computer',
      blockedByQueueItemId: key
    }))
  }
}

export async function deleteComputer(id: string, ownerId?: string, enqueue = true) {
  const database = await getDatabase()
  const existing = await database.get('computers', id)
  const transaction = database.transaction(['computers', 'syncQueue'], 'readwrite')
  await transaction.objectStore('computers').delete(id)
  if (enqueue) await enqueueComputerDelete(transaction.objectStore('syncQueue'), id, ownerId, existing)
  await transaction.done
}

export async function findDuplicates(inventoryId: string, serialNumber: string, excludeId?: string) {
  const database = await getDatabase()
  const found = new Map<string, ComputerRecord>()
  const serial = normalizeKey(serialNumber)
  const inventory = normalizeKey(inventoryId)
  if (serial) {
    for (const computer of await database.getAllFromIndex('computers', 'by-serial', serial)) {
      if (computer.id !== excludeId) found.set(computer.id, computer)
    }
  }
  if (inventory) {
    for (const computer of await database.getAllFromIndex('computers', 'by-inventory', inventory)) {
      if (computer.id !== excludeId) found.set(computer.id, computer)
    }
  }
  return [...found.values()]
}

export const PHOTO_FIELDS = ['photo', 'photoName', 'photoRemote', 'photoStoredLocally', 'photoNeedsUpload', 'photoUploadStatus', 'photoUploadError', 'photoLocalRevision', 'photoPath'] as const

export interface RestoreBatch {
  sessions: Array<{ record: InventorySession; expectedUpdatedAt: string | null }>
  computers: Array<{
    /** Sin campos de fotografía: se conservan los del registro actual salvo que `photoFields` o `photo` indiquen una nueva. */
    record: ComputerRecord
    photo?: Blob
    photoFields?: Partial<ComputerRecord>
    expectedUpdatedAt: string | null
  }>
  deletes: Array<{ id: string; expectedUpdatedAt: string; ownerId: string }>
}

export interface RestoreBatchResult {
  sessions: Array<{ id: string; created: boolean }>
  computers: Array<{ id: string; created: boolean }>
  deleted: Array<{ id: string; remoteId?: string }>
  /** Registros que cambiaron localmente entre la vista previa y la escritura; se conservaron intactos. */
  changedMeanwhile: Array<{ kind: 'session' | 'computer'; id: string }>
  queuedIds: string[]
}

/**
 * Aplica una restauración en una sola transacción: registros, borrados y cola de sincronización cambian juntos o no cambian.
 * No toca operaciones pendientes de otros registros y respeta los cambios locales posteriores a la vista previa.
 */
export async function applyRestoreBatch(batch: RestoreBatch): Promise<RestoreBatchResult> {
  const result: RestoreBatchResult = { sessions: [], computers: [], deleted: [], changedMeanwhile: [], queuedIds: [] }
  const database = await getDatabase()
  const transaction = database.transaction(['sessions', 'computers', 'syncQueue'], 'readwrite')
  transaction.done.catch(() => undefined)
  try {
    const queue = transaction.objectStore('syncQueue')
    const stale = (current: { updatedAt: string } | undefined, expected: string | null) =>
      expected === null ? Boolean(current) : current?.updatedAt !== expected
    for (const entry of batch.sessions) {
      const current = await transaction.objectStore('sessions').get(entry.record.id)
      if (stale(current, entry.expectedUpdatedAt)) { result.changedMeanwhile.push({ kind: 'session', id: entry.record.id }); continue }
      const prepared = prepareSession(entry.record)
      await transaction.objectStore('sessions').put(prepared)
      await enqueueSessionUpsert(queue, prepared)
      result.sessions.push({ id: prepared.id, created: !current })
      result.queuedIds.push(queueKey('upsert-session', prepared.id))
    }
    for (const entry of batch.computers) {
      const current = await transaction.objectStore('computers').get(entry.record.id)
      if (stale(current, entry.expectedUpdatedAt)) { result.changedMeanwhile.push({ kind: 'computer', id: entry.record.id }); continue }
      const photoState: Record<string, unknown> = {}
      if (current) for (const field of PHOTO_FIELDS) photoState[field] = current[field]
      const merged = { ...entry.record, ...photoState, ...entry.photoFields } as ComputerRecord
      const prepared = buildPreparedComputer(merged, entry.photo ?? merged.photo, true)
      await transaction.objectStore('computers').put(prepared)
      await enqueueComputerUpsert(queue, prepared)
      result.computers.push({ id: prepared.id, created: !current })
      result.queuedIds.push(queueKey('upsert-computer', prepared.id))
    }
    for (const entry of batch.deletes) {
      const current = await transaction.objectStore('computers').get(entry.id)
      if (!current) continue
      if (stale(current, entry.expectedUpdatedAt)) { result.changedMeanwhile.push({ kind: 'computer', id: entry.id }); continue }
      await transaction.objectStore('computers').delete(entry.id)
      await enqueueComputerDelete(queue, entry.id, entry.ownerId, current)
      result.deleted.push({ id: entry.id, remoteId: current.cloudId })
      result.queuedIds.push(queueKey('delete-computer', entry.id))
    }
    await transaction.done
  } catch (error) {
    try { transaction.abort() } catch { /* ya terminó */ }
    throw describeStorageFailure(error)
  }
  return result
}

export async function replaceAllData(sessions: InventorySession[], computers: ComputerRecord[]) {
  const database = await getDatabase()
  const transaction = database.transaction(['sessions', 'computers', 'syncQueue'], 'readwrite')
  await Promise.all([
    transaction.objectStore('sessions').clear(),
    transaction.objectStore('computers').clear(),
    transaction.objectStore('syncQueue').clear()
  ])
  for (const session of sessions) await transaction.objectStore('sessions').put(session)
  for (const computer of computers) await transaction.objectStore('computers').put(computer)
  await transaction.done
}

export async function mergeAllData(sessions: InventorySession[], computers: ComputerRecord[]) {
  const database = await getDatabase()
  const transaction = database.transaction(['sessions', 'computers'], 'readwrite')
  for (const session of sessions) await transaction.objectStore('sessions').put(session)
  for (const computer of computers) await transaction.objectStore('computers').put(computer)
  await transaction.done
}

export async function clearAllData() {
  await replaceAllData([], [])
}

export async function getPendingSyncQueue() {
  const database = await getDatabase()
  return database.getAllFromIndex('syncQueue', 'by-created')
}

export async function removeSyncQueueItem(id: string) {
  const database = await getDatabase()
  await database.delete('syncQueue', id)
}

export async function completeSessionSync(item: SyncQueueItem, cloudId: string) {
  const database = await getDatabase()
  const transaction = database.transaction(['sessions', 'syncQueue'], 'readwrite')
  const queue = transaction.objectStore('syncQueue')
  const current = await queue.get(item.id)
  if (!sameQueueRevision(current, item)) {
    await transaction.done
    return false
  }
  const session = await transaction.objectStore('sessions').get(item.entityId)
  if (session) await transaction.objectStore('sessions').put({ ...session, syncStatus: 'synced', syncError: undefined, cloudId, sharedCloud: true })
  await queue.delete(item.id)
  await transaction.done
  return true
}

export async function completeComputerSync(item: SyncQueueItem, cloudId: string, changes: Partial<ComputerRecord> = {}, cleanupFileIds: string[] = []) {
  const database = await getDatabase()
  const transaction = database.transaction(['computers', 'syncQueue'], 'readwrite')
  const queue = transaction.objectStore('syncQueue')
  const current = await queue.get(item.id)
  if (!sameQueueRevision(current, item)) {
    await transaction.done
    return false
  }
  const computer = await transaction.objectStore('computers').get(item.entityId)
  if (computer) await transaction.objectStore('computers').put({ ...computer, ...changes, syncStatus: 'synced', syncError: undefined, cloudId, sharedCloud: true })
  for (const fileId of new Set(cleanupFileIds.filter(Boolean))) {
    if (changes.photoRemote?.fileId === fileId) continue
    const cleanupKey = queueKey('cleanup-photo', item.entityId, fileId)
    const previousCleanup = await queue.get(cleanupKey)
    await queue.put(queueItem('cleanup-photo', item.entityId, item.ownerId, cloudId, fileId, previousCleanup, {
      sessionId: computer?.sessionId || item.sessionId,
      cleanupReason: 'replaced-photo'
    }))
  }
  await queue.delete(item.id)
  await transaction.done
  return true
}

export async function completeDeleteSync(item: SyncQueueItem) {
  const database = await getDatabase()
  const transaction = database.transaction('syncQueue', 'readwrite')
  const queue = transaction.objectStore('syncQueue')
  const current = await queue.get(item.id)
  if (!sameQueueRevision(current, item)) {
    await transaction.done
    return false
  }
  await queue.delete(item.id)
  await transaction.done
  return true
}

export async function isSyncQueueItemCurrent(item: SyncQueueItem) {
  const database = await getDatabase()
  return sameQueueRevision(await database.get('syncQueue', item.id), item)
}

export async function savePhotoCandidate(item: SyncQueueItem, photoCandidate: ImageKitPhotoReference, photoSourceRevision?: string) {
  const database = await getDatabase()
  const transaction = database.transaction('syncQueue', 'readwrite')
  const queue = transaction.objectStore('syncQueue')
  const current = await queue.get(item.id)
  if (sameQueueRevision(current, item)) {
    await queue.put({ ...current!, photoCandidate, photoSourceRevision })
    await transaction.done
    return true
  }
  const cleanupKey = queueKey('cleanup-photo', item.entityId, photoCandidate.fileId)
  const previousCleanup = await queue.get(cleanupKey)
  await queue.put(queueItem('cleanup-photo', item.entityId, item.ownerId, item.remoteId, photoCandidate.fileId, previousCleanup, {
    sessionId: item.sessionId,
    cleanupReason: 'orphan-upload',
    blockedByQueueItemId: current?.operation === 'upsert-computer' ? current.id : undefined
  }))
  await transaction.done
  return false
}

export async function queuePhotoCleanup(input: {
  entityId: string
  remoteId?: string
  sessionId?: string
  ownerId?: string
  fileId: string
  reason: PhotoCleanupReason
  blockedByQueueItemId?: string
}) {
  const database = await getDatabase()
  const transaction = database.transaction(['computers', 'syncQueue'], 'readwrite')
  const activeReferences = (await transaction.objectStore('computers').getAll()).filter((computer) => computer.photoRemote?.fileId === input.fileId)
  if (activeReferences.length && !input.blockedByQueueItemId) {
    await transaction.done
    return false
  }
  const queue = transaction.objectStore('syncQueue')
  const key = queueKey('cleanup-photo', input.entityId, input.fileId)
  const previous = await queue.get(key)
  await queue.put(queueItem('cleanup-photo', input.entityId, input.ownerId, input.remoteId, input.fileId, previous, {
    sessionId: input.sessionId,
    cleanupReason: input.reason,
    blockedByQueueItemId: input.blockedByQueueItemId
  }))
  await transaction.done
  return true
}

export async function markSyncQueueFailure(item: SyncQueueItem, message: string, nextAttemptAt: string, retryable: boolean) {
  const database = await getDatabase()
  const transaction = database.transaction('syncQueue', 'readwrite')
  const queue = transaction.objectStore('syncQueue')
  const current = await queue.get(item.id)
  if (!sameQueueRevision(current, item)) {
    await transaction.done
    return false
  }
  await queue.put({ ...current!, attempts: (current?.attempts || 0) + 1, nextAttemptAt, lastError: message, retryable })
  await transaction.done
  return true
}

export async function updateSessionSyncState(id: string, status: SyncStatus, error?: string, cloudId?: string, sharedCloud?: boolean) {
  const database = await getDatabase()
  const session = await database.get('sessions', id)
  if (!session) return
  await database.put('sessions', { ...session, syncStatus: status, syncError: error, cloudId: cloudId || session.cloudId, sharedCloud: sharedCloud ?? session.sharedCloud })
}

export async function updateComputerSyncState(id: string, status: SyncStatus, error?: string, cloudId?: string, photoPath?: string, sharedCloud?: boolean) {
  const database = await getDatabase()
  const transaction = database.transaction('computers', 'readwrite')
  const computer = await transaction.store.get(id)
  if (computer) await transaction.store.put({ ...computer, syncStatus: status, syncError: error, cloudId: cloudId || computer.cloudId, photoPath: photoPath || computer.photoPath, sharedCloud: sharedCloud ?? computer.sharedCloud })
  await transaction.done
}

export async function updateComputerPhotoState(id: string, changes: Partial<Pick<ComputerRecord, 'photoRemote' | 'photoNeedsUpload' | 'photoUploadStatus' | 'photoUploadError'>>) {
  const database = await getDatabase()
  const transaction = database.transaction('computers', 'readwrite')
  const computer = await transaction.store.get(id)
  if (computer) await transaction.store.put({ ...computer, ...changes })
  await transaction.done
}

export async function queueLocalPhotoMigrations(ownerId: string) {
  const computers = await listComputers()
  let queued = 0
  for (const computer of computers.filter((item) => item.ownerId === ownerId && item.photo && !item.photoRemote)) {
    await saveComputer({ ...computer, photoNeedsUpload: true, photoUploadStatus: 'pending', photoUploadError: undefined }, true)
    queued += 1
  }
  return queued
}

/**
 * Vuelve a encolar la subida de fotografías locales que no tienen operación pendiente (por ejemplo, las que quedaron
 * esperando mientras ImageKit no estaba configurado o tras restaurar un respaldo). No modifica los registros ni
 * su fecha de edición, y no duplica operaciones ya encoladas.
 */
export async function queuePendingPhotoUploads(ownerId: string, exclude: ReadonlySet<string> = new Set()) {
  const database = await getDatabase()
  const transaction = database.transaction(['computers', 'syncQueue'], 'readwrite')
  const queue = transaction.objectStore('syncQueue')
  let queued = 0
  let cursor = await transaction.objectStore('computers').openCursor()
  while (cursor) {
    const computer = cursor.value
    const needsUpload = Boolean(computer.photo) && (computer.photoNeedsUpload || !computer.photoRemote)
    if (computer.ownerId === ownerId && needsUpload && !exclude.has(computer.id) && !(computer.cloudId && exclude.has(computer.cloudId)) && !await queue.get(queueKey('upsert-computer', computer.id))) {
      await enqueueComputerUpsert(queue, computer)
      queued += 1
    }
    cursor = await cursor.continue()
  }
  await transaction.done
  return queued
}

/**
 * Prepara la subida de registros PROPIOS que no tienen operación pendiente (por ejemplo, equipos solo locales): crea la operación
 * en la cola local. No modifica el registro ni su fecha, no toca registros de otras cuentas y no repite una operación ya encolada.
 * No escribe en Firestore: la operación se ejecuta después, con confirmación.
 */
export async function enqueueOwnUploads(ownerId: string, ids: readonly string[]) {
  const database = await getDatabase()
  const transaction = database.transaction(['sessions', 'computers', 'syncQueue'], 'readwrite')
  const queue = transaction.objectStore('syncQueue')
  let queued = 0
  for (const id of new Set(ids)) {
    const computer = await transaction.objectStore('computers').get(id)
    if (computer) {
      if (computer.ownerId === ownerId && !await queue.get(queueKey('upsert-computer', id)) && !await queue.get(queueKey('delete-computer', id))) {
        await enqueueComputerUpsert(queue, computer)
        queued += 1
      }
      continue
    }
    const session = await transaction.objectStore('sessions').get(id)
    if (session && session.ownerId === ownerId && !await queue.get(queueKey('upsert-session', id)) && !await queue.get(queueKey('delete-session', id))) {
      await enqueueSessionUpsert(queue, session)
      queued += 1
    }
  }
  await transaction.done
  return queued
}

/**
 * Las siguientes funciones aplican datos descargados de Firestore dentro de UNA transacción que también consulta la cola.
 * Así, una edición o un borrado local hecho mientras se descargaba (después de leer la cola) nunca se sobrescribe con datos
 * remotos antiguos. Devuelven false cuando el registro tiene una operación local pendiente y se conserva intacto.
 */
const pendingFor = async (queue: QueueStore, kind: 'session' | 'computer', ids: Array<string | undefined>) => {
  for (const id of ids) if (id && await queue.get(`${kind}:${id}`)) return true
  return false
}

export async function applyRemoteSession(remote: InventorySession) {
  const database = await getDatabase()
  const transaction = database.transaction(['sessions', 'syncQueue'], 'readwrite')
  if (await pendingFor(transaction.objectStore('syncQueue'), 'session', [remote.id, remote.cloudId])) {
    await transaction.done
    return false
  }
  await transaction.objectStore('sessions').put({ ...remote, sharedCloud: true, syncStatus: 'synced', syncError: undefined })
  await transaction.done
  return true
}

export async function applyRemoteComputer(remote: ComputerRecord) {
  const database = await getDatabase()
  const transaction = database.transaction(['computers', 'syncQueue'], 'readwrite')
  if (await pendingFor(transaction.objectStore('syncQueue'), 'computer', [remote.id, remote.cloudId])) {
    await transaction.done
    return false
  }
  const current = await transaction.objectStore('computers').get(remote.id)
  // La fotografía local solo se conserva si espera subirse o es la misma que ya referencia Firestore.
  // Si el documento remoto no tiene referencia de fotografía, nunca se descartan los bytes locales ni la referencia local:
  // ni se marca la foto como recuperada ni se cancela una subida pendiente. Solo se reemplaza lo local cuando el remoto sí la tiene.
  const remoteLacksPhoto = !remote.photoRemote
  const keepLocalPhoto = Boolean(current?.photoNeedsUpload)
    || Boolean(current?.photoRemote?.fileId && current.photoRemote.fileId === remote.photoRemote?.fileId)
    || (remoteLacksPhoto && Boolean(current?.photo))
  const keepLocalReference = remoteLacksPhoto && Boolean(current?.photoRemote)
  const record: ComputerRecord = {
    ...remote,
    equipmentType: remote.equipmentType || '',
    sharedCloud: true,
    photoRemote: remote.photoRemote ?? (keepLocalReference ? current?.photoRemote : undefined),
    photo: keepLocalPhoto ? current?.photo : undefined,
    photoNeedsUpload: keepLocalPhoto ? current?.photoNeedsUpload : false,
    photoUploadStatus: remote.photoRemote ? 'uploaded' : keepLocalPhoto ? current?.photoUploadStatus : undefined,
    photoUploadError: keepLocalPhoto ? current?.photoUploadError : undefined,
    photoLocalRevision: keepLocalPhoto ? current?.photoLocalRevision : undefined,
    inventoryNormalized: normalizeKey(remote.inventoryId),
    serialNormalized: normalizeKey(remote.serialNumber),
    syncStatus: 'synced',
    syncError: undefined
  }
  await transaction.objectStore('computers').put(record)
  await transaction.done
  return true
}

/** Elimina el espejo local de un documento que ya no existe en Firestore, salvo que tenga una operación local pendiente. */
export async function removeRemoteMirroredComputer(id: string, cloudId?: string) {
  const database = await getDatabase()
  const transaction = database.transaction(['computers', 'syncQueue'], 'readwrite')
  if (await pendingFor(transaction.objectStore('syncQueue'), 'computer', [id, cloudId])) {
    await transaction.done
    return false
  }
  await transaction.objectStore('computers').delete(id)
  await transaction.done
  return true
}

export async function removeRemoteMirroredSession(id: string, cloudId?: string) {
  const database = await getDatabase()
  const transaction = database.transaction(['sessions', 'syncQueue'], 'readwrite')
  if (await pendingFor(transaction.objectStore('syncQueue'), 'session', [id, cloudId])) {
    await transaction.done
    return false
  }
  await transaction.objectStore('sessions').delete(id)
  await transaction.done
  return true
}

export async function deleteLocalSession(id: string) {
  const database = await getDatabase()
  await database.delete('sessions', id)
}

export async function getLocalImportPreview() {
  const [sessions, computers] = await Promise.all([listSessions(), listComputers()])
  const localSessions = sessions.filter((session) => !session.ownerId)
  const localComputers = computers.filter((computer) => !computer.ownerId)
  return {
    sessions: localSessions.length,
    computers: localComputers.length,
    photos: localComputers.filter((computer) => computer.photo).length
  }
}

export async function claimLocalData(ownerId: string, ownerName = '', ownerEmail = '') {
  const database = await getDatabase()
  const [sessions, computers] = await Promise.all([database.getAll('sessions'), database.getAll('computers')])
  for (const session of sessions.filter((item) => !item.ownerId)) {
    await saveSession({ ...session, ownerId, ownerName, ownerEmail, syncStatus: 'local' }, true)
  }
  for (const computer of computers.filter((item) => !item.ownerId)) {
    await saveComputer({ ...computer, ownerId, ownerName, ownerEmail, syncStatus: 'local' }, true)
  }
  return getLocalImportPreview()
}

export async function findComputerByCloudId(cloudId: string) {
  return (await listComputers()).find((computer) => computer.cloudId === cloudId || computer.id === cloudId)
}
