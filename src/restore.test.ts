import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, any>
const store = vi.hoisted(() => ({
  data: new Map<string, Map<string, Row>>(), reads: 0, setCalls: 0, activeSets: 0, maxActiveSets: 0,
  authUid: undefined as string | undefined, failSetAt: 0, failReads: false, setDelayMs: 0, deleteLog: [] as string[],
  listeners: new Map<string, Set<{ next: (snapshot: { docChanges: () => unknown[] }) => void; error: (error: Error) => void }>>(),
  setHook: undefined as undefined | ((ref: { name: string; id: string }, row: Row) => Promise<void>)
}))
const photoStore = vi.hoisted(() => ({
  failUpload: false,
  configured: true,
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
      if (store.authUid) {
        // Simulación de firestore.rules: crear exige ownerId == uid; actualizar exige ser el propietario sin cambiarlo.
        const current = store.data.get(ref.name)?.get(ref.id)
        const denied = current ? current.ownerId !== store.authUid || row.ownerId !== current.ownerId : row.ownerId !== store.authUid
        if (denied) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' })
      }
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
    deleteDoc: async (ref: { name: string; id: string }) => {
      if (store.authUid && store.data.get(ref.name)?.get(ref.id)?.ownerId !== store.authUid) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' })
      store.deleteLog.push(`${ref.name}/${ref.id}`); store.data.get(ref.name)?.delete(ref.id) },
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
  get imageKitConfigured() { return photoStore.configured },
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

import { applyRestoreBatch, queuePendingPhotoUploads, clearAllData, getComputer, getDatabase, getPendingSyncQueue, listComputers, listSessions, saveComputer, saveSession } from './db'
import { pullCloudData, synchronize } from './cloudSync'
import { applyRestore, defaultRestoreOptions, planHasChanges, planRestore, summarizeBackupOwnership, summarizeSkips, syncAndVerifyRestore, type RestoreOptions } from './restore'
import { createBackup, restoreBackup } from './backup'
import { planSharedImport, sharedRecordId, type SharedImportSelection } from './sharedImport'
import { normalizeKey } from './utils'
import type { ComputerRecord, InventoryBackup, InventorySession } from './types'

const iso = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString()
const minute = iso
const png = (extra = 1) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, extra, 2, 3])], { type: 'image/png' })
const dataUrl = (bytes: number[], type = 'image/png') => `data:${type};base64,${btoa(String.fromCharCode(...bytes))}`
const PNG_URL = dataUrl([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 9, 9, 9]

const session = (id: string, owner: string | undefined = 'alice', n = 0, extra: Partial<InventorySession> = {}): InventorySession => ({
  id, name: `Sesión ${id}`, date: '2026-01-01', location: '', ownerId: owner, ownerName: owner || '', ownerEmail: '', createdAt: iso(n), updatedAt: iso(n), ...extra
})
const computer = (id: string, sessionId: string, owner: string | undefined = 'alice', n = 0, extra: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId, ownerId: owner, ownerName: owner || '', ownerEmail: '', equipmentType: 'Laptop',
  inventoryId: `INV-${id}`, inventoryNormalized: normalizeKey(`INV-${id}`), serialNumber: `SN-${id}`, serialNormalized: normalizeKey(`SN-${id}`),
  brand: 'Marca', model: 'Modelo', manufacturingYear: null, yearUnknown: true, operatingSystem: 'Windows', ramGB: 8, drives: [],
  originalCode: '', scannedAt: iso(n), timezone: 'UTC', latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '',
  createdAt: iso(n), updatedAt: iso(n), ...extra
})
const backupOf = (sessions: InventorySession[], computers: Array<ComputerRecord & { photoDataUrl?: string }>, exportedAt = iso(100)): InventoryBackup => ({
  format: 'inventario-computadoras', version: 1, exportedAt, sessions,
  computers: computers.map(({ photo: _photo, ...rest }) => rest)
})
const options = (change: { [K in keyof RestoreOptions]?: Partial<RestoreOptions[K]> } = {}): RestoreOptions => {
  const base = defaultRestoreOptions()
  return { sessions: { ...base.sessions, ...change.sessions }, computers: { ...base.computers, ...change.computers }, photos: { ...base.photos, ...change.photos } }
}
const plan = async (backup: InventoryBackup, opts = options(), owner: string | null = 'alice') =>
  planRestore(backup, opts, { sessions: await listSessions(), computers: await listComputers() }, owner)
const run = async (backup: InventoryBackup, opts = options(), owner = 'alice') => {
  const planned = await plan(backup, opts, owner)
  return { planned, result: await applyRestore(planned, owner) }
}
const remote = (name = 'inventoryComputers') => store.data.get(name) ?? new Map<string, Row>()
const bytes = async (blob: Blob | undefined) => Array.from(new Uint8Array(await blob!.arrayBuffer()))
const syncNow = () => synchronize('alice', undefined, { force: true })

