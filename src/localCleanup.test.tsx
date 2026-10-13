import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const firestore = vi.hoisted(() => ({ setDoc: vi.fn(), deleteDoc: vi.fn(), updateDoc: vi.fn(), writeBatch: vi.fn(), addDoc: vi.fn() }))
vi.mock('firebase/firestore', () => ({ ...firestore, collection: vi.fn(), getDocsFromServer: vi.fn(), doc: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {}, firebaseAuth: null }))

import { LocalCleanupCard } from './components/LocalCleanupCard'
import { SyncInventoryView } from './components/SyncInventoryView'
import { getDatabase, removeLocalComputerCopy } from './db'
import { planLocalCleanup, runLocalCleanup, type CleanupDeps, type CleanupItem, type CleanupPlan, type CleanupResult } from './localCleanup'
import { buildRecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { initialFlow } from './syncFlow'
import type { ComputerRecord, ImageKitPhotoReference, InventorySession, SyncQueueItem } from './types'

const stamp = '2026-01-01T00:00:00Z'
const session: InventorySession = { id: 's1', name: 'Sesión', date: '2026-01-01', location: '', ownerId: 'alice', createdAt: stamp, updatedAt: stamp }
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: 'Marca', model: 'Modelo', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '', scannedAt: '', timezone: '',
  latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice', ownerName: 'Alicia', createdAt: stamp, updatedAt: stamp, cloudId: id, syncStatus: 'synced', ...changes
})
const bytes = (...values: number[]) => new Blob([new Uint8Array(values)], { type: 'image/jpeg' })
const reference = (owner = 'alice', changes: Partial<ImageKitPhotoReference> = {}): ImageKitPhotoReference => ({
  fileId: 'file-1', url: 'https://ik.example/a.jpg', filePath: `/inventario/${owner}/a.jpg`, name: 'a.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: stamp, ...changes
})
const queued = (entityId: string, changes: Partial<SyncQueueItem> = {}): SyncQueueItem => ({ id: `computer:${entityId}`, operation: 'upsert-computer', entityId, ownerId: 'alice', createdAt: stamp, revision: 'r1', ...changes })
const snap = (computers: ComputerRecord[], queue: SyncQueueItem[] = []): RecoverySnapshot => ({ sessions: [session], computers, queue })
const remoteOf = (computers: ComputerRecord[]): RemoteRecoverySnapshot => ({ sessions: [session], computers })
const plan = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, extra: { authUid?: string | null; loadRemote?: CleanupDeps['loadRemote'] } = {}) =>
  planLocalCleanup({ local, remote, accountId: 'alice', authUid: 'authUid' in extra ? extra.authUid : 'alice', loadRemote: extra.loadRemote })
const categoryOf = (result: CleanupPlan, id: string) => result.items.find((item) => item.id === id)?.category

