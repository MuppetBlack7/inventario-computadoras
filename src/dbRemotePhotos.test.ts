import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyRemoteComputer, clearAllData, getComputer, getPendingSyncQueue, saveComputer } from './db'
import type { ComputerRecord, ImageKitPhotoReference } from './types'

const stamp = '2026-01-01T00:00:00Z'
const reference = (fileId: string): ImageKitPhotoReference => ({ fileId, url: `https://example.com/${fileId}.jpg`, filePath: `/inventario/bob/${fileId}.jpg`, name: `${fileId}.jpg`, size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: stamp })
const bytes = () => new Blob([new Uint8Array([7, 8, 9])], { type: 'image/jpeg' })
const record = (changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id: 'c1', cloudId: 'c1', sessionId: 's1', inventoryId: 'INV', inventoryNormalized: 'INV', serialNumber: 'SER', serialNormalized: 'SER',
  brand: '', model: '', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '', scannedAt: '', timezone: '',
  latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'bob', createdAt: stamp, updatedAt: stamp, ...changes
})
const remoteVersion = (changes: Partial<ComputerRecord> = {}) => record({ photoStoredLocally: undefined, ...changes })
const readBytes = async (blob: Blob | undefined) => blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : null

beforeEach(async () => { await clearAllData() })

describe('applyRemoteComputer conserva las fotografías locales', () => {
  it('sin referencia remota y sin subida pendiente: conserva los bytes y no la marca como recuperada', async () => {
    await saveComputer(record({ photo: bytes(), photoStoredLocally: true }), false)
    expect(await applyRemoteComputer(remoteVersion({ photoStoredLocally: true, notes: 'remoto' }))).toBe(true)
    const stored = (await getComputer('c1'))!
    expect(await readBytes(stored.photo)).toEqual([7, 8, 9])
    expect(stored.notes).toBe('remoto')
    expect(stored.photoRemote).toBeUndefined()
    expect(stored.photoUploadStatus).toBeUndefined()
    expect(stored.photoNeedsUpload).toBeFalsy()
  })

  it('con subida pendiente: conserva los bytes y la subida sigue pendiente', async () => {
    await saveComputer(record({ photo: bytes(), photoNeedsUpload: true, photoUploadStatus: 'pending', photoLocalRevision: 'rev-1' }), false)
    await applyRemoteComputer(remoteVersion())
    const stored = (await getComputer('c1'))!
    expect(await readBytes(stored.photo)).toEqual([7, 8, 9])
    expect(stored).toMatchObject({ photoNeedsUpload: true, photoUploadStatus: 'pending', photoLocalRevision: 'rev-1' })
    expect(stored.photoRemote).toBeUndefined()
  })

  it('con subida en curso o con error: conserva el estado y el mensaje', async () => {
    for (const [status, error] of [['uploading', undefined], ['error', 'sin red']] as const) {
      await clearAllData()
      await saveComputer(record({ photo: bytes(), photoNeedsUpload: true, photoUploadStatus: status, photoUploadError: error }), false)
      await applyRemoteComputer(remoteVersion())
      expect(await getComputer('c1')).toMatchObject({ photoUploadStatus: status, photoUploadError: error, photoNeedsUpload: true })
    }
  })

  it('el documento remoto perdió la referencia que sí tenía el registro local: se conservan bytes y referencia local', async () => {
    await saveComputer(record({ photo: bytes(), photoRemote: reference('f1'), photoUploadStatus: 'uploaded' }), false)
    await applyRemoteComputer(remoteVersion())
    const stored = (await getComputer('c1'))!
    expect(await readBytes(stored.photo)).toEqual([7, 8, 9])
    expect(stored.photoRemote?.fileId).toBe('f1')
  })

  it('con la misma referencia remota: conserva los bytes y queda subida', async () => {
    await saveComputer(record({ photo: bytes(), photoRemote: reference('f1') }), false)
    await applyRemoteComputer(remoteVersion({ photoRemote: reference('f1') }))
    const stored = (await getComputer('c1'))!
    expect(await readBytes(stored.photo)).toEqual([7, 8, 9])
    expect(stored).toMatchObject({ photoUploadStatus: 'uploaded', photoRemote: expect.objectContaining({ fileId: 'f1' }) })
  })

  it('con otra referencia remota y sin subida pendiente: se adopta la remota (la nube ya tiene su fotografía)', async () => {
    await saveComputer(record({ photo: bytes(), photoRemote: reference('old') }), false)
    await applyRemoteComputer(remoteVersion({ photoRemote: reference('new') }))
    const stored = (await getComputer('c1'))!
    expect(stored.photo).toBeUndefined()
    expect(stored.photoRemote?.fileId).toBe('new')
    expect(stored.photoUploadStatus).toBe('uploaded')
  })

  it('con otra referencia remota pero una subida local pendiente: conserva los bytes pendientes', async () => {
    await saveComputer(record({ photo: bytes(), photoNeedsUpload: true, photoUploadStatus: 'pending', photoRemote: reference('old') }), false)
    await applyRemoteComputer(remoteVersion({ photoRemote: reference('new') }))
    const stored = (await getComputer('c1'))!
    expect(await readBytes(stored.photo)).toEqual([7, 8, 9])
    expect(stored.photoNeedsUpload).toBe(true)
    expect(stored.photoRemote?.fileId).toBe('new')
  })

  it('registro de otra cuenta sin bytes ni referencia (foto solo en su dispositivo): no se marca como recuperado ni se inventa una referencia', async () => {
    await saveComputer(record({ photoStoredLocally: true }), false)
    await applyRemoteComputer(remoteVersion({ photoStoredLocally: true }))
    const stored = (await getComputer('c1'))!
    expect(stored.photo).toBeUndefined()
    expect(stored.photoRemote).toBeUndefined()
    expect(stored.photoStoredLocally).toBe(true)
    expect(stored.photoUploadStatus).toBeUndefined()
  })

  it('registro nuevo con referencia remota: queda subida; sin referencia: sin foto', async () => {
    await applyRemoteComputer(remoteVersion({ photoRemote: reference('f1') }))
    expect((await getComputer('c1'))?.photoUploadStatus).toBe('uploaded')
    await clearAllData()
    await applyRemoteComputer(remoteVersion())
    expect((await getComputer('c1'))?.photoRemote).toBeUndefined()
  })

  it('con una operación local pendiente no se aplica nada y los bytes siguen intactos', async () => {
    await saveComputer(record({ ownerId: 'alice', photo: bytes(), photoNeedsUpload: true }))
    const queueBefore = await getPendingSyncQueue()
    expect(await applyRemoteComputer(remoteVersion({ ownerId: 'alice', notes: 'remoto' }))).toBe(false)
    const stored = (await getComputer('c1'))!
    expect(stored.notes).toBe('')
    expect(await readBytes(stored.photo)).toEqual([7, 8, 9])
    expect(await getPendingSyncQueue()).toEqual(queueBefore)
  })
})
