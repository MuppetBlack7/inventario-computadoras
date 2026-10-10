import { collection, deleteDoc, doc, getDoc, getDocs, limit, query, setDoc, where } from 'firebase/firestore'
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
    await deleteDoc(doc(firestore, SHARED_SESSIONS, item.remoteId || item.entityId))
  }

  if (item.operation === 'delete-computer') {
    const remoteId = item.remoteId || item.entityId
    await deleteDoc(doc(firestore, SHARED_COMPUTERS, remoteId))
    if (item.photoFileId && imageKitConfigured) {
      await deleteCurrentImageKitPhoto(remoteId, item.photoFileId).catch(() => undefined)
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
  return { sessions, computers }
}

export async function pullCloudData(_ownerId: string) {
  if (!firestore || !navigator.onLine) return { sessions: 0, computers: 0 }
  const [remoteSessions, remoteComputers, localSessions, localComputers] = await Promise.all([
    getDocs(collection(firestore, SHARED_SESSIONS)),
    getDocs(collection(firestore, SHARED_COMPUTERS)),
    listSessions(),
    listComputers()
  ])
  const sessionIds = new Set(remoteSessions.docs.map((entry) => entry.id))
  const computerIds = new Set(remoteComputers.docs.map((entry) => entry.id))

  for (const snapshot of remoteSessions.docs) {
    const remote = snapshot.data() as InventorySession
    const local = localSessions.find((item) => item.cloudId === snapshot.id || item.id === snapshot.id)
    if (local && local.syncStatus && local.syncStatus !== 'synced' && local.ownerId === remote.ownerId) continue
    await saveSession({ ...remote, id: local?.id || remote.id || snapshot.id, cloudId: snapshot.id, sharedCloud: true, syncStatus: 'synced', syncError: undefined }, false)
  }

  for (const snapshot of remoteComputers.docs) {
    const remote = snapshot.data() as ComputerRecord
    const local = localComputers.find((item) => item.cloudId === snapshot.id || item.id === snapshot.id)
    if (local && local.syncStatus && local.syncStatus !== 'synced' && local.ownerId === remote.ownerId) continue
    const photo = local?.photo
    await saveComputer({
      ...remote,
      equipmentType: remote.equipmentType || '',
      id: local?.id || remote.id || snapshot.id,
      cloudId: snapshot.id,
      sharedCloud: true,
      photo,
      photoNeedsUpload: local?.photoNeedsUpload,
      photoUploadStatus: remote.photoRemote ? 'uploaded' : local?.photoUploadStatus,
      photoUploadError: local?.photoUploadError,
      syncStatus: 'synced',
      syncError: undefined
    }, false)
  }

  for (const computer of localComputers.filter((item) => item.sharedCloud && item.syncStatus === 'synced' && !computerIds.has(item.cloudId || item.id))) {
    await deleteComputer(computer.id, computer.ownerId, false)
  }
  for (const session of localSessions.filter((item) => item.sharedCloud && item.syncStatus === 'synced' && !sessionIds.has(item.cloudId || item.id))) {
    await deleteLocalSession(session.id)
  }
  return { sessions: remoteSessions.size, computers: remoteComputers.size }
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
