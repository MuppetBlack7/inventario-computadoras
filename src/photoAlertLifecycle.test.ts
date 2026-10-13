import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn(), setDoc: vi.fn(), deleteDoc: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {} }))

import { describeReviewReasons, hasValidRemotePhoto, readLocalRecoverySnapshot, runRecoveryDiagnostic, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { computeSyncDisplay } from './syncDisplay'
import { getDatabase } from './db'
import type { ComputerRecord, ImageKitPhotoReference, InventorySession } from './types'

const stamp = '2026-01-01T00:00:00Z'
const session: InventorySession = { id: 's1', name: 'Sesión', date: '2026-01-01', location: '', ownerId: 'alice', createdAt: stamp, updatedAt: stamp }
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: 'Marca', model: 'Modelo', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '',
  scannedAt: '', timezone: '', latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'bob', ownerName: 'Su amigo',
  createdAt: stamp, updatedAt: stamp, cloudId: id, ...changes
})
const reference = (changes: Partial<ImageKitPhotoReference> = {}): ImageKitPhotoReference => ({
  fileId: 'f1', url: 'https://ik.example/f1.jpg', filePath: '/inventario/bob/f1.jpg', name: 'f1.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: stamp, ...changes
})

// La copia local de mi dispositivo: foto de otra cuenta que solo existe en su dispositivo (sin bytes ni referencia).
const stuck = () => computer('0150430', { photoStoredLocally: true })
const local = (): RecoverySnapshot => ({ sessions: [session], computers: [stuck()], queue: [] })
const remoteWith = (changes: Partial<ComputerRecord>): RemoteRecoverySnapshot => ({ sessions: [session], computers: [computer('0150430', { photoStoredLocally: true, ...changes })] })
const alerts = async (remote: RemoteRecoverySnapshot | null) => {
  const result = await runRecoveryDiagnostic('alice', { local: async () => local(), remote: async () => { if (!remote) throw new Error('offline'); return remote } })
  return { result, reasons: describeReviewReasons(result.local, result.remote, result.report).filter((reason) => reason.code === 'photo-pending-other-account') }
}

describe('ciclo de vida de photo-pending-other-account', () => {
  it('con la foto sin subir la alerta existe', async () => {
    const { reasons } = await alerts(remoteWith({}))
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatchObject({ count: 1, actor: 'other-account' })
  })

  it('desaparece solo cuando Firestore trae una referencia remota válida', async () => {
    const { reasons, result } = await alerts(remoteWith({ photoRemote: reference(), photoStoredLocally: false, updatedAt: '2026-02-01T00:00:00Z' }))
    expect(reasons).toEqual([])
    expect(result.report.rows[0].categories).not.toContain('photo-pending')
  })

  it('si el propietario sube los datos pero no la fotografía, la alerta permanece', async () => {
    const edited = await alerts(remoteWith({ notes: 'texto nuevo', updatedAt: '2026-02-01T00:00:00Z' }))
    expect(edited.reasons).toHaveLength(1)
    const failedUpload = await alerts(remoteWith({ photoUploadStatus: 'error', photoUploadError: 'ImageKit no respondió', updatedAt: '2026-02-01T00:00:00Z' }))
    expect(failedUpload.reasons).toHaveLength(1)
  })

  it('una referencia incompleta, vacía o con ruta ajena no cuenta como válida', async () => {
    const invalid: Array<Partial<ImageKitPhotoReference>> = [
      { fileId: '' }, { url: '' }, { filePath: '/inventario/alice/f1.jpg' }, { filePath: '/otra/carpeta/f1.jpg' }, { filePath: '/inventario/bob/../secreto' }, { filePath: '/inventario/bob/' }
    ]
    for (const changes of invalid) {
      expect(hasValidRemotePhoto(computer('x', { photoRemote: reference(changes) }))).toBe(false)
      expect((await alerts(remoteWith({ photoRemote: reference(changes) }))).reasons).toHaveLength(1)
    }
    expect(hasValidRemotePhoto(computer('x'))).toBe(false)
    expect(hasValidRemotePhoto(computer('x', { ownerId: '' as string, photoRemote: reference() }))).toBe(false)
    expect(hasValidRemotePhoto(computer('x', { photoRemote: reference() }))).toBe(true)
  })

  it('si Firebase o ImageKit fallan al consultar, la alerta no se elimina', async () => {
    const { result, reasons } = await alerts(null)
    expect(result.remote).toBeNull()
    expect(result.report.remoteAvailable).toBe(false)
    expect(reasons).toHaveLength(1)
    const display = computeSyncDisplay({ online: true, paused: true, pending: 0, failedOperations: 0, photoProblems: 0, syncStatus: 'local', report: result.report, now: Date.parse(result.report.generatedAt) })
    expect(display.title).toBe('Estado remoto sin verificar')
    expect(display.foreignPhotos).toBe(1)
  })

  it('el estado visible pasa de advertencia a ninguna solo con la referencia válida', async () => {
    const before = await alerts(remoteWith({}))
    const after = await alerts(remoteWith({ photoRemote: reference(), photoStoredLocally: false }))
    const show = (report: typeof before.result.report) => computeSyncDisplay({ online: true, paused: true, pending: 0, failedOperations: 0, photoProblems: 0, syncStatus: 'local', report, now: Date.parse(report.generatedAt) })
    expect(show(before.result.report)).toMatchObject({ foreignPhotos: 1 })
    expect(show(before.result.report).warning).toBeTruthy()
    expect(show(after.result.report)).toMatchObject({ foreignPhotos: 0, warning: undefined })
  })
})

describe('actualizar el diagnóstico manualmente no modifica datos ni marca fotos como recuperadas', () => {
  let writes: ReturnType<typeof vi.spyOn>[] = []
  beforeEach(async () => {
    const db = await getDatabase()
    const tx = db.transaction(['sessions', 'computers', 'syncQueue'], 'readwrite')
    await tx.objectStore('sessions').clear(); await tx.objectStore('computers').clear(); await tx.objectStore('syncQueue').clear()
    await tx.objectStore('sessions').put(session); await tx.objectStore('computers').put(stuck())
    await tx.done
    writes = (['put', 'add', 'delete', 'clear'] as const).map((method) => vi.spyOn(IDBObjectStore.prototype, method))
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('repetirlo con documentos cambiados y con la referencia válida no escribe en IndexedDB ni cambia el equipo local', async () => {
    const before = JSON.stringify(await readLocalRecoverySnapshot())
    writes.forEach((spy) => spy.mockClear())
    for (const remote of [remoteWith({ notes: 'cambió el documento', updatedAt: '2026-02-01T00:00:00Z' }), remoteWith({ photoRemote: reference(), photoStoredLocally: false }), remoteWith({})]) {
      await runRecoveryDiagnostic('alice', { local: readLocalRecoverySnapshot, remote: async () => remote })
    }
    await runRecoveryDiagnostic('alice', { local: readLocalRecoverySnapshot, remote: async () => { throw new Error('sin red') } })
    expect(writes.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(0)
    expect(JSON.stringify(await readLocalRecoverySnapshot())).toBe(before)
    const [mine] = (await readLocalRecoverySnapshot()).computers
    // Nada se marcó como recuperado: sigue sin bytes, sin referencia y con la marca de "solo en el dispositivo del propietario".
    expect(mine).toMatchObject({ photoStoredLocally: true })
    expect(mine.photo).toBeUndefined()
    expect(mine.photoRemote).toBeUndefined()
    expect(mine.photoUploadStatus).toBeUndefined()
  })
})
