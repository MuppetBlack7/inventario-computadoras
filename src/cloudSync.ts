import { collection, deleteDoc, doc, getCountFromServer, getDoc, getDocs, limit, onSnapshot, orderBy, query, setDoc, startAfter, where, type DocumentChange, type DocumentData, type QueryConstraint, type QueryDocumentSnapshot, type Unsubscribe } from 'firebase/firestore'
import {
  applyRemoteComputer,
  applyRemoteSession,
  completeComputerSync,
  completeDeleteSync,
  completeSessionSync,
  getComputer,
  getDatabase,
  getPendingSyncQueue,
  isSyncQueueItemCurrent,
  listComputers,
  listSessions,
  markSyncQueueFailure,
  removeRemoteMirroredComputer,
  removeRemoteMirroredSession,
  queuePendingPhotoUploads,
  queuePhotoCleanup,
  savePhotoCandidate,
  updateComputerPhotoState,
  updateComputerSyncState,
  updateSessionSyncState
} from './db'
import { firestore } from './firebaseClient'
import { cleanupImageKitPhoto, imageKitConfigured, uploadPhotoToImageKit } from './imageKitClient'
import type { ComputerRecord, InventorySession, SyncQueueItem, SyncStatus } from './types'

const SHARED_SESSIONS = 'inventorySessions'
const SHARED_COMPUTERS = 'inventoryComputers'

export interface SyncSummary {
  /** La sincronización está detenida a propósito (recuperación pendiente o modo local): no se intentó nada. */
  held?: boolean
  synced: number
  errors: number
  photosLocalOnly: number
  pending: number
  retryAfterMs?: number
  lastError?: string
}

export interface FullSyncSummary extends SyncSummary {
  pulled: PullStats
}

export interface RealtimeApplyStats {
  sessions: number
  computers: number
  removed: number
}

export interface CreatorIdentity {
  uid: string
  displayName?: string | null
  email?: string | null
}

export type SyncReporter = (status: SyncStatus, message: string) => void

export function describeSyncError(error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code).replace(/^firestore\//, '') : ''
  const messages: Record<string, string> = {
    'permission-denied': 'Firebase rechazó el acceso al inventario compartido.',
    unauthenticated: 'La sesión de Google ya no es válida. Vuelve a iniciar sesión.',
    unavailable: 'Firebase no está disponible temporalmente. Se reintentará al recuperar conexión.',
    'network-request-failed': 'No fue posible comunicarse con Firebase.',
    'failed-precondition': 'Firebase requiere una configuración adicional para esta consulta.'
  }
  return messages[code] || (error instanceof Error ? error.message : 'No fue posible actualizar el inventario')
}

const clean = <T extends object>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Blob || item === undefined ? undefined : item)) as T

const sessionPayload = (session: InventorySession, ownerId: string, cloudId: string) => clean({
  ...session,
  id: cloudId,
  ownerId,
  ownerName: session.ownerName || '',
  ownerEmail: session.ownerEmail || '',
  cloudId,
  sharedCloud: undefined,
  syncStatus: undefined,
  syncError: undefined
})

const computerPayload = (computer: ComputerRecord, ownerId: string, cloudId: string) => clean({
  ...computer,
  id: cloudId,
  ownerId,
  ownerName: computer.ownerName || '',
  ownerEmail: computer.ownerEmail || '',
  equipmentType: computer.equipmentType || '',
  customEquipmentType: computer.customEquipmentType || '',
  cloudId,
  sharedCloud: undefined,
  photo: undefined,
  photoStoredLocally: !computer.photoRemote && (Boolean(computer.photo) || Boolean(computer.photoStoredLocally)),
  photoNeedsUpload: undefined,
  photoUploadStatus: undefined,
  photoUploadError: undefined,
  syncStatus: undefined,
  syncError: undefined
})

async function findRemoteDuplicate(computer: ComputerRecord) {
  if (!firestore) return undefined
  const computers = collection(firestore, SHARED_COMPUTERS)
  const fields: Array<['serialNormalized' | 'inventoryNormalized', string]> = [
    ['serialNormalized', computer.serialNormalized],
    ['inventoryNormalized', computer.inventoryNormalized]
  ]
  for (const [field, value] of fields) {
    if (!value) continue
    const snapshot = await getDocs(query(computers, where(field, '==', value), limit(25)))
    // Un inventario repetido (p. ej. "NO ETIQUETADO") con series distintas corresponde a equipos distintos.
    const match = snapshot.docs.find((entry) => {
      const data = entry.data() as Partial<ComputerRecord>
      return field === 'serialNormalized' || !computer.serialNormalized || !data.serialNormalized || data.serialNormalized === computer.serialNormalized
    })
    if (match) return match.id
  }
  return undefined
}