describe('planificación: qué copias locales pueden limpiarse', () => {
  it('registro coincidente por ID, propietario y contenido: es candidato, con motivo y recuento', async () => {
    const result = await plan(snap([computer('a')]), remoteOf([computer('a')]))
    expect(result.candidates.map((item) => item.id)).toEqual(['a'])
    expect(result.counts['verified-copy']).toBe(1)
    expect(result.items[0].reason).toContain('verificada')
    expect(result.excluded).toEqual([])
  })

  it('coincidir solo por inventario o serie no basta: otro ID es posible duplicado y se conserva', async () => {
    const result = await plan(snap([computer('a')]), remoteOf([computer('other', { inventoryId: 'INV-a', inventoryNormalized: 'INVa', serialNormalized: 'SERa' })]))
    expect(categoryOf(result, 'a')).toBe('possible-duplicate')
    expect(result.candidates).toEqual([])
    // Y un duplicado local con la misma clave también bloquea a ambos.
    const twin = await plan(snap([computer('a'), computer('b', { inventoryNormalized: 'INVa', serialNormalized: 'SERa' })]), remoteOf([computer('a'), computer('b')]))
    expect(twin.candidates).toEqual([])
    expect(twin.counts['possible-duplicate']).toBe(2)
  })

  it('dos copias locales con el mismo ID remoto se conservan aunque ambas parezcan sincronizadas', async () => {
    const result = await plan(snap([computer('a'), computer('alias', { cloudId: 'a', inventoryId: 'INV-a', inventoryNormalized: 'INVa', serialNumber: 'SER-a', serialNormalized: 'SERa' })]), remoteOf([computer('a')]))
    expect(result.candidates).toEqual([])
    expect(categoryOf(result, 'a')).toBe('possible-duplicate')
    expect(categoryOf(result, 'alias')).toBe('possible-duplicate')
  })

  it('un campo persistente nuevo o metadatos de propietario distintos impiden afirmar igualdad de contenido', async () => {
    const extra = computer('a') as ComputerRecord & { futureField?: string }
    extra.futureField = 'solo-local'
    expect(categoryOf(await plan(snap([extra]), remoteOf([computer('a')])), 'a')).toBe('different-content')
    expect(categoryOf(await plan(snap([computer('a', { ownerName: 'Alicia' })]), remoteOf([computer('a', { ownerName: 'Otro nombre' })])), 'a')).toBe('different-content')
  })

  it('cambios locales, contenido distinto y fecha de modificación distinta se conservan', async () => {
    const result = await plan(
      snap([computer('edited', { updatedAt: '2026-02-01T00:00:00Z' }), computer('status', { syncStatus: 'local' }), computer('content', { notes: 'local' }), computer('error', { syncStatus: 'error' })]),
      remoteOf([computer('edited'), computer('status'), computer('content', { notes: 'remoto' }), computer('error')]))
    expect(categoryOf(result, 'edited')).toBe('local-changes')
    expect(categoryOf(result, 'status')).toBe('local-changes')
    expect(categoryOf(result, 'content')).toBe('different-content')
    expect(categoryOf(result, 'error')).toBe('local-changes')
    expect(result.candidates).toEqual([])
  })

  it('operaciones en la cola (propias, de limpieza de foto o por remoteId) se conservan', async () => {
    const local = snap([computer('a'), computer('b', { photoRemote: reference() }), computer('c', { cloudId: 'cloud-c' })], [
      queued('a'), { ...queued('x'), id: 'photo:file-1', operation: 'cleanup-photo', photoFileId: 'file-1' }, queued('zzz', { remoteId: 'cloud-c' })
    ])
    const result = await plan(local, remoteOf([computer('a'), computer('b', { photoRemote: reference() }), computer('cloud-c')]))
    expect(['a', 'b', 'c'].map((id) => categoryOf(result, id))).toEqual(['queued-operations', 'queued-operations', 'queued-operations'])
  })

  it('otras cuentas, propietario desconocido y propietarios distintos no se tocan', async () => {
    const result = await plan(
      snap([computer('theirs', { ownerId: 'bob' }), computer('nobody', { ownerId: '' as string }), computer('mismatch'), computer('remoteNobody')]),
      remoteOf([computer('theirs', { ownerId: 'bob' }), computer('nobody'), computer('mismatch', { ownerId: 'bob' }), computer('remoteNobody', { ownerId: '' as string })]))
    expect(['theirs', 'nobody', 'mismatch', 'remoteNobody'].map((id) => categoryOf(result, id))).toEqual(['other-account', 'owner-unknown', 'owner-mismatch', 'owner-unknown'])
  })

  it('un registro que no existe en Firebase con el mismo ID se conserva', async () => {
    const result = await plan(snap([computer('only-local')]), remoteOf([]))
    expect(categoryOf(result, 'only-local')).toBe('not-in-firebase')
  })

  it('sin lectura de Firebase o con otro usuario autenticado no hay candidatos', async () => {
    const down = await plan(snap([computer('a')]), null)
    expect(down.candidates).toEqual([])
    expect(down.blockedBy[0]).toContain('No se pudo leer Firebase')
    for (const authUid of ['bob', null, undefined]) {
      const other = await plan(snap([computer('a')]), remoteOf([computer('a')]), { authUid })
      expect(other.candidates).toEqual([])
      expect(other.blockedBy[0]).toContain('cuenta autenticada')
    }
  })

  describe('fotografía, verificada por separado', () => {
    const withPhoto = (changes: Partial<ComputerRecord> = {}) => computer('p', { photo: bytes(1, 2, 3), photoRemote: reference(), ...changes })
    const remotePhoto = (changes: Partial<ComputerRecord> = {}) => computer('p', { photoRemote: reference(), ...changes })

    it('bytes locales idénticos a la imagen remota verificada: candidato', async () => {
      const loadRemote = vi.fn(async () => bytes(1, 2, 3))
      const result = await plan(snap([withPhoto()]), remoteOf([remotePhoto()]), { loadRemote })
      expect(result.candidates.map((item) => item.id)).toEqual(['p'])
      expect(loadRemote).toHaveBeenCalledTimes(1)
    })

    it('fotografía sin referencia remota: los bytes locales son la única copia y se conserva', async () => {
      const result = await plan(snap([computer('p', { photo: bytes(1) })]), remoteOf([computer('p')]), { loadRemote: async () => bytes(1) })
      expect(categoryOf(result, 'p')).toBe('photo-only-local')
    })

    it('marcada como guardada solo localmente sin bytes aquí: se conserva', async () => {
      const result = await plan(snap([computer('p', { photoStoredLocally: true })]), remoteOf([computer('p', { photoStoredLocally: true })]))
      expect(categoryOf(result, 'p')).toBe('photo-only-local')
    })

    it('subida pendiente, en curso o con error: se conserva', async () => {
      for (const changes of [{ photoNeedsUpload: true }, { photoUploadStatus: 'uploading' as const }, { photoUploadStatus: 'pending' as const }, { photoUploadStatus: 'error' as const }]) {
        const result = await plan(snap([withPhoto(changes)]), remoteOf([remotePhoto()]), { loadRemote: async () => bytes(1, 2, 3) })
        expect(categoryOf(result, 'p')).toBe('photo-upload-pending')
      }
    })

    it('referencia remota incompleta, ajena o distinta: se conserva', async () => {
      for (const bad of [reference('alice', { fileId: '' }), reference('alice', { url: '' }), reference('bob'), reference('alice', { filePath: '/inventario/alice/../x' }), reference('alice', { name: '' }), reference('alice', { size: 0 })]) {
        const result = await plan(snap([withPhoto()]), remoteOf([remotePhoto({ photoRemote: bad })]), { loadRemote: async () => bytes(1, 2, 3) })
        expect(['photo-reference-incomplete', 'different-content']).toContain(categoryOf(result, 'p'))
        expect(result.candidates).toEqual([])
      }
      const otherFile = await plan(snap([withPhoto()]), remoteOf([remotePhoto({ photoRemote: reference('alice', { fileId: 'file-2' }) })]), { loadRemote: async () => bytes(1, 2, 3) })
      expect(otherFile.candidates).toEqual([])
    })

    it('estado no verificable (sin lector o con error) o imagen distinta: se conserva', async () => {
      expect(categoryOf(await plan(snap([withPhoto()]), remoteOf([remotePhoto()])), 'p')).toBe('photo-unverified')
      expect(categoryOf(await plan(snap([withPhoto()]), remoteOf([remotePhoto()]), { loadRemote: async () => { throw new Error('ImageKit no respondió') } }), 'p')).toBe('photo-unverified')
      expect(categoryOf(await plan(snap([withPhoto()]), remoteOf([remotePhoto()]), { loadRemote: async () => new Blob([]) }), 'p')).toBe('photo-unverified')
      expect(categoryOf(await plan(snap([withPhoto()]), remoteOf([remotePhoto()]), { loadRemote: async () => bytes(9, 9, 9) }), 'p')).toBe('photo-mismatch')
    })

    it('sin bytes locales pero con la misma referencia y descarga remota verificada: candidato; si falta o falla, se conserva', async () => {
      const same = await plan(snap([computer('p', { photoRemote: reference() })]), remoteOf([remotePhoto()]), { loadRemote: async () => bytes(1, 2, 3) })
      expect(same.candidates.map((item) => item.id)).toEqual(['p'])
      expect(categoryOf(await plan(snap([computer('p', { photoRemote: reference() })]), remoteOf([remotePhoto()])), 'p')).toBe('photo-unverified')
      const missingRemote = await plan(snap([computer('p', { photoRemote: reference() })]), remoteOf([computer('p')]))
      expect(missingRemote.candidates).toEqual([])
    })
  })
})