beforeEach(async () => {
  vi.stubGlobal('navigator', { onLine: true })
  await clearAllData()
  store.data = new Map([['inventorySessions', new Map()], ['inventoryComputers', new Map()]])
  store.reads = 0; store.setCalls = 0; store.activeSets = 0; store.maxActiveSets = 0; store.failSetAt = 0; store.failReads = false; store.authUid = undefined
  store.setDelayMs = 0; store.deleteLog = []; store.listeners = new Map(); store.setHook = undefined
  photoStore.configured = true; photoStore.failUpload = false; photoStore.uploads = 0; photoStore.failDeletes = 0; photoStore.deletes = []; photoStore.uploadHook = undefined
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('restauración selectiva de respaldos', () => {
  it('combina sesiones y equipos sin eliminar datos existentes', async () => {
    await saveSession(session('local-only'), false)
    await saveComputer(computer('local-pc', 'local-only'), false)
    const { planned, result } = await run(backupOf([session('s1')], [computer('c1', 's1')]))
    expect(planned.summary).toMatchObject({ sessions: { create: 1 }, computers: { create: 1, delete: 0 } })
    expect(result.created).toEqual({ sessions: 1, computers: 1 })
    expect((await listSessions()).map((item) => item.id).sort()).toEqual(['local-only', 's1'])
    expect((await listComputers()).map((item) => item.id).sort()).toEqual(['c1', 'local-pc'])
  })

  it('reemplaza únicamente las sesiones del archivo sin tocar equipos ni otras sesiones', async () => {
    await saveSession(session('s1', 'alice', 1, { name: 'Nombre local', location: 'Sala vieja' }), false)
    await saveSession(session('other'), false)
    await saveComputer(computer('c1', 's1', 'alice', 1), false)
    const { result } = await run(
      backupOf([session('s1', 'alice', 1, { name: 'Nombre respaldo', location: 'Sala nueva' })], [computer('c-new', 's1')]),
      options({ sessions: { mode: 'replace' }, computers: { enabled: false } })
    )
    expect(result.updated.sessions).toBe(1)
    expect((await listSessions()).find((item) => item.id === 's1')).toMatchObject({ name: 'Nombre respaldo', location: 'Sala nueva' })
    expect((await listSessions()).map((item) => item.id).sort()).toEqual(['other', 's1'])
    expect((await listComputers()).map((item) => item.id)).toEqual(['c1'])
  })

  it('reemplaza equipos solo en las sesiones del archivo sin borrar sesiones ni equipos ajenos', async () => {
    await saveSession(session('s1'), false)
    await saveSession(session('s2'), false)
    await saveComputer(computer('c-in-file', 's1', 'alice', 1, { notes: 'viejo' }), false)
    await saveComputer(computer('c-missing', 's1', 'alice', 1), false)
    await saveComputer(computer('c-other-session', 's2', 'alice', 1), false)
    await saveComputer(computer('c-foreign', 's1', 'bob', 1), false)
    const { planned, result } = await run(
      backupOf([session('s1')], [computer('c-in-file', 's1', 'alice', 1, { notes: 'respaldo', updatedAt: iso(2) })]),
      options({ sessions: { enabled: false }, computers: { mode: 'replace' } })
    )
    expect(planned.destructive).toBe(true)
    expect(result.deleted).toBe(1)
    expect((await listSessions()).map((item) => item.id).sort()).toEqual(['s1', 's2'])
    expect((await listComputers()).map((item) => item.id).sort()).toEqual(['c-foreign', 'c-in-file', 'c-other-session'])
    expect((await getComputer('c-in-file'))?.notes).toBe('respaldo')
    expect((await getPendingSyncQueue()).find((item) => item.id === 'computer:c-missing')?.operation).toBe('delete-computer')
  })

  it('importa solo fotografías a equipos existentes sin modificar sus demás campos', async () => {
    await saveSession(session('s1'), false)
    await saveComputer(computer('c1', 's1', 'alice', 1, { notes: 'local' }), false)
    const { result } = await run(
      backupOf([session('s1')], [{ ...computer('c1', 's1', 'alice', 5, { notes: 'distinto' }), photoDataUrl: PNG_URL }]),
      options({ sessions: { enabled: false }, computers: { enabled: false } })
    )
    const stored = (await getComputer('c1'))!
    expect(result.photosRestored).toBe(1)
    expect(stored.notes).toBe('local')
    expect(stored.photo?.type).toBe('image/png')
    expect(stored.photoNeedsUpload).toBe(true)
    expect(await bytes(stored.photo)).toEqual(PNG_BYTES)
  })

  it('no permite importar solo fotografías si no hay equipos destinatarios', async () => {
    const planned = await plan(backupOf([session('s1')], [{ ...computer('c1', 's1'), photoDataUrl: PNG_URL }]), options({ sessions: { enabled: false }, computers: { enabled: false } }))
    expect(planned.blocking[0]).toMatch(/destinatarios/)
    expect(planned.conflicts[0].conflict).toBe('no-recipient')
    await expect(applyRestore(planned, 'alice')).rejects.toThrow(/destinatarios/)
  })

  it('restaura un archivo con identificadores de otra instalación y lo asigna al usuario actual', async () => {
    const { result } = await run(backupOf([session('uuid-a', undefined)], [{ ...computer('uuid-b', 'uuid-a', undefined), photoDataUrl: PNG_URL }]))
    expect(result.created).toEqual({ sessions: 1, computers: 1 })
    expect(await getComputer('uuid-b')).toMatchObject({ ownerId: 'alice', sessionId: 'uuid-a' })
    expect((await listSessions())[0].ownerId).toBe('alice')
  })

  it('resuelve la sesión de un equipo cuando la sesión local tiene otro identificador', async () => {
    await saveSession(session('local-id', 'alice', 1, { cloudId: 'shared-id' }), false)
    const { result } = await run(backupOf([session('shared-id', 'alice', 1, { cloudId: 'shared-id' })], [computer('c1', 'shared-id')]))
    expect(result.created.computers).toBe(1)
    expect((await getComputer('c1'))?.sessionId).toBe('local-id')
    expect(await listSessions()).toHaveLength(1)
  })

  it('detecta duplicados, equipos de otro usuario y sesiones ausentes sin apropiárselos', async () => {
    await saveSession(session('s1'), false)
    await saveComputer(computer('existing', 's1', 'alice', 1, { serialNumber: 'DUP-1', serialNormalized: 'DUP1' }), false)
    await saveComputer(computer('bobs', 's1', 'bob', 1), false)
    const backup = backupOf([session('s1'), session('bob-session', 'bob')], [
      computer('same-serial', 's1', 'alice', 9, { serialNumber: 'dup 1', serialNormalized: 'DUP1', inventoryId: 'X', inventoryNormalized: 'X' }),
      computer('bobs', 's1', 'bob', 9),
      computer('new-bob', 's1', 'bob', 9),
      computer('twin-a', 's1', 'alice', 9, { serialNumber: 'T-1', serialNormalized: 'T1' }),
      computer('twin-b', 's1', 'alice', 9, { serialNumber: 'T-1', serialNormalized: 'T1', inventoryId: 'B', inventoryNormalized: 'B' }),
      computer('orphan', 'nope', 'alice', 9)
    ])
    const planned = await plan(backup)
    expect(planned.conflicts.map((item) => item.conflict).sort()).toEqual(['duplicate-in-file', 'duplicate-key', 'foreign-owner', 'foreign-owner', 'foreign-owner', 'missing-session'])
    const result = await applyRestore(planned, 'alice')
    expect((await getComputer('bobs'))?.ownerId).toBe('bob')
    expect(await getComputer('new-bob')).toBeUndefined()
    expect(await getComputer('same-serial')).toBeUndefined()
    expect(result.created.computers).toBe(1)
    expect((await listComputers()).filter((item) => item.serialNormalized === 'DUP1')).toHaveLength(1)
    expect((await listSessions()).find((item) => item.id === 'bob-session')).toBeUndefined()
  })

  it('si falla a mitad de la importación no cambia nada y conserva la cola existente', async () => {
    await saveSession(session('s1'))
    await saveComputer(computer('pending-pc', 's1'))
    const queueBefore = await getPendingSyncQueue()
    const planned = await plan(backupOf([session('s2')], [computer('c1', 's2'), computer('c2', 's2')]))
    const original = IDBObjectStore.prototype.put
    let computerPuts = 0
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'computers' && ++computerPuts === 2) throw new DOMException('fallo simulado', 'UnknownError')
      return original.call(this, value, key)
    })
    await expect(applyRestore(planned, 'alice')).rejects.toThrow(/No se aplicó ningún cambio/)
    vi.restoreAllMocks()
    expect((await listSessions()).map((item) => item.id)).toEqual(['s1'])
    expect((await listComputers()).map((item) => item.id)).toEqual(['pending-pc'])
    expect(await getPendingSyncQueue()).toEqual(queueBefore)
  })

  it('restaura sin Internet, informa pendiente local y sincroniza al recuperar la conexión tras reabrir', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const { result } = await run(backupOf([session('s1')], [{ ...computer('c1', 's1'), photoDataUrl: PNG_URL }]))
    const offline = await syncAndVerifyRestore(result, 'alice', async () => { await synchronize('alice'); return undefined })
    expect(offline.state).toBe('local-only')
    expect(offline.pending).toBe(2)
    expect(offline.message).toMatch(/pendiente/)
    expect(remote().size).toBe(0)
    ;(await getDatabase()).close()
    vi.stubGlobal('navigator', { onLine: true })
    const online = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(online.state).toBe('synced')
    expect(online.pending).toBe(0)
    expect(remote().has('c1')).toBe(true)
    expect(remote('inventorySessions').has('s1')).toBe(true)
    expect((await getComputer('c1'))?.photoRemote?.fileId).toBe('photo-1')
  })

  it('confirma las escrituras en Firestore y el otro dispositivo las recibe', async () => {
    const { result } = await run(backupOf([session('s1')], [computer('c1', 's1'), computer('c2', 's1')]))
    const outcome = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(outcome).toMatchObject({ state: 'synced', pending: 0, confirmed: 3 })
    expect([...remote().keys()].sort()).toEqual(['c1', 'c2'])
    expect(remote().get('c1')).toMatchObject({ ownerId: 'alice', sessionId: 's1' })
    await clearAllData() // otro dispositivo, sin datos locales
    await pullCloudData('bob', { force: true })
    expect((await listComputers()).map((item) => item.id).sort()).toEqual(['c1', 'c2'])
    expect((await listSessions()).map((item) => item.id)).toEqual(['s1'])
  })

  it('no declara sincronización completa si Firebase falla o no confirma', async () => {
    const { result } = await run(backupOf([session('s1')], [computer('c1', 's1')]))
    store.failSetAt = 1
    const failed = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(failed.state).toBe('pending')
    expect(failed.message).toMatch(/pendiente/)
    // La verificación directa detecta un documento ausente aunque la cola ya no tenga operaciones.
    const database = await getDatabase()
    await database.clear('syncQueue')
    remote().clear()
    const unconfirmed = await syncAndVerifyRestore({ ...result, queuedIds: ['computer:c1'] }, 'alice', async () => undefined)
    expect(unconfirmed.state).toBe('unverified')
    expect(unconfirmed.problems.join(' ')).toMatch(/no existe en Firebase/)
  })

  it('al reemplazar protege los cambios locales posteriores al respaldo', async () => {
    await saveSession(session('s1'), false)
    await saveComputer(computer('edited-later', 's1', 'alice', 1, { notes: 'viejo' }), false)
    await saveComputer(computer('only-local-new', 's1', 'alice', 1)) // updatedAt = ahora, posterior al respaldo
    await saveComputer({ ...(await getComputer('edited-later'))!, notes: 'cambio posterior' })
    const backup = backupOf([session('s1')], [computer('edited-later', 's1', 'alice', 1, { notes: 'respaldo' })])
    const { planned, result } = await run(backup, options({ sessions: { enabled: false }, computers: { mode: 'replace' } }))
    expect(planned.conflicts.map((item) => item.conflict)).toEqual(['local-newer', 'local-newer'])
    expect(result.deleted).toBe(0)
    expect((await getComputer('edited-later'))?.notes).toBe('cambio posterior')
    expect(await getComputer('only-local-new')).toBeDefined()
  })

  it('detecta cambios ocurridos entre la vista previa y la escritura', async () => {
    await saveSession(session('s1'), false)
    await saveComputer(computer('c1', 's1', 'alice', 1, { notes: 'viejo' }), false)
    const planned = await plan(backupOf([session('s1')], [computer('c1', 's1', 'alice', 5, { notes: 'respaldo' })]))
    await saveComputer({ ...(await getComputer('c1'))!, notes: 'editado durante la restauración' })
    const result = await applyRestore(planned, 'alice')
    expect(result.errors.join(' ')).toMatch(/cambió mientras se restauraba/)
    expect((await getComputer('c1'))?.notes).toBe('editado durante la restauración')
  })

  it('conserva la fotografía local y la remota si falla ImageKit al sustituirla', async () => {
    const previous = { fileId: 'old-photo', url: 'https://example.com/old.jpg', filePath: '/old.jpg', name: 'old.jpg', size: 4, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: iso(0) }
    await saveSession(session('s1'), false)
    await saveComputer(computer('c1', 's1', 'alice', 1, { cloudId: 'c1', sharedCloud: true, photo: png(1), photoRemote: previous }), false)
    remote().set('c1', { ...computer('c1', 's1', 'alice', 1), cloudId: 'c1', photoRemote: previous })
    const { result } = await run(
      backupOf([session('s1')], [{ ...computer('c1', 's1', 'alice', 5), photoDataUrl: PNG_URL }]),
      options({ sessions: { enabled: false }, computers: { enabled: false }, photos: { mode: 'replace' } })
    )
    photoStore.failUpload = true
    const outcome = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(outcome.state).toBe('pending')
    const stored = (await getComputer('c1'))!
    expect(await bytes(stored.photo)).toEqual(PNG_BYTES)
    expect(stored.photoRemote?.fileId).toBe('old-photo')
    expect(remote().get('c1')!.photoRemote.fileId).toBe('old-photo')
    expect(photoStore.deletes).toEqual([])
    photoStore.failUpload = false
    const recovered = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(recovered.state).toBe('synced')
    expect(remote().get('c1')!.photoRemote.fileId).toBe('photo-1')
  })

  it('conserva las fotografías existentes cuando la opción de fotografías está desactivada', async () => {
    await saveSession(session('s1'), false)
    await saveComputer(computer('c1', 's1', 'alice', 1, { photo: png(1), photoName: 'local.png' }), false)
    await run(backupOf([session('s1')], [{ ...computer('c1', 's1', 'alice', 5, { notes: 'respaldo' }), photoDataUrl: PNG_URL }]), options({ photos: { enabled: false } }))
    const stored = (await getComputer('c1'))!
    expect(stored.notes).toBe('respaldo')
    expect(await bytes(stored.photo)).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  })

  it('mantiene los datos de las categorías desmarcadas', async () => {
    await saveSession(session('s1', 'alice', 1, { name: 'Local' }), false)
    await saveComputer(computer('c1', 's1', 'alice', 1, { notes: 'local' }), false)
    const { result } = await run(backupOf([session('s1', 'alice', 9, { name: 'Respaldo' })], [computer('c1', 's1', 'alice', 9, { notes: 'respaldo' })]), options({ sessions: { enabled: false } }))
    expect(result.updated).toEqual({ sessions: 0, computers: 1 })
    expect((await listSessions())[0].name).toBe('Local')
  })

  it('una importación repetida no crea duplicados ni operaciones nuevas', async () => {
    const backup = backupOf([session('s1')], [{ ...computer('c1', 's1'), photoDataUrl: PNG_URL }])
    await run(backup)
    const queueAfterFirst = await getPendingSyncQueue()
    const second = await run(backup)
    expect(second.result.created).toEqual({ sessions: 0, computers: 0 })
    expect(second.result.queuedIds).toEqual([])
    expect(await listSessions()).toHaveLength(1)
    expect(await listComputers()).toHaveLength(1)
    expect(await getPendingSyncQueue()).toEqual(queueAfterFirst)
  })

  it('informa guardado local cuando no hay sincronización disponible', async () => {
    const { result } = await run(backupOf([session('s1')], [computer('c1', 's1')]))
    const outcome = await syncAndVerifyRestore(result, 'alice', async () => undefined)
    expect(outcome.state).toBe('local-only')
    expect(outcome.message).toMatch(/Importación local completada/)
    expect(outcome.message).not.toMatch(/Sincronización completa/)
  })

  it('no reemplaza ni toca la cola pendiente de otros registros', async () => {
    await saveSession(session('s1'))
    await saveComputer(computer('pending-pc', 's1'))
    const before = (await getPendingSyncQueue()).map((item) => item.id)
    await run(backupOf([session('s1', 'alice', 1)], [computer('c1', 's1')]), options({ sessions: { mode: 'replace' }, computers: { mode: 'replace' } }))
    const after = (await getPendingSyncQueue()).map((item) => item.id)
    for (const id of before) expect(after).toContain(id)
  })

  it('valida el archivo e ignora registros inválidos sin modificar datos', async () => {
    const backup = backupOf([session('s1'), { ...session('s2'), name: '' }], [computer('c1', 's1'), { ...computer('c2', 's1'), inventoryId: '', serialNumber: '' }])
    const planned = await plan(backup)
    expect(planned.conflicts.filter((item) => item.conflict === 'invalid')).toHaveLength(2)
    const { result } = await run(backup)
    expect(result.created).toEqual({ sessions: 1, computers: 1 })
  })

  it('restoreBackup (compatibilidad) restaura todo el respaldo propio', async () => {
    await saveSession(session('s1'))
    await saveComputer(computer('c1', 's1', 'alice', 1, { photo: png(4) }))
    const backup = await createBackup('alice')
    await clearAllData()
    expect(await restoreBackup(backup, true, 'alice')).toEqual({ sessions: 1, computers: 1 })
    expect((await getComputer('c1'))?.photo?.size).toBe(7)
  })

  it('applyRestoreBatch vacío no modifica datos', async () => {
    await saveSession(session('s1'))
    const result = await applyRestoreBatch({ sessions: [], computers: [], deletes: [] })
    expect(result.queuedIds).toEqual([])
    expect(await listSessions()).toHaveLength(1)
  })
})