/**
 * Alcance de una sincronización:
 * - all: todo lo propio (comportamiento normal).
 * - operations: solo operaciones propias sobre sesiones y equipos; no sube fotografías ni ejecuta limpiezas de ImageKit.
 * - photos: solo equipos propios con fotografía pendiente de subir.
 * En ningún alcance se ejecutan operaciones de otra cuenta ni sobre registros ajenos.
 */
export type SyncScope = 'all' | 'operations' | 'photos'
export interface SyncOptions {
  force?: boolean
  scope?: SyncScope
  /** Identificadores de equipos o sesiones (locales o remotos) que no deben tocarse en esta ejecución. */
  exclude?: ReadonlySet<string>
}

async function syncItem(ownerId: string, item: SyncQueueItem, scope: SyncScope = 'all') {
  if (!firestore) throw new Error('Firestore no está configurado')
  if (item.ownerId !== ownerId) return false
  // Una operación terminada tarde nunca puede ejecutar efectos sobre una revisión más nueva.
  if (!await isSyncQueueItemCurrent(item)) return false

  if (item.operation === 'upsert-session') {
    const session = (await listSessions()).find((entry) => entry.id === item.entityId)
    if (!session) return completeDeleteSync(item)
    if (session.ownerId !== ownerId) throw new Error('La sesión pendiente pertenece a otra cuenta')
    await updateSessionSyncState(session.id, 'syncing')
    const cloudId = session.cloudId || session.id
    const reference = doc(firestore, SHARED_SESSIONS, cloudId)
    await setDoc(reference, sessionPayload(session, ownerId, cloudId))
    const verified = await getDoc(reference)
    if (!verified.exists() || verified.data().ownerId !== ownerId) throw new Error('Firebase no confirmó la sesión')
    return completeSessionSync(item, cloudId)
  }

  if (item.operation === 'upsert-computer') {
    const computer = await getComputer(item.entityId)
    if (!computer) return completeDeleteSync(item)
    if (computer.ownerId !== ownerId) throw new Error('El equipo pendiente pertenece a otra cuenta')
    await updateComputerSyncState(computer.id, 'syncing')
    const duplicateId = await findRemoteDuplicate(computer)
    const knownId = computer.cloudId || computer.id
    if (duplicateId && duplicateId !== knownId) {
      // Una coincidencia de clave no demuestra que sean el mismo equipo. Conserva la copia
      // local y su operación pendiente para que la recuperación pueda revisar ambos registros.
      throw new Error(`Posible duplicado remoto ${duplicateId}: requiere revisión antes de sincronizar`)
    }
    const cloudId = duplicateId || knownId
    const reference = doc(firestore, SHARED_COMPUTERS, cloudId)
    if (!await isSyncQueueItemCurrent(item)) return false
    // Crea o actualiza primero el documento conservando la fotografía anterior.
    // El Worker exige que el equipo exista y pertenezca al usuario antes de aceptar una carga.
    await setDoc(reference, computerPayload(computer, ownerId, cloudId))
    let syncedComputer = computer
    let uploadedCandidate = item.photoCandidate && item.photoSourceRevision === computer.photoLocalRevision
      ? item.photoCandidate
      : undefined
    if (computer.photo && (computer.photoNeedsUpload || !computer.photoRemote)) {
      if (scope === 'operations') {
        // Alcance «solo operaciones»: la fotografía no se sube ni cambia de estado; sigue pendiente para su propio alcance.
      } else if (imageKitConfigured) {
        await updateComputerPhotoState(computer.id, { photoUploadStatus: 'uploading', photoUploadError: undefined })
        if (!uploadedCandidate) {
          uploadedCandidate = await uploadPhotoToImageKit(cloudId, computer.photo, computer.photoName)
          if (!await savePhotoCandidate(item, uploadedCandidate, computer.photoLocalRevision)) return false
        }
        syncedComputer = { ...computer, photoRemote: uploadedCandidate, photoNeedsUpload: false, photoUploadStatus: 'uploaded', photoUploadError: undefined, photoStoredLocally: false }
      } else {
        syncedComputer = { ...computer, photoNeedsUpload: true, photoUploadStatus: 'pending' }
        await updateComputerPhotoState(computer.id, { photoNeedsUpload: true, photoUploadStatus: 'pending', photoUploadError: 'Backend de ImageKit pendiente de configurar' })
      }
    }
    if (!await isSyncQueueItemCurrent(item)) {
      if (uploadedCandidate) await queuePhotoCleanup({ entityId: computer.id, remoteId: cloudId, sessionId: computer.sessionId, ownerId, fileId: uploadedCandidate.fileId, reason: 'orphan-upload', blockedByQueueItemId: item.id })
      return false
    }
    if (uploadedCandidate) await setDoc(reference, computerPayload(syncedComputer, ownerId, cloudId))
    const verified = await getDoc(reference)
    if (!verified.exists() || verified.data().ownerId !== ownerId || (uploadedCandidate && verified.data().photoRemote?.fileId !== uploadedCandidate.fileId)) {
      throw new Error('Firebase no confirmó el equipo y su fotografía')
    }
    if (!await isSyncQueueItemCurrent(item)) {
      if (uploadedCandidate) await queuePhotoCleanup({ entityId: computer.id, remoteId: cloudId, sessionId: computer.sessionId, ownerId, fileId: uploadedCandidate.fileId, reason: 'orphan-upload', blockedByQueueItemId: item.id })
      return false
    }
    const cleanupFileIds = computer.photoRemote && uploadedCandidate && computer.photoRemote.fileId !== uploadedCandidate.fileId
      ? [computer.photoRemote.fileId]
      : []
    return completeComputerSync(item, cloudId, {
      photoRemote: syncedComputer.photoRemote,
      photoNeedsUpload: syncedComputer.photoNeedsUpload,
      photoUploadStatus: syncedComputer.photoUploadStatus,
      photoUploadError: syncedComputer.photoUploadError,
      photoStoredLocally: syncedComputer.photoStoredLocally,
      photoPath: syncedComputer.photoPath
    }, cleanupFileIds)
  }

  if (item.operation === 'delete-session') {
    // Solo se esperan las bajas de equipos del mismo propietario autenticado. Las de otras cuentas no se pueden ejecutar aquí:
    // se dejan intactas en la cola y no bloquean esta baja.
    const computerDeletes = (await getPendingSyncQueue()).filter((queued) => queued.operation === 'delete-computer' && queued.sessionId === item.entityId && queued.ownerId === ownerId)
    if (computerDeletes.length) return false
    const reference = doc(firestore, SHARED_SESSIONS, item.remoteId || item.entityId)
    // Si nunca llegó a Firestore no hay nada que borrar (las reglas rechazan borrar documentos inexistentes).
    const existing = await getDoc(reference)
    if (existing.exists()) {
      if (existing.data().ownerId !== ownerId) throw new Error('Solo el creador puede eliminar la sesión')
      await deleteDoc(reference)
    }
    return completeDeleteSync(item)
  }

  if (item.operation === 'delete-computer') {
    const remoteId = item.remoteId || item.entityId
    const reference = doc(firestore, SHARED_COMPUTERS, remoteId)
    const existing = await getDoc(reference)
    if (existing.exists()) {
      if (existing.data().ownerId !== ownerId) throw new Error('Solo el creador puede eliminar el equipo')
      const currentFileId = existing.data().photoRemote?.fileId as string | undefined
      if (currentFileId) {
        await queuePhotoCleanup({
          entityId: item.entityId,
          remoteId,
          sessionId: item.sessionId,
          ownerId,
          fileId: currentFileId,
          reason: 'deleted-computer',
          blockedByQueueItemId: item.id
        })
      }
      await deleteDoc(reference)
    }
    return completeDeleteSync(item)
  }
  if (item.operation === 'cleanup-photo') {
    if (scope !== 'all') return false
    if (!item.photoFileId) return completeDeleteSync(item)
    if (item.blockedByQueueItemId && (await getPendingSyncQueue()).some((queued) => queued.id === item.blockedByQueueItemId)) return false
    if (!imageKitConfigured) throw new Error('ImageKit está pendiente de configurar')
    await cleanupImageKitPhoto(item.remoteId || item.entityId, item.photoFileId)
    return completeDeleteSync(item)
  }
  return false
}

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 60_000

