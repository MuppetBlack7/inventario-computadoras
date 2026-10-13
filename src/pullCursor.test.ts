import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, any>
const store = vi.hoisted(() => ({
  data: new Map<string, Map<string, Row>>(), reads: 0, setCalls: 0, activeSets: 0, maxActiveSets: 0,
  failSetAt: 0, failReads: false, setDelayMs: 0, deleteLog: [] as string[],
  listeners: new Map<string, Set<{ next: (snapshot: { docChanges: () => unknown[] }) => void; error: (error: Error) => void }>>(),
  setHook: undefined as undefined | ((ref: { name: string; id: string }, row: Row) => Promise<void>),
  getDocsHook: undefined as undefined | ((name: string) => Promise<void>)
}))
const photoStore = vi.hoisted(() => ({
  failUpload: false,
  uploads: 0,
  failDeletes: 0,
  deletes: [] as string[],
  uploadHook: undefined as undefined | (() => Promise<void>)
}))

vi.mock('./firebaseClient', () => ({ firestore: {} }))
vi.mock('firebase/firestore', () => {
  const snap = (id: string, row: Row) => ({ id, exists: () => true, data: () => row })
  return {
    collection: (_db: unknown, name: string) => ({ name }),
    doc: (_db: unknown, name: string, id: string) => ({ name, id }),
    where: (field: string, op: string, value: unknown) => ({ kind: 'where', field, op, value }),
    orderBy: (field: string) => ({ kind: 'orderBy', field }),
    startAfter: (last: { id: string }) => ({ kind: 'startAfter', last }),
    limit: (n: number) => ({ kind: 'limit', n }),
    query: (base: { name: string }, ...constraints: Array<Record<string, unknown>>) => ({ name: base.name, constraints }),
    getDocs: async (q: { name: string; constraints: Array<Record<string, any>> }) => {
      if (store.getDocsHook) await store.getDocsHook(q.name)
      if (store.failReads) throw Object.assign(new Error('Permiso denegado'), { code: 'permission-denied' })
      let rows = [...(store.data.get(q.name) ?? new Map<string, Row>()).entries()]
      for (const c of q.constraints) if (c.kind === 'where') rows = rows.filter(([, row]) => c.op === '==' ? row[c.field] === c.value : String(row[c.field]) >= String(c.value))
      rows.sort((a, b) => String(a[1].updatedAt).localeCompare(String(b[1].updatedAt)))
      const after = q.constraints.find((c) => c.kind === 'startAfter')
      if (after) rows = rows.slice(rows.findIndex(([id]) => id === after.last.id) + 1)
      const max = q.constraints.find((c) => c.kind === 'limit')
      if (max) rows = rows.slice(0, max.n)
      store.reads += rows.length
      return { docs: rows.map(([id, row]) => snap(id, row)), size: rows.length }
    },
    getCountFromServer: async (base: { name: string }) => {
      if (store.failReads) throw Object.assign(new Error('Permiso denegado'), { code: 'permission-denied' })
      store.reads += 1
      return { data: () => ({ count: (store.data.get(base.name) ?? new Map<string, Row>()).size }) }
    },
    getDoc: async (ref: { name: string; id: string }) => {
      if (store.failReads) throw Object.assign(new Error('Permiso denegado'), { code: 'permission-denied' })
      const row = store.data.get(ref.name)?.get(ref.id)
      return row ? snap(ref.id, row) : { exists: () => false, data: () => undefined }
    },
    setDoc: async (ref: { name: string; id: string }, row: Row) => {
      store.setCalls += 1
      store.activeSets += 1
      store.maxActiveSets = Math.max(store.maxActiveSets, store.activeSets)
      if (store.setDelayMs) await new Promise((resolve) => setTimeout(resolve, store.setDelayMs))
      if (store.failSetAt === store.setCalls) {
        store.activeSets -= 1
        throw Object.assign(new Error('Red interrumpida'), { code: 'unavailable' })
      }
      if (!store.data.has(ref.name)) store.data.set(ref.name, new Map())
      store.data.get(ref.name)!.set(ref.id, row)
      if (store.setHook) await store.setHook(ref, row)
      store.activeSets -= 1
    },
    deleteDoc: async (ref: { name: string; id: string }) => { store.deleteLog.push(`${ref.name}/${ref.id}`); store.data.get(ref.name)?.delete(ref.id) },
    onSnapshot: (ref: { name: string }, next: (snapshot: { docChanges: () => unknown[] }) => void, error: (error: Error) => void) => {
      const listeners = store.listeners.get(ref.name) ?? new Set()
      const listener = { next, error }
      listeners.add(listener)
      store.listeners.set(ref.name, listeners)
      return () => listeners.delete(listener)
    }
  }
})

