import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {}, firebaseAuth: null }))

import { buildRecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { previewControl, previewScope } from './recoveryPermissions'
import { syncAndVerifyRestore, type RestoreResult } from './restore'
import { getDatabase, listComputers, saveComputer } from './db'
import { syncToast } from './syncMessages'
import type { ComputerRecord, InventorySession, SyncQueueItem } from './types'

const stamp = '2026-01-01T00:00:00Z'
const session = (ownerId = 'alice', id = 's1'): InventorySession => ({ id, name: 'Sesión', date: '2026-01-01', location: '', ownerId, createdAt: stamp, updatedAt: stamp })
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: '', model: '', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '', scannedAt: '', timezone: '',
  latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice', createdAt: stamp, updatedAt: stamp, ...changes
})
const op = (entityId: string, changes: Partial<SyncQueueItem> = {}): SyncQueueItem => ({ id: `computer:${entityId}`, operation: 'upsert-computer', entityId, ownerId: 'alice', createdAt: stamp, revision: 'r1', ...changes })
const snap = (computers: ComputerRecord[], queue: SyncQueueItem[] = []): RecoverySnapshot => ({ sessions: [session(), session('bob', 's2')], computers, queue })
const remoteOf = (computers: ComputerRecord[]): RemoteRecoverySnapshot => ({ sessions: [session(), session('bob', 's2')], computers })
const photo = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
const context = { imageKitConfigured: true }
const report = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null) => buildRecoveryReport(local, remote, 'alice', '2026-02-01T00:00:00Z')

describe('mensajes en modo local: nada promete una sincronización automática', () => {
  const labels = { synced: 'Sincronizado', local: 'Guardado local', failed: 'Error' }

  it('con la sincronización detenida el aviso dice que el cambio queda en la cola y no se enviará hasta autorizarla', () => {
    const message = syncToast({ held: true, errors: 0, pending: 3 }, labels)
    expect(message).toContain('detenida')
    expect(message).toContain('cola local')
    expect(message).toContain('hasta que la autorices')
    expect(message).not.toMatch(/se sincronizará|recuperar la conexión|automátic/)
    expect(syncToast(undefined, labels)).toContain('recuperar la conexión') // sin conexión real sí es cierto
  })

  it('una restauración con la sincronización detenida informa que la cola no se enviará, aunque haya Internet', async () => {
    const database = await getDatabase()
    await database.clear('syncQueue')
    await saveComputer(computer('c1'))
    const result = { created: { sessions: 0, computers: 1 }, updated: { sessions: 0, computers: 0 }, skipped: 0, skippedBy: {}, deleted: 0, photosRestored: 0, errors: [], queuedIds: ['computer:c1'], sessionIds: [], computerIds: ['c1'], deletedRemoteIds: [] } as RestoreResult
    const before = JSON.stringify(await database.getAll('syncQueue'))
    const outcome = await syncAndVerifyRestore(result, 'alice', async () => ({ held: true, errors: 0 }))
    expect(outcome.state).toBe('local-only')
    expect(outcome.message).toContain('sincronización está detenida')
    expect(outcome.message).toContain('no se enviará')
    expect(outcome.message).not.toMatch(/reintentará|recuperar la conexión/)
    expect(outcome.pending).toBe(1)
    expect(JSON.stringify(await database.getAll('syncQueue'))).toBe(before)
    expect((await listComputers()).length).toBe(1)
  })

  it('en la aplicación, los avisos y la confirmación de restaurar distinguen el modo detenido', () => {
    const app = readFileSync('src/App.tsx', 'utf8')
    const backup = readFileSync('src/components/BackupView.tsx', 'utf8')
    expect(app).toContain('held: true')
    expect(app).toContain("syncHeld={recovery.phase === 'local-only'}")
    expect(backup).toContain('no se enviarán mientras la sincronización esté detenida')
    expect(backup).toContain('Sincronización detenida: nada se envió.')
  })
})

