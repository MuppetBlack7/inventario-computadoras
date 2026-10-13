import 'fake-indexeddb/auto'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn(), setDoc: vi.fn(), deleteDoc: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {}, firebaseAuth: null }))

import { checkPhotoPair, sha256Hex } from './photoCheck'
import { PhotoCheckResult } from './components/PhotoCheckPanel'
import { SyncInventoryView } from './components/SyncInventoryView'
import { buildRecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { initialFlow } from './syncFlow'
import { buildProposal, defaultDecisions } from './syncPlan'
import type { ComputerRecord, ImageKitPhotoReference, InventorySession } from './types'

const stamp = '2026-01-01T00:00:00Z'
const session: InventorySession = { id: 's1', name: 'Sesión', date: '2026-01-01', location: '', ownerId: 'alice', createdAt: stamp, updatedAt: stamp }
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: id, inventoryNormalized: id, serialNumber: '', serialNormalized: '',
  brand: 'Marca', model: 'Modelo', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '', scannedAt: '', timezone: '',
  latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice', ownerName: 'Alicia', createdAt: stamp, updatedAt: stamp, cloudId: id, ...changes
})
const bytes = (...values: number[]) => new Blob([new Uint8Array(values)], { type: 'image/jpeg' })
const reference = (owner = 'alice', changes: Partial<ImageKitPhotoReference> = {}): ImageKitPhotoReference => ({
  fileId: 'file-abcdef-1', url: 'https://ik.example/a.jpg', filePath: `/inventario/${owner}/a.jpg`, name: 'a.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: stamp, ...changes
})
const hash = (...values: number[]) => createHash('sha256').update(Uint8Array.from(values)).digest('hex')