vi.mock('./imageKitClient', () => ({
  imageKitConfigured: true,
  uploadPhotoToImageKit: vi.fn(async (_computerId: string, photo: Blob) => {
    if (photoStore.failUpload) throw Object.assign(new Error('ImageKit no disponible'), { code: 'unavailable' })
    photoStore.uploads += 1
    if (photoStore.uploadHook) await photoStore.uploadHook()
    const fileId = `photo-${photoStore.uploads}`
    return { fileId, url: `https://example.com/${fileId}.jpg`, filePath: `/inventario/alice/${fileId}.jpg`, name: `${fileId}.jpg`, size: photo.size, width: null, height: null, mimeType: photo.type, uploadedAt: minute(0) }
  }),
  cleanupImageKitPhoto: vi.fn(async (_computerId: string, fileId: string) => {
    if (photoStore.failDeletes > 0) {
      photoStore.failDeletes -= 1
      throw Object.assign(new Error('ImageKit no disponible'), { code: 'unavailable' })
    }
    if (![...store.data.get('inventoryComputers')!.values()].some((row) => row.photoRemote?.fileId === fileId)) {
      if (!photoStore.deletes.includes(fileId)) photoStore.deletes.push(fileId)
    }
    else throw Object.assign(new Error('La fotografía todavía está referenciada'), { code: 'aborted' })
    return { deleted: true }
  })
}))

import { getComputer, getDatabase, clearAllData, deleteComputer, deleteSessionAndComputers, getPendingSyncQueue, listComputers, listSessions, listVisibleComputers, queuePhotoCleanup, saveComputer, saveSession } from './db'
import { describeSyncError, pullCloudData, subscribeToSharedInventory, synchronize, synchronizeAndPull } from './cloudSync'
import { normalizeKey } from './utils'
import type { ComputerRecord, InventorySession } from './types'

const minute = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString()
const remoteComputer = (n: number, owner: string, sessionId: string): Row => ({
  id: `c${n}`, cloudId: `c${n}`, sessionId, ownerId: owner, ownerName: owner, ownerEmail: `${owner}@example.com`, equipmentType: 'Laptop',
  inventoryId: `INV-${n}`, inventoryNormalized: normalizeKey(`INV-${n}`), serialNumber: `SN-${n}`, serialNormalized: normalizeKey(`SN-${n}`),
  brand: 'Marca', model: 'Modelo', manufacturingYear: 2020, yearUnknown: false, operatingSystem: 'Windows', ramGB: 8, drives: [],
  originalCode: '', scannedAt: minute(n), timezone: 'UTC', latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '',
  createdAt: minute(n), updatedAt: minute(n)
})

const seed = () => {
  const sessions = new Map<string, Row>()
  const computers = new Map<string, Row>()
  for (let s = 0; s < 4; s++) sessions.set(`s${s}`, { id: `s${s}`, cloudId: `s${s}`, name: `Sesión ${s}`, date: '2026-01-01', location: '', ownerId: s % 2 ? 'bob' : 'alice', ownerName: '', ownerEmail: '', createdAt: minute(s), updatedAt: minute(s) })
  for (let n = 0; n < 250; n++) computers.set(`c${n}`, remoteComputer(n, n % 2 ? 'bob' : 'alice', `s${n % 4}`))
  store.data = new Map([['inventorySessions', sessions], ['inventoryComputers', computers]])
  store.reads = 0
  store.setCalls = 0
  store.activeSets = 0
  store.maxActiveSets = 0
  store.failSetAt = 0
  store.failReads = false
  store.setDelayMs = 0
  store.deleteLog = []
  store.listeners = new Map()
  store.setHook = undefined
  store.getDocsHook = undefined
  photoStore.failUpload = false
  photoStore.uploads = 0
  photoStore.failDeletes = 0
  photoStore.deletes = []
  photoStore.uploadHook = undefined
}

const emitRemoteChanges = async (collectionName: string, changes: Array<{ type: 'added' | 'modified' | 'removed'; id: string; row?: Row }>) => {
  const snapshot = {
    docChanges: () => changes.map((change) => ({
      type: change.type,
      doc: { id: change.id, exists: () => change.type !== 'removed', data: () => change.row }
    }))
  }
  for (const listener of store.listeners.get(collectionName) ?? []) listener.next(snapshot)
  await vi.waitFor(async () => {
    await Promise.resolve()
  })
}

const localSession = (owner = 'alice'): InventorySession => ({
  id: 'local-session', name: 'Sin conexión', date: '2026-01-01', location: '', ownerId: owner,
  ownerName: owner, ownerEmail: `${owner}@example.com`, syncStatus: 'local', createdAt: minute(0), updatedAt: minute(0)
})

const localComputer = (n: number, owner = 'alice'): ComputerRecord => ({
  ...(remoteComputer(n, owner, 'local-session') as ComputerRecord), id: `local-${n}`, cloudId: undefined,
  inventoryId: `OFF-${n}`, inventoryNormalized: normalizeKey(`OFF-${n}`), serialNumber: `OFF-SN-${n}`, serialNormalized: normalizeKey(`OFF-SN-${n}`),
  sharedCloud: false, syncStatus: 'local'
})

beforeEach(async () => {
  vi.stubGlobal('navigator', { onLine: true })
  await clearAllData()
  seed()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })



describe('cursor de descarga y exclusiones', () => {
  const setRemote = (id: string, changes: Row) => store.data.get('inventoryComputers')!.set(id, { ...store.data.get('inventoryComputers')!.get(id)!, ...changes })

  it('con exclusiones el cursor no pasa del registro omitido: se descarga después sin forzar y sin omisiones permanentes', async () => {
    await pullCloudData('alice', { force: true }) // cursor inicial al día
    setRemote('c1', { notes: 'cambio c1', updatedAt: minute(900) })
    setRemote('c2', { notes: 'cambio c2', updatedAt: minute(950) })
    await pullCloudData('alice', { exclude: new Set(['c1']), keepLocalRecords: true })
    expect((await getComputer('c2'))?.notes).toBe('cambio c2')
    expect((await getComputer('c1'))?.notes).not.toBe('cambio c1')
    // Descarga incremental normal (sin forzar y sin exclusiones): el omitido llega aunque c2, más nuevo, ya se aplicó.
    await pullCloudData('alice')
    expect((await getComputer('c1'))?.notes).toBe('cambio c1')
  })

  it('un registro excluido no se omite para siempre aunque se hagan varias descargas con exclusiones', async () => {
    await pullCloudData('alice', { force: true })
    setRemote('c1', { notes: 'cambio c1', updatedAt: minute(3000) })
    for (let attempt = 0; attempt < 3; attempt += 1) await pullCloudData('alice', { exclude: new Set(['c1']), keepLocalRecords: true })
    expect((await getComputer('c1'))?.notes).not.toBe('cambio c1')
    await pullCloudData('alice', { exclude: new Set() })
    expect((await getComputer('c1'))?.notes).toBe('cambio c1')
  })

  it('las descargas sin exclusiones siguen avanzando el cursor: no relee todo cada vez', async () => {
    await pullCloudData('alice', { force: true })
    setRemote('c1', { notes: 'nuevo', updatedAt: minute(4000) })
    await pullCloudData('alice')
    expect((await getComputer('c1'))?.notes).toBe('nuevo')
    store.reads = 0
    await pullCloudData('alice')
    expect(store.reads).toBeLessThan(20)
  })

  it('una descarga con exclusiones no elimina registros locales ni siquiera los excluidos o los que desaparecieron de Firestore', async () => {
    await pullCloudData('alice', { force: true })
    const local = (await listComputers()).filter((item) => item.sharedCloud)
    store.data.get('inventoryComputers')!.delete(local[0].cloudId!)
    store.data.get('inventoryComputers')!.delete(local[1].cloudId!)
    await pullCloudData('alice', { force: true, exclude: new Set([local[0].id]), keepLocalRecords: true })
    expect(await getComputer(local[0].id)).toBeDefined()
    expect(await getComputer(local[1].id)).toBeDefined()
    expect((await listComputers()).length).toBe(local.length)
  })

  it('las exclusiones se respetan al encolar, subir, eliminar y limpiar', async () => {
    const photoBlob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    await saveSession(localSession('alice'))
    // Dos equipos con foto pendiente y sin operación en la cola (estado tras sincronizar sin ImageKit).
    await saveComputer({ ...localComputer(70), photo: photoBlob(), photoNeedsUpload: true }, false)
    await saveComputer({ ...localComputer(71), photo: photoBlob(), photoNeedsUpload: true }, false)
    await synchronize('alice', undefined, { force: true, scope: 'photos', exclude: new Set(['local-70']) })
    const queue = (await getPendingSyncQueue()).map((item) => item.id)
    expect(queue).not.toContain('computer:local-70') // no se encoló
    expect(store.data.get('inventoryComputers')!.has('local-70')).toBe(false)
    expect(store.data.get('inventoryComputers')!.has('local-71')).toBe(true)
    expect(photoStore.uploads).toBe(1)
    expect((await getComputer('local-70'))?.photo?.size).toBe(3)

    // Altas, bajas y limpiezas de registros excluidos permanecen en la cola, intactas.
    const previous = { fileId: 'old', url: 'https://example.com/old.jpg', filePath: '/inventario/alice/old.jpg', name: 'old.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: minute(0) }
    await saveComputer({ ...localComputer(72), cloudId: 'local-72', sharedCloud: true, photoRemote: previous })
    await saveComputer(localComputer(73))
    await synchronize('alice', undefined, { force: true, scope: 'operations' })
    await deleteComputer('local-72', 'alice')
    await saveComputer(localComputer(74))
    const before = (await getPendingSyncQueue()).filter((item) => ['local-72', 'local-74'].includes(item.entityId))
    store.deleteLog = []
    await synchronize('alice', undefined, { force: true, scope: 'all', exclude: new Set(['local-72', 'local-74']) })
    expect(store.deleteLog).toEqual([])
    expect(photoStore.deletes).toEqual([])
    expect((await getPendingSyncQueue()).filter((item) => ['local-72', 'local-74'].includes(item.entityId))).toEqual(before)
    expect(store.data.get('inventoryComputers')!.has('local-74')).toBe(false)
  })
})