const operationPriority = (item: SyncQueueItem) => {
  if (item.operation === 'upsert-session') return 0
  if (item.operation === 'upsert-computer') return 1
  if (item.operation === 'delete-computer') return 2
  if (item.operation === 'cleanup-photo') return 3
  return 4
}

const isTransientSyncError = (error: unknown) => {
  if (!navigator.onLine) return true
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code).replace(/^firestore\//, '') : ''
  return ['aborted', 'deadline-exceeded', 'internal', 'network-request-failed', 'resource-exhausted', 'unavailable', 'unknown'].includes(code)
}

const syncRuns = new Map<string, { scope: SyncScope; promise: Promise<SyncSummary> }>()

export function synchronize(ownerId: string, report: SyncReporter = () => undefined, options: SyncOptions = {}): Promise<SyncSummary> {
  const scope = options.scope ?? 'all'
  const running = syncRuns.get(ownerId)
  if (running) {
    // Una ejecución idéntica comparte el resultado. Con otro alcance o exclusiones se espera y se ejecuta después, nunca en paralelo.
    if (scope === 'all' && running.scope === 'all' && !options.exclude?.size) return running.promise
    return running.promise.catch(() => undefined).then(() => synchronize(ownerId, report, options))
  }
  const promise = runSynchronize(ownerId, report, options).finally(() => { if (syncRuns.get(ownerId)?.promise === promise) syncRuns.delete(ownerId) })
  syncRuns.set(ownerId, { scope, promise })
  return promise
}