describe('ejecución: segunda confirmación, nueva verificación y errores parciales', () => {
  const local = () => snap([computer('a'), computer('b'), computer('keep', { syncStatus: 'local' }), computer('theirs', { ownerId: 'bob' })])
  const remote = () => remoteOf([computer('a'), computer('b'), computer('keep'), computer('theirs', { ownerId: 'bob' })])
  let user: string | null | undefined
  let removeCopy: ReturnType<typeof vi.fn<CleanupDeps['removeCopy']>>
  let logged: CleanupResult[]
  const deps = (changes: Partial<CleanupDeps> = {}): CleanupDeps => ({ currentUserId: () => user, readLocal: async () => local(), readRemote: async () => remote(), removeCopy, log: (result) => { logged.push(result) }, ...changes })
  const initial = () => plan(local(), remote())
  beforeEach(() => { user = 'alice'; removeCopy = vi.fn<CleanupDeps['removeCopy']>(async () => 'removed'); logged = []; vi.clearAllMocks() })

  it('solo elimina los candidatos verificados y registra el resultado; nada se escribe en Firestore', async () => {
    const result = await runLocalCleanup(await initial(), true, deps())
    expect(result.status).toBe('completed')
    expect(result.removed).toEqual(['a', 'b'])
    expect(removeCopy.mock.calls.map(([item]) => item.id)).toEqual(['a', 'b'])
    expect(logged).toHaveLength(1)
    for (const spy of Object.values(firestore)) expect(spy).not.toHaveBeenCalled()
  })

  it('sin la segunda confirmación explícita no se elimina nada', async () => {
    const result = await runLocalCleanup(await initial(), false, deps())
    expect(result.status).toBe('cancelled')
    expect(result.cancelReason).toContain('segunda confirmación')
    expect(removeCopy).not.toHaveBeenCalled()
  })

  it('si Firebase falla al volver a verificar, se cancela sin borrar', async () => {
    const result = await runLocalCleanup(await initial(), true, deps({ readRemote: async () => { throw new Error('sin red') } }))
    expect(result.status).toBe('cancelled')
    expect(result.cancelReason).toContain('sin red')
    expect(removeCopy).not.toHaveBeenCalled()
  })

  it('si la información remota cambió desde la vista previa, se cancela sin borrar', async () => {
    const changed = remoteOf([computer('a', { updatedAt: '2026-03-01T00:00:00Z' }), computer('b'), computer('keep'), computer('theirs', { ownerId: 'bob' })])
    const result = await runLocalCleanup(await initial(), true, deps({ readRemote: async () => changed }))
    expect(result.status).toBe('cancelled')
    expect(result.cancelReason).toContain('cambió')
    expect(removeCopy).not.toHaveBeenCalled()
  })

  it('si Firebase cambia o falla entre dos eliminaciones, detiene el resto e informa resultado parcial', async () => {
    let reads = 0
    const result = await runLocalCleanup(await initial(), true, deps({ readRemote: async () => {
      reads += 1
      if (reads === 3) throw new Error('Firebase dejó de responder')
      return remote()
    } }))
    expect(result.removed).toEqual(['a'])
    expect(result.notAttempted).toEqual(['b'])
    expect(result.status).toBe('partial')
    expect(result.cancelReason).toContain('Firebase dejó de responder')
  })

  it('si cambió el usuario autenticado antes o durante la limpieza, no se borra más', async () => {
    const beforeStart = await initial()
    user = 'bob'
    expect((await runLocalCleanup(beforeStart, true, deps())).status).toBe('cancelled')
    expect(removeCopy).not.toHaveBeenCalled()
    user = 'alice'
    removeCopy.mockImplementation(async () => { user = 'bob'; return 'removed' })
    const during = await runLocalCleanup(await initial(), true, deps())
    expect(during.removed).toEqual(['a'])
    expect(during.notAttempted).toEqual(['b'])
    expect(during.status).toBe('partial')
    expect(during.cancelReason).toContain('usuario')
  })

  it('un error durante la limpieza nunca se informa como éxito total y el reintento es idempotente', async () => {
    removeCopy.mockImplementationOnce(async () => { throw new Error('IndexedDB falló') })
    const first = await runLocalCleanup(await initial(), true, deps())
    expect(first.status).toBe('partial')
    expect(first.failed).toEqual([{ id: 'a', error: 'IndexedDB falló' }])
    expect(first.removed).toEqual(['b'])
    const everything = removeCopy.mockImplementation(async (item: CleanupItem) => (item.id === 'b' ? 'absent' : 'removed'))
    const retry = await runLocalCleanup(await initial(), true, deps())
    expect(everything).toBeDefined()
    expect(retry.status).toBe('completed')
    expect(retry.removed).toEqual(['a'])
    expect(retry.alreadyAbsent).toEqual(['b'])
    removeCopy.mockImplementation(async () => { throw new Error('todo falla') })
    expect((await runLocalCleanup(await initial(), true, deps())).status).toBe('failed')
  })

  it('una copia que cambió o apareció en la cola en el último instante se conserva y el resultado no es total', async () => {
    removeCopy.mockImplementation(async (item: CleanupItem) => (item.id === 'a' ? 'queued' : 'changed'))
    const result = await runLocalCleanup(await initial(), true, deps())
    expect(result.removed).toEqual([])
    expect(result.kept.map((item) => item.id)).toEqual(['a', 'b'])
    expect(result.status).not.toBe('completed')
  })
})

