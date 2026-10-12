import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, any>
const store = vi.hoisted(() => ({
  data: new Map<string, Map<string, Row>>(), reads: 0, setCalls: 0, activeSets: 0, maxActiveSets: 0,
  failSetAt: 0, setDelayMs: 0, deleteLog: [] as string[], setHook: undefined as undefined | ((ref: { name: string; id: string }, row: Row) => Promise<void>)
}))
const photoStore = vi.hoisted(() => ({ failUpload: false, uploads: 0 }))

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
      store.reads += 1
      return { data: () => ({ count: (store.data.get(base.name) ?? new Map<string, Row>()).size }) }
    },
    getDoc: async (ref: { name: string; id: string }) => {
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
    deleteDoc: async (ref: { name: string; id: string }) => { store.deleteLog.push(`${ref.name}/${ref.id}`); store.data.get(ref.name)?.delete(ref.id) }
  }
})

vi.mock('./imageKitClient', () => ({
  imageKitConfigured: true,
  uploadPhotoToImageKit: vi.fn(async (_computerId: string, photo: Blob) => {
    photoStore.uploads += 1
    if (photoStore.failUpload) throw Object.assign(new Error('ImageKit no disponible'), { code: 'unavailable' })
    return { fileId: 'photo-1', url: 'https://example.com/photo.jpg', filePath: '/photo.jpg', name: 'photo.jpg', size: photo.size, width: null, height: null, mimeType: photo.type, uploadedAt: minute(0) }
  }),
  cleanupReplacedImageKitPhoto: vi.fn(),
  deleteCurrentImageKitPhoto: vi.fn()
}))

import { clearAllData, deleteComputer, deleteSessionAndComputers, getPendingSyncQueue, listComputers, listSessions, listVisibleComputers, saveComputer, saveSession } from './db'
import { pullCloudData, synchronize } from './cloudSync'
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
  store.setDelayMs = 0
  store.deleteLog = []
  store.setHook = undefined
  photoStore.failUpload = false
  photoStore.uploads = 0
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
})