async function runSynchronize(ownerId: string, report: SyncReporter, options: SyncOptions): Promise<SyncSummary> {
  const scope = options.scope ?? 'all'
  if (!firestore) throw new Error('Firebase no está configurado')
  if (!navigator.onLine) {
    report('local', 'Guardado local')
    return { synced: 0, errors: 0, photosLocalOnly: 0, pending: await pendingCount(ownerId) }
  }
  // Las fotografías que esperaban a ImageKit (o a un reintento) vuelven a la cola sin necesidad de reimportar nada.
  if (imageKitConfigured && scope !== 'operations') await queuePendingPhotoUploads(ownerId, options.exclude)
  const pendingPhotoEntities = new Set<string>()
  if (scope === 'photos') {
    for (const computer of await listComputers()) {
      if (computer.ownerId === ownerId && computer.photo && (computer.photoNeedsUpload || !computer.photoRemote)) { pendingPhotoEntities.add(computer.id); if (computer.cloudId) pendingPhotoEntities.add(computer.cloudId) }
    }
  }
  const inScope = (item: SyncQueueItem) => {
    if (options.exclude?.has(item.entityId) || (item.remoteId && options.exclude?.has(item.remoteId))) return false
    if (scope === 'operations') return item.operation !== 'cleanup-photo'
    if (scope === 'photos') return item.operation === 'upsert-computer' && pendingPhotoEntities.has(item.entityId)
    return true
  }
  const initialQueue = (await getPendingSyncQueue()).filter((item) => item.ownerId === ownerId)
  if (!initialQueue.length) {
    const photosLocalOnly = (await listComputers()).filter((computer) => computer.ownerId === ownerId && computer.photo && !computer.photoRemote).length
    report('synced', photosLocalOnly ? `Sincronizado · ${photosLocalOnly} foto${photosLocalOnly === 1 ? '' : 's'} pendiente${photosLocalOnly === 1 ? '' : 's'}` : 'Sincronizado')
    return { synced: 0, errors: 0, photosLocalOnly, pending: 0 }
  }
  report('syncing', 'Sincronizando')
  let synced = 0
  let errors = 0
  let lastError = ''
  let stoppedByTransientError = false
  const processed = new Set<string>()
  for (let pass = 0; pass < 20; pass += 1) {
    const now = Date.now()
    const queue = (await getPendingSyncQueue())
      .filter((item) => item.ownerId === ownerId && inScope(item) && !processed.has(`${item.id}:${item.revision || item.createdAt}`) && (options.force || !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now))
      .sort((left, right) => operationPriority(left) - operationPriority(right) || left.createdAt.localeCompare(right.createdAt))
    if (!queue.length) break
    for (const item of queue) {
      processed.add(`${item.id}:${item.revision || item.createdAt}`)
      try {
        const didSync = await syncItem(ownerId, item, scope)
        if (didSync) synced += 1
      } catch (error) {
        errors += 1
        const message = error instanceof Error ? error.message : 'Error desconocido'
        lastError = message
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(item.attempts || 0, 6)))
        const transient = isTransientSyncError(error)
        await markSyncQueueFailure(item, message, new Date(Date.now() + delay).toISOString(), transient)
        if (item.operation.includes('computer')) {
          await updateComputerSyncState(item.entityId, 'error', message)
          if (item.operation === 'upsert-computer') await updateComputerPhotoState(item.entityId, { photoUploadStatus: 'error', photoUploadError: message })
        }
        if (item.operation.includes('session')) await updateSessionSyncState(item.entityId, 'error', message)
        if (transient && item.operation !== 'cleanup-photo') {
          stoppedByTransientError = true
          break
        }
      }
    }
    if (stoppedByTransientError) break
  }
  const [remaining, localComputers] = await Promise.all([
    getPendingSyncQueue().then((items) => items.filter((item) => item.ownerId === ownerId)),
    listComputers()
  ])
  const photosLocalOnly = localComputers.filter((computer) => computer.ownerId === ownerId && computer.photo && !computer.photoRemote).length
  const cleanupPending = remaining.filter((item) => item.operation === 'cleanup-photo').length
  const retryAt = remaining.filter((item) => item.retryable !== false).map((item) => item.nextAttemptAt).filter(Boolean).sort()[0]
  const retryAfterMs = retryAt ? Math.max(0, Date.parse(retryAt) - Date.now()) : undefined
  const photoMessage = photosLocalOnly ? ` · ${photosLocalOnly} foto${photosLocalOnly === 1 ? '' : 's'} pendiente${photosLocalOnly === 1 ? '' : 's'}` : ''
  const cleanupMessage = cleanupPending ? ` · ${cleanupPending} limpieza${cleanupPending === 1 ? '' : 's'} pendiente${cleanupPending === 1 ? '' : 's'}` : ''
  if (remaining.length) report(errors ? 'error' : 'local', `${remaining.length} pendiente${remaining.length === 1 ? '' : 's'}${lastError ? ` · ${lastError}` : ''}${photoMessage}${cleanupMessage}`)
  else report('synced', `Sincronizado · ${synced} ${synced === 1 ? 'operación' : 'operaciones'}${photoMessage}`)
  return { synced, errors, photosLocalOnly, pending: remaining.length, retryAfterMs, lastError: lastError || undefined }
}

