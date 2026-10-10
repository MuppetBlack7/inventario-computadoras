import { collection, deleteDoc, doc, getCountFromServer, getDoc, getDocs, limit, orderBy, query, setDoc, startAfter, where, type QueryConstraint, type QueryDocumentSnapshot } from 'firebase/firestore'
import {
  deleteComputer,
  deleteLocalSession,
  getComputer,
  getDatabase,
  getPendingSyncQueue,
  listComputers,
  listSessions,
  removeSyncQueueItem,
  saveComputer,
  saveSession,
  updateComputerPhotoState,
  updateComputerSyncState,
  updateSessionSyncState
} from './db'
import { firestore } from './firebaseClient'
import { cleanupReplacedImageKitPhoto, deleteCurrentImageKitPhoto, imageKitConfigured, uploadPhotoToImageKit } from './imageKitClient'
import type { ComputerRecord, InventorySession, SyncQueueItem, SyncStatus } from './types'

const SHARED_SESSIONS = 'inventorySessions'
const SHARED_COMPUTERS = 'inventoryComputers'

export interface SyncSummary {
  synced: number
  errors: number
  photosLocalOnly: number
}

export interface CreatorIdentity {
  uid: string
  displayName?: string | null
  email?: string | null
}

export type SyncReporter = (status: SyncStatus, message: string) => void

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
    const snapshot = await getDocs(query(computers, where(field, '==', value), limit(1)))
    const match = snapshot.docs[0]
    if (match) return match.id
  }
  return undefined
}

async function syncItem(ownerId: string, item: SyncQueueItem) {
  if (!firestore) throw new Error('Firestore no está configurado')
  if (item.ownerId !== ownerId) return false

  if (item.operation === 'upsert-session') {
    const session = (await listSessions()).find((entry) => entry.id === item.entityId)
    if (!session || session.ownerId !== ownerId) return false
    await updateSessionSyncState(session.id, 'syncing')
    const cloudId = session.cloudId || session.id
    const reference = doc(firestore, SHARED_SESSIONS, cloudId)
    await setDoc(reference, sessionPayload(session, ownerId, cloudId))
    const verified = await getDoc(reference)
    if (!verified.exists() || verified.data().ownerId !== ownerId) throw new Error('Firebase no confirmó la sesión')
    await updateSessionSyncState(session.id, 'synced', undefined, cloudId, true)
  }

  if (item.operation === 'upsert-computer') {
    const computer = await getComputer(item.entityId)
    if (!computer || computer.ownerId !== ownerId) return false
    await updateComputerSyncState(computer.id, 'syncing')
    const duplicateId = await findRemoteDuplicate(computer)
    const knownId = computer.cloudId || computer.id
    if (duplicateId && duplicateId !== knownId) throw new Error('Ya existe un equipo con el mismo número de serie o inventario')
    const cloudId = duplicateId || knownId
    const reference = doc(firestore, SHARED_COMPUTERS, cloudId)
    await setDoc(reference, computerPayload(computer, ownerId, cloudId))
    let syncedComputer = computer
    if (computer.photo && (computer.photoNeedsUpload || !computer.photoRemote)) {
      if (imageKitConfigured) {
        await updateComputerPhotoState(computer.id, { photoUploadStatus: 'uploading', photoUploadError: undefined })
        const previous = computer.photoRemote
        const photoRemote = await uploadPhotoToImageKit(cloudId, computer.photo, computer.photoName)
        syncedComputer = { ...computer, photoRemote, photoNeedsUpload: false, photoUploadStatus: 'uploaded', photoUploadError: undefined, photoStoredLocally: false }
        await setDoc(reference, computerPayload(syncedComputer, ownerId, cloudId))
        await updateComputerPhotoState(computer.id, { photoRemote, photoNeedsUpload: false, photoUploadStatus: 'uploaded', photoUploadError: undefined })
        if (previous && previous.fileId !== photoRemote.fileId) {
          await cleanupReplacedImageKitPhoto(cloudId, previous.fileId).catch(() => undefined)
        }
      } else {
        syncedComputer = { ...computer, photoNeedsUpload: true, photoUploadStatus: 'pending' }
        await updateComputerPhotoState(computer.id, { photoNeedsUpload: true, photoUploadStatus: 'pending', photoUploadError: 'Backend de ImageKit pendiente de configurar' })
      }
    }
    const verified = await getDoc(reference)
    if (!verified.exists() || verified.data().ownerId !== ownerId) throw new Error('Firebase no confirmó el equipo')
    await updateComputerSyncState(computer.id, 'synced', undefined, cloudId, syncedComputer.photoPath, true)
  }

  if (item.operation === 'delete-session') {
    const reference = doc(firestore, SHARED_SESSIONS, item.remoteId || item.entityId)
    // Si nunca llegó a Firestore no hay nada que borrar (las reglas rechazan borrar documentos inexistentes).
    const existing = await getDoc(reference)
    if (existing.exists()) {
      if (existing.data().ownerId !== ownerId) throw new Error('Solo el creador puede eliminar la sesión')
      await deleteDoc(reference)
    }
  }

  if (item.operation === 'delete-computer') {
    const remoteId = item.remoteId || item.entityId
    const reference = doc(firestore, SHARED_COMPUTERS, remoteId)
    const existing = await getDoc(reference)
    if (existing.exists()) {
      if (existing.data().ownerId !== ownerId) throw new Error('Solo el creador puede eliminar el equipo')
      await deleteDoc(reference)
      // Solo se borra en ImageKit la foto de un equipo propio.
      if (item.photoFileId && imageKitConfigured) {
        await deleteCurrentImageKitPhoto(remoteId, item.photoFileId).catch(() => undefined)
      }
    }
  }
  await removeSyncQueueItem(item.id)
  return true
}