describe('motivos de omisión y emparejamiento', () => {
  const sixtyTwo = () => {
    const sessions = [session('s1'), session('s2', 'bob')]
    const computers = Array.from({ length: 60 }, (_, index) => computer(`c${index}`, index < 30 ? 's1' : 's2', index < 30 ? 'alice' : 'bob', 1))
    return { sessions, computers }
  }

  it('un respaldo de este mismo inventario omite los 62 registros explicando el motivo de cada uno', async () => {
    const { sessions, computers } = sixtyTwo()
    for (const item of sessions) await saveSession(item, false)
    for (const item of computers) await saveComputer(item, false)
    const planned = await plan(backupOf(sessions, computers))
    const groups = summarizeSkips(planned)
    expect(planned.items.filter((item) => item.action === 'skip')).toHaveLength(62)
    expect(Object.fromEntries(groups.map((group) => [group.kind, group.count]))).toEqual({ identical: 31, 'foreign-owner': 31 })
    expect(groups.flatMap((group) => group.items).every((item) => item.id && item.label)).toBe(true)
    expect(planHasChanges(planned)).toBe(false)
    const result = await applyRestore(planned, 'alice')
    expect(result.queuedIds).toEqual([])
    expect(result.skippedBy).toEqual({ identical: 31, 'foreign-owner': 31 })
    const outcome = await syncAndVerifyRestore(result, 'alice', async () => undefined)
    expect(outcome.state).toBe('nothing')
  })

  it('distingue idénticos, actualizables, de otra cuenta, inválidos y sin sesión', async () => {
    await saveSession(session('s1'), false)
    await saveComputer(computer('same', 's1', 'alice', 1), false)
    await saveComputer(computer('newer-local', 's1', 'alice', 9, { notes: 'local nuevo' }), false)
    await saveComputer(computer('updatable', 's1', 'alice', 1, { notes: 'viejo' }), false)
    await saveComputer(computer('theirs', 's1', 'bob', 1), false)
    const planned = await plan(backupOf([session('s1')], [
      computer('same', 's1', 'alice', 1),
      computer('newer-local', 's1', 'alice', 2, { notes: 'respaldo viejo' }),
      computer('updatable', 's1', 'alice', 5, { notes: 'respaldo nuevo' }),
      computer('theirs', 's1', 'bob', 5),
      { ...computer('bad', 's1'), inventoryId: '', serialNumber: '' },
      computer('no-session', 'ghost', 'alice', 5),
      computer('brand-new', 's1', 'alice', 5)
    ]))
    const byKind = Object.fromEntries(summarizeSkips(planned).map((group) => [group.kind, group.items.map((item) => item.id).sort()]))
    expect(byKind).toMatchObject({ identical: ['s1', 'same'], 'local-newer': ['newer-local'], 'foreign-owner': ['theirs'], invalid: ['bad'], 'missing-session': ['no-session'] })
    expect(planned.summary.computers).toMatchObject({ create: 1, update: 1 })
  })

  it('los equipos con el marcador NO ETIQUETADO y series distintas no son duplicados y llegan a Firestore', async () => {
    const placeholder = (id: string, serial: string) => computer(id, 's1', 'alice', 1, { inventoryId: 'NO ETIQUETADO', inventoryNormalized: 'NOETIQUETADO', serialNumber: serial, serialNormalized: serial })
    const backup = backupOf([session('s1')], [placeholder('a', 'MXL1'), placeholder('b', 'MXL2'), placeholder('c', 'MXL3')])
    const { planned, result } = await run(backup)
    expect(planned.conflicts).toHaveLength(0)
    expect(result.created.computers).toBe(3)
    const outcome = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(outcome.state).toBe('synced')
    expect([...remote().keys()].sort()).toEqual(['a', 'b', 'c'])
    // Repetir la importación no duplica ni cambia nada.
    const again = await run(backup)
    expect(again.result.created.computers).toBe(0)
    expect(await listComputers()).toHaveLength(3)
  })

  it('el mismo inventario sin serie, o con la misma serie, sigue siendo duplicado', async () => {
    await saveSession(session('s1'), false)
    await saveComputer(computer('existing', 's1', 'alice', 1, { serialNumber: '', serialNormalized: '', inventoryId: 'INV-9', inventoryNormalized: 'INV9' }), false)
    const planned = await plan(backupOf([session('s1')], [computer('other-id', 's1', 'alice', 5, { serialNumber: '', serialNormalized: '', inventoryId: 'inv 9', inventoryNormalized: 'INV9' })]))
    expect(planned.conflicts.map((item) => item.conflict)).toEqual(['duplicate-key'])
    expect(planned.summary.computers).toMatchObject({ create: 0, update: 1 })
  })

  it('un respaldo de otra cuenta sobre un inventario vacío solo importa lo propio y lista el resto como ajeno', async () => {
    const { sessions, computers } = sixtyTwo()
    const planned = await plan(backupOf(sessions, computers), options(), 'carol')
    expect(planned.summary.computers.create).toBe(0)
    expect(summarizeSkips(planned).map((group) => group.kind)).toEqual(['foreign-owner'])
    expect(planHasChanges(planned)).toBe(false)
  })
})