export async function migrateLegacyCloudData(identity: CreatorIdentity) {
  if (!firestore || !navigator.onLine) return { sessions: 0, computers: 0 }
  // La ruta privada anterior solo se migra una vez por dispositivo y cuenta (evita 2 lecturas completas en cada inicio).
  if (readMeta(`inventario.legacy.${identity.uid}`) === 'done') return { sessions: 0, computers: 0 }
  const [legacySessions, legacyComputers] = await Promise.all([
    getDocs(collection(firestore, 'users', identity.uid, 'sessions')),
    getDocs(collection(firestore, 'users', identity.uid, 'computers'))
  ])
  let sessions = 0
  let computers = 0
  for (const snapshot of legacySessions.docs) {
    const legacy = snapshot.data() as InventorySession
    const target = doc(firestore, SHARED_SESSIONS, snapshot.id)
    const existing = await getDoc(target)
    if (!existing.exists() || (existing.data().ownerId === identity.uid && String(existing.data().updatedAt || '') < legacy.updatedAt)) {
      await setDoc(target, sessionPayload({ ...legacy, ownerId: identity.uid, ownerName: legacy.ownerName || identity.displayName || '', ownerEmail: legacy.ownerEmail || identity.email || '' }, identity.uid, snapshot.id))
      sessions += 1
    }
  }
  for (const snapshot of legacyComputers.docs) {
    const legacy = snapshot.data() as ComputerRecord
    const duplicateId = await findRemoteDuplicate(legacy)
    if (duplicateId && duplicateId !== snapshot.id) continue
    const target = doc(firestore, SHARED_COMPUTERS, snapshot.id)
    const existing = await getDoc(target)
    if (!existing.exists() || (existing.data().ownerId === identity.uid && String(existing.data().updatedAt || '') < legacy.updatedAt)) {
      await setDoc(target, computerPayload({ ...legacy, equipmentType: legacy.equipmentType || '', ownerId: identity.uid, ownerName: legacy.ownerName || identity.displayName || '', ownerEmail: legacy.ownerEmail || identity.email || '' }, identity.uid, snapshot.id))
      computers += 1
    }
  }
  writeMeta(`inventario.legacy.${identity.uid}`, 'done')
  return { sessions, computers }
}

const PULL_PAGE_SIZE = 200
const OVERLAP_MS = 10 * 60 * 1000
const FULL_RECONCILE_MIN_INTERVAL_MS = 10 * 60 * 1000

const memoryMeta = new Map<string, string>()
const readMeta = (key: string) => {
  try { return localStorage.getItem(key) ?? memoryMeta.get(key) ?? null } catch { return memoryMeta.get(key) ?? null }
}
const writeMeta = (key: string, value: string) => {
  memoryMeta.set(key, value)
  try { localStorage.setItem(key, value) } catch { /* el almacenamiento puede estar bloqueado */ }
}

export const PULL_META_PREFIX = 'inventario.pull.'
const cursorKey = (name: string) => `${PULL_META_PREFIX}${name}.cursor`
const reconcileKey = (name: string) => `${PULL_META_PREFIX}${name}.reconciledAt`

export interface PullStats {
  sessions: number
  computers: number
  reads: number
}

/** Descarga una colección por páginas ordenadas por updatedAt. Con `since` solo trae lo modificado. */
async function fetchPages(name: string, since?: string) {
  if (!firestore) return []
  const base = collection(firestore, name)
  const docs: QueryDocumentSnapshot[] = []
  let last: QueryDocumentSnapshot | undefined
  for (;;) {
    const constraints: QueryConstraint[] = []
    if (since) constraints.push(where('updatedAt', '>=', since))
    constraints.push(orderBy('updatedAt'))
    if (last) constraints.push(startAfter(last))
    constraints.push(limit(PULL_PAGE_SIZE))
    const page = await getDocs(query(base, ...constraints))
    docs.push(...page.docs)
    if (page.docs.length < PULL_PAGE_SIZE) break
    last = page.docs[page.docs.length - 1]
  }
  return docs
}