describe('eliminación local en IndexedDB', () => {
  const seed = async (computers: ComputerRecord[], queue: SyncQueueItem[] = []) => {
    const db = await getDatabase()
    const tx = db.transaction(['sessions', 'computers', 'syncQueue'], 'readwrite')
    await tx.objectStore('sessions').clear(); await tx.objectStore('computers').clear(); await tx.objectStore('syncQueue').clear()
    await tx.objectStore('sessions').put(session)
    for (const item of computers) await tx.objectStore('computers').put(item)
    for (const item of queue) await tx.objectStore('syncQueue').put(item)
    await tx.done
  }
  const expectation = (record: ComputerRecord) => ({ updatedAt: record.updatedAt, ownerId: record.ownerId, photoLocalRevision: record.photoLocalRevision, photoSize: record.photo?.size ?? null, photoRemoteFileId: record.photoRemote?.fileId })

  it('elimina solo el equipo indicado; conserva sesiones, cola, otros equipos y los de otras cuentas', async () => {
    const [target, sibling, foreign] = [computer('a'), computer('b'), computer('c', { ownerId: 'bob', photo: bytes(1), photoStoredLocally: true })]
    await seed([target, sibling, foreign], [queued('b')])
    expect(await removeLocalComputerCopy('a', expectation(target))).toBe('removed')
    const db = await getDatabase()
    expect((await db.getAll('computers')).map((item) => item.id).sort()).toEqual(['b', 'c'])
    expect(await db.getAll('sessions')).toHaveLength(1)
    expect((await db.getAll('syncQueue')).map((item) => item.id)).toEqual(['computer:b'])
    expect((await db.get('computers', 'c'))?.photo?.size).toBe(1)
    for (const spy of Object.values(firestore)) expect(spy).not.toHaveBeenCalled()
  })

  it('es idempotente y no elimina si el registro cambió o hay una operación en cola', async () => {
    const target = computer('a')
    await seed([target])
    expect(await removeLocalComputerCopy('a', { ...expectation(target), updatedAt: '2030-01-01T00:00:00Z' })).toBe('changed')
    expect(await removeLocalComputerCopy('a', { ...expectation(target), photoSize: 5 })).toBe('changed')
    await seed([computer('a', { syncStatus: 'local' })])
    expect(await removeLocalComputerCopy('a', expectation(target))).toBe('changed')
    await seed([target], [queued('a')])
    expect(await removeLocalComputerCopy('a', expectation(target))).toBe('queued')
    expect((await (await getDatabase()).getAll('computers')).map((item) => item.id)).toEqual(['a'])
    await seed([target])
    expect(await removeLocalComputerCopy('a', expectation(target))).toBe('removed')
    expect(await removeLocalComputerCopy('a', expectation(target))).toBe('absent')
  })

  it('la transacción conserva un registro editado con la misma fecha y una fotografía cuya subida empezó', async () => {
    const target = computer('a')
    const preview = await plan(snap([target]), remoteOf([target]))
    const expected = preview.candidates[0].expect!
    await seed([computer('a', { notes: 'edición concurrente' })])
    expect(await removeLocalComputerCopy('a', expected)).toBe('changed')
    await seed([computer('a', { photoUploadStatus: 'uploading' })])
    expect(await removeLocalComputerCopy('a', expected)).toBe('changed')
    await seed([target])
    expect(await removeLocalComputerCopy('a', expected, () => 'bob')).toBe('changed')
    expect(await (await getDatabase()).get('computers', 'a')).toBeDefined()
  })

  it('una fotografía sustituida por otros bytes del mismo tamaño se conserva', async () => {
    const original = computer('a', { photo: bytes(1, 2, 3), photoRemote: reference() })
    const remote = computer('a', { photoRemote: reference() })
    const preview = await plan(snap([original]), remoteOf([remote]), { loadRemote: async () => bytes(1, 2, 3) })
    await seed([computer('a', { photo: bytes(9, 8, 7), photoRemote: reference() })])
    expect(await removeLocalComputerCopy('a', preview.candidates[0].expect!)).toBe('changed')
    expect(await (await getDatabase()).get('computers', 'a')).toBeDefined()
  })

  it('no se enfila ninguna operación: eliminar una copia no genera delete-computer', async () => {
    const target = computer('a')
    await seed([target])
    await removeLocalComputerCopy('a', expectation(target))
    expect(await (await getDatabase()).getAll('syncQueue')).toEqual([])
  })
})

