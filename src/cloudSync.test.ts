import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, any>
const store = vi.hoisted(() => ({
  data: new Map<string, Map<string, Row>>(), reads: 0, setCalls: 0, activeSets: 0, maxActiveSets: 0,
  failSetAt: 0, failReads: false, setDelayMs: 0, deleteLog: [] as string[],
  listeners: new Map<string, Set<{ next: (snapshot: { docChanges: () => unknown[] }) => void; error: (error: Error) => void }>>(),
  setHook: undefined as undefined | ((ref: { name: string; id: string }, row: Row) => Promise<void>)
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

import { clearAllData, deleteComputer, deleteSessionAndComputers, getPendingSyncQueue, listComputers, listSessions, listVisibleComputers, queuePhotoCleanup, saveComputer, saveSession } from './db'
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