async function loadRemote(name: string, localSharedCount: number, pendingDeleteCount: number, force: boolean, exclude: ReadonlySet<string> = new Set()) {
  const cursor = readMeta(cursorKey(name))
  const lastFull = Number(readMeta(reconcileKey(name)) || 0)
  const stale = Date.now() - lastFull > FULL_RECONCILE_MIN_INTERVAL_MS
  let full = force || !cursor
  let docs: QueryDocumentSnapshot[] = []
  let reads = 0
  if (!full) {
    docs = await fetchPages(name, new Date(Date.parse(cursor!) - OVERLAP_MS).toISOString())
    reads += docs.length
    if (stale && firestore) {
      // Detecta borrados remotos con una consulta de conteo (1 lectura por cada 1000 documentos) en vez de releer todo.
      const remoteCount = (await getCountFromServer(collection(firestore, name))).data().count
      reads += 1
      if (remoteCount !== localSharedCount + pendingDeleteCount) full = true
      else writeMeta(reconcileKey(name), String(Date.now()))
    }
  }
  if (full) {
    docs = await fetchPages(name)
    reads += docs.length
    writeMeta(reconcileKey(name), String(Date.now()))
  }
  // Con exclusiones el cursor nunca pasa del documento omitido más antiguo: los omitidos se volverán a descargar
  // en la siguiente descarga incremental y no se pierden ni se omiten de forma permanente.
  const skippedAt = docs.filter((entry) => exclude.has(entry.id)).map((entry) => String(entry.data().updatedAt || '')).sort()[0]
  const newest = docs.reduce((max, entry) => {
    const value = String(entry.data().updatedAt || '')
    if (exclude.has(entry.id) || (skippedAt !== undefined && value >= skippedAt)) return max
    return value > max ? value : max
  }, cursor || '')
  if (newest) writeMeta(cursorKey(name), newest)
  return { docs, full, reads }
}

let pullInFlight: { force: boolean; promise: Promise<PullStats> } | undefined

export interface PullOptions {
  force?: boolean
  /** Registros (identificadores locales o remotos) que no deben actualizarse ni eliminarse en esta descarga. */
  exclude?: ReadonlySet<string>
  /** No elimina registros locales aunque ya no existan en Firestore (solo agrega y actualiza). */
  keepLocalRecords?: boolean
}

/**
 * Sincroniza hacia el dispositivo solo los documentos nuevos o modificados (paginado, orderBy + limit + startAfter).
 * Las llamadas simultáneas comparten la misma consulta. `force` hace una reconciliación completa.
 */
export function pullCloudData(_ownerId: string, options: PullOptions = {}): Promise<PullStats> {
  if (!firestore || !navigator.onLine) return Promise.resolve({ sessions: 0, computers: 0, reads: 0 })
  const force = Boolean(options.force)
  const exclude = options.exclude
  const keepLocal = Boolean(options.keepLocalRecords)
  if (pullInFlight) {
    if (!exclude?.size && !keepLocal && (!force || pullInFlight.force)) return pullInFlight.promise
    return pullInFlight.promise.catch(() => undefined).then(() => pullCloudData(_ownerId, options))
  }
  const promise = runPull(force, exclude, keepLocal).finally(() => {
    if (pullInFlight?.promise === promise) pullInFlight = undefined
  })
  pullInFlight = { force, promise }
  return promise
}

const fullSyncInFlight = new Map<string, { force: boolean; promise: Promise<FullSyncSummary> }>()

/** Ejecuta escritura y descarga como una sola operación deduplicada. */
export function synchronizeAndPull(ownerId: string, report: SyncReporter = () => undefined, options: { force?: boolean } = {}): Promise<FullSyncSummary> {
  const running = fullSyncInFlight.get(ownerId)
  const force = Boolean(options.force)
  if (running) {
    if (!force || running.force) return running.promise
    return running.promise.then(() => synchronizeAndPull(ownerId, report, { force: true }))
  }
  const promise = (async () => {
    report('syncing', 'Sincronizando…')
    const written = await synchronize(ownerId, report, options)
    const pulled = await pullCloudData(ownerId, { force })
    return { ...written, pulled }
  })().finally(() => {
    if (fullSyncInFlight.get(ownerId)?.promise === promise) fullSyncInFlight.delete(ownerId)
  })
  fullSyncInFlight.set(ownerId, { force, promise })
  return promise
}