describe('interfaz de la limpieza', () => {
  const noop = async () => { throw new Error('no se usa') }
  it('es una acción separada con advertencias claras y botón deshabilitado sin conexión', () => {
    const online = renderToStaticMarkup(<LocalCleanupCard online onPreview={noop} onRun={noop} />)
    expect(online).toContain('Limpiar copias locales verificadas en Firebase')
    expect(online).toContain('no sincroniza ni sube nada')
    expect(online).toContain('no borra nada de Firebase ni de ImageKit')
    expect(online).toContain('Revisar qué copias se pueden limpiar')
    expect(online).not.toMatch(/<button[^>]*disabled=""[^>]*>Revisar qué copias/)
    const offline = renderToStaticMarkup(<LocalCleanupCard online={false} onPreview={noop} onRun={noop} />)
    expect(offline).toMatch(/<button[^>]*disabled=""[^>]*>Revisar qué copias/)
    expect(offline).toContain('no se limpia nada')
  })

  it('aparece en «Sincronizar inventario» solo si la aplicación la conecta y separada de la sincronización', () => {
    const data = snap([computer('a')])
    const report = buildRecoveryReport(data, remoteOf([computer('a')]), 'alice', '2026-02-01T00:00:00Z')
    const render = (extra: object) => renderToStaticMarkup(<SyncInventoryView report={report} local={data} remote={remoteOf([computer('a')])} online imageKitConfigured flow={initialFlow()} onFlow={() => undefined} onBack={() => undefined} onAuthorize={() => undefined} onRetry={() => undefined} {...extra} />)
    expect(render({})).not.toContain('Limpiar copias locales verificadas')
    expect(render({ onCleanupPreview: noop, onCleanupRun: noop })).toContain('Limpiar copias locales verificadas en Firebase')
  })

  it('la segunda confirmación exige marcar la casilla y la limpieza solo se invoca desde ella', () => {
    const source = readFileSync('src/components/LocalCleanupCard.tsx', 'utf8')
    expect(source).toContain('disabled={!understood}')
    expect(source).toContain("setStage('confirm')")
    expect(source.match(/onRun\(/g)).toHaveLength(1)
    const app = readFileSync('src/App.tsx', 'utf8').replace(/\r\n/g, '\n')
    const body = app.slice(app.indexOf('const cleanupDeps'), app.indexOf('const openSyncReview'))
    for (const forbidden of ['setDoc', 'deleteDoc', 'runSync', 'synchronize(', 'pullCloudData', 'clearAllData', 'deleteComputer(', 'saveComputer']) expect(body).not.toContain(forbidden)
  })
})