describe('«mantener detenida» no permite subidas automáticas', () => {
  const app = readFileSync('src/App.tsx', 'utf8')

  it('toda llamada de sincronización o descarga de App.tsx está protegida: bloqueo, autorización o acción confirmada', () => {
    const lines = app.split('\n')
    const callSites = lines.map((line, index) => ({ line, index })).filter(({ line }) => /\b(synchronizeAndPull|synchronize|pullCloudData|subscribeToSharedInventory)\(/.test(line) && !line.includes('import '))
    const position = (needle: string) => app.indexOf(needle)
    const lineStart = (index: number) => lines.slice(0, index).join('\n').length
    const inside = (index: number, from: string, to: string) => lineStart(index) > position(from) && lineStart(index) < position(to)
    for (const { line, index } of callSites) {
      const guardedByRunSync = inside(index, 'const runSync = useCallback(', 'const syncAfterRestore')
      const insideRunControl = inside(index, 'const runControl = useCallback(', '}, [controlBusy')
      const insideExecuteProposal = inside(index, 'const executeProposal = useCallback(', 'const dispatchFlow')
      const insideAuthorizedEffect = inside(index, 'if (!ownerId || !syncAllowed(recovery)) return', 'recovery.phase])')
      expect(guardedByRunSync || insideRunControl || insideExecuteProposal || insideAuthorizedEffect, `llamada sin protección: ${line.trim()}`).toBe(true)
    }
    expect(callSites.length).toBeGreaterThanOrEqual(5)
    // runSync devuelve antes de cualquier sincronización cuando el bloqueo está activo.
    const runSync = app.slice(app.indexOf('const runSync = useCallback('))
    expect(runSync.indexOf('recoveryHoldRef.current')).toBeLessThan(runSync.indexOf('synchronizeAndPull('))
    // El modo local mantiene el bloqueo: solo autorizar lo libera.
    expect([...app.matchAll(/recoveryHoldRef\.current = false/g)]).toHaveLength(1)
  })

  it('el modo local nunca autoriza y mantiene la cola intacta (los cambios solo se encolan)', async () => {
    await saveComputer(computer('c9'))
    const database = await getDatabase()
    const queue = await database.getAll('syncQueue')
    expect(queue.some((item) => item.entityId === 'c9' && item.operation === 'upsert-computer')).toBe(true)
  })

  it('la acción confirmada comprueba que los datos no cambiaron desde la vista previa antes de ejecutar nada', () => {
    const start = app.indexOf('const runControl = useCallback(')
    const body = app.slice(start, app.indexOf('}, [controlBusy', start))
    expect(body.indexOf('previewControl(')).toBeGreaterThan(-1)
    expect(body.indexOf('previewControl(')).toBeLessThan(body.indexOf('pullCloudData('))
    expect(body.indexOf('previewControl(')).toBeLessThan(body.indexOf("scope: 'operations'"))
    expect(body).toContain('!== previewKey')
    expect(body).toContain('no se ejecutó nada')
  })
})

describe('las vistas previas reflejan lo que se ejecutará', () => {
  it('subir fotografías incluye el documento completo del equipo y sus cambios de datos pendientes', () => {
    const mine = computer('mine', { photo: photo(), photoNeedsUpload: true, notes: 'cambio local' })
    const local = snap([mine], [op('mine')])
    const remote = remoteOf([{ ...mine, photo: undefined, notes: 'remoto' }])
    const preview = previewControl('photos', local, remote, report(local, remote), context)
    expect(preview.items.map((item) => item.action)).toEqual(['upload-photo', 'write-document'])
    expect(preview.items[1].detail).toContain('campos distintos que se escribirán: notes')
    expect(preview.items[1].detail).toContain('ya tiene una operación pendiente')
    expect(preview.notes.join(' ')).toContain('documento COMPLETO')
  })

  it('un equipo con foto pero sin operación en la cola se anuncia como nueva operación local, y uno con baja pendiente se excluye', () => {
    const withoutOp = computer('noop', { photo: photo(), photoNeedsUpload: true })
    const deleting = computer('del', { photo: photo(), photoNeedsUpload: true })
    const local = snap([withoutOp, deleting], [op('del', { operation: 'delete-computer' })])
    const preview = previewControl('photos', local, remoteOf([{ ...withoutOp, photo: undefined }, { ...deleting, photo: undefined }]), report(local, remoteOf([withoutOp, deleting])), context)
    expect(preview.items.find((item) => item.action === 'write-document')?.detail).toContain('se encolará una operación local')
    expect(preview.excluded.find((item) => item.id === 'del')?.detail).toContain('delete-computer')
    expect(preview.items.some((item) => item.id === 'del')).toBe(false)
  })

  it('subir operaciones no lista las limpiezas de ImageKit ni promete subir fotos, y avisa de las que quedan pendientes', () => {
    const mine = computer('mine', { photo: photo(), photoNeedsUpload: true })
    const local = snap([mine], [op('mine'), op('gone', { operation: 'cleanup-photo', id: 'photo:old' })])
    const result = previewScope('push-own', local, remoteOf([mine]), report(local, remoteOf([mine])))
    expect(result.items.map((item) => item.id)).toEqual(['mine'])
    expect(result.items[0].detail).toContain('su fotografía pendiente NO se sube en este paso')
    expect(result.excluded.find((item) => item.id === 'gone')?.detail).toContain('permanece en la cola')
  })

  it('descargar no anuncia eliminaciones locales (nunca se ejecutan) y respeta las exclusiones', () => {
    const local = snap([computer('a', { sharedCloud: true, cloudId: 'a' }), computer('b', { notes: 'x' })])
    const remote = remoteOf([computer('b', { notes: 'y' }), computer('new')])
    const preview = previewControl('local-files', local, remote, report(local, remote), context)
    expect(preview.items.some((item) => item.action.includes('remove'))).toBe(false)
    expect(preview.items.map((item) => item.action).sort()).toEqual(['create-local-copy', 'overwrite-local-copy'])
    expect(preview.notes.join(' ')).toContain('ni se elimina ningún registro local')
    const withExclusion = previewScope('pull-remote', local, remote, report(local, remote), new Set(['b']))
    expect(withExclusion.items.map((item) => item.id)).toEqual(['new'])
    expect(withExclusion.excluded.map((item) => item.id)).toEqual(['b'])
  })

  it('la huella cambia cuando cambia lo que se ejecutaría y es estable si no cambia nada', () => {
    const mine = computer('mine', { photo: photo(), photoNeedsUpload: true })
    const remote = remoteOf([{ ...mine, photo: undefined }])
    const a = previewControl('all', snap([mine], [op('mine')]), remote, report(snap([mine], [op('mine')]), remote), context)
    const same = previewControl('all', snap([mine], [op('mine')]), remote, report(snap([mine], [op('mine')]), remote), context)
    const other = computer('other', { photo: photo(), photoNeedsUpload: true })
    const changed = previewControl('all', snap([mine, other], [op('mine'), op('other')]), remoteOf([{ ...mine, photo: undefined }, { ...other, photo: undefined }]), report(snap([mine, other], [op('mine'), op('other')]), remoteOf([mine, other])), context)
    expect(same.key).toBe(a.key)
    expect(changed.key).not.toBe(a.key)
  })

  it('«actualizar todos» excluye en las tres rutas (descarga, operaciones y fotos) los registros con conflicto', () => {
    const conflict = computer('conflict', { notes: 'a', photo: photo(), photoNeedsUpload: true })
    const fine = computer('fine', { photo: photo(), photoNeedsUpload: true })
    const local = snap([conflict, fine], [op('conflict'), op('fine')])
    const remote = remoteOf([{ ...conflict, notes: 'b', photo: undefined }, { ...fine, photo: undefined }])
    const preview = previewControl('all', local, remote, report(local, remote), context)
    expect(preview.items.filter((item) => item.id === 'conflict')).toEqual([])
    expect(preview.items.filter((item) => item.id === 'fine').length).toBeGreaterThanOrEqual(3)
    expect(preview.excluded.filter((item) => item.id === 'conflict').length).toBeGreaterThanOrEqual(1)
  })
})
