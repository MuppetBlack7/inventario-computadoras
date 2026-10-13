import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackup, restoreBackup } from './backup'
import { clearAllData, getComputer, getDatabase, getPendingSyncQueue, listComputers, LocalSaveError, prepareComputerForRewrite, preparePhotoForStorage, saveComputer, saveSession, updateComputerSyncState } from './db'
import type { ComputerRecord } from './types'
import { normalizeKey } from './utils'

const bytesOf = async (blob: Blob | undefined) => Array.from(new Uint8Array(await blob!.arrayBuffer()))
const imageBlob = (header: number[], type: string, extra = 20) => new Blob([new Uint8Array([...header, ...Array.from({ length: extra }, (_, index) => index)])], { type })
const jpeg = () => imageBlob([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg')
const png = () => imageBlob([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png')
const webp = () => imageBlob([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 'image/webp')

const base: ComputerRecord = {
  id: 'pc-1', sessionId: 'session-1', inventoryId: 'INV-1', inventoryNormalized: normalizeKey('INV-1'),
  serialNumber: 'SN-1', serialNormalized: normalizeKey('SN-1'), brand: 'Marca', model: 'Modelo',
  manufacturingYear: null, yearUnknown: true, operatingSystem: 'Windows 11', ramGB: 8, drives: [],
  originalCode: '', scannedAt: '2026-10-12T10:00:00.000Z', timezone: 'America/Mazatlan', latitude: null, longitude: null,
  accuracyMeters: null, writtenLocation: 'Aula 1', notes: '', ownerId: 'alice',
  createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:00:00.000Z'
}

beforeEach(async () => { await clearAllData() })
afterEach(() => { vi.restoreAllMocks() })

describe('guardado local de equipos con fotografía', () => {
  it('guarda un equipo sin fotografía y lo encola', async () => {
    await saveComputer(base)
    const stored = await getComputer('pc-1')
    expect(stored?.photo).toBeUndefined()
    expect((await getPendingSyncQueue()).map((item) => item.id)).toEqual(['computer:pc-1'])
  })

  it('guarda un Blob JPEG conservando MIME y contenido', async () => {
    const photo = jpeg()
    await saveComputer({ ...base, photo, photoNeedsUpload: true, photoUploadStatus: 'pending' })
    const stored = await getComputer('pc-1')
    expect(stored?.photo?.type).toBe('image/jpeg')
    expect(await bytesOf(stored?.photo)).toEqual(await bytesOf(photo))
  })

  it.each([['PNG', png], ['WebP', webp]])('guarda fotografías %s conservando MIME y contenido', async (_name, make) => {
    const photo = make()
    await saveComputer({ ...base, photo })
    const stored = await getComputer('pc-1')
    expect(stored?.photo?.type).toBe(photo.type)
    expect(await bytesOf(stored?.photo)).toEqual(await bytesOf(photo))
  })

  it('convierte un File en un Blob propio con su MIME', async () => {
    const file = new File([jpeg()], 'camara.jpg', { type: 'image/jpeg' })
    const prepared = await preparePhotoForStorage(file)
    expect(prepared).not.toBeInstanceOf(File)
    expect(prepared.type).toBe('image/jpeg')
    expect(await bytesOf(prepared)).toEqual(await bytesOf(file))
  })

  it('deduce el MIME por contenido cuando el Blob no lo trae', async () => {
    const prepared = await preparePhotoForStorage(new Blob([await png().arrayBuffer()]))
    expect(prepared.type).toBe('image/png')
  })

  it('guarda una fotografía restaurada desde un respaldo y permite editarla', async () => {
    await saveSession({ id: 'session-1', name: 'Sesión', date: '2026-10-12', location: '', ownerId: 'alice', createdAt: base.createdAt, updatedAt: base.createdAt })
    await saveComputer({ ...base, photo: png() })
    const backup = await createBackup('alice')
    await clearAllData()
    await restoreBackup(backup, true, 'alice')
    const restored = (await listComputers())[0]
    expect(restored.photo?.type).toBe('image/png')
    await saveComputer({ ...restored, notes: 'editado tras restaurar' })
    const edited = await getComputer('pc-1')
    expect(edited?.notes).toBe('editado tras restaurar')
    expect(await bytesOf(edited?.photo)).toEqual(await bytesOf(png()))
  })

  it('al editar y reemplazar la fotografía conserva la nueva y deja la cola con revisión nueva', async () => {
    await saveComputer({ ...base, photo: jpeg(), photoNeedsUpload: true, photoLocalRevision: 'rev-1' })
    const firstRevision = (await getPendingSyncQueue())[0].revision
    const stored = (await getComputer('pc-1'))!
    await saveComputer({ ...stored, photo: webp(), photoLocalRevision: 'rev-2', photoNeedsUpload: true })
    const edited = await getComputer('pc-1')
    expect(edited?.photo?.type).toBe('image/webp')
    expect(await bytesOf(edited?.photo)).toEqual(await bytesOf(webp()))
    const queue = await getPendingSyncQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].revision).not.toBe(firstRevision)
    expect(queue[0].photoSourceRevision).toBe('rev-2')
  })

  it('al volver a guardar un Blob leído de IndexedDB conserva la fotografía', async () => {
    await saveComputer({ ...base, photo: jpeg() })
    const fromDatabase = (await getComputer('pc-1'))!
    await saveComputer({ ...fromDatabase, model: 'Otro' }, false)
    expect(await bytesOf((await getComputer('pc-1'))?.photo)).toEqual(await bytesOf(jpeg()))
  })

  it('materializa un Blob nuevo antes de reescribir estados de sincronización', async () => {
    await saveComputer({ ...base, photo: jpeg(), photoNeedsUpload: true })
    const fromDatabase = (await getComputer('pc-1'))!
    const prepared = await prepareComputerForRewrite(fromDatabase)
    expect(prepared.photo).not.toBe(fromDatabase.photo)
    expect(prepared.photo?.type).toBe('image/jpeg')
    expect(await bytesOf(prepared.photo)).toEqual(await bytesOf(fromDatabase.photo))
  })

  it('no altera referencias remotas válidas al actualizar un registro', async () => {
    const photoRemote = { fileId: 'remote-1', url: 'https://example.com/1.jpg', filePath: '/1.jpg', name: '1.jpg', size: 4, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: base.createdAt }
    await saveComputer({ ...base, photo: jpeg(), photoRemote, cloudId: 'cloud-1' })
    await updateComputerSyncState('pc-1', 'syncing')
    const stored = (await getComputer('pc-1'))!
    await saveComputer({ ...stored, notes: 'nota' })
    const edited = await getComputer('pc-1')
    expect(edited?.photoRemote).toEqual(photoRemote)
    expect(edited?.cloudId).toBe('cloud-1')
    expect(await bytesOf(edited?.photo)).toEqual(await bytesOf(jpeg()))
  })

  it('rechaza una fotografía ilegible o vacía antes de abrir la transacción y no cambia nada', async () => {
    await saveComputer({ ...base, notes: 'original', photo: jpeg() })
    const queueBefore = await getPendingSyncQueue()
    const unreadable = jpeg()
    unreadable.arrayBuffer = () => Promise.reject(new DOMException('The requested file could not be read', 'NotReadableError'))
    await expect(saveComputer({ ...base, notes: 'cambio', photo: unreadable })).rejects.toBeInstanceOf(LocalSaveError)
    await expect(saveComputer({ ...base, notes: 'cambio', photo: new Blob([], { type: 'image/jpeg' }) })).rejects.toThrow(/vacía/)
    const stored = await getComputer('pc-1')
    expect(stored?.notes).toBe('original')
    expect(await bytesOf(stored?.photo)).toEqual(await bytesOf(jpeg()))
    expect(await getPendingSyncQueue()).toEqual(queueBefore)
  })

  it('si IndexedDB falla al guardar no informa éxito y no deja registro ni cola a medias', async () => {
    const original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'computers') throw new DOMException('Error preparing Blob/File data to be stored in object store', 'UnknownError')
      return original.call(this, value, key)
    })
    await expect(saveComputer({ ...base, photo: jpeg() })).rejects.toThrow(/no pudo guardar el registro/)
    vi.restoreAllMocks()
    expect(await getComputer('pc-1')).toBeUndefined()
    expect(await getPendingSyncQueue()).toHaveLength(0)
  })

  it('si falla al encolar revierte también el registro (misma transacción)', async () => {
    const original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'syncQueue') throw new DOMException('fallo', 'UnknownError')
      return original.call(this, value, key)
    })
    await expect(saveComputer({ ...base, photo: jpeg() })).rejects.toBeInstanceOf(LocalSaveError)
    vi.restoreAllMocks()
    expect(await getComputer('pc-1')).toBeUndefined()
  })

  it('al reabrir IndexedDB el registro, la fotografía y la cola siguen disponibles', async () => {
    await saveComputer({ ...base, photo: jpeg(), photoNeedsUpload: true })
    ;(await getDatabase()).close()
    const stored = await getComputer('pc-1')
    expect(await bytesOf(stored?.photo)).toEqual(await bytesOf(jpeg()))
    expect((await getPendingSyncQueue()).map((item) => item.id)).toEqual(['computer:pc-1'])
  })
})
