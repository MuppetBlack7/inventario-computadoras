import 'fake-indexeddb/auto'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => ({
  synchronize: vi.fn(),
  synchronizeAndPull: vi.fn(),
  pullCloudData: vi.fn()
}))
vi.mock('./cloudSync', () => sync)
vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {} }))

import { buildRecoveryReport, classifyOwner, needsRecoveryReview, runRecoveryDiagnostic, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { afterDiagnostic, authorizeRecovery, syncAllowed } from './recoveryState'
import { RecoveryView } from './components/RecoveryView'
import type { ComputerRecord, InventorySession, SyncQueueItem } from './types'

const stamp = '2026-01-01T00:00:00Z'
const session = (ownerId: string | undefined = 'alice', id = 's1'): InventorySession => ({ id, name: 'Sesión', date: '2026-01-01', location: '', ownerId, createdAt: stamp, updatedAt: stamp })
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: 'Marca', model: 'Modelo', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '',
  scannedAt: '', timezone: '', latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice',
  createdAt: stamp, updatedAt: stamp, ...changes
})
const op = (entityId: string, changes: Partial<SyncQueueItem> = {}): SyncQueueItem => ({
  id: `computer:${entityId}`, operation: 'upsert-computer', entityId, ownerId: 'alice', createdAt: stamp, revision: 'r1', ...changes
})
const snapshot = (computers: ComputerRecord[], queue: SyncQueueItem[] = [], sessions: InventorySession[] = [session()]): RecoverySnapshot => ({ sessions, computers, queue })
const remoteOf = (computers: ComputerRecord[], sessions: InventorySession[] = [session()]): RemoteRecoverySnapshot => ({ sessions, computers })
const report = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, account = 'alice') => buildRecoveryReport(local, remote, account, '2026-02-01T00:00:00Z')
const rowOf = (result: ReturnType<typeof report>, id: string) => result.rows.find((item) => item.kind === 'computer' && (item.localId === id || item.remoteId === id))!
const review = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, account = 'alice') => needsRecoveryReview(local, remote, report(local, remote, account))

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('clasificación de propiedad del diagnóstico', () => {
  it('registro propio coincidente: own-record, sin revisión', () => {
    const local = snapshot([computer('c1')])
    const result = report(local, remoteOf([computer('c1')]))
    const row = rowOf(result, 'c1')
    expect(row.categories).toEqual(expect.arrayContaining(['exact-id', 'own-record']))
    expect(row.categories).not.toContain('manual-review')
    expect(row.proposal).toBe('keep')
    expect(review(local, remoteOf([computer('c1')]))).toBe(false)
  })

  it('registro de otra cuenta coincidente en local y remoto: informativo, sin conflicto real', () => {
    const local = snapshot([computer('c1', { ownerId: 'bob' })])
    const remote = remoteOf([computer('c1', { ownerId: 'bob' })])
    const row = rowOf(report(local, remote), 'c1')
    expect(row.categories).toContain('other-account-record')
    expect(row.categories).not.toContain('owner-mismatch')
    expect(row.categories).not.toContain('manual-review')
    expect(row.proposal).toBe('no-action')
    expect(row.ownerId).toBe('bob')
    expect(review(local, remote)).toBe(false)
  })

  it('propietarios diferentes entre local y remoto: conflicto real con revisión manual', () => {
    const local = snapshot([computer('c1', { ownerId: 'bob' })])
    const remote = remoteOf([computer('c1', { ownerId: 'carol' })])
    const row = rowOf(report(local, remote), 'c1')
    expect(row.categories).toEqual(expect.arrayContaining(['owner-mismatch', 'manual-review', 'different']))
    expect(row.categories).not.toContain('other-account-record')
    expect(row.differences).toContain('ownerId')
    expect(review(local, remote)).toBe(true)
    // También si uno de los dos es la cuenta autenticada.
    expect(rowOf(report(snapshot([computer('c1', { ownerId: 'alice' })]), remoteOf([computer('c1', { ownerId: 'bob' })])), 'c1').categories).toContain('owner-mismatch')
  })

  it('propietario ausente: owner-missing para revisión; nunca se reclama ni se reasigna', () => {
    const missingLocal = computer('c1', { ownerId: undefined })
    const local = snapshot([missingLocal])
    const before = JSON.stringify(local)
    for (const remote of [remoteOf([computer('c1')]), remoteOf([computer('c1', { ownerId: undefined })])]) {
      const row = rowOf(report(local, remote), 'c1')
      expect(row.categories).toEqual(expect.arrayContaining(['owner-missing', 'manual-review']))
      expect(row.ownerId).toBeUndefined()
      expect(row.proposal).toBe('manual-review')
      expect(review(local, remote)).toBe(true)
    }
    expect(JSON.stringify(local)).toBe(before)
    // Solo local sin propietario.
    const only = rowOf(report(local, remoteOf([])), 'c1')
    expect(only.categories).toEqual(expect.arrayContaining(['local-only', 'owner-missing', 'manual-review']))
    expect(classifyOwner(undefined, undefined, true, false, 'alice')).toBe('owner-missing')
    expect(classifyOwner(undefined, 'bob', false, true, 'alice')).toBe('other-account-record')
  })

  it('operación pendiente de otra cuenta: se señala sin ejecutarla, eliminarla ni modificarla', () => {
    const foreignOperation = op('c1', { ownerId: 'bob' })
    const noOwnerOperation = op('c2', { ownerId: undefined })
    const queue = [foreignOperation, noOwnerOperation]
    const before = JSON.stringify(queue)
    const local = snapshot([computer('c1'), computer('c2')], queue)
    const remote = remoteOf([computer('c1'), computer('c2')])
    const result = report(local, remote)
    for (const id of ['c1', 'c2']) {
      const row = rowOf(result, id)
      expect(row.categories).toEqual(expect.arrayContaining(['foreign-pending-operation', 'queue-pending', 'manual-review']))
      expect(row.pending[0].foreign).toBe(true)
      expect(row.proposal).toBe('manual-review')
    }
    expect(JSON.stringify(queue)).toBe(before)
    expect(result.ownership.foreignPending).toBe(2)
    expect(result.ownership.pendingOperations).toBe(2)
    expect(needsRecoveryReview(local, remote, result)).toBe(true)
  })

  it('operación propia sobre un registro ajeno también se señala; la propia sobre un registro propio no es ajena', () => {
    const onForeign = report(snapshot([computer('c1', { ownerId: 'bob' })], [op('c1')]), remoteOf([computer('c1', { ownerId: 'bob' })]))
    expect(rowOf(onForeign, 'c1').categories).toContain('foreign-pending-operation')
    const own = report(snapshot([computer('c1')], [op('c1')]), remoteOf([computer('c1')]))
    expect(rowOf(own, 'c1').categories).not.toContain('foreign-pending-operation')
    expect(rowOf(own, 'c1').categories).toContain('queue-pending')
  })

  it('una operación huérfana de otra cuenta, sin registro en ningún lado, también queda señalada', () => {
    const result = report(snapshot([], [op('ghost', { ownerId: 'bob' })]), remoteOf([]))
    const row = result.rows.find((item) => item.localId === 'ghost')!
    expect(row.categories).toEqual(expect.arrayContaining(['foreign-pending-operation', 'manual-review']))
  })

  it('registro de otra cuenta con diferencias de contenido o fotografías NO queda como informativo limpio', () => {
    const differing = snapshot([computer('c1', { ownerId: 'bob', notes: 'local' })])
    const remoteDiffering = remoteOf([computer('c1', { ownerId: 'bob', notes: 'remoto' })])
    const row = rowOf(report(differing, remoteDiffering), 'c1')
    expect(row.categories).toEqual(expect.arrayContaining(['other-account-record', 'different', 'manual-review']))
    expect(row.differences).toEqual(['notes'])
    expect(review(differing, remoteDiffering)).toBe(true)

    const photo = new Blob(['x'], { type: 'image/png' })
    const withPhoto = snapshot([computer('c2', { ownerId: 'bob', photo })])
    const remotePhoto = remoteOf([computer('c2', { ownerId: 'bob' })])
    const photoRow = rowOf(report(withPhoto, remotePhoto), 'c2')
    expect(photoRow.categories).toEqual(expect.arrayContaining(['other-account-record', 'photo-pending']))
    expect(review(withPhoto, remotePhoto)).toBe(true)

    // Registro ajeno que existe solo en este dispositivo: no se puede subir con esta cuenta, requiere revisión.
    const localOnly = rowOf(report(snapshot([computer('c3', { ownerId: 'bob' })]), remoteOf([])), 'c3')
    expect(localOnly.categories).toEqual(expect.arrayContaining(['local-only', 'other-account-record', 'manual-review']))
    expect(localOnly.proposal).toBe('manual-review')
  })

  it('no ignora IDs diferentes, duplicados probables ni lectura remota fallida', () => {
    const duplicate = rowOf(report(snapshot([computer('c1')]), remoteOf([computer('c9', { serialNumber: 'SER-c1', serialNormalized: 'SERc1' })])), 'c1')
    expect(duplicate.categories).toEqual(expect.arrayContaining(['probable-duplicate', 'manual-review']))
    expect(review(snapshot([computer('c1', { ownerId: 'bob' })]), null)).toBe(true)
  })

  it('colección mixta: cuenta propios, informativos, conflictos y pendientes por separado', () => {
    const locals = [computer('own1'), computer('own2'), computer('bob1', { ownerId: 'bob' }), computer('bob2', { ownerId: 'bob' }),
      computer('mix', { ownerId: 'bob' }), computer('none', { ownerId: undefined })]
    const remotes = [computer('own1'), computer('own2'), computer('bob1', { ownerId: 'bob' }), computer('bob2', { ownerId: 'bob' }),
      computer('mix', { ownerId: 'carol' }), computer('none')]
    const local = snapshot(locals, [op('own2', { ownerId: 'bob' })], [session('alice'), session('bob', 's2')])
    const remote = remoteOf(remotes, [session('alice'), session('bob', 's2')])
    const result = report(local, remote)
    expect(result.ownership).toEqual({ own: 3, otherAccount: 3, mismatch: 1, missing: 1, foreignPending: 1, pendingOperations: 1 })
    expect(result.counts['manual-review']).toBe(3)
    expect(result.counts['other-account-record']).toBe(3)
    expect(needsRecoveryReview(local, remote, result)).toBe(true)
    expect(rowOf(result, 'bob1').proposal).toBe('no-action')
    expect(rowOf(result, 'own1').proposal).toBe('keep')
  })
})