async function runPull(force: boolean, exclude: ReadonlySet<string> = new Set(), keepLocalRecords = false): Promise<PullStats> {
  const skipped = (...ids: Array<string | undefined>) => ids.some((id) => id && exclude.has(id))
  const [localSessions, localComputers, queue] = await Promise.all([listSessions(), listComputers(), getPendingSyncQueue()])
  // Borrados pendientes: no se vuelven a descargar mientras Firestore no los confirme.
  const pendingDeletes = queue.filter((item) => item.operation.startsWith('delete-'))
  const deletedSessions = new Set(pendingDeletes.filter((item) => item.operation === 'delete-session').flatMap((item) => [item.entityId, item.remoteId]))
  const deletedComputers = new Set(pendingDeletes.filter((item) => item.operation === 'delete-computer').flatMap((item) => [item.entityId, item.remoteId]))
  const sessionPending = (localId: string | undefined, remoteId: string) => queue.some((item) =>
    item.operation.includes('session') && (item.entityId === localId || item.entityId === remoteId || item.remoteId === remoteId))
  const computerPending = (localId: string | undefined, remoteId: string) => queue.some((item) =>
    item.operation.includes('computer') && (item.entityId === localId || item.entityId === remoteId || item.remoteId === remoteId))
  const sharedCount = <T extends { sharedCloud?: boolean; cloudId?: string; id: string }>(items: T[]) =>
    new Set(items.filter((item) => item.sharedCloud).map((item) => item.cloudId || item.id)).size

  const [sessionsResult, computersResult] = await Promise.all([
    loadRemote(SHARED_SESSIONS, sharedCount(localSessions), pendingDeletes.filter((item) => item.operation === 'delete-session').length, force, exclude),
    loadRemote(SHARED_COMPUTERS, sharedCount(localComputers), pendingDeletes.filter((item) => item.operation === 'delete-computer').length, force, exclude)
  ])

  for (const snapshot of sessionsResult.docs) {
    if (deletedSessions.has(snapshot.id)) continue
    const remote = snapshot.data() as InventorySession
    const local = localSessions.find((item) => item.cloudId === snapshot.id || item.id === snapshot.id)
    if (sessionPending(local?.id, snapshot.id) || skipped(snapshot.id, local?.id)) continue
    await applyRemoteSession({ ...remote, id: local?.id || remote.id || snapshot.id, cloudId: snapshot.id })
  }

  for (const snapshot of computersResult.docs) {
    if (deletedComputers.has(snapshot.id)) continue
    const remote = snapshot.data() as ComputerRecord
    const local = localComputers.find((item) => item.cloudId === snapshot.id || item.id === snapshot.id)
    if (computerPending(local?.id, snapshot.id) || skipped(snapshot.id, local?.id)) continue
    await applyRemoteComputer({ ...remote, id: local?.id || remote.id || snapshot.id, cloudId: snapshot.id })
  }

  // Solo una descarga completa permite saber qué documentos desaparecieron de Firestore.
  if (computersResult.full && !keepLocalRecords) {
    const ids = new Set(computersResult.docs.map((entry) => entry.id))
    for (const computer of localComputers.filter((item) => item.sharedCloud && !skipped(item.id, item.cloudId) && !computerPending(item.id, item.cloudId || item.id) && !ids.has(item.cloudId || item.id))) {
      await removeRemoteMirroredComputer(computer.id, computer.cloudId)
    }
  }
  if (sessionsResult.full && !keepLocalRecords) {
    const ids = new Set(sessionsResult.docs.map((entry) => entry.id))
    for (const session of localSessions.filter((item) => item.sharedCloud && !skipped(item.id, item.cloudId) && !sessionPending(item.id, item.cloudId || item.id) && !ids.has(item.cloudId || item.id))) {
      await removeRemoteMirroredSession(session.id, session.cloudId)
    }
  }
  return { sessions: sessionsResult.docs.length, computers: computersResult.docs.length, reads: sessionsResult.reads + computersResult.reads }
}

async function applySessionChanges(changes: Array<DocumentChange<DocumentData>>) {
  let applied = 0
  let removed = 0
  for (const change of changes) {
    const [sessions, queue] = await Promise.all([listSessions(), getPendingSyncQueue()])
    const local = sessions.find((item) => item.cloudId === change.doc.id || item.id === change.doc.id)
    const pending = queue.some((item) => item.operation.includes('session') && (item.entityId === local?.id || item.entityId === change.doc.id || item.remoteId === change.doc.id))
    if (pending) continue
    if (change.type === 'removed') {
      if (local && await removeRemoteMirroredSession(local.id, local.cloudId)) removed += 1
      continue
    }
    const remote = change.doc.data() as InventorySession
    if (await applyRemoteSession({ ...remote, id: local?.id || remote.id || change.doc.id, cloudId: change.doc.id })) applied += 1
  }
  return { applied, removed }
}