describe('importar respaldo compartido', () => {
  const alice = { id: 'alice', name: 'Alice', email: 'alice@example.com' }
  const friendBackup = (count = 5, extra: Array<ComputerRecord & { photoDataUrl?: string }> = []) => backupOf(
    [session('fs1', 'bob', 1), session('fs2', 'bob', 1)],
    [...Array.from({ length: count }, (_, index) => ({ ...computer(`f${index}`, index % 2 ? 'fs2' : 'fs1', 'bob', 1, { cloudId: `f${index}` }), photoDataUrl: PNG_URL })), ...extra]
  )
  const planShared = async (backup: InventoryBackup, selection: SharedImportSelection = { photos: true }, owner: typeof alice | null = alice) =>
    planSharedImport(backup, selection, { sessions: await listSessions(), computers: await listComputers() }, owner)
  const runShared = async (backup: InventoryBackup, selection: SharedImportSelection = { photos: true }) => {
    const planned = await planShared(backup, selection)
    return { planned, result: await applyRestore(planned, 'alice') }
  }

  it('crea registros nuevos bajo la cuenta actual, con identificadores nuevos y relaciones conservadas', async () => {
    const { planned, result } = await runShared(friendBackup(5))
    expect(planned.conflicts).toHaveLength(0)
    expect(result.created).toEqual({ sessions: 2, computers: 5 })
    const computers = await listComputers()
    expect(computers.every((item) => item.ownerId === 'alice' && item.id.startsWith('imp-alice-') && !item.cloudId && !item.sharedCloud)).toBe(true)
    expect(computers.find((item) => item.importedFrom?.id === 'f1')?.sessionId).toBe(sharedRecordId('alice', 'fs2'))
    expect(computers.find((item) => item.importedFrom?.id === 'f0')?.sessionId).toBe(sharedRecordId('alice', 'fs1'))
    expect((await listSessions()).every((item) => item.ownerId === 'alice')).toBe(true)
    expect(JSON.stringify(computers)).not.toContain('bob')
  })

  it('conserva la copia local y su operación al encontrar el documento original del exportador', async () => {
    const originalComputer = { ...computer('f0', 'fs1', 'bob', 1), cloudId: 'f0' }
    const originalSession = { ...session('fs1', 'bob', 1), cloudId: 'fs1' }
    remote().set('f0', originalComputer)
    remote('inventorySessions').set('fs1', originalSession)
    const { result } = await runShared(friendBackup(3))
    const outcome = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(outcome.state).toBe('pending')
    const imported = [...remote().values()].filter((row) => String(row.id).startsWith('imp-'))
    expect(imported).toHaveLength(2)
    expect(imported.every((row) => row.ownerId === 'alice')).toBe(true)
    expect(remote().get('f0')).toBe(originalComputer)
    expect((await listComputers()).some((item) => item.importedFrom?.id === 'f0')).toBe(true)
    expect((await getPendingSyncQueue()).some((item) => item.entityId === sharedRecordId('alice', 'f0'))).toBe(true)
    expect(remote('inventorySessions').get('fs1')).toBe(originalSession)
  })

  it('importar dos veces el mismo archivo no duplica ni crea operaciones nuevas', async () => {
    const backup = friendBackup(4)
    await runShared(backup)
    const queue = await getPendingSyncQueue()
    const second = await runShared(backup)
    expect(second.result.created).toEqual({ sessions: 0, computers: 0 })
    expect(second.result.queuedIds).toEqual([])
    expect(second.planned.summary.computers.skip).toBe(4)
    expect(await listComputers()).toHaveLength(4)
    expect(await listSessions()).toHaveLength(2)
    expect(await getPendingSyncQueue()).toEqual(queue)
  })

  it('no modifica registros existentes y omite equipos ya presentes, propios o de otra cuenta', async () => {
    await saveSession(session('fs1', 'bob', 1), false)
    await saveComputer(computer('f0', 'fs1', 'bob', 1), false)
    await saveSession(session('mine'), false)
    await saveComputer(computer('mine-pc', 'mine', 'alice', 1, { serialNumber: 'SN-f1', serialNormalized: 'SNF1' }), false)
    const before = JSON.stringify(await listComputers())
    const { planned, result } = await runShared(friendBackup(3))
    expect(planned.conflicts.filter((item) => item.conflict === 'duplicate-key').map((item) => item.reason).sort()).toEqual([
      'Ya existe en el inventario compartido (de otra cuenta)',
      'Ya existe un equipo tuyo con la misma serie o inventario; no se modifica'
    ])
    expect(result.created.computers).toBe(1)
    const after = await listComputers()
    expect(JSON.stringify(after.filter((item) => !item.id.startsWith('imp-')))).toBe(before)
    expect((await listSessions()).filter((item) => item.id === 'fs1')).toHaveLength(1)
  })

  it('enlaza los equipos a una sesión que ya existe en el inventario en lugar de duplicarla', async () => {
    await saveSession(session('fs1', 'bob', 1), false)
    const { result } = await runShared(friendBackup(1))
    expect(result.created).toEqual({ sessions: 1, computers: 1 })
    expect((await listComputers())[0].sessionId).toBe('fs1')
  })

  it('detecta duplicados dentro del archivo pero permite series distintas con el mismo marcador de inventario', async () => {
    const placeholder = (id: string, serial: string) => computer(id, 'fs1', 'bob', 1, { inventoryId: 'NO ETIQUETADO', inventoryNormalized: 'NOETIQUETADO', serialNumber: serial, serialNormalized: serial })
    const planned = await planShared(backupOf([session('fs1', 'bob', 1)], [placeholder('a', 'S1'), placeholder('b', 'S2'), placeholder('c', 'S1')]))
    expect(planned.summary.computers.create).toBe(2)
    expect(planned.conflicts.map((item) => item.conflict)).toEqual(['duplicate-in-file'])
  })

  it('importa las fotografías como copias locales y no reutiliza referencias privadas del exportador', async () => {
    const friendPhoto = { fileId: 'friend-file', url: 'https://example.com/friend.jpg', filePath: '/inventario/bob/f.jpg', name: 'f.jpg', size: 4, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: iso(0) }
    const backup = backupOf([session('fs1', 'bob', 1)], [
      { ...computer('with-data', 'fs1', 'bob', 1, { photoRemote: friendPhoto }), photoDataUrl: PNG_URL },
      computer('remote-only', 'fs1', 'bob', 1, { photoRemote: friendPhoto })
    ])
    const { planned, result } = await runShared(backup)
    expect(planned.warnings.join(' ')).toMatch(/solo en el almacenamiento privado/)
    const withData = (await listComputers()).find((item) => item.importedFrom?.id === 'with-data')!
    expect(withData.photoRemote).toBeUndefined()
    expect(withData.photoNeedsUpload).toBe(true)
    expect(await bytes(withData.photo)).toEqual(PNG_BYTES)
    expect((await listComputers()).find((item) => item.importedFrom?.id === 'remote-only')?.photoRemote).toBeUndefined()
    const outcome = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(outcome.state).toBe('synced')
    expect((await listComputers()).find((item) => item.importedFrom?.id === 'with-data')?.photoRemote?.fileId).toBe('photo-1')
    expect(photoStore.uploads).toBe(1)
  })

  it('con la opción de fotografías desactivada no importa ninguna', async () => {
    const { result } = await runShared(friendBackup(2), { photos: false })
    expect(result.photosRestored).toBe(0)
    expect((await listComputers()).every((item) => !item.photo && !item.photoNeedsUpload)).toBe(true)
  })

  it('permite elegir sesiones y equipos y avisa si falta la sesión de un equipo seleccionado', async () => {
    const backup = friendBackup(4)
    const selected = await planShared(backup, { sessionIds: new Set(['fs1']), computerIds: new Set(['f0', 'f1']), photos: true })
    expect(selected.summary.sessions.create).toBe(1)
    expect(selected.summary.computers.create).toBe(1)
    expect(selected.conflicts.map((item) => item.conflict)).toEqual(['missing-session'])
    const { result } = await runShared(backup, { sessionIds: new Set(['fs1']), computerIds: new Set(['f0', 'f2']), photos: false })
    expect(result.created).toEqual({ sessions: 1, computers: 2 })
    expect((await listComputers()).map((item) => item.importedFrom?.id).sort()).toEqual(['f0', 'f2'])
  })

  it('si falla la subida deja los registros y fotos pendientes y lo informa; después se completa', async () => {
    const { result } = await runShared(friendBackup(2))
    store.failSetAt = 1
    photoStore.failUpload = true
    const failed = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(failed.state).toBe('pending')
    expect(failed.message).toMatch(/pendiente/)
    expect(failed.pending).toBeGreaterThan(0)
    expect((await listComputers()).every((item) => item.photo)).toBe(true)
    photoStore.failUpload = false
    const recovered = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(recovered.state).toBe('synced')
    expect(remote().size).toBe(2)
  })

  it('sin Internet queda guardado localmente en cola y se sincroniza después', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const { result } = await runShared(friendBackup(2))
    const offline = await syncAndVerifyRestore(result, 'alice', async () => { await synchronize('alice'); return undefined })
    expect(offline.state).toBe('local-only')
    expect(remote().size).toBe(0)
    vi.stubGlobal('navigator', { onLine: true })
    expect((await syncAndVerifyRestore(result, 'alice', syncNow)).state).toBe('synced')
  })

  it('exige sesión iniciada', async () => {
    const planned = await planShared(friendBackup(1), { photos: true }, null)
    expect(planned.blocking[0]).toMatch(/Inicia sesión/)
  })

  it('el modo normal sigue tratando los registros de otra cuenta como ajenos', async () => {
    const planned = await plan(friendBackup(3))
    expect(planned.summary.computers.create).toBe(0)
    expect(summarizeSkips(planned).map((group) => group.kind)).toContain('foreign-owner')
  })
})