describe('diagnóstico limpio sin sincronización', () => {
  it('con registros propios y de otras cuentas coincidentes queda en ready, nunca authorized, y no sincroniza', async () => {
    const local = snapshot([computer('own1'), computer('bob1', { ownerId: 'bob' }), computer('bob2', { ownerId: 'bob' })], [], [session('alice'), session('bob', 's2')])
    const remote = remoteOf(local.computers, local.sessions)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await runRecoveryDiagnostic('alice', { local: async () => local, remote: async () => remote })
      expect(result.needsReview).toBe(false)
      const state = afterDiagnostic(result.report, result.local, result.remote, result.needsReview)
      expect(state.phase).toBe('ready')
      expect(syncAllowed(state)).toBe(false)
      expect(result.report.writesEnabled).toBe(false)
    }
    expect(sync.synchronize).not.toHaveBeenCalled()
    expect(sync.synchronizeAndPull).not.toHaveBeenCalled()
    expect(sync.pullCloudData).not.toHaveBeenCalled()
  })
})

describe('resumen de la interfaz', () => {
  it('distingue propios, informativos de otras cuentas, conflictos reales y operaciones pendientes', () => {
    const local = snapshot([computer('own1'), computer('bob1', { ownerId: 'bob' }), computer('mix', { ownerId: 'bob' })], [op('own1', { ownerId: 'carol' })])
    const remote = remoteOf([computer('own1'), computer('bob1', { ownerId: 'bob' }), computer('mix', { ownerId: 'dan' })])
    const html = renderToStaticMarkup(<RecoveryView report={report(local, remote)} local={local} remote={remote} onRetry={() => undefined} onAuthorize={() => undefined} />)
    expect(html).toContain('Propios: 2')
    expect(html).toContain('Informativos de otras cuentas (solo lectura, sin acción): 1')
    expect(html).toContain('Conflictos reales de propietario: 1')
    expect(html).toContain('En la cola: 1')
    expect(html).toContain('no se ejecutan): 1')
    expect(html).toContain('sin acción: registro de otra cuenta, solo lectura')
    expect(html).toContain('decisión manual; conservar ambas versiones')
    expect(html).not.toContain('owner-conflict')
  })
})

