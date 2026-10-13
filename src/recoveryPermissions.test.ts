import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {} }))

import { buildRecoveryReport, describeReviewReasons, needsRecoveryReview, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { evaluateScopes, photosAtRisk, planUpdateAll, previewScope, type RecoveryScope } from './recoveryPermissions'
import { sharedRecordId } from './sharedImport'
import type { ComputerRecord, InventorySession, SyncQueueItem } from './types'

const stamp = '2026-01-01T00:00:00Z'
const session = (ownerId = 'alice', id = 's1'): InventorySession => ({ id, name: 'Sesión', date: '2026-01-01', location: '', ownerId, createdAt: stamp, updatedAt: stamp })
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: 'Marca', model: 'Modelo', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '',
  scannedAt: '', timezone: '', latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice',
  createdAt: stamp, updatedAt: stamp, ...changes
})
const op = (entityId: string, changes: Partial<SyncQueueItem> = {}): SyncQueueItem => ({ id: `computer:${entityId}`, operation: 'upsert-computer', entityId, ownerId: 'alice', createdAt: stamp, revision: 'r1', ...changes })
const remoteRef = { fileId: 'f1', url: 'https://x/y', filePath: '/inventario/alice/f1.jpg', name: 'f1.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: stamp }
const photo = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
const snap = (computers: ComputerRecord[], queue: SyncQueueItem[] = []): RecoverySnapshot => ({ sessions: [session(), session('bob', 's2')], computers, queue })
const remoteOf = (computers: ComputerRecord[]): RemoteRecoverySnapshot => ({ sessions: [session(), session('bob', 's2')], computers })
const evaluate = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, imageKitConfigured = true) => {
  const report = buildRecoveryReport(local, remote, 'alice', '2026-02-01T00:00:00Z')
  return { report, decisions: evaluateScopes(local, remote, report, { imageKitConfigured }), preview: (scope: RecoveryScope) => previewScope(scope, local, remote, report) }
}

// El caso observado: mis equipos, 39 copias importadas ya sincronizadas y 2 equipos de mi amigo con la foto solo en su dispositivo.
const observed = () => {
  const mine = Array.from({ length: 5 }, (_, index) => computer(`own${index}`))
  const imported = Array.from({ length: 39 }, (_, index) => computer(sharedRecordId('alice', `orig${index}`), { importedFrom: { id: `orig${index}`, importedAt: stamp }, photo: photo(), photoRemote: remoteRef, photoUploadStatus: 'uploaded' }))
  const stuck = ['0150430', '0447137'].map((id) => computer(`stuck-${id}`, { ownerId: 'bob', photoStoredLocally: true }))
  const all = [...mine, ...imported, ...stuck]
  const remoteAll = all.map(({ photo: _photo, ...rest }) => rest as ComputerRecord)
  return { local: snap(all), remote: remoteOf(remoteAll) }
}