describe('propiedad original con dos usuarios', () => {
  const bobBackup = () => backupOf([session('s1', 'bob', 1)], [
    { ...computer('p1', 's1', 'bob', 1, { cloudId: 'p1' }), photoDataUrl: PNG_URL },
    computer('p2', 's1', 'bob', 1, { cloudId: 'p2' })
  ])
  const syncAs = (uid: string) => () => synchronize(uid, undefined, { force: true })

  it('el creador restaura su propio respaldo: se conservan IDs, relaciones y propietario en Firestore', async () => {
    store.authUid = 'bob'
    const { planned, result } = await run(bobBackup(), options(), 'bob')
    expect(planned.conflicts).toHaveLength(0)
    const outcome = await syncAndVerifyRestore(result, 'bob', syncAs('bob'))
    expect(outcome.state).toBe('synced')
    expect([...remote().keys()].sort()).toEqual(['p1', 'p2'])
    for (const row of remote().values()) expect(row).toMatchObject({ ownerId: 'bob', sessionId: 's1', id: row.cloudId })
    expect(remote('inventorySessions').get('s1')).toMatchObject({ ownerId: 'bob', id: 's1', cloudId: 's1' })
  })

  it('un segundo usuario ve los registros pero no puede editarlos ni eliminarlos', async () => {
    store.authUid = 'bob'
    const { result } = await run(bobBackup(), options(), 'bob')
    await syncAndVerifyRestore(result, 'bob', syncAs('bob'))
    const original = JSON.stringify([...remote().entries()])
    await clearAllData() // dispositivo de Alice
    store.authUid = 'alice'
    await pullCloudData('alice', { force: true })
    expect((await listComputers()).map((item) => item.ownerId)).toEqual(['bob', 'bob'])
    // Intento de edición: Alice se atribuye el registro de Bob y lo envía.
    await saveComputer({ ...(await getComputer('p1'))!, ownerId: 'alice', model: 'Cambio ajeno' })
    // Intento de eliminación del otro registro.
    const { deleteComputer } = await import('./db')
    await deleteComputer('p2', 'alice')
    const summary = await synchronize('alice', undefined, { force: true })
    expect(summary.errors).toBeGreaterThan(0)
    expect(JSON.stringify([...remote().entries()])).toBe(original)
    expect(remote().get('p1')).toMatchObject({ ownerId: 'bob', model: 'Modelo' })
    expect(remote().has('p2')).toBe(true)
  })

  it('al restaurar el respaldo de otra persona con tu cuenta no se crea ni modifica ningún registro', async () => {
    store.authUid = 'alice'
    remote().set('p1', { ...computer('p1', 's1', 'bob', 1), cloudId: 'p1' })
    await saveSession(session('s1', 'bob', 1), false)
    await saveComputer(computer('p1', 's1', 'bob', 1, { cloudId: 'p1' }), false)
    const { planned, result } = await run(bobBackup(), options(), 'alice')
    expect(summarizeSkips(planned).some((group) => group.kind === 'foreign-owner' && group.label.includes('creador'))).toBe(true)
    expect(result.created).toEqual({ sessions: 0, computers: 0 })
    expect(result.queuedIds).toEqual([])
    expect((await listComputers()).filter((item) => item.ownerId === 'alice')).toHaveLength(0)
    expect(await getPendingSyncQueue()).toHaveLength(0)
    expect(remote().get('p1')).toMatchObject({ ownerId: 'bob' })
  })

  it('un JSON manipulado que se atribuye registros ajenos no obtiene permisos: Firestore los rechaza', async () => {
    store.authUid = 'alice'
    const original = { ...computer('p1', 's1', 'bob', 1), cloudId: 'p1', model: 'Original de Bob' }
    remote().set('p1', original)
    remote('inventorySessions').set('s1', { ...session('s1', 'bob', 1), cloudId: 's1' })
    const forged = backupOf([session('s1', 'alice', 9)], [computer('p1', 's1', 'alice', 9, { cloudId: 'p1', model: 'Manipulado' })])
    const { result } = await run(forged, options(), 'alice') // el campo ownerId del JSON no prueba identidad
    const outcome = await syncAndVerifyRestore(result, 'alice', syncAs('alice'))
    expect(outcome.state).toBe('pending')
    expect(outcome.problems.join(' ')).toMatch(/permissions|permiso|rechaz/i)
    expect(remote().get('p1')).toBe(original)
    expect(remote('inventorySessions').get('s1')).toMatchObject({ ownerId: 'bob' })
  })

  it('resume a quién pertenece el contenido del archivo sin tratarlo como prueba de identidad', () => {
    const backup = backupOf([session('s1', 'bob'), session('s2', 'x', 0, { ownerId: undefined })], [computer('a', 's1', 'alice'), computer('b', 's1', 'bob'), computer('c', 's1', 'carol')])
    expect(summarizeBackupOwnership(backup, 'alice')).toEqual({ mine: 1, others: 3, unowned: 1, otherAccounts: 2 })
  })
})

