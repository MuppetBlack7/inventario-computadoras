import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {} }))

import { buildRecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { buildProposal, defaultDecisions, summarizeSync, type SyncDecisions } from './syncPlan'
import { clearAllData, enqueueOwnUploads, getComputer, getPendingSyncQueue, saveComputer, saveSession } from './db'
import { sharedRecordId } from './sharedImport'
import type { ComputerRecord, InventorySession, SyncQueueItem } from './types'

const stamp = '2026-01-01T00:00:00Z'
const session = (ownerId = 'alice', id = 's1'): InventorySession => ({ id, name: 'Sesión', date: '2026-01-01', location: '', ownerId, createdAt: stamp, updatedAt: stamp })
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: '', model: '', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '', scannedAt: '', timezone: '',
  latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice', ownerName: 'Alicia', createdAt: stamp, updatedAt: stamp, ...changes
})
const op = (entityId: string, changes: Partial<SyncQueueItem> = {}): SyncQueueItem => ({ id: `computer:${entityId}`, operation: 'upsert-computer', entityId, ownerId: 'alice', createdAt: stamp, revision: 'r1', ...changes })
const snap = (computers: ComputerRecord[], queue: SyncQueueItem[] = []): RecoverySnapshot => ({ sessions: [session(), session('bob', 's2')], computers, queue })
const remoteOf = (computers: ComputerRecord[]): RemoteRecoverySnapshot => ({ sessions: [session(), session('bob', 's2')], computers })
const photo = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
const report = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null) => buildRecoveryReport(local, remote, 'alice', '2026-02-01T00:00:00Z')
const proposal = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, change: Partial<SyncDecisions> = {}, imageKitConfigured = true) =>
  buildProposal(local, remote, report(local, remote), { ...defaultDecisions(), ...change }, { imageKitConfigured })
const ids = (items: Array<{ id: string }>) => items.map((item) => item.id).sort()

// Escenario: propios sincronizados, 39 importados sincronizados, equipos de un amigo y sus 2 fotos solo en su dispositivo.
const observed = () => {
  const imported = Array.from({ length: 39 }, (_, index) => computer(sharedRecordId('alice', `orig${index}`), { importedFrom: { id: `orig${index}`, importedAt: stamp }, photoRemote: { fileId: `f${index}`, url: 'https://x/y', filePath: '/inventario/alice/x', name: 'x', size: 1, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: stamp } }))
  const stuck = ['0150430', '0447137'].map((id) => computer(`stuck-${id}`, { ownerId: 'bob', ownerName: 'Su amigo', photoStoredLocally: true }))
  const all = [computer('own'), ...imported, ...stuck]
  return { local: snap(all), remote: remoteOf(all) }
}

describe('resumen «Sincronizar inventario»', () => {
  it('muestra conexión, pendientes, solo locales, solo en Firebase, diferentes, fotos y registros de otras cuentas', () => {
    const local = snap([computer('both'), computer('only-local'), computer('diff', { notes: 'a' }), computer('theirs', { ownerId: 'bob' }), computer('photo', { photo: photo(), photoNeedsUpload: true })], [op('only-local'), op('diff')])
    const remote = remoteOf([computer('both'), computer('diff', { notes: 'b' }), computer('theirs', { ownerId: 'bob' }), computer('only-remote'), computer('photo')])
    const overview = summarizeSync(local, remote, report(local, remote), true)
    expect(overview.connection).toBe('online')
    expect(overview.myPendingOperations).toBe(2)
    expect(overview.localOnly.map((item) => item.id)).toEqual(['only-local'])
    expect(overview.remoteOnly.map((item) => item.id)).toEqual(['only-remote'])
    expect(overview.different.map((item) => item.id)).toEqual(['diff'])
    expect(overview.different[0]).toMatchObject({ fields: ['notes'], hasPendingOperation: true, mine: true })
    expect(overview.photos.ownPending.map((item) => item.id)).toEqual(['photo'])
    expect(overview.otherAccountRecords).toBe(2) // el equipo de otra cuenta y su sesión
  })

  it('distingue conexión, sin conexión y Firebase sin responder', () => {
    const local = snap([computer('a')])
    expect(summarizeSync(local, remoteOf([computer('a')]), report(local, remoteOf([computer('a')])), false).connection).toBe('offline')
    expect(summarizeSync(local, null, report(local, null), true).connection).toBe('remote-unavailable')
  })

  it('las 2 fotos de otra cuenta aparecen con el nombre de quien debe recuperarlas y no se cuentan como recuperadas', () => {
    const { local, remote } = observed()
    const overview = summarizeSync(local, remote, report(local, remote), true)
    expect(overview.photos.otherAccount.map((item) => item.ownerName)).toEqual(['Su amigo', 'Su amigo'])
    expect(overview.photos.ownPending).toEqual([])
    expect(overview.otherAccountRecords).toBeGreaterThanOrEqual(2)
  })
})

