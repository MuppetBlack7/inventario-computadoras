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
  uploadedByKey: new Map<string, Row>(),
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
    updateDoc: async (ref: { name: string; id: string }, changes: Row) => {
      store.setCalls += 1
      if (store.failSetAt === store.setCalls) throw Object.assign(new Error('Red interrumpida'), { code: 'unavailable' })
      const previous = store.data.get(ref.name)?.get(ref.id)
      if (!previous) throw Object.assign(new Error('Documento inexistente'), { code: 'not-found' })
      store.data.get(ref.name)!.set(ref.id, { ...previous, ...changes })
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
  uploadPhotoToImageKit: vi.fn(async (computerId: string, photo: Blob, _fileName?: string, uploadKey = computerId) => {
    if (photoStore.failUpload) throw Object.assign(new Error('ImageKit no disponible'), { code: 'unavailable' })
    const previous = photoStore.uploadedByKey.get(uploadKey)
    if (previous) return previous
    photoStore.uploads += 1
    if (photoStore.uploadHook) await photoStore.uploadHook()
    const fileId = `photo-${photoStore.uploads}`
    const reference = { fileId, url: `https://example.com/${fileId}.jpg`, filePath: `/inventario/alice/${fileId}.jpg`, name: `${fileId}.jpg`, size: photo.size, width: null, height: null, mimeType: photo.type, uploadedAt: minute(0) }
    photoStore.uploadedByKey.set(uploadKey, reference)
    return reference
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

import { getComputer, getDatabase, clearAllData, deleteComputer, deleteSessionAndComputers, getPendingSyncQueue, listComputers, listSessions, listVisibleComputers, queuePhotoCleanup, saveComputer, saveSession, saveSharedComputerPhoto } from './db'
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
  photoStore.uploadedByKey = new Map()
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

describe('actualización compartida de fotografías', () => {
  it('permite que Bob reemplace la foto del equipo de Alice sin cambiar propietario ni otros datos', async () => {
    await pullCloudData('bob', { force: true })
    const aliceComputer = (await listComputers()).find((item) => item.cloudId === 'c0')!
    const saved = await saveSharedComputerPhoto({ ...aliceComputer, photo: new Blob(['foto-bob'], { type: 'image/jpeg' }), photoName: 'foto-bob.jpg' }, 'bob')
    expect(saved.ownerId).toBe('alice')
    expect((await getPendingSyncQueue()).find((item) => item.entityId === saved.id)).toMatchObject({ operation: 'update-computer-photo', ownerId: 'bob', recordOwnerId: 'alice' })
    const result = await synchronize('bob')
    const remote = store.data.get('inventoryComputers')!.get('c0')!
    expect(result).toMatchObject({ synced: 1, errors: 0, pending: 0 })
    expect(remote.ownerId).toBe('alice')
    expect(remote.model).toBe('Modelo')
    expect(remote.photoRemote.fileId).toBe('photo-1')
    expect((await listComputers()).find((item) => item.cloudId === 'c0')?.ownerId).toBe('alice')
  })

  it('conserva pendiente una subida fallida y la reintenta sin duplicar el archivo', async () => {
    await pullCloudData('bob', { force: true })
    const aliceComputer = (await listComputers()).find((item) => item.cloudId === 'c2')!
    await saveSharedComputerPhoto({ ...aliceComputer, photo: new Blob(['foto-pendiente'], { type: 'image/webp' }), photoName: 'foto.webp' }, 'bob')
    photoStore.failUpload = true
    const failed = await synchronize('bob')
    expect(failed).toMatchObject({ synced: 0, errors: 1, pending: 1 })
    expect(store.data.get('inventoryComputers')!.get('c2')!.photoRemote).toBeUndefined()
    expect((await listComputers()).find((item) => item.cloudId === 'c2')?.photoUploadStatus).not.toBe('uploaded')
    photoStore.failUpload = false
    const recovered = await synchronize('bob', undefined, { force: true })
    expect(recovered.pending).toBe(0)
    expect(photoStore.uploads).toBe(1)
  })

  it('reutiliza la subida confirmada si Firestore falla antes de guardar la referencia', async () => {
    await pullCloudData('bob', { force: true })
    const aliceComputer = (await listComputers()).find((item) => item.cloudId === 'c4')!
    await saveSharedComputerPhoto({ ...aliceComputer, photo: new Blob(['foto-confirmada'], { type: 'image/png' }), photoName: 'foto.png' }, 'bob')
    store.failSetAt = 1
    const failed = await synchronize('bob')
    expect(failed).toMatchObject({ errors: 1, pending: 1 })
    expect(photoStore.uploads).toBe(1)
    expect(store.data.get('inventoryComputers')!.get('c4')!.photoRemote).toBeUndefined()
    store.failSetAt = 0
    const recovered = await synchronize('bob', undefined, { force: true })
    expect(recovered.pending).toBe(0)
    expect(photoStore.uploads).toBe(1)
    expect(store.data.get('inventoryComputers')!.get('c4')!.photoRemote.fileId).toBe('photo-1')
  })
})

describe('fallos de Blob durante la sincronización local', () => {
  it('conserva la cola y reutiliza la misma subida si IndexedDB falla al confirmar el estado local', async () => {
    await saveSession(localSession())
    await saveComputer({
      ...localComputer(40),
      photo: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }),
      photoName: 'equipo.jpg',
      photoNeedsUpload: true,
      photoUploadStatus: 'pending',
      photoLocalRevision: 'blob-revision-1'
    })
    const originalPut = IDBObjectStore.prototype.put
    let reproduced = false
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const record = value as Partial<ComputerRecord>
      if (!reproduced && this.name === 'computers' && record.syncStatus === 'synced' && record.photoUploadStatus === 'uploaded') {
        reproduced = true
        throw new DOMException('Error preparing Blob/File data to be stored in object store', 'UnknownError')
      }
      return originalPut.call(this, value, key)
    })

    const failed = await synchronize('alice')
    expect(reproduced).toBe(true)
    expect(failed).toMatchObject({ synced: 1, errors: 1, pending: 1 })
    expect(failed.lastError).toContain('El navegador no pudo guardar el registro en este dispositivo')
    expect(photoStore.uploads).toBe(1)
    const pending = await getPendingSyncQueue()
    expect(pending.find((item) => item.entityId === 'local-40')).toMatchObject({
      operation: 'upsert-computer',
      retryable: true,
      photoCandidate: { fileId: 'photo-1' }
    })

    putSpy.mockRestore()
    const retried = await synchronize('alice', undefined, { force: true })
    expect(retried.pending).toBe(0)
    expect(photoStore.uploads).toBe(1)
    expect((await getComputer('local-40'))?.photoRemote?.fileId).toBe('photo-1')
  })
})