describe('botón de autorización de la sincronización', () => {
  const render = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null) =>
    renderToStaticMarkup(<RecoveryView report={report(local, remote)} local={local} remote={remote} onRetry={() => undefined} onAuthorize={() => undefined} />)
  const button = 'Autorizar y reanudar la sincronización'

  it('aparece solo con el diagnóstico limpio, incluso con registros informativos de otras cuentas', () => {
    const local = snapshot([computer('own1'), computer('bob1', { ownerId: 'bob' })])
    const remote = remoteOf([computer('own1'), computer('bob1', { ownerId: 'bob' })])
    expect(review(local, remote)).toBe(false)
    expect(render(local, remote)).toContain(button)
  })

  it('no aparece con operaciones pendientes, propias o ajenas', () => {
    const remote = remoteOf([computer('c1')])
    for (const queue of [[op('c1')], [op('c1', { ownerId: 'bob' })]]) {
      const html = render(snapshot([computer('c1')], queue), remote)
      expect(html).not.toContain(button)
      expect(html).toContain('Por qué la sincronización sigue detenida')
    }
  })

  it('no aparece con conflictos de propietario, propietarios ausentes, diferencias, fotos pendientes, duplicados o sin lectura remota', () => {
    const photo = new Blob(['x'], { type: 'image/png' })
    const cases: Array<[RecoverySnapshot, RemoteRecoverySnapshot | null]> = [
      [snapshot([computer('c1', { ownerId: 'bob' })]), remoteOf([computer('c1', { ownerId: 'carol' })])],
      [snapshot([computer('c1', { ownerId: undefined })]), remoteOf([computer('c1')])],
      [snapshot([computer('c1', { notes: 'a' })]), remoteOf([computer('c1', { notes: 'b' })])],
      [snapshot([computer('c1', { photo })]), remoteOf([computer('c1')])],
      [snapshot([computer('c1')]), remoteOf([computer('c9', { serialNumber: 'SER-c1', serialNormalized: 'SERc1' })])],
      [snapshot([computer('c1')]), null]
    ]
    for (const [local, remote] of cases) expect(render(local, remote)).not.toContain(button)
  })

  it('el estado ready se recalcula con los datos: una cola pendiente nunca produce ready ni se puede autorizar', () => {
    const queued = snapshot([computer('c1')], [op('c1')])
    const remote = remoteOf([computer('c1')])
    const state = afterDiagnostic(report(queued, remote), queued, remote, false) // aunque se afirme «limpio»
    expect(state.phase).toBe('review')
    expect(syncAllowed(authorizeRecovery(state, 'alice'))).toBe(false)
    const clean = snapshot([computer('c1')])
    expect(afterDiagnostic(report(clean, remote), clean, remote, false).phase).toBe('ready')
  })

  it('el diagnóstico limpio no modifica registros ni operaciones de otras cuentas', () => {
    const local = snapshot([computer('bob1', { ownerId: 'bob' })], [])
    const before = JSON.stringify(local)
    const remote = remoteOf([computer('bob1', { ownerId: 'bob' })])
    afterDiagnostic(report(local, remote), local, remote, false)
    render(local, remote)
    expect(JSON.stringify(local)).toBe(before)
  })
})