describe('propuesta de sincronización', () => {
  it('con los 39 importados y las fotos de otra cuenta no propone escribir nada y conserva las advertencias', () => {
    const { local, remote } = observed()
    const result = proposal(local, remote)
    expect(result.steps).toEqual({ enqueue: [], download: [], upload: [], photos: [] })
    expect(result.runDownload || result.runUpload || result.runPhotos).toBe(false)
    expect(result.allowed).toBe(false)
    expect(result.kept.filter((item) => item.detail?.includes('solo su propietario puede subirla')).map((item) => item.id).sort()).toEqual(['stuck-0150430', 'stuck-0447137'])
    expect(local.computers.filter((item) => item.importedFrom).every((item) => item.ownerId === 'alice')).toBe(true)
  })

  it('subir mis cambios incluye solo operaciones propias; «conservar localmente» las excluye y las deja en la cola', () => {
    const local = snap([computer('a'), computer('b'), computer('theirs', { ownerId: 'bob' })], [op('a'), op('b'), op('theirs'), op('x', { ownerId: 'bob' })])
    const remote = remoteOf([computer('a'), computer('b'), computer('theirs', { ownerId: 'bob' })])
    const upload = proposal(local, remote)
    expect(ids(upload.steps.upload)).toEqual(['a', 'b'])
    expect(upload.kept.some((item) => item.id === 'theirs')).toBe(true)
    expect(upload.kept.some((item) => item.id === 'x')).toBe(true)
    const keep = proposal(local, remote, { uploadMyChanges: false })
    expect(keep.steps.upload).toEqual([])
    expect(keep.excludeIds.has('a') && keep.excludeIds.has('b')).toBe(true)
    expect(keep.kept.some((item) => item.id === '*' && item.detail?.includes('se conservan en la cola'))).toBe(true)
  })

  it('equipos solo locales: se preparan solo si son míos y no tienen duplicado ni conflicto; el resto se conserva con su motivo', () => {
    const local = snap([
      computer('mine'), computer('mine-queued'), computer('theirs', { ownerId: 'bob' }), computer('nobody', { ownerId: undefined }),
      computer('dup', { serialNumber: 'SER-z', serialNormalized: 'SERz' })
    ], [op('mine-queued')])
    const remote = remoteOf([computer('z-other', { serialNumber: 'SER-z', serialNormalized: 'SERz' })])
    const result = proposal(local, remote)
    expect(result.enqueueIds).toEqual(['mine'])
    const reasons = Object.fromEntries(result.kept.map((item) => [item.id, item.detail]))
    expect(reasons.theirs).toContain('otra cuenta')
    expect(reasons.nobody).toContain('sin propietario')
    expect(reasons.dup).toContain('posible duplicado')
    expect(proposal(local, remote, { localOnly: 'keep' }).enqueueIds).toEqual([])
  })

  it('un posible duplicado o un conflicto de propietario nunca se sube ni se descarga', () => {
    const local = snap([computer('a'), computer('c', { ownerId: 'bob' })], [op('a'), op('c')])
    const remote = remoteOf([computer('other', { serialNumber: 'SER-a', serialNormalized: 'SERa' }), computer('c', { ownerId: 'carol' })])
    const result = proposal(local, remote)
    expect(result.steps.upload).toEqual([])
    expect(result.steps.download).toEqual([])
    expect(result.excludeIds.has('a') && result.excludeIds.has('c')).toBe(true)
  })

  it('solo en Firebase: descargar o no, sin eliminar nada local', () => {
    const local = snap([computer('a')])
    const remote = remoteOf([computer('a'), computer('new'), computer('newer', { ownerId: 'bob' })])
    expect(ids(proposal(local, remote).steps.download)).toEqual(['new', 'newer'])
    const skip = proposal(local, remote, { remoteOnly: 'skip' })
    expect(skip.steps.download).toEqual([])
    expect(skip.excludeIds.has('new')).toBe(true)
    expect(JSON.stringify(proposal(local, remote).steps)).not.toMatch(/delete|remove|eliminar/)
  })

  it('cambios distintos en ambos lados: por defecto se conserva la versión local; cada registro se resuelve por separado', () => {
    const local = snap([computer('d1', { notes: 'a' }), computer('d2', { notes: 'a' }), computer('d3', { notes: 'a' }), computer('d4', { notes: 'a', ownerId: 'bob' })], [op('d3')])
    const remote = remoteOf([computer('d1', { notes: 'b' }), computer('d2', { notes: 'b' }), computer('d3', { notes: 'b' }), computer('d4', { notes: 'b', ownerId: 'bob' })])
    const none = proposal(local, remote)
    expect(none.steps.download).toEqual([])
    expect([...none.excludeIds].sort()).toEqual(['d1', 'd2', 'd3', 'd4'])
    const resolved = proposal(local, remote, { perRecord: { d1: 'use-remote', d2: 'upload-mine', d3: 'use-remote', d4: 'upload-mine' } })
    expect(ids(resolved.steps.download)).toEqual(['d1']) // d3 tiene una operación pendiente: no se sobrescribe
    expect(resolved.enqueueIds).toEqual(['d2']) // d4 no es mío: no se sube
    expect(resolved.kept.find((item) => item.id === 'd3')?.detail).toContain('no se sobrescribe')
    expect(resolved.kept.find((item) => item.id === 'd4')?.detail).toContain('no es un registro propio')
  })

  it('fotografías: solo las mías y solo con ImageKit configurado; si no, se conservan en el dispositivo', () => {
    const mine = computer('mine', { photo: photo(), photoNeedsUpload: true, photoUploadStatus: 'pending' })
    const local = snap([mine], [op('mine')])
    const remote = remoteOf([{ ...mine, photo: undefined }])
    expect(proposal(local, remote).steps.photos.map((item) => item.action)).toEqual(['upload-photo', 'write-document'])
    const without = proposal(local, remote, {}, false)
    expect(without.steps.photos).toEqual([])
    expect(without.kept.some((item) => item.detail?.includes('ImageKit no está configurado'))).toBe(true)
    expect(proposal(local, remote, { uploadPhotos: false }).steps.photos).toEqual([])
  })

  it('sin lectura de Firebase no se puede sincronizar ni comparar duplicados', () => {
    const local = snap([computer('a')], [op('a')])
    const result = proposal(local, null)
    expect(result.allowed).toBe(false)
    expect(result.runUpload || result.runDownload || result.runPhotos).toBe(false)
    expect(result.blockedBy[0]).toContain('Firebase no respondió')
  })

  it('la huella es estable con los mismos datos y cambia si cambia algo, y la propuesta no modifica los datos', () => {
    const local = snap([computer('a')], [op('a')])
    const remote = remoteOf([computer('a')])
    const before = JSON.stringify([local, remote])
    const first = proposal(local, remote)
    expect(proposal(local, remote).key).toBe(first.key)
    expect(proposal(snap([computer('a'), computer('b')], [op('a'), op('b')]), remoteOf([computer('a'), computer('b')])).key).not.toBe(first.key)
    expect(proposal(local, remote, { uploadMyChanges: false }).key).not.toBe(first.key)
    expect(JSON.stringify([local, remote])).toBe(before)
  })
})

