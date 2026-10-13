import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => ({
  synchronize: vi.fn(async () => ({ synced: 0, errors: 0, pending: 0, photosLocalOnly: 0 })),
  synchronizeAndPull: vi.fn(async () => ({ synced: 0, errors: 0, pending: 0, photosLocalOnly: 0 })),
  pullCloudData: vi.fn(async () => ({ sessions: 0, computers: 0, reads: 0 })),
  setDoc: vi.fn(),
  deleteDoc: vi.fn()
}))
vi.mock('./cloudSync', () => sync)
vi.mock('firebase/firestore', () => ({ setDoc: sync.setDoc, deleteDoc: sync.deleteDoc, collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {} }))

import { exportRecoverySnapshot, readLocalRecoverySnapshot, runRecoveryDiagnostic, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { afterDiagnostic, appUsable, authorizeRecovery, CHECKING, keepSyncStopped, syncAllowed } from './recoveryState'
import { getDatabase } from './db'
import type { ComputerRecord, InventorySession, SyncQueueItem } from './types'

const stamp = '2026-01-01T00:00:00Z'
const session: InventorySession = { id: 's1', name: 'Sesión', date: '2026-01-01', location: '', ownerId: 'alice', createdAt: stamp, updatedAt: stamp }
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: 'Marca', model: 'Modelo', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '',
  scannedAt: '', timezone: '', latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice',
  createdAt: stamp, updatedAt: stamp, cloudId: id, ...changes
})
const remotePhoto = { fileId: 'f1', url: 'https://example.com/f1.jpg', filePath: '/inventario/alice/f1.jpg', name: 'f1.jpg', size: 3, width: null, height: null, mimeType: 'image/png', uploadedAt: stamp }
const queued: SyncQueueItem = { id: 'computer:q1', operation: 'upsert-computer', entityId: 'q1', ownerId: 'alice', createdAt: stamp, revision: 'r1' }

const seed = async (computers: ComputerRecord[], queue: SyncQueueItem[] = []) => {
  const db = await getDatabase()
  const tx = db.transaction(['sessions', 'computers', 'syncQueue'], 'readwrite')
  await tx.objectStore('sessions').clear()
  await tx.objectStore('computers').clear()
  await tx.objectStore('syncQueue').clear()
  await tx.objectStore('sessions').put(session)
  for (const item of computers) await tx.objectStore('computers').put(item)
  for (const item of queue) await tx.objectStore('syncQueue').put(item)
  await tx.done
}
const snapshotOf = async () => {
  const local = await readLocalRecoverySnapshot()
  const computers = await Promise.all(local.computers.map(async ({ photo, ...rest }) => ({ ...rest, photo: photo ? Array.from(new Uint8Array(await photo.arrayBuffer())) : null })))
  return JSON.stringify({ sessions: local.sessions, computers, queue: local.queue })
}

let writes: ReturnType<typeof vi.spyOn>[] = []
beforeEach(() => {
  vi.clearAllMocks()
  writes = (['put', 'add', 'delete', 'clear'] as const).map((method) => vi.spyOn(IDBObjectStore.prototype, method))
})
afterEach(() => { vi.restoreAllMocks() })
const writeCalls = () => writes.reduce((total, spy) => total + spy.mock.calls.length, 0)

describe('el diagnóstico de recuperación es de solo lectura', () => {
  it('repetido varias veces con resultado limpio no sincroniza, no escribe y no modifica IndexedDB', async () => {
    const photo = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const records = [computer('c1', { photo, photoRemote: remotePhoto }), computer('c2')]
    await seed(records)
    const remote: RemoteRecoverySnapshot = { sessions: [session], computers: records.map(({ photo: _photo, ...rest }) => rest as ComputerRecord) }
    const before = await snapshotOf()
    writes.forEach((spy) => spy.mockClear())
    const remoteReader = vi.fn(async () => remote)
    let state = CHECKING
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await runRecoveryDiagnostic('alice', { local: readLocalRecoverySnapshot, remote: remoteReader })
      expect(result.needsReview).toBe(false)
      state = afterDiagnostic(result.report, result.local, result.remote, result.needsReview)
      expect(state.phase).toBe('ready')
      expect(syncAllowed(state)).toBe(false)
      expect(result.report.writesEnabled).toBe(false)
    }
    expect(remoteReader).toHaveBeenCalledTimes(5)
    expect(writeCalls()).toBe(0)
    expect(sync.synchronize).not.toHaveBeenCalled()
    expect(sync.synchronizeAndPull).not.toHaveBeenCalled()
    expect(sync.pullCloudData).not.toHaveBeenCalled()
    expect(sync.setDoc).not.toHaveBeenCalled()
    expect(sync.deleteDoc).not.toHaveBeenCalled()
    expect(await snapshotOf()).toBe(before)
  })

  it('con operaciones pendientes, conflictos o sin lectura remota tampoco escribe y exige revisión', async () => {
    await seed([computer('c1', { ownerId: 'bob' }), computer('q1', { cloudId: undefined })], [queued])
    const before = await snapshotOf()
    writes.forEach((spy) => spy.mockClear())
    const remoteComputers = [computer('c1', { ownerId: 'bob' })]
    for (const remote of [{ sessions: [session], computers: remoteComputers }, null]) {
      const result = await runRecoveryDiagnostic('alice', { local: readLocalRecoverySnapshot, remote: async () => { if (!remote) throw new Error('sin red'); return remote } })
      expect(result.needsReview).toBe(true)
      expect(afterDiagnostic(result.report, result.local, result.remote, result.needsReview).phase).toBe('review')
    }
    expect(writeCalls()).toBe(0)
    expect(sync.synchronize).not.toHaveBeenCalled()
    expect(await snapshotOf()).toBe(before)
  })

  it('exportar la copia solo lee: no modifica registros, cola ni fotografías', async () => {
    const photo = new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' })
    await seed([computer('c1', { photo })], [queued])
    const before = await snapshotOf()
    writes.forEach((spy) => spy.mockClear())
    const local: RecoverySnapshot = await readLocalRecoverySnapshot()
    const result = await runRecoveryDiagnostic('alice', { local: async () => local, remote: async () => ({ sessions: [session], computers: [computer('c1')] }) })
    const exported = await exportRecoverySnapshot(local, result.remote, result.report)
    expect(exported.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(exported.payload).local.computers[0].photoDataUrl).toContain('base64')
    expect(writeCalls()).toBe(0)
    expect(sync.setDoc).not.toHaveBeenCalled()
    expect(await snapshotOf()).toBe(before)
  })
})