describe('comprobación de identidad de fotografías (solo lectura)', () => {
  it('calcula el SHA-256 en memoria', async () => {
    expect(await sha256Hex(bytes(1, 2, 3))).toBe(hash(1, 2, 3))
  })

  it('bytes locales ausentes: lo indica expresamente y la identidad queda desconocida', async () => {
    const check = await checkPhotoPair({ local: computer('0150430', { photoName: 'image_692.jpg', photoStoredLocally: true }), remote: computer('0150430', { photoName: 'image.jpg' }) })
    expect(check.local.bytes).toBe('absent')
    expect(check.local.sha256).toBeUndefined()
    expect(check.warnings.join(' ')).toContain('NO existen')
    expect(check.sameBytes).toBe('unknown')
    expect(check.remote.reference).toBe('none')
    expect(check.remote.verification).toBe('unverified')
    const html = renderToStaticMarkup(<PhotoCheckResult check={check} />)
    expect(html).toContain('Los bytes locales no existen')
    expect(html).toContain('No verificada')
    expect(html).toContain('No se puede determinar si las imágenes corresponden al mismo equipo')
    expect(html).toContain('image_692.jpg')
    expect(html).toContain('Inventario 0150430')
  })

  it('fotografías diferentes: hashes distintos y advertencia de reemplazo', async () => {
    const loadRemote = vi.fn(async () => bytes(9, 9, 9, 9))
    const check = await checkPhotoPair({ local: computer('x', { photo: bytes(1, 2, 3), photoName: 'image_692.jpg' }), remote: computer('x', { photoRemote: reference(), photoName: 'image.jpg' }), loadRemote })
    expect(check.sameBytes).toBe(false)
    expect(check.local).toMatchObject({ bytes: 'present', size: 3, sha256: hash(1, 2, 3) })
    expect(check.remote).toMatchObject({ verification: 'verified', size: 4, sha256: hash(9, 9, 9, 9) })
    expect(loadRemote).toHaveBeenCalledWith('x', expect.objectContaining({ fileId: 'file-abcdef-1' }))
    expect(check.warnings.join(' ')).toContain('DISTINTAS')
  })

  it('mismos bytes: lo declara aunque el nombre sea distinto', async () => {
    const check = await checkPhotoPair({ local: computer('x', { photo: bytes(5, 6), photoName: 'image_692.jpg' }), remote: computer('x', { photoRemote: reference(), photoName: 'image.jpg' }), loadRemote: async () => bytes(5, 6) })
    expect(check.sameBytes).toBe(true)
  })

  it('propietarios diferentes: se señalan y no se asume nada', async () => {
    const check = await checkPhotoPair({ local: computer('x', { ownerId: 'alice', ownerName: 'Alicia' }), remote: computer('x', { ownerId: 'bob', ownerName: 'Su amigo' }) })
    expect(check.ownersDiffer).toBe(true)
    expect(check.localOwner).toContain('Alicia')
    expect(check.remoteOwner).toContain('Su amigo')
    expect(check.warnings.join(' ')).toContain('propietario local y el remoto son distintos')
  })

  it('referencias remotas inválidas: no se lee nada y queda «No verificada»', async () => {
    for (const changes of [{ fileId: '' }, { url: '' }, { filePath: '/inventario/otro/a.jpg' }, { filePath: '/inventario/alice/../x' }]) {
      const loadRemote = vi.fn(async () => bytes(1))
      const check = await checkPhotoPair({ local: computer('x', { photo: bytes(1) }), remote: computer('x', { photoRemote: reference('alice', changes) }), loadRemote })
      expect(check.remote).toMatchObject({ reference: 'invalid', verification: 'unverified' })
      expect(check.remote.blob).toBeUndefined()
      expect(loadRemote).not.toHaveBeenCalled()
    }
  })

  it('errores de lectura remota y local no se convierten en «verificada»', async () => {
    const failing = await checkPhotoPair({ local: computer('x', { photo: bytes(1) }), remote: computer('x', { photoRemote: reference() }), loadRemote: async () => { throw new Error('ImageKit no respondió') } })
    expect(failing.remote.verification).toBe('unverified')
    expect(failing.remote.error).toContain('ImageKit no respondió')
    expect(failing.sameBytes).toBe('unknown')
    const empty = await checkPhotoPair({ local: computer('x'), remote: computer('x', { photoRemote: reference() }), loadRemote: async () => new Blob([]) })
    expect(empty.remote.verification).toBe('unverified')
    const brokenBlob = Object.assign(bytes(1, 2), { arrayBuffer: () => Promise.reject(new Error('lectura fallida')) })
    const errored = await checkPhotoPair({ local: computer('x', { photo: brokenBlob }) })
    expect(errored.local).toMatchObject({ bytes: 'error', error: 'lectura fallida' })
    const noRemote = await checkPhotoPair({ local: computer('x', { photo: bytes(1) }), remote: null })
    expect(noRemote.remote).toMatchObject({ documentFound: false, verification: 'unverified' })
  })

  it('nunca muestra la imagen remota de otro equipo', async () => {
    const loadRemote = vi.fn(async () => bytes(7))
    const check = await checkPhotoPair({ local: computer('0150430', { photo: bytes(1) }), remote: computer('0447137', { photoRemote: reference() }), loadRemote })
    expect(check.sameEquipment).toBe(false)
    expect(loadRemote).not.toHaveBeenCalled()
    expect(check.remote.blob).toBeUndefined()
  })

  describe('solo lectura', () => {
    let writes: ReturnType<typeof vi.spyOn>[] = []
    beforeEach(() => { writes = (['put', 'add', 'delete', 'clear'] as const).map((method) => vi.spyOn(IDBObjectStore.prototype, method)) })
    afterEach(() => { vi.restoreAllMocks() })

    it('no escribe en IndexedDB ni usa la red por sí misma y deja intactos los registros', async () => {
      const local = computer('x', { photo: bytes(1, 2, 3), photoName: 'image_692.jpg', photoLocalRevision: 'rev-local', photoUploadStatus: 'pending', photoNeedsUpload: true })
      const remote = computer('x', { photoRemote: reference(), photoName: 'image.jpg', photoLocalRevision: 'rev-remote' })
      const before = JSON.stringify([{ ...local, photo: undefined }, remote])
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      await checkPhotoPair({ local, remote, loadRemote: async () => bytes(1, 2, 3) })
      expect(writes.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(0)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(JSON.stringify([{ ...local, photo: undefined }, remote])).toBe(before)
      expect(local.photoNeedsUpload).toBe(true)
      expect(local.photoUploadStatus).toBe('pending')
    })
  })
})

describe('los dos conflictos de photoName siguen sin resolver', () => {
  const ids = ['0150430', '0447137']
  const photoOnlyLocal: RecoverySnapshot = { sessions: [session], computers: ids.map((id, index) => computer(id, { photoName: 'image_692.jpg', photo: bytes(index + 1) })), queue: [] }
  const photoOnlyRemote: RemoteRecoverySnapshot = { sessions: [session], computers: ids.map((id) => computer(id, { photoName: 'image.jpg' })) }
  const report = buildRecoveryReport(photoOnlyLocal, photoOnlyRemote, 'alice', '2026-02-01T00:00:00Z')

  it('photoName sigue contando como diferencia (no se elimina automáticamente) y por defecto no escribe nada', () => {
    expect(report.rows.map((row) => row.differences).filter((fields) => fields.length)).toEqual([['photoName'], ['photoName']])
    const proposal = buildProposal(photoOnlyLocal, photoOnlyRemote, report, defaultDecisions(), { imageKitConfigured: true })
    expect(proposal.allowed).toBe(false)
    expect(proposal.kept.filter((item) => item.detail?.startsWith('diferencias sin resolver (photoName)'))).toHaveLength(2)
  })

  it('cada tarjeta ofrece la comprobación y no muestra imágenes hasta que la persona la pida', () => {
    const html = renderToStaticMarkup(<SyncInventoryView report={report} local={photoOnlyLocal} remote={photoOnlyRemote} online imageKitConfigured flow={{ ...initialFlow(), step: 'proposal' }}
      onFlow={() => undefined} onBack={() => undefined} onAuthorize={() => undefined} onRetry={() => undefined} />)
    expect(html.match(/Comprobar fotografías \(solo lectura\)/g)).toHaveLength(2)
    expect(html).toContain('No sube, descarga ni modifica nada')
    expect(html).toContain('Equipo 0150430')
    expect(html).toContain('Equipo 0447137')
    expect(html).not.toContain('<img')
  })
})