describe('preparar subidas en la cola local (sin escribir en Firebase)', () => {
  beforeEach(async () => { await clearAllData() })

  it('crea la operación solo para registros propios sin operación, sin modificar el registro, y es idempotente', async () => {
    await saveSession(session('alice', 's1'), false)
    await saveComputer(computer('mine'), false)
    await saveComputer(computer('theirs', { ownerId: 'bob' }), false)
    const before = JSON.stringify(await getComputer('mine'))
    expect(await enqueueOwnUploads('alice', ['mine', 'theirs', 's1', 'inexistente'])).toBe(2)
    expect(await enqueueOwnUploads('alice', ['mine', 'theirs', 's1'])).toBe(0)
    expect((await getPendingSyncQueue()).map((item) => item.id).sort()).toEqual(['computer:mine', 'session:s1'])
    expect(JSON.stringify(await getComputer('mine'))).toBe(before)
    expect(await getComputer('theirs')).toBeDefined()
  })

  it('no crea una subida si ya existe una operación (por ejemplo, una baja) para ese registro', async () => {
    await saveComputer(computer('mine'))
    const queue = await getPendingSyncQueue()
    expect(await enqueueOwnUploads('alice', ['mine'])).toBe(0)
    expect(await getPendingSyncQueue()).toEqual(queue)
  })
})