describe('la sincronización solo se reanuda con autorización explícita', () => {
  const report = { accountId: 'alice', remoteAvailable: true, localCounts: { queue: 0 }, rows: [] } as never
  const local: RecoverySnapshot = { sessions: [], computers: [], queue: [] }

  it('ningún resultado de diagnóstico produce el estado autorizado', () => {
    for (const needsReview of [true, false]) {
      const state = afterDiagnostic(report, local, null, needsReview)
      expect(syncAllowed(state)).toBe(false)
      expect(syncAllowed(afterDiagnostic(report, local, null, needsReview))).toBe(false)
    }
    expect(syncAllowed(CHECKING)).toBe(false)
  })

  it('solo se autoriza un diagnóstico limpio de la misma cuenta y nunca una revisión pendiente', () => {
    const server = { sessions: [], computers: [] }
    const ready = afterDiagnostic(report, local, server, false)
    expect(authorizeRecovery(CHECKING, 'alice')).toBe(CHECKING)
    expect(authorizeRecovery(ready, 'mallory')).toBe(ready)
    expect(syncAllowed(authorizeRecovery(ready, 'mallory'))).toBe(false)
    expect(syncAllowed(authorizeRecovery(ready, 'alice'))).toBe(true)
    expect(syncAllowed(authorizeRecovery(afterDiagnostic(report, local, server, true), 'alice'))).toBe(false)
  })

  it('«mantener detenida» permite usar la aplicación en local sin permitir nunca la sincronización', () => {
    const server = { sessions: [], computers: [] }
    for (const needsReview of [true, false]) {
      const state = afterDiagnostic(report, local, server, needsReview)
      const stopped = keepSyncStopped(state)
      expect(stopped.phase).toBe('local-only')
      expect(appUsable(stopped)).toBe(true)
      expect(syncAllowed(stopped)).toBe(false)
      expect(syncAllowed(authorizeRecovery(stopped, 'alice'))).toBe(false)
    }
    expect(keepSyncStopped(CHECKING)).toBe(CHECKING)
    // El inventario siempre es utilizable: la sincronización detenida no bloquea la pantalla principal.
    expect(appUsable(CHECKING)).toBe(true)
    expect(appUsable(afterDiagnostic(report, local, server, false))).toBe(true)
  })

  it('en App.tsx el diagnóstico no puede iniciar sincronizaciones ni liberar el bloqueo', () => {
    const source = readFileSync('src/App.tsx', 'utf8')
    const start = source.indexOf('const inspectRecovery = useCallback(')
    const body = source.slice(start, source.indexOf('}, [])', start))
    expect(start).toBeGreaterThan(-1)
    for (const forbidden of ['runSync', 'synchronize', 'recoveryHoldRef.current = false', 'authorize', 'runSyncRef', "'authorized'"]) expect(body).not.toContain(forbidden)
    // El bloqueo solo se libera en la acción explícita de autorización.
    const releases = [...source.matchAll(/recoveryHoldRef\.current = false/g)]
    expect(releases).toHaveLength(1)
    expect(releases[0].index).toBeGreaterThan(source.indexOf('const authorizeSync'))
    expect(source).not.toContain('runSyncRef')
    expect(source).toContain('if (!ownerId || !syncAllowed(recovery)) return')
    expect(source).toContain('{user && appUsable(recovery) && <BottomNav')
  })

  it('el botón «Actualizar diagnóstico» solo llama a inspectRecovery y la autorización exige confirmación', () => {
    const view = readFileSync('src/components/RecoveryView.tsx', 'utf8')
    const app = readFileSync('src/App.tsx', 'utf8')
    expect(app).toContain('onRetry={() => void inspectRecovery(user.uid)}')
    expect(view).toContain('onClick={onRetry}')
    expect(view).toContain('disabled={!backedUp}')
    expect(view).toContain('window.confirm(')
  })
})