describe('descarga incremental de Firestore', () => {
  it('la primera descarga pagina 250 equipos de 4 sesiones y dos usuarios', async () => {
    const result = await pullCloudData('bob', { force: true })
    expect(result.computers).toBe(250)
    expect(await listSessions()).toHaveLength(4)
    expect((await listVisibleComputers('bob')).filter((item) => item.ownerId === 'alice')).toHaveLength(125)
  })

  it('las descargas siguientes solo leen documentos modificados y comparten la consulta en curso', async () => {
    await pullCloudData('bob', { force: true })
    store.reads = 0
    const [a, b] = await Promise.all([pullCloudData('bob'), pullCloudData('bob')])
    expect(a).toBe(b)
    expect(store.reads).toBeLessThan(40)
    store.data.get('inventoryComputers')!.set('new', { ...remoteComputer(999, 'alice', 's1'), id: 'new', cloudId: 'new', updatedAt: minute(500) })
    store.reads = 0
    await pullCloudData('bob')
    expect((await listComputers()).some((item) => item.cloudId === 'new')).toBe(true)
    expect(store.reads).toBeLessThan(40)
  })

  it('detecta borrados remotos con conteo y reconciliación completa', async () => {
    await pullCloudData('bob', { force: true })
    store.data.get('inventoryComputers')!.delete('c10')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    await pullCloudData('bob')
    expect(await listComputers()).toHaveLength(249)
  })

  it('no recupera una sesión eliminada cuyo borrado sigue pendiente', async () => {
    await pullCloudData('alice', { force: true })
    await deleteSessionAndComputers('s0', 'alice')
    await pullCloudData('alice', { force: true })
    expect((await listSessions()).some((item) => item.id === 's0')).toBe(false)
    expect((await listComputers()).some((item) => item.sessionId === 's0')).toBe(false)
    await synchronize('alice')
    expect(store.data.get('inventorySessions')!.has('s0')).toBe(false)
    expect([...store.data.get('inventoryComputers')!.values()].some((row) => row.sessionId === 's0')).toBe(false)
    expect(store.deleteLog.at(-1)).toBe('inventorySessions/s0')
  })

  it('sin conexión no consulta Firestore y conserva los datos locales', async () => {
    await pullCloudData('bob', { force: true })
    vi.stubGlobal('navigator', { onLine: false })
    store.reads = 0
    expect((await pullCloudData('bob')).reads).toBe(0)
    expect(store.reads).toBe(0)
    expect(await listComputers()).toHaveLength(250)
  })

  it('un usuario no sube cambios sobre registros de otro', async () => {
    await pullCloudData('bob', { force: true })
    const alice = (await listComputers()).find((item) => item.ownerId === 'alice')!
    await saveComputer({ ...alice, model: 'Editado por Bob' })
    await synchronize('bob')
    expect(store.data.get('inventoryComputers')!.get(alice.cloudId!)!.model).toBe('Modelo')
  })

  it('sincroniza más de 20 equipos capturados sin conexión y vacía solo su cola', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    await saveSession(localSession())
    for (let n = 0; n < 25; n++) await saveComputer(localComputer(n))
    expect((await getPendingSyncQueue()).filter((item) => item.ownerId === 'alice')).toHaveLength(26)
    vi.stubGlobal('navigator', { onLine: true })
    const result = await synchronize('alice')
    expect(result).toMatchObject({ synced: 26, errors: 0, pending: 0 })
    expect([...store.data.get('inventoryComputers')!.keys()].filter((id) => id.startsWith('local-'))).toHaveLength(25)
  })

  it('conserva pendientes tras una interrupción y los completa al reintentar', async () => {
    await saveSession(localSession())
    for (let n = 0; n < 20; n++) await saveComputer(localComputer(n))
    store.failSetAt = 11
    const interrupted = await synchronize('alice')
    expect(interrupted.errors).toBe(1)
    expect(interrupted.pending).toBeGreaterThan(0)
    expect((await getPendingSyncQueue()).some((item) => item.lastError === 'Red interrumpida')).toBe(true)
    store.failSetAt = 0
    const recovered = await synchronize('alice', undefined, { force: true })
    expect(recovered.pending).toBe(0)
    expect([...store.data.get('inventoryComputers')!.keys()].filter((id) => id.startsWith('local-'))).toHaveLength(20)
  })

  it('mantiene la cola persistente al volver a abrir y no descarta errores de Firebase', async () => {
    await saveComputer(localComputer(1))
    store.failSetAt = 1
    await synchronize('alice')
    const beforeReload = await getPendingSyncQueue()
    expect(beforeReload).toHaveLength(1)
    expect(beforeReload[0].attempts).toBe(1)
    expect((await listComputers())[0].model).toBe('Modelo')
    store.failSetAt = 0
    await synchronize('alice', undefined, { force: true })
    expect(await getPendingSyncQueue()).toHaveLength(0)
  })

  it('si hay una edición durante la confirmación no borra la revisión nueva y termina idempotente', async () => {
    await saveComputer(localComputer(2))
    let edited = false
    store.setHook = async (ref) => {
      if (!edited && ref.name === 'inventoryComputers') {
        edited = true
        const latest = (await listComputers()).find((item) => item.id === 'local-2')!
        await saveComputer({ ...latest, model: 'Modelo final' })
      }
    }
    const result = await synchronize('alice')
    expect(result.pending).toBe(0)
    expect(store.data.get('inventoryComputers')!.get('local-2')!.model).toBe('Modelo final')
    expect((await listComputers()).filter((item) => item.id === 'local-2')).toHaveLength(1)
  })

  it('colapsa crear y editar sin conexión y convierte crear-eliminar en borrado idempotente', async () => {
    await saveComputer(localComputer(3))
    await saveComputer({ ...(await listComputers()).find((item) => item.id === 'local-3')!, model: 'Último modelo' })
    expect((await getPendingSyncQueue()).filter((item) => item.entityId === 'local-3')).toHaveLength(1)
    await synchronize('alice')
    expect(store.data.get('inventoryComputers')!.get('local-3')!.model).toBe('Último modelo')

    await saveComputer(localComputer(4))
    await deleteComputer('local-4', 'alice')
    expect((await getPendingSyncQueue()).find((item) => item.entityId === 'local-4')?.operation).toBe('delete-computer')
    await synchronize('alice')
    expect(store.data.get('inventoryComputers')!.has('local-4')).toBe(false)
    expect((await getPendingSyncQueue()).some((item) => item.entityId === 'local-4')).toBe(false)
  })

  it('comparte una sola ejecución entre solicitudes concurrentes', async () => {
    await saveComputer(localComputer(5))
    store.setDelayMs = 20
    const first = synchronize('alice')
    const second = synchronize('alice')
    expect(first).toBe(second)
    await Promise.all([first, second])
    expect(store.maxActiveSets).toBe(1)
    expect(store.setCalls).toBe(1)
  })

  it('conserva y reintenta una foto fallida sin duplicar el documento remoto', async () => {
    photoStore.failUpload = true
    await saveComputer({ ...localComputer(6), photo: new Blob(['foto'], { type: 'image/jpeg' }), photoNeedsUpload: true, photoUploadStatus: 'pending' })
    const failed = await synchronize('alice')
    let stored = (await listComputers()).find((item) => item.id === 'local-6')!
    expect(failed).toMatchObject({ errors: 1, pending: 1 })
    expect(stored.photo?.size).toBe(4)
    expect(stored.photoNeedsUpload).toBe(true)
    expect(store.data.get('inventoryComputers')!.get('local-6')!.photo).toBeUndefined()
    expect([...store.data.get('inventoryComputers')!.keys()].filter((id) => id === 'local-6')).toHaveLength(1)
    photoStore.failUpload = false
    const recovered = await synchronize('alice', undefined, { force: true })
    stored = (await listComputers()).find((item) => item.id === 'local-6')!
    expect(recovered.pending).toBe(0)
    expect(stored.photo?.size).toBe(4)
    expect(stored.photoRemote?.fileId).toBe('photo-1')
    expect([...store.data.get('inventoryComputers')!.keys()].filter((id) => id === 'local-6')).toHaveLength(1)
  })

  it('un equipo con fotografía guardado sin Internet se sincroniza al recuperar la conexión', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const bytes = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]
    await saveComputer({ ...localComputer(9), photo: new Blob([new Uint8Array(bytes)], { type: 'image/png' }), photoNeedsUpload: true, photoUploadStatus: 'pending' })
    await synchronize('alice')
    expect(store.setCalls).toBe(0)
    let stored = (await listComputers()).find((item) => item.id === 'local-9')!
    expect(stored.syncStatus).not.toBe('synced')
    expect(Array.from(new Uint8Array(await stored.photo!.arrayBuffer()))).toEqual(bytes)
    expect((await getPendingSyncQueue()).some((item) => item.id === 'computer:local-9')).toBe(true)
    vi.stubGlobal('navigator', { onLine: true })
    const result = await synchronize('alice', undefined, { force: true })
    stored = (await listComputers()).find((item) => item.id === 'local-9')!
    expect(result.pending).toBe(0)
    expect(stored.syncStatus).toBe('synced')
    expect(stored.photoRemote?.mimeType).toBe('image/png')
    expect(store.data.get('inventoryComputers')!.get('local-9')).toBeDefined()
  })

  it('una edición local hecha mientras se descarga no se sobrescribe con datos remotos antiguos', async () => {
    await pullCloudData('alice', { force: true })
    store.data.get('inventoryComputers')!.set('c0', { ...remoteComputer(0, 'alice', 's0'), notes: 'remoto', updatedAt: minute(500) })
    let fired = false
    store.getDocsHook = async (name) => {
      if (name !== 'inventoryComputers' || fired) return
      fired = true
      await saveComputer({ ...(await getComputer('c0'))!, notes: 'edición local' })
    }
    await pullCloudData('alice', { force: true })
    expect(fired).toBe(true)
    expect((await getComputer('c0'))?.notes).toBe('edición local')
    store.getDocsHook = undefined
    await synchronize('alice')
    expect(store.data.get('inventoryComputers')!.get('c0')!.notes).toBe('edición local')
  })

  it('un borrado remoto no elimina localmente un equipo editado durante la descarga', async () => {
    await pullCloudData('alice', { force: true })
    store.data.get('inventoryComputers')!.delete('c0')
    let fired = false
    store.getDocsHook = async (name) => {
      if (name !== 'inventoryComputers' || fired) return
      fired = true
      await saveComputer({ ...(await getComputer('c0'))!, notes: 'edición local' })
    }
    await pullCloudData('alice', { force: true })
    store.getDocsHook = undefined
    expect((await getComputer('c0'))?.notes).toBe('edición local')
  })

  it('una operación pendiente de otra cuenta no se ejecuta y queda intacta en la cola', async () => {
    await saveSession(localSession('bob'))
    await saveComputer(localComputer(9, 'bob'))
    const before = JSON.stringify(await getPendingSyncQueue())
    const result = await synchronize('alice', undefined, { force: true })
    expect(result.synced).toBe(0)
    expect(store.setCalls).toBe(0)
    expect(store.deleteLog).toEqual([])
    expect(JSON.stringify(await getPendingSyncQueue())).toBe(before)
  })

  it('una baja de un registro ajeno no se ejecuta, conserva el documento remoto y la operación queda con su error', async () => {
    await pullCloudData('alice', { force: true })
    const bobs = (await listComputers()).find((item) => item.ownerId === 'bob')!
    await deleteComputer(bobs.id, 'alice')
    const result = await synchronize('alice', undefined, { force: true })
    expect(result.errors).toBeGreaterThan(0)
    expect(store.deleteLog).toEqual([])
    expect(store.data.get('inventoryComputers')!.has(bobs.cloudId!)).toBe(true)
    const queued = (await getPendingSyncQueue()).find((item) => item.entityId === bobs.id)
    expect(queued).toMatchObject({ operation: 'delete-computer', ownerId: 'alice' })
    expect(queued?.lastError).toMatch(/creador/)
  })

  it('las operaciones pendientes de otra cuenta no bloquean las del usuario autenticado y siguen intactas', async () => {
    await saveSession(localSession('alice'))
    await saveSession({ ...localSession('bob'), id: 'bob-session' })
    await saveComputer(localComputer(1, 'alice'))
    await saveComputer({ ...localComputer(2, 'bob'), sessionId: 'bob-session' })
    const bobsBefore = JSON.stringify((await getPendingSyncQueue()).filter((item) => item.ownerId === 'bob'))
    const result = await synchronize('alice', undefined, { force: true })
    expect(result).toMatchObject({ synced: 2, errors: 0, pending: 0 })
    expect(store.data.get('inventoryComputers')!.has('local-1')).toBe(true)
    expect(store.data.get('inventoryComputers')!.has('local-2')).toBe(false)
    expect(JSON.stringify((await getPendingSyncQueue()).filter((item) => item.ownerId === 'bob'))).toBe(bobsBefore)
  })

  it('la baja de una sesión no espera bajas pendientes de otra cuenta y no modifica nada ajeno', async () => {
    const bobsDocument = { ...remoteComputer(50, 'bob', 'local-session'), id: 'bobpc', cloudId: 'bobpc' }
    store.data.get('inventoryComputers')!.set('bobpc', bobsDocument)
    await saveSession(localSession('alice'))
    await synchronize('alice', undefined, { force: true })
    expect(store.data.get('inventorySessions')!.has('local-session')).toBe(true)
    await deleteSessionAndComputers('local-session', 'alice')
    const bobsOperation = { id: 'computer:bobpc', operation: 'delete-computer' as const, entityId: 'bobpc', remoteId: 'bobpc', sessionId: 'local-session', ownerId: 'bob', createdAt: minute(1), revision: 'bob-1', attempts: 2, lastError: 'sin red' }
    await (await getDatabase()).put('syncQueue', bobsOperation)
    const result = await synchronize('alice', undefined, { force: true })
    expect(store.data.get('inventorySessions')!.has('local-session')).toBe(false)
    expect(store.deleteLog).toEqual(['inventorySessions/local-session'])
    expect(store.data.get('inventoryComputers')!.get('bobpc')).toBe(bobsDocument)
    const queue = await getPendingSyncQueue()
    expect(queue).toEqual([bobsOperation])
    expect(result).toMatchObject({ errors: 0, pending: 0 })
  })

  it('las bajas pendientes propias de la misma sesión siguen teniendo que terminar antes de borrar la sesión', async () => {
    const bobsDocument = { ...remoteComputer(50, 'bob', 'local-session'), id: 'bobpc', cloudId: 'bobpc' }
    store.data.get('inventoryComputers')!.set('bobpc', bobsDocument)
    await saveSession(localSession('alice'))
    await synchronize('alice', undefined, { force: true })
    await saveComputer({ ...localComputer(50, 'bob'), id: 'bobpc', cloudId: 'bobpc', sharedCloud: true }, false)
    await deleteSessionAndComputers('local-session', 'alice') // encola una baja propia sobre un equipo ajeno, que se rechazará
    const result = await synchronize('alice', undefined, { force: true })
    expect(result.errors).toBeGreaterThan(0)
    expect(store.data.get('inventorySessions')!.has('local-session')).toBe(true)
    expect(store.data.get('inventoryComputers')!.get('bobpc')).toBe(bobsDocument)
    expect(store.deleteLog).toEqual([])
    expect((await getPendingSyncQueue()).map((item) => item.operation).sort()).toEqual(['delete-computer', 'delete-session'])
  })

  describe('alcances independientes de la sincronización', () => {
    const photoBlob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    const withPhoto = (n: number, owner = 'alice') => ({ ...localComputer(n, owner), photo: photoBlob(), photoNeedsUpload: true, photoUploadStatus: 'pending' as const, photoLocalRevision: `rev-${n}` })
    const ownQueue = async () => (await getPendingSyncQueue()).map((item) => item.id).sort()

    it('solo operaciones: sube el documento pero no la fotografía, que sigue local y pendiente', async () => {
      await saveSession(localSession('alice'))
      await saveComputer(withPhoto(1))
      const result = await synchronize('alice', undefined, { force: true, scope: 'operations' })
      expect(result).toMatchObject({ errors: 0, pending: 0 })
      expect(store.data.get('inventoryComputers')!.has('local-1')).toBe(true)
      expect(store.data.get('inventoryComputers')!.get('local-1')!.photoRemote).toBeUndefined()
      expect(photoStore.uploads).toBe(0)
      const stored = (await getComputer('local-1'))!
      expect(stored.photo?.size).toBe(3)
      expect(stored.photoRemote).toBeUndefined()
      expect(stored.photoNeedsUpload).toBe(true)
    })

    it('solo operaciones no ejecuta limpiezas de ImageKit ni las elimina de la cola', async () => {
      const previous = { fileId: 'old-photo', url: 'https://example.com/old.jpg', filePath: '/inventario/alice/old.jpg', name: 'old.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: minute(0) }
      await saveSession(localSession('alice'))
      await saveComputer({ ...localComputer(2), cloudId: 'local-2', sharedCloud: true, photoRemote: previous })
      await synchronize('alice', undefined, { force: true })
      await deleteComputer('local-2', 'alice')
      const result = await synchronize('alice', undefined, { force: true, scope: 'operations' })
      expect(result.errors).toBe(0)
      expect(store.deleteLog).toContain('inventoryComputers/local-2')
      expect(photoStore.deletes).toEqual([])
      expect((await getPendingSyncQueue()).map((item) => item.operation)).toEqual(['cleanup-photo'])
    })

    it('solo fotografías: procesa únicamente equipos con foto pendiente y deja el resto de la cola intacta', async () => {
      await saveSession(localSession('alice'))
      await saveComputer(withPhoto(3))
      await saveComputer(localComputer(4))
      const before = (await getPendingSyncQueue()).filter((item) => item.entityId !== 'local-3')
      const result = await synchronize('alice', undefined, { force: true, scope: 'photos' })
      expect(result).toMatchObject({ errors: 0 })
      expect(photoStore.uploads).toBe(1)
      expect(store.data.get('inventoryComputers')!.get('local-3')!.photoRemote.fileId).toBe('photo-1')
      expect(store.data.get('inventoryComputers')!.has('local-4')).toBe(false)
      expect(store.data.get('inventorySessions')!.has('local-session')).toBe(false)
      expect((await getPendingSyncQueue())).toEqual(before)
      expect((await getComputer('local-3'))?.photo?.size).toBe(3)
    })

    it('operaciones y después fotografías equivale a una sincronización completa sin duplicar documentos ni archivos', async () => {
      await saveSession(localSession('alice'))
      await saveComputer(withPhoto(5))
      await synchronize('alice', undefined, { force: true, scope: 'operations' })
      await synchronize('alice', undefined, { force: true, scope: 'photos' })
      await synchronize('alice', undefined, { force: true, scope: 'photos' })
      expect(photoStore.uploads).toBe(1)
      expect([...store.data.get('inventoryComputers')!.keys()].filter((key) => key === 'local-5')).toHaveLength(1)
      expect(store.data.get('inventoryComputers')!.get('local-5')!.photoRemote.fileId).toBe('photo-1')
      expect(await ownQueue()).toEqual([])
    })

    it('en ningún alcance se ejecutan operaciones de otra cuenta ni se suben fotografías ajenas', async () => {
      await saveSession(localSession('bob'))
      await saveComputer(withPhoto(6, 'bob'))
      const before = JSON.stringify(await getPendingSyncQueue())
      for (const scope of ['operations', 'photos', 'all'] as const) {
        await synchronize('alice', undefined, { force: true, scope })
      }
      expect(store.setCalls).toBe(0)
      expect(photoStore.uploads).toBe(0)
      expect(JSON.stringify(await getPendingSyncQueue())).toBe(before)
      expect((await getComputer('local-6'))?.photo?.size).toBe(3)
    })

    it('los registros excluidos no se tocan y el resto sí se procesa', async () => {
      await saveSession(localSession('alice'))
      await saveComputer(localComputer(7))
      await saveComputer(localComputer(8))
      const result = await synchronize('alice', undefined, { force: true, scope: 'operations', exclude: new Set(['local-7']) })
      expect(result.errors).toBe(0)
      expect(store.data.get('inventoryComputers')!.has('local-8')).toBe(true)
      expect(store.data.get('inventoryComputers')!.has('local-7')).toBe(false)
      expect((await getPendingSyncQueue()).map((item) => item.id)).toEqual(['computer:local-7'])
    })

    it('alcances distintos pedidos a la vez se ejecutan en secuencia, nunca en paralelo', async () => {
      await saveSession(localSession('alice'))
      await saveComputer(withPhoto(9))
      store.setDelayMs = 5
      await Promise.all([
        synchronize('alice', undefined, { force: true, scope: 'operations' }),
        synchronize('alice', undefined, { force: true, scope: 'photos' })
      ])
      expect(store.maxActiveSets).toBe(1)
      expect(photoStore.uploads).toBe(1)
    })

    it('descargar con exclusiones no aplica los registros excluidos, no avanza el cursor y no toca los 39 importados', async () => {
      await pullCloudData('alice', { force: true })
      const imported = { ...localComputer(60), id: 'imp-alice-orig60', cloudId: 'imp-alice-orig60', importedFrom: { id: 'orig60', importedAt: minute(0) }, sharedCloud: true, syncStatus: 'synced' as const }
      await saveComputer(imported, false)
      store.data.get('inventoryComputers')!.set('imp-alice-orig60', { ...remoteComputer(60, 'alice', 'local-session'), id: 'imp-alice-orig60', cloudId: 'imp-alice-orig60', importedFrom: imported.importedFrom })
      store.data.get('inventoryComputers')!.set('c1', { ...store.data.get('inventoryComputers')!.get('c1')!, notes: 'cambio remoto', updatedAt: minute(900) })
      await pullCloudData('alice', { exclude: new Set(['c1']) })
      expect((await getComputer('c1'))?.notes).toBe('')
      await pullCloudData('alice') // sin exclusiones el mismo cambio sí llega: el cursor no se adelantó
      expect((await getComputer('c1'))?.notes).toBe('cambio remoto')
      const stored = (await getComputer('imp-alice-orig60'))!
      expect(stored.ownerId).toBe('alice')
      expect(stored.importedFrom?.id).toBe('orig60')
    })

    it('un error parcial en un alcance conserva la cola y el reintento termina sin duplicar documentos', async () => {
      await saveSession(localSession('alice'))
      await saveComputer(localComputer(80))
      await saveComputer(localComputer(81))
      await saveComputer(localComputer(82))
      store.failSetAt = 3 // la tercera escritura falla (red interrumpida)
      const first = await synchronize('alice', undefined, { force: true, scope: 'operations' })
      expect(first.errors).toBeGreaterThan(0)
      const remaining = (await getPendingSyncQueue()).map((item) => item.id)
      expect(remaining.length).toBeGreaterThan(0)
      expect(remaining.every((id) => id.startsWith('computer:') || id.startsWith('session:'))).toBe(true)
      for (const id of remaining) expect((await getPendingSyncQueue()).find((item) => item.id === id)).toBeDefined()
      store.failSetAt = 0
      const retry = await synchronize('alice', undefined, { force: true, scope: 'operations' })
      expect(retry).toMatchObject({ errors: 0, pending: 0 })
      const keys = [...store.data.get('inventoryComputers')!.keys()]
      for (const id of ['local-80', 'local-81', 'local-82']) expect(keys.filter((key) => key === id)).toHaveLength(1)
      expect(await getPendingSyncQueue()).toEqual([])
    })

    it('si falla la subida de una fotografía la foto local y su operación se conservan y el reintento no duplica el archivo', async () => {
      const bytes = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
      await saveSession(localSession('alice'))
      await saveComputer({ ...localComputer(83), photo: bytes(), photoNeedsUpload: true, photoUploadStatus: 'pending' as const, photoLocalRevision: 'rev-83' })
      await synchronize('alice', undefined, { force: true, scope: 'operations' })
      photoStore.failUpload = true
      const failed = await synchronize('alice', undefined, { force: true, scope: 'photos' })
      expect(failed.errors).toBeGreaterThan(0)
      expect(photoStore.uploads).toBe(0)
      const stored = (await getComputer('local-83'))!
      expect(stored.photo?.size).toBe(3)
      expect(stored.photoRemote).toBeUndefined()
      expect((await getPendingSyncQueue()).map((item) => item.id)).toContain('computer:local-83')
      photoStore.failUpload = false
      await synchronize('alice', undefined, { force: true, scope: 'photos' })
      await synchronize('alice', undefined, { force: true, scope: 'photos' })
      expect(photoStore.uploads).toBe(1)
      expect((await getComputer('local-83'))?.photoRemote?.fileId).toBe('photo-1')
      expect((await getComputer('local-83'))?.photo?.size).toBe(3)
    })

    it('no escribe en Firestore antes de ejecutar un alcance: preparar la cola es local', async () => {
      await saveComputer({ ...localComputer(84), sharedCloud: false }, false)
      const { enqueueOwnUploads } = await import('./db')
      expect(await enqueueOwnUploads('alice', ['local-84'])).toBe(1)
      expect(store.setCalls).toBe(0)
      expect(store.data.get('inventoryComputers')!.has('local-84')).toBe(false)
    })

    it('lo registrado sin internet se conserva al recargar, no se sube al volver la conexión y solo se envía tras la acción confirmada', async () => {
      const bytes = () => new Blob([new Uint8Array([4, 5, 6])], { type: 'image/jpeg' })
      vi.stubGlobal('navigator', { onLine: false })
      await saveSession(localSession('alice'))
      await saveComputer({ ...localComputer(90), photo: bytes(), photoNeedsUpload: true, photoUploadStatus: 'pending' as const, photoLocalRevision: 'rev-90' })
      await saveComputer(localComputer(91))
      ;(await getDatabase()).close() // recargar la aplicación
      expect((await getComputer('local-90'))?.photo?.size).toBe(3)
      expect((await getPendingSyncQueue()).length).toBeGreaterThanOrEqual(3)
      expect(store.setCalls).toBe(0)
      // Vuelve internet: no hay ninguna subida por sí sola.
      vi.stubGlobal('navigator', { onLine: true })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(store.setCalls).toBe(0)
      expect(photoStore.uploads).toBe(0)
      // La persona revisa y confirma: solo entonces se sube, una sola vez por documento y por archivo.
      await synchronize('alice', undefined, { force: true, scope: 'operations' })
      await synchronize('alice', undefined, { force: true, scope: 'photos' })
      await synchronize('alice', undefined, { force: true, scope: 'photos' })
      const keys = [...store.data.get('inventoryComputers')!.keys()]
      expect(keys.filter((key) => key === 'local-90')).toHaveLength(1)
      expect(keys.filter((key) => key === 'local-91')).toHaveLength(1)
      expect(photoStore.uploads).toBe(1)
      expect((await getComputer('local-90'))?.photo?.size).toBe(3)
      expect((await getComputer('local-90'))?.photoRemote?.fileId).toBe('photo-1')
      expect(await getPendingSyncQueue()).toEqual([])
    })

    it('si Firebase falla a mitad de la subida confirmada, la cola y las fotos locales se conservan y el reintento no duplica', async () => {
      const bytes = () => new Blob([new Uint8Array([4, 5, 6])], { type: 'image/jpeg' })
      await saveSession(localSession('alice'))
      await saveComputer({ ...localComputer(92), photo: bytes(), photoNeedsUpload: true, photoUploadStatus: 'pending' as const, photoLocalRevision: 'rev-92' })
      await saveComputer(localComputer(93))
      store.failSetAt = 2
      const first = await synchronize('alice', undefined, { force: true, scope: 'operations' })
      expect(first.errors).toBeGreaterThan(0)
      expect((await getPendingSyncQueue()).length).toBeGreaterThan(0)
      expect((await getComputer('local-92'))?.photo?.size).toBe(3)
      store.failSetAt = 0
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await synchronize('alice', undefined, { force: true, scope: 'operations' })
        await synchronize('alice', undefined, { force: true, scope: 'photos' })
      }
      const keys = [...store.data.get('inventoryComputers')!.keys()]
      expect(keys.filter((key) => key === 'local-92' || key === 'local-93').sort()).toEqual(['local-92', 'local-93'])
      expect(photoStore.uploads).toBe(1)
      expect(await getPendingSyncQueue()).toEqual([])
    })

    it('descargar sin eliminar registros locales conserva los que ya no existen en Firestore', async () => {
      await pullCloudData('alice', { force: true })
      const mirrored = (await listComputers()).find((item) => item.sharedCloud)!
      store.data.get('inventoryComputers')!.delete(mirrored.cloudId!)
      await pullCloudData('alice', { force: true, keepLocalRecords: true })
      expect(await getComputer(mirrored.id)).toBeDefined()
      await pullCloudData('alice', { force: true }) // el comportamiento normal sí concilia la baja remota
      expect(await getComputer(mirrored.id)).toBeUndefined()
    })

    it('los 39 equipos importados ya sincronizados no generan escrituras en ningún alcance', async () => {
      for (let n = 0; n < 39; n += 1) {
        const id = `imp-alice-orig${n}`
        const row = { ...localComputer(100 + n), id, cloudId: id, importedFrom: { id: `orig${n}`, importedAt: minute(0) }, sharedCloud: true, syncStatus: 'synced' as const, photoRemote: { fileId: `f${n}`, url: 'https://example.com/x', filePath: '/inventario/alice/x', name: 'x', size: 1, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: minute(0) } }
        await saveComputer(row, false)
        store.data.get('inventoryComputers')!.set(id, { ...remoteComputer(100 + n, 'alice', 'local-session'), id, cloudId: id, photoRemote: row.photoRemote })
      }
      for (const scope of ['operations', 'photos', 'all'] as const) await synchronize('alice', undefined, { force: true, scope })
      expect(store.setCalls).toBe(0)
      expect(photoStore.uploads).toBe(0)
      expect((await listComputers()).filter((item) => item.importedFrom && item.ownerId === 'alice')).toHaveLength(39)
    })
  })

  it('descarga después de subir sin desaparecer ni duplicar el registro local', async () => {
    await saveComputer(localComputer(7))
    await synchronize('alice')
    await pullCloudData('alice', { force: true })
    expect((await listComputers()).filter((item) => item.id === 'local-7')).toHaveLength(1)
  })

  it('reemplaza una foto y limpia la anterior solo después de confirmar la nueva', async () => {
    const previous = { fileId: 'old-photo', url: 'https://example.com/old.jpg', filePath: '/inventario/alice/old.jpg', name: 'old.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: minute(0) }
    const record = { ...localComputer(8), cloudId: 'local-8', sharedCloud: true, photoRemote: previous, photo: new Blob(['new'], { type: 'image/jpeg' }), photoNeedsUpload: true, photoLocalRevision: 'photo-rev-1' }
    store.data.get('inventoryComputers')!.set('local-8', { ...remoteComputer(8, 'alice', 'local-session'), photoRemote: previous })
    await saveComputer(record)
    const result = await synchronize('alice')
    expect(result.pending).toBe(0)
    expect(store.data.get('inventoryComputers')!.get('local-8')!.photoRemote.fileId).toBe('photo-1')
    expect(photoStore.deletes).toEqual(['old-photo'])
  })

  it('si falla la subida nueva conserva la fotografía anterior activa', async () => {
    const previous = { fileId: 'old-upload', url: 'https://example.com/old.jpg', filePath: '/inventario/alice/old.jpg', name: 'old.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: minute(0) }
    store.data.get('inventoryComputers')!.set('local-15', { ...remoteComputer(15, 'alice', 'local-session'), id: 'local-15', cloudId: 'local-15', photoRemote: previous })
    await saveComputer({ ...localComputer(15), cloudId: 'local-15', photoRemote: previous, photo: new Blob(['new'], { type: 'image/jpeg' }), photoNeedsUpload: true, photoLocalRevision: 'failed-upload' })
    photoStore.failUpload = true
    const result = await synchronize('alice')
    expect(result.pending).toBe(1)
    expect(store.data.get('inventoryComputers')!.get('local-15')!.photoRemote.fileId).toBe('old-upload')
    expect(photoStore.deletes).toEqual([])
    expect((await listComputers()).find((item) => item.id === 'local-15')!.photoRemote?.fileId).toBe('old-upload')
  })

  it('si falla Firestore después de subir, reutiliza la candidata y conserva ambas fotos válidas', async () => {
    const previous = { fileId: 'old-photo', url: 'https://example.com/old.jpg', filePath: '/inventario/alice/old.jpg', name: 'old.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: minute(0) }
    store.data.get('inventoryComputers')!.set('local-9', { ...remoteComputer(9, 'alice', 'local-session'), id: 'local-9', cloudId: 'local-9', photoRemote: previous })
    await saveComputer({ ...localComputer(9), cloudId: 'local-9', photoRemote: previous, photo: new Blob(['new'], { type: 'image/jpeg' }), photoNeedsUpload: true, photoLocalRevision: 'photo-rev-2' })
    store.failSetAt = 2
    const failed = await synchronize('alice')
    expect(failed.pending).toBe(1)
    expect(photoStore.uploads).toBe(1)
    expect(photoStore.deletes).toEqual([])
    expect(store.data.get('inventoryComputers')!.get('local-9')!.photoRemote.fileId).toBe('old-photo')
    store.failSetAt = 0
    const recovered = await synchronize('alice', undefined, { force: true })
    expect(recovered.pending).toBe(0)
    expect(photoStore.uploads).toBe(1)
    expect(photoStore.deletes).toEqual(['old-photo'])
  })

  it('conserva una limpieza fallida y la completa en el siguiente reintento', async () => {
    const photoRemote = { fileId: 'delete-photo', url: 'https://example.com/delete.jpg', filePath: '/inventario/alice/delete.jpg', name: 'delete.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: minute(0) }
    const record = { ...localComputer(10), cloudId: 'local-10', sharedCloud: true, syncStatus: 'synced' as const, photoRemote }
    store.data.get('inventoryComputers')!.set('local-10', { ...remoteComputer(10, 'alice', 'local-session'), id: 'local-10', cloudId: 'local-10', photoRemote })
    await saveComputer(record, false)
    await deleteComputer(record.id, 'alice')
    photoStore.failDeletes = 1
    const failed = await synchronize('alice')
    expect(failed.pending).toBe(1)
    expect((await getPendingSyncQueue())[0]).toMatchObject({ operation: 'cleanup-photo', photoFileId: 'delete-photo', attempts: 1 })
    await synchronize('alice', undefined, { force: true })
    expect(await getPendingSyncQueue()).toHaveLength(0)
    expect(photoStore.deletes).toEqual(['delete-photo'])
  })

  it('no limpia una foto que todavía referencia otro equipo', async () => {
    const sharedPhoto = { fileId: 'shared-photo', url: 'https://example.com/shared.jpg', filePath: '/inventario/alice/shared.jpg', name: 'shared.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: minute(0) }
    for (const id of ['shared-a', 'shared-b']) {
      store.data.get('inventoryComputers')!.set(id, { ...remoteComputer(11, 'alice', 'local-session'), id, cloudId: id, photoRemote: sharedPhoto })
      await saveComputer({ ...localComputer(11), id, cloudId: id, sharedCloud: true, syncStatus: 'synced', photoRemote: sharedPhoto }, false)
    }
    await deleteComputer('shared-a', 'alice')
    const result = await synchronize('alice')
    expect(result.pending).toBe(1)
    expect(photoStore.deletes).toEqual([])
    expect((await getPendingSyncQueue())[0].operation).toBe('cleanup-photo')
  })

  it('hace idempotente una limpieza repetida', async () => {
    await queuePhotoCleanup({ entityId: 'gone', remoteId: 'gone', ownerId: 'alice', fileId: 'same-photo', reason: 'orphan-upload' })
    await synchronize('alice')
    await queuePhotoCleanup({ entityId: 'gone', remoteId: 'gone', ownerId: 'alice', fileId: 'same-photo', reason: 'orphan-upload' })
    await synchronize('alice')
    expect(photoStore.deletes).toEqual(['same-photo'])
    expect(await getPendingSyncQueue()).toHaveLength(0)
  })

  it('una nueva foto durante otra sincronización gana sin borrar la activa', async () => {
    const previous = { fileId: 'old-concurrent', url: 'https://example.com/old.jpg', filePath: '/inventario/alice/old.jpg', name: 'old.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: minute(0) }
    store.data.get('inventoryComputers')!.set('local-12', { ...remoteComputer(12, 'alice', 'local-session'), id: 'local-12', cloudId: 'local-12', photoRemote: previous })
    await saveComputer({ ...localComputer(12), cloudId: 'local-12', photoRemote: previous, photo: new Blob(['first'], { type: 'image/jpeg' }), photoNeedsUpload: true, photoLocalRevision: 'first' })
    let changed = false
    photoStore.uploadHook = async () => {
      if (changed) return
      changed = true
      const latest = (await listComputers()).find((item) => item.id === 'local-12')!
      await saveComputer({ ...latest, photo: new Blob(['second'], { type: 'image/jpeg' }), photoNeedsUpload: true, photoLocalRevision: 'second' })
    }
    const result = await synchronize('alice')
    expect(result.pending).toBe(0)
    expect(photoStore.uploads).toBe(2)
    expect(store.data.get('inventoryComputers')!.get('local-12')!.photoRemote.fileId).toBe('photo-2')
    expect(photoStore.deletes.sort()).toEqual(['old-concurrent', 'photo-1'].sort())
  })

  it('eliminar una sesión sustituye operaciones pendientes y no permite que reaparezcan', async () => {
    await saveSession(localSession())
    await saveComputer({ ...localComputer(13), photo: new Blob(['local'], { type: 'image/jpeg' }), photoNeedsUpload: true })
    await deleteSessionAndComputers('local-session', 'alice')
    expect((await getPendingSyncQueue()).some((item) => item.operation.startsWith('upsert-'))).toBe(false)
    await synchronize('alice')
    expect([...store.data.get('inventoryComputers')!.keys()].some((id) => id === 'local-13')).toBe(false)
  })

  it('una limpieza fallida no bloquea las demás operaciones', async () => {
    await queuePhotoCleanup({ entityId: 'gone', remoteId: 'gone', ownerId: 'alice', fileId: 'retry-photo', reason: 'orphan-upload' })
    await saveComputer(localComputer(14))
    photoStore.failDeletes = 1
    const result = await synchronize('alice')
    expect(store.data.get('inventoryComputers')!.has('local-14')).toBe(true)
    expect(result.pending).toBe(1)
    expect((await getPendingSyncQueue())[0].operation).toBe('cleanup-photo')
  })
})

describe('sincronización manual y tiempo real compartido', () => {
  it('descarga el inventario remoto aunque la cola local esté vacía', async () => {
    expect(await getPendingSyncQueue()).toHaveLength(0)
    const result = await synchronizeAndPull('bob', undefined, { force: true })
    expect(result).toMatchObject({ synced: 0, errors: 0, pending: 0 })
    expect(result.pulled.computers).toBe(250)
    expect(await listComputers()).toHaveLength(250)
  })

  it('comparte una sola sincronización manual concurrente', async () => {
    store.setDelayMs = 20
    await saveComputer(localComputer(300))
    const first = synchronizeAndPull('alice', undefined, { force: true })
    const second = synchronizeAndPull('alice', undefined, { force: true })
    expect(first).toBe(second)
    await Promise.all([first, second])
    expect(store.setCalls).toBe(1)
  })

  it('propaga un error real de lectura y lo describe para la interfaz', async () => {
    store.failReads = true
    const error = await synchronizeAndPull('alice', undefined, { force: true }).catch((caught) => caught)
    expect(error).toMatchObject({ code: 'permission-denied' })
    expect(describeSyncError(error)).toContain('rechazó el acceso')
  })

  it('recibe una alta creada por otra cuenta sin recargar', async () => {
    let applied = 0
    const unsubscribe = subscribeToSharedInventory('bob', { onApplied: (stats) => { applied += stats.computers }, onError: vi.fn() })
    const row = { ...remoteComputer(900, 'alice', 's1'), id: 'realtime-new', cloudId: 'realtime-new' }
    await emitRemoteChanges('inventoryComputers', [{ type: 'added', id: 'realtime-new', row }])
    await vi.waitFor(async () => expect((await listComputers()).some((item) => item.cloudId === 'realtime-new')).toBe(true))
    expect(applied).toBe(1)
    unsubscribe()
  })

  it('aplica modificaciones remotas de sesión y equipo', async () => {
    await pullCloudData('bob', { force: true })
    const unsubscribe = subscribeToSharedInventory('bob', { onApplied: vi.fn(), onError: vi.fn() })
    await emitRemoteChanges('inventorySessions', [{ type: 'modified', id: 's1', row: { ...store.data.get('inventorySessions')!.get('s1'), name: 'Sesión renovada' } }])
    await emitRemoteChanges('inventoryComputers', [{ type: 'modified', id: 'c1', row: { ...store.data.get('inventoryComputers')!.get('c1'), model: 'Modelo renovado' } }])
    await vi.waitFor(async () => {
      expect((await listSessions()).find((item) => item.cloudId === 's1')?.name).toBe('Sesión renovada')
      expect((await listComputers()).find((item) => item.cloudId === 'c1')?.model).toBe('Modelo renovado')
    })
    unsubscribe()
  })

  it('elimina documentos locales cuando Firestore notifica el borrado', async () => {
    await pullCloudData('bob', { force: true })
    const unsubscribe = subscribeToSharedInventory('bob', { onApplied: vi.fn(), onError: vi.fn() })
    await emitRemoteChanges('inventoryComputers', [{ type: 'removed', id: 'c1' }])
    await emitRemoteChanges('inventorySessions', [{ type: 'removed', id: 's1' }])
    await vi.waitFor(async () => {
      expect((await listComputers()).some((item) => item.cloudId === 'c1')).toBe(false)
      expect((await listSessions()).some((item) => item.cloudId === 's1')).toBe(false)
    })
    unsubscribe()
  })

  it('no sobrescribe una edición local pendiente con una notificación remota', async () => {
    await pullCloudData('alice', { force: true })
    const current = (await listComputers()).find((item) => item.cloudId === 'c2')!
    await saveComputer({ ...current, model: 'Edición local pendiente' })
    const unsubscribe = subscribeToSharedInventory('alice', { onApplied: vi.fn(), onError: vi.fn() })
    await emitRemoteChanges('inventoryComputers', [{ type: 'modified', id: 'c2', row: { ...store.data.get('inventoryComputers')!.get('c2'), model: 'Cambio remoto' } }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await listComputers()).find((item) => item.cloudId === 'c2')?.model).toBe('Edición local pendiente')
    expect((await getPendingSyncQueue()).some((item) => item.entityId === current.id)).toBe(true)
    unsubscribe()
  })

  it('cancela listeners al cerrar sesión y crea listeners limpios para otra cuenta', async () => {
    const first = subscribeToSharedInventory('alice', { onApplied: vi.fn(), onError: vi.fn() })
    expect(store.listeners.get('inventorySessions')?.size).toBe(1)
    expect(store.listeners.get('inventoryComputers')?.size).toBe(1)
    first()
    expect(store.listeners.get('inventorySessions')?.size).toBe(0)
    expect(store.listeners.get('inventoryComputers')?.size).toBe(0)
    const second = subscribeToSharedInventory('bob', { onApplied: vi.fn(), onError: vi.fn() })
    expect(store.listeners.get('inventorySessions')?.size).toBe(1)
    expect(store.listeners.get('inventoryComputers')?.size).toBe(1)
    second()
  })

  it('un listener cancelado deja de aplicar cambios', async () => {
    const onApplied = vi.fn()
    const unsubscribe = subscribeToSharedInventory('alice', { onApplied, onError: vi.fn() })
    unsubscribe()
    await emitRemoteChanges('inventoryComputers', [{ type: 'added', id: 'after-logout', row: { ...remoteComputer(901, 'bob', 's1'), id: 'after-logout' } }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onApplied).not.toHaveBeenCalled()
    expect((await listComputers()).some((item) => item.cloudId === 'after-logout')).toBe(false)
  })

  it('reanuda cambios al recuperar conexión sin duplicar registros', async () => {
    const unsubscribe = subscribeToSharedInventory('bob', { onApplied: vi.fn(), onError: vi.fn() })
    vi.stubGlobal('navigator', { onLine: false })
    expect(await listComputers()).toHaveLength(0)
    vi.stubGlobal('navigator', { onLine: true })
    const row = { ...remoteComputer(902, 'alice', 's1'), id: 'reconnected', cloudId: 'reconnected' }
    await emitRemoteChanges('inventoryComputers', [{ type: 'added', id: 'reconnected', row }])
    await emitRemoteChanges('inventoryComputers', [{ type: 'modified', id: 'reconnected', row: { ...row, model: 'Final' } }])
    await vi.waitFor(async () => expect((await listComputers()).filter((item) => item.cloudId === 'reconnected')).toHaveLength(1))
    expect((await listComputers()).find((item) => item.cloudId === 'reconnected')?.model).toBe('Final')
    unsubscribe()
  })
})
