import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const store = vi.hoisted(() => ({ data: new Map<string, Map<string, Row>>(), reads: 0 }))

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
      for (const c of q.constraints) if (c.kind === 'where') rows = rows.filter(([, row]) => String(row[c.field]) >= String(c.value))
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
      if (!store.data.has(ref.name)) store.data.set(ref.name, new Map())
      store.data.get(ref.name)!.set(ref.id, row)
    },
    deleteDoc: async (ref: { name: string; id: string }) => { store.data.get(ref.name)?.delete(ref.id) }
  }
})

import { clearAllData, deleteSessionAndComputers, listComputers, listSessions, listVisibleComputers, saveComputer } from './db'
import { pullCloudData, synchronize } from './cloudSync'
import { normalizeKey } from './utils'

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
}

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
})