export async function synchronize(ownerId: string, report: SyncReporter = () => undefined): Promise<SyncSummary> {
  if (!firestore) throw new Error('Firebase no está configurado')
  if (!navigator.onLine) {
    report('local', 'Guardado local')
    return { synced: 0, errors: 0, photosLocalOnly: 0 }
  }
  const queue = (await getPendingSyncQueue())
    .filter((item) => item.ownerId === ownerId)
    .sort((left, right) => {
      const priority = (item: SyncQueueItem) => item.operation === 'delete-computer' ? 0 : item.operation === 'delete-session' ? 1 : 2
      return priority(left) - priority(right) || left.createdAt.localeCompare(right.createdAt)
    })
  if (!queue.length) {
    report('synced', 'Sincronizado')
    return { synced: 0, errors: 0, photosLocalOnly: 0 }
  }
  report('syncing', 'Sincronizando')
  let synced = 0
  let errors = 0
  let photosLocalOnly = 0
  for (const item of queue) {
    try {
      const didSync = await syncItem(ownerId, item)
      if (didSync) synced += 1
      const computer = item.operation === 'upsert-computer' ? await getComputer(item.entityId) : undefined
      if (computer?.photo && !computer.photoRemote) photosLocalOnly += 1
    } catch (error) {
      errors += 1
      const message = error instanceof Error ? error.message : 'Error desconocido'
      if (item.operation.includes('computer')) {
        await updateComputerSyncState(item.entityId, 'error', message)
        if (item.operation === 'upsert-computer') await updateComputerPhotoState(item.entityId, { photoUploadStatus: 'error', photoUploadError: message })
      }
      if (item.operation.includes('session')) await updateSessionSyncState(item.entityId, 'error', message)
    }
  }
  if (errors) report('error', 'Error al sincronizar')
  else report('synced', 'Sincronizado')
  return { synced, errors, photosLocalOnly }
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

async function loadRemote(name: string, localSharedCount: number, pendingDeleteCount: number, force: boolean) {
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
  const newest = docs.reduce((max, entry) => {
    const value = String(entry.data().updatedAt || '')
    return value > max ? value : max
  }, cursor || '')
  if (newest) writeMeta(cursorKey(name), newest)
  return { docs, full, reads }
}

let pullInFlight: Promise<PullStats> | undefined

/**
 * Sincroniza hacia el dispositivo solo los documentos nuevos o modificados (paginado, orderBy + limit + startAfter).
 * Las llamadas simultáneas comparten la misma consulta. `force` hace una reconciliación completa.
 */
export function pullCloudData(_ownerId: string, options: { force?: boolean } = {}): Promise<PullStats> {
  if (!firestore || !navigator.onLine) return Promise.resolve({ sessions: 0, computers: 0, reads: 0 })
  if (!pullInFlight) pullInFlight = runPull(Boolean(options.force)).finally(() => { pullInFlight = undefined })
  return pullInFlight
}

async function runPull(force: boolean): Promise<PullStats> {
  const [localSessions, localComputers, queue] = await Promise.all([listSessions(), listComputers(), getPendingSyncQueue()])
  // Borrados pendientes: no se vuelven a descargar mientras Firestore no los confirme.
  const pendingDeletes = queue.filter((item) => item.operation.startsWith('delete-'))
  const deletedSessions = new Set(pendingDeletes.filter((item) => item.operation === 'delete-session').flatMap((item) => [item.entityId, item.remoteId]))
  const deletedComputers = new Set(pendingDeletes.filter((item) => item.operation === 'delete-computer').flatMap((item) => [item.entityId, item.remoteId]))
  const sharedCount = <T extends { sharedCloud?: boolean; cloudId?: string; id: string }>(items: T[]) =>
    new Set(items.filter((item) => item.sharedCloud).map((item) => item.cloudId || item.id)).size

  const [sessionsResult, computersResult] = await Promise.all([
    loadRemote(SHARED_SESSIONS, sharedCount(localSessions), pendingDeletes.filter((item) => item.operation === 'delete-session').length, force),
    loadRemote(SHARED_COMPUTERS, sharedCount(localComputers), pendingDeletes.filter((item) => item.operation === 'delete-computer').length, force)
  ])

  for (const snapshot of sessionsResult.docs) {
    if (deletedSessions.has(snapshot.id)) continue
    const remote = snapshot.data() as InventorySession
    const local = localSessions.find((item) => item.cloudId === snapshot.id || item.id === snapshot.id)
    if (local && local.syncStatus && local.syncStatus !== 'synced' && local.ownerId === remote.ownerId) continue
    await saveSession({ ...remote, id: local?.id || remote.id || snapshot.id, cloudId: snapshot.id, sharedCloud: true, syncStatus: 'synced', syncError: undefined }, false)
  }

  for (const snapshot of computersResult.docs) {
    if (deletedComputers.has(snapshot.id)) continue
    const remote = snapshot.data() as ComputerRecord
    const local = localComputers.find((item) => item.cloudId === snapshot.id || item.id === snapshot.id)
    if (local && local.syncStatus && local.syncStatus !== 'synced' && local.ownerId === remote.ownerId) continue
    await saveComputer({
      ...remote,
      equipmentType: remote.equipmentType || '',
      id: local?.id || remote.id || snapshot.id,
      cloudId: snapshot.id,
      sharedCloud: true,
      photo: local?.photo,
      photoNeedsUpload: local?.photoNeedsUpload,
      photoUploadStatus: remote.photoRemote ? 'uploaded' : local?.photoUploadStatus,
      photoUploadError: local?.photoUploadError,
      syncStatus: 'synced',
      syncError: undefined
    }, false)
  }

  // Solo una descarga completa permite saber qué documentos desaparecieron de Firestore.
  if (computersResult.full) {
    const ids = new Set(computersResult.docs.map((entry) => entry.id))
    for (const computer of localComputers.filter((item) => item.sharedCloud && item.syncStatus === 'synced' && !ids.has(item.cloudId || item.id))) {
      await deleteComputer(computer.id, computer.ownerId, false)
    }
  }
  if (sessionsResult.full) {
    const ids = new Set(sessionsResult.docs.map((entry) => entry.id))
    for (const session of localSessions.filter((item) => item.sharedCloud && item.syncStatus === 'synced' && !ids.has(item.cloudId || item.id))) {
      await deleteLocalSession(session.id)
    }
  }
  return { sessions: sessionsResult.docs.length, computers: computersResult.docs.length, reads: sessionsResult.reads + computersResult.reads }
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

export async function resetSyncQueueForTests() {
  const database = await getDatabase()
  await database.clear('syncQueue')
}