async function applyComputerChanges(changes: Array<DocumentChange<DocumentData>>) {
  let applied = 0
  let removed = 0
  for (const change of changes) {
    const [computers, queue] = await Promise.all([listComputers(), getPendingSyncQueue()])
    const local = computers.find((item) => item.cloudId === change.doc.id || item.id === change.doc.id)
    const pending = queue.some((item) => item.operation.includes('computer') && (item.entityId === local?.id || item.entityId === change.doc.id || item.remoteId === change.doc.id))
    if (pending) continue
    if (change.type === 'removed') {
      if (local && await removeRemoteMirroredComputer(local.id, local.cloudId)) removed += 1
      continue
    }
    const remote = change.doc.data() as ComputerRecord
    if (await applyRemoteComputer({ ...remote, id: local?.id || remote.id || change.doc.id, cloudId: change.doc.id })) applied += 1
  }
  return { applied, removed }
}

/** Mantiene IndexedDB alineado con el inventario compartido sin reemplazar operaciones locales pendientes. */
export function subscribeToSharedInventory(
  _ownerId: string,
  handlers: { onApplied: (stats: RealtimeApplyStats) => void | Promise<void>; onError: (error: Error) => void }
): Unsubscribe {
  if (!firestore) return () => undefined
  let active = true
  let chain = Promise.resolve()
  const schedule = (task: () => Promise<RealtimeApplyStats>) => {
    chain = chain.then(async () => {
      if (!active) return
      const stats = await task()
      if (active && (stats.sessions || stats.computers || stats.removed)) await handlers.onApplied(stats)
    }).catch((error) => {
      if (active) handlers.onError(error instanceof Error ? error : new Error('No fue posible recibir cambios de Firestore'))
    })
  }
  const sessionUnsubscribe = onSnapshot(collection(firestore, SHARED_SESSIONS), (snapshot) => {
    const changes = snapshot.docChanges()
    schedule(async () => {
      const result = await applySessionChanges(changes)
      return { sessions: result.applied, computers: 0, removed: result.removed }
    })
  }, (error) => { if (active) handlers.onError(error) })
  const computerUnsubscribe = onSnapshot(collection(firestore, SHARED_COMPUTERS), (snapshot) => {
    const changes = snapshot.docChanges()
    schedule(async () => {
      const result = await applyComputerChanges(changes)
      return { sessions: 0, computers: result.applied, removed: result.removed }
    })
  }, (error) => { if (active) handlers.onError(error) })
  return () => {
    active = false
    sessionUnsubscribe()
    computerUnsubscribe()
  }
}

export async function verifyCloudOwnership(ownerId: string) {
  if (!firestore) return false
  const [sessions, computers] = await Promise.all([
    getDocs(query(collection(firestore, SHARED_SESSIONS), where('ownerId', '==', ownerId))),
    getDocs(query(collection(firestore, SHARED_COMPUTERS), where('ownerId', '==', ownerId)))
  ])
  return [...sessions.docs, ...computers.docs].every((entry) => entry.data().ownerId === ownerId)
}

export async function pendingCount(ownerId: string | null) {
  return (await getPendingSyncQueue()).filter((item) => ownerId ? item.ownerId === ownerId : !item.ownerId).length
}

/** Operaciones propias que fallaron y siguen en la cola (solo lectura). */
export async function failedCount(ownerId: string | null) {
  return (await getPendingSyncQueue()).filter((item) => (ownerId ? item.ownerId === ownerId : !item.ownerId) && Boolean(item.lastError)).length
}

export async function resetSyncQueueForTests() {
  const database = await getDatabase()
  await database.clear('syncQueue')
}

export interface RemoteVerification {
  confirmed: number
  missing: string[]
  foreign: string[]
  stillPresent: string[]
}

/** Lee directamente de Firestore para confirmar que los documentos existen con el propietario correcto (o que ya no existen). */
export async function verifyRemoteDocuments(ownerId: string, expected: { sessions: string[]; computers: string[]; deletedComputers: string[] }): Promise<RemoteVerification> {
  if (!firestore) throw new Error('Firebase no está configurado')
  const result: RemoteVerification = { confirmed: 0, missing: [], foreign: [], stillPresent: [] }
  const check = async (collectionName: string, id: string, label: string) => {
    const snapshot = await getDoc(doc(firestore!, collectionName, id))
    if (!snapshot.exists()) result.missing.push(`${label} ${id} no existe en Firebase`)
    else if (snapshot.data()?.ownerId !== ownerId) result.foreign.push(`${label} ${id} pertenece a otra cuenta`)
    else result.confirmed += 1
  }
  for (const id of new Set(expected.sessions)) await check(SHARED_SESSIONS, id, 'La sesión')
  for (const id of new Set(expected.computers)) await check(SHARED_COMPUTERS, id, 'El equipo')
  for (const id of new Set(expected.deletedComputers)) {
    if ((await getDoc(doc(firestore, SHARED_COMPUTERS, id))).exists()) result.stillPresent.push(`El equipo ${id} sigue existiendo en Firebase`)
  }
  return result
}