describe('alcances separados de la recuperación', () => {
  it('con 2 fotos pendientes de otra cuenta, las operaciones propias podrían habilitarse y las fotos siguen visibles como advertencia', () => {
    const { local, remote } = observed()
    const { report, decisions } = evaluate(local, remote)
    expect(needsRecoveryReview(local, remote, report)).toBe(true) // el bloqueo global actual sigue mostrándolas
    expect(describeReviewReasons(local, remote, report).map((reason) => reason.code)).toEqual(['photo-pending-other-account'])
    expect(decisions['local-edits'].allowed).toBe(true)
    expect(decisions['push-own'].allowed).toBe(true)
    expect(decisions['pull-remote'].allowed).toBe(true)
    for (const decision of Object.values(decisions)) expect(decision.warnings.join(' ')).toContain('2 fotografías pendientes de otra cuenta')
  })

  it('las operaciones sobre registros ajenos siguen bloqueadas siempre', () => {
    const { local, remote } = observed()
    expect(evaluate(local, remote).decisions['foreign-operations']).toMatchObject({ allowed: false, blockedBy: ['owner-only-by-rules'] })
    for (const [scopeLocal, scopeRemote] of [[snap([]), remoteOf([])], [snap([computer('a')]), null]] as Array<[RecoverySnapshot, RemoteRecoverySnapshot | null]>) {
      expect(evaluate(scopeLocal, scopeRemote).decisions['foreign-operations'].allowed).toBe(false)
    }
  })

  it('subir mis operaciones solo incluye operaciones propias sobre registros propios; las ajenas quedan excluidas sin tocarse', () => {
    const own = computer('mine')
    const theirs = computer('theirs', { ownerId: 'bob' })
    const queue = [op('mine'), op('theirs'), op('bobs-op', { ownerId: 'bob' }), op('nobody', { ownerId: undefined }), op('gone', { operation: 'delete-computer' })]
    const local = snap([own, theirs, computer('bobs-op', { ownerId: 'bob' }), computer('nobody')], queue)
    const { preview } = evaluate(local, remoteOf([own, theirs, computer('bobs-op', { ownerId: 'bob' }), computer('nobody')]))
    const result = preview('push-own')
    expect(result.items.map((item) => item.id).sort()).toEqual(['gone', 'mine'])
    expect(result.excluded.map((item) => item.id).sort()).toEqual(['bobs-op', 'nobody', 'theirs'])
    expect(result.excluded.find((item) => item.id === 'theirs')?.detail).toContain('registro de otra cuenta')
    expect(JSON.stringify(local.queue)).toBe(JSON.stringify(queue)) // la cola no se modifica
  })

  it('los 39 equipos importados ya sincronizados no producen subidas, fotos ni documentos nuevos', () => {
    const { local, remote } = observed()
    const { preview } = evaluate(local, remote)
    expect(preview('push-own').items).toEqual([])
    expect(preview('upload-own-photos').items).toEqual([])
    expect(preview('pull-remote').items).toEqual([])
    expect(local.computers.filter((item) => item.importedFrom).every((item) => item.id === sharedRecordId('alice', item.importedFrom!.id))).toBe(true)
  })

  it('las fotos pendientes de mis equipos sí pueden resolverse desde mi cuenta, con vista previa; las de otra cuenta quedan excluidas', () => {
    const mine = computer('mine', { photo: photo(), photoNeedsUpload: true, photoUploadStatus: 'pending' })
    const stuck = computer('stuck', { ownerId: 'bob', photoStoredLocally: true })
    const local = snap([mine, stuck])
    const remote = remoteOf([{ ...mine, photo: undefined }, stuck])
    const ready = evaluate(local, remote, true)
    expect(ready.decisions['upload-own-photos'].allowed).toBe(true)
    expect(ready.preview('upload-own-photos').items).toEqual([
      { action: 'upload-photo', kind: 'computer', id: 'mine', detail: '3 bytes' },
      { action: 'write-document', kind: 'computer', id: 'mine', detail: 'sin cambios de datos respecto a Firestore; se encolará una operación local' }
    ])
    expect(ready.preview('upload-own-photos').excluded.map((item) => item.id)).toEqual(['stuck'])
    expect(evaluate(local, remote, false).decisions['upload-own-photos']).toMatchObject({ allowed: false, blockedBy: ['imagekit-not-configured'] })
  })

  it('sin fotos propias que subir el alcance de fotos no tiene nada que habilitar', () => {
    const { local, remote } = observed()
    expect(evaluate(local, remote).decisions['upload-own-photos']).toMatchObject({ allowed: false, blockedBy: ['nothing-to-upload'] })
  })

  it('los conflictos propios bloquean subir; los ajenos no, pero sí bloquean descargar', () => {
    const foreignDifference = snap([computer('b', { ownerId: 'bob', notes: 'local' })])
    const foreignRemote = remoteOf([computer('b', { ownerId: 'bob', notes: 'remoto' })])
    const foreign = evaluate(foreignDifference, foreignRemote)
    expect(foreign.decisions['push-own'].allowed).toBe(true)
    expect(foreign.decisions['pull-remote']).toMatchObject({ allowed: false, blockedBy: ['different'] })
    expect(foreign.preview('pull-remote').items).toEqual([{ action: 'overwrite-local-copy', kind: 'computer', id: 'b', detail: 'campos: notes' }])
    const ownDifference = evaluate(snap([computer('a', { notes: 'x' })]), remoteOf([computer('a', { notes: 'y' })]))
    expect(ownDifference.decisions['push-own']).toMatchObject({ allowed: false, blockedBy: ['different'] })
    expect(evaluate(snap([computer('a', { ownerId: undefined })]), remoteOf([computer('a')])).decisions['push-own'].blockedBy).toContain('owner-missing')
    expect(evaluate(snap([computer('a')]), null).decisions['push-own'].blockedBy).toContain('remote-unavailable')
  })

  it('descargar ya no se bloquea por fotos locales: applyRemoteComputer conserva los bytes', () => {
    const withBytes = computer('keep', { ownerId: 'bob', photo: photo(), photoStoredLocally: true })
    const local = snap([withBytes])
    const remote = remoteOf([{ ...withBytes, photo: undefined }])
    expect(photosAtRisk(local, remote)).toEqual(['keep']) // informativo
    expect(evaluate(local, remote).decisions['pull-remote'].allowed).toBe(true)
  })

  it('«actualizar todos» concilia primero y excluye registros con conflictos, duplicados, propietario ausente o contenido distinto', () => {
    const mine = [computer('ok'), computer('diff', { notes: 'a' }), computer('dup'), computer('noowner', { ownerId: undefined }), computer('mismatch', { ownerId: 'bob' })]
    const theirs = [computer('ok'), computer('diff', { notes: 'b' }), computer('other', { serialNumber: 'SER-dup', serialNormalized: 'SERdup' }), computer('noowner'), computer('mismatch', { ownerId: 'carol' })]
    const local = snap(mine, [op('ok'), op('diff'), op('noowner')])
    const result = evaluate(local, remoteOf(theirs))
    const plan = planUpdateAll(local, remoteOf(theirs), result.report, { imageKitConfigured: true })
    expect(plan.allowed).toBe(true)
    expect([...plan.excludeIds].sort()).toEqual(expect.arrayContaining(['diff', 'dup', 'mismatch', 'noowner']))
    expect(plan.excludeIds.has('ok')).toBe(false)
    expect(plan.steps.operations.map((item) => item.id)).toEqual(['ok'])
    expect(plan.excluded.map((item) => item.id)).toEqual(expect.arrayContaining(['diff', 'dup', 'noowner', 'mismatch']))
  })

  it('«actualizar todos» no incluye registros ni operaciones ajenas ni las fotos de otra cuenta, y no depende de ImageKit si no hay fotos propias', () => {
    const { local, remote } = observed()
    const { report } = evaluate(local, remote)
    const plan = planUpdateAll(local, remote, report, { imageKitConfigured: false })
    expect(plan.allowed).toBe(true)
    expect(plan.steps).toEqual({ pull: [], operations: [], photos: [] })
    expect(plan.excluded.map((item) => item.id).sort()).toEqual(['stuck-0150430', 'stuck-0447137'])
    expect(planUpdateAll(local, null, report, { imageKitConfigured: true })).toMatchObject({ allowed: false, blockedBy: ['remote-unavailable'] })
  })

  it('cada alcance se decide por separado: permitir uno no cambia el resultado de otro', () => {
    const local = snap([computer('b', { ownerId: 'bob', notes: 'local' })])
    const remote = remoteOf([computer('b', { ownerId: 'bob', notes: 'remoto' })])
    const first = evaluate(local, remote).decisions
    expect(first['push-own'].allowed).toBe(true)
    expect(first['pull-remote'].allowed).toBe(false)
    expect(first['upload-own-photos'].allowed).toBe(false)
    expect(evaluate(local, remote).decisions).toEqual(first)
  })

  it('la evaluación y las vistas previas son de solo lectura y nunca marcan como recuperada una foto ajena', () => {
    const { local, remote } = observed()
    const before = JSON.stringify([local, remote])
    const result = evaluate(local, remote)
    for (const scope of ['local-edits', 'pull-remote', 'push-own', 'upload-own-photos', 'foreign-operations'] as RecoveryScope[]) result.preview(scope)
    expect(JSON.stringify([local, remote])).toBe(before)
    const stillPending = result.report.rows.filter((row) => row.categories.includes('photo-pending')).map((row) => row.localId)
    expect(stillPending).toEqual(['stuck-0150430', 'stuck-0447137'])
    expect(local.computers.filter((item) => item.ownerId === 'bob').every((item) => !item.photoRemote && !item.photo)).toBe(true)
  })
})