describe('subida de fotografías restauradas', () => {
  const photoBackup = (count = 3) => backupOf(
    [session('s1')],
    Array.from({ length: count }, (_, index) => ({ ...computer(`p${index}`, 's1', 'alice', 1), photoDataUrl: dataUrl([0x89, 0x50, 0x4e, 0x47, index, 7, 7]) }))
  )
  const expectedBytes = (index: number) => [0x89, 0x50, 0x4e, 0x47, index, 7, 7]

  it('sube las fotografías, conserva los bytes locales y solo entonces informa sincronización completa', async () => {
    const { result } = await run(photoBackup(3))
    const outcome = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(outcome.state).toBe('synced')
    expect(outcome.photosPending).toBe(0)
    expect(photoStore.uploads).toBe(3)
    for (const index of [0, 1, 2]) {
      const stored = (await getComputer(`p${index}`))!
      expect(stored.photoRemote?.fileId).toMatch(/^photo-/)
      expect(stored.photoNeedsUpload).toBe(false)
      expect(await bytes(stored.photo)).toEqual(expectedBytes(index))
      expect(remote().get(`p${index}`)!.photoRemote.fileId).toBe(stored.photoRemote!.fileId)
    }
    expect(await syncAndVerifyRestore(result, 'alice', syncNow)).toMatchObject({ state: 'synced' })
    expect(photoStore.uploads).toBe(3)
  })

  it('sin configurar ImageKit sincroniza los documentos pero no declara las fotos como subidas; al configurarlo se suben sin reimportar', async () => {
    photoStore.configured = false
    const { result } = await run(photoBackup(3))
    const first = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(first.state).toBe('photos-pending')
    expect(first.photosPending).toBe(3)
    expect(first.confirmed).toBe(4)
    expect(first.message).toMatch(/VITE_IMAGEKIT_BACKEND_URL/)
    expect(photoStore.uploads).toBe(0)
    expect(remote().size).toBe(3)
    expect(await getPendingSyncQueue()).toHaveLength(0)
    for (const index of [0, 1, 2]) {
      const stored = (await getComputer(`p${index}`))!
      expect(stored.photoRemote).toBeUndefined()
      expect(await bytes(stored.photo)).toEqual(expectedBytes(index))
    }
    // Se configura el backend: basta sincronizar, sin volver a importar el JSON.
    photoStore.configured = true
    const second = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(second.state).toBe('synced')
    expect(photoStore.uploads).toBe(3)
    expect(remote().size).toBe(3)
    expect((await listComputers()).filter((item) => item.photoRemote)).toHaveLength(3)
    expect((await listComputers()).every((item) => item.photo)).toBe(true)
  })

  it('un fallo de red en la subida conserva la foto local, queda pendiente y el reintento no duplica archivos ni equipos', async () => {
    const { result } = await run(photoBackup(2))
    photoStore.failUpload = true
    const failed = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(failed.state).not.toBe('synced')
    expect(photoStore.uploads).toBe(0)
    expect((await listComputers()).every((item) => item.photo && !item.photoRemote)).toBe(true)
    expect((await getPendingSyncQueue()).length).toBeGreaterThan(0)
    photoStore.failUpload = false
    const recovered = await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(recovered.state).toBe('synced')
    expect(photoStore.uploads).toBe(2)
    expect(remote().size).toBe(2)
    expect(await listComputers()).toHaveLength(2)
  })

  it('tras cerrar y reabrir la aplicación las fotos pendientes se reintentan, incluso sin operaciones en la cola', async () => {
    photoStore.configured = false
    const { result } = await run(photoBackup(2))
    await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(await getPendingSyncQueue()).toHaveLength(0)
    ;(await getDatabase()).close() // la aplicación se cierra
    photoStore.configured = true // y se abre con ImageKit configurado
    const summary = await synchronize('alice') // sincronización normal de inicio, sin force
    expect(summary).toMatchObject({ pending: 0, errors: 0 })
    expect(photoStore.uploads).toBe(2)
    expect((await listComputers()).every((item) => item.photoRemote && item.photo)).toBe(true)
  })

  it('no encola dos veces la misma foto ni toca registros sin foto o ya subidos', async () => {
    photoStore.configured = false
    await run(photoBackup(2))
    await saveComputer(computer('no-photo', 's1'), false)
    await (await getDatabase()).clear('syncQueue') // estado tras sincronizar sin ImageKit: sin operaciones pendientes
    const before = JSON.stringify((await listComputers()).map((item) => item.updatedAt))
    expect(await queuePendingPhotoUploads('alice')).toBe(2)
    expect(await queuePendingPhotoUploads('alice')).toBe(0)
    expect(await queuePendingPhotoUploads('bob')).toBe(0)
    expect(JSON.stringify((await listComputers()).map((item) => item.updatedAt))).toBe(before)
  })

  it('no elimina archivos de ImageKit al reintentar', async () => {
    photoStore.configured = false
    const { result } = await run(photoBackup(2))
    await syncAndVerifyRestore(result, 'alice', syncNow)
    photoStore.configured = true
    await syncAndVerifyRestore(result, 'alice', syncNow)
    expect(photoStore.deletes).toEqual([])
  })
})
