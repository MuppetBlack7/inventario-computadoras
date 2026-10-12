import { openDB, type DBSchema } from 'idb'
import type { ComputerRecord, InventorySession, SyncQueueItem, SyncStatus } from './types'
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

const queueKey = (operation: SyncQueueItem['operation'], entityId: string) =>
  `${operation.includes('session') ? 'session' : 'computer'}:${entityId}`

const queueItem = (operation: SyncQueueItem['operation'], entityId: string, ownerId?: string, remoteId?: string, photoFileId?: string, previous?: SyncQueueItem): SyncQueueItem => ({
  id: queueKey(operation, entityId),
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
  retryable: undefined
})

const sameQueueRevision = (current: SyncQueueItem | undefined, expected: SyncQueueItem) =>
  Boolean(current) && (expected.revision ? current?.revision === expected.revision : current?.createdAt === expected.createdAt && current?.operation === expected.operation)

export async function listSessions() {
  const database = await getDatabase()
  return (await database.getAll('sessions')).sort((a, b) => b.date.localeCompare(a.date))
}

export async function listVisibleSessions(ownerId: string | null) {
  return ownerId ? listSessions() : []
}

export async function saveSession(session: InventorySession, enqueue = true) {
  const database = await getDatabase()
  const prepared = enqueue ? { ...session, syncStatus: 'local' as const, syncError: undefined, updatedAt: new Date().toISOString() } : session
  const transaction = database.transaction(['sessions', 'syncQueue'], 'readwrite')
  await transaction.objectStore('sessions').put(prepared)
  if (enqueue) {
    const queue = transaction.objectStore('syncQueue')
    const previous = await queue.get(queueKey('upsert-session', prepared.id))
    await queue.put(queueItem('upsert-session', prepared.id, prepared.ownerId, prepared.cloudId, undefined, previous))
  }
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
      await queue.put(queueItem('delete-computer', computer.id, ownerId, computer.cloudId, computer.photoRemote?.fileId, previous))
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

export async function saveComputer(computer: ComputerRecord, enqueue = true) {
  const prepared: ComputerRecord = {
    ...computer,
    inventoryNormalized: normalizeKey(computer.inventoryId),
    serialNormalized: normalizeKey(computer.serialNumber),
    updatedAt: enqueue ? new Date().toISOString() : computer.updatedAt,
    syncStatus: enqueue ? 'local' : computer.syncStatus,
    syncError: enqueue ? undefined : computer.syncError
  }
  const database = await getDatabase()
  const transaction = database.transaction(['computers', 'syncQueue'], 'readwrite')
  await transaction.objectStore('computers').put(prepared)
  if (enqueue) {
    const queue = transaction.objectStore('syncQueue')
    const previous = await queue.get(queueKey('upsert-computer', prepared.id))
    await queue.put(queueItem('upsert-computer', prepared.id, prepared.ownerId, prepared.cloudId, prepared.photoRemote?.fileId, previous))
  }
  await transaction.done
  return prepared
}

export async function deleteComputer(id: string, ownerId?: string, enqueue = true) {
  const database = await getDatabase()
  const existing = await database.get('computers', id)
  const transaction = database.transaction(['computers', 'syncQueue'], 'readwrite')
  await transaction.objectStore('computers').delete(id)
  if (enqueue) {
    const queue = transaction.objectStore('syncQueue')
    const key = queueKey('delete-computer', id)
    const previous = await queue.get(key)
    await queue.put(queueItem('delete-computer', id, ownerId, existing?.cloudId, existing?.photoRemote?.fileId, previous))
  }
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

export async function completeComputerSync(item: SyncQueueItem, cloudId: string, changes: Partial<ComputerRecord> = {}) {
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
  const computer = await database.get('computers', id)
  if (!computer) return
  await database.put('computers', { ...computer, syncStatus: status, syncError: error, cloudId: cloudId || computer.cloudId, photoPath: photoPath || computer.photoPath, sharedCloud: sharedCloud ?? computer.sharedCloud })
}

export async function updateComputerPhotoState(id: string, changes: Partial<Pick<ComputerRecord, 'photoRemote' | 'photoNeedsUpload' | 'photoUploadStatus' | 'photoUploadError'>>) {
  const database = await getDatabase()
  const computer = await database.get('computers', id)
  if (!computer) return
  await database.put('computers', { ...computer, ...changes })
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
