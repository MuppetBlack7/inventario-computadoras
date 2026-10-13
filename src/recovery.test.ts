import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { buildRecoveryReport, exportRecoverySnapshot, readLocalRecoverySnapshot, runRecoveryDiagnostic, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { afterDiagnostic, authorizeRecovery, syncAllowed } from './recoveryState'
import { getDatabase } from './db'
import type { ComputerRecord, InventorySession, SyncQueueItem } from './types'

const session = (id = 's1', ownerId = 'alice'): InventorySession => ({
  id, name: 'Sesión', date: '2026-01-01', location: '', ownerId,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z'
})
const computer = (id = 'c1', changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: 'INV-1', inventoryNormalized: 'INV1', serialNumber: 'SER-1', serialNormalized: 'SER1',
  brand: 'Marca', model: 'Modelo', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null,
  drives: [], originalCode: '', scannedAt: '', timezone: '', latitude: null, longitude: null, accuracyMeters: null,
  writtenLocation: '', notes: '', ownerId: 'alice', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  ...changes
})
const queue = (operation: SyncQueueItem['operation'], entityId = 'c1', changes: Partial<SyncQueueItem> = {}): SyncQueueItem => ({
  id: `${operation.includes('session') ? 'session' : 'computer'}:${entityId}`,
  operation, entityId, ownerId: 'alice', createdAt: '2026-01-01T00:00:00Z', revision: 'r1', ...changes
})
const local = (computers: ComputerRecord[] = [], pending: SyncQueueItem[] = []): RecoverySnapshot => ({ sessions: [session()], computers, queue: pending })
const remote = (computers: ComputerRecord[] = []): RemoteRecoverySnapshot => ({ sessions: [session()], computers })
const row = (a: RecoverySnapshot, b: RemoteRecoverySnapshot | null) => buildRecoveryReport(a, b, 'alice').rows.find((item) => item.kind === 'computer')!

describe('diagnóstico de recuperación sin escrituras', () => {
  it('marca equipo antiguo que nunca llegó a Firebase como solo local', () => {
    expect(row(local([computer()]), remote()).categories).toContain('local-only')
    expect(row(local([computer()]), remote()).proposal).toBe('create-after-review')
  })
  it('reconoce coincidencia exacta por ID sin crear otro documento', () => {
    const result = row(local([computer()]), remote([computer()]))
    expect(result.categories).toContain('exact-id')
    expect(result.differences).toEqual([])
    expect(result.proposal).toBe('keep')
  })
  it.each(['inventoryId', 'serialNumber'] as const)('deja en revisión otro ID con igual %s', (field) => {
    const original = computer()
    const different = computer('c2', field === 'inventoryId'
      ? { serialNumber: 'OTRA', serialNormalized: 'OTRA' }
      : { inventoryId: 'OTRO', inventoryNormalized: 'OTRO' })
    const result = row(local([original]), remote([different]))
    expect(result.categories).toContain('probable-duplicate')
    expect(result.proposal).toBe('manual-review')
  })
  it('no atribuye un registro de otra cuenta', () => {
    const result = row(local([computer('c1', { ownerId: 'bob' })]), remote([computer('c1', { ownerId: 'bob' })]))
    expect(result.categories).toContain('other-account-record')
    expect(result.categories).not.toContain('manual-review')
    expect(result.ownerId).toBe('bob')
    expect(result.proposal).toBe('no-action')
  })
  it('muestra los campos diferentes incluso cuando la versión local es más reciente', () => {
    const result = row(local([computer('c1', { notes: 'local', updatedAt: '2026-02-01T00:00:00Z' })]), remote([computer('c1', { notes: 'remoto' })]))
    expect(result.categories).toContain('different')
    expect(result.differences).toContain('notes')
    expect(result.localRevision).not.toBe(result.remoteRevision)
  })
  it('conserva ambos estados ante cambios concurrentes', () => {
    const result = row(local([computer('c1', { notes: 'A' })]), remote([computer('c1', { notes: 'B' })]))
    expect(result.proposal).toBe('manual-review')
    expect(result.differences).toEqual(['notes'])
  })
  it('detecta fotografía local pendiente y referencia remota ausente', () => {
    const photo = new Blob(['photo'], { type: 'image/png' })
    const result = row(local([computer('c1', { photo, photoNeedsUpload: true, photoRemote: {
      fileId: 'old', url: 'https://example.com/x', filePath: '/x', name: 'x', size: 5,
      width: null, height: null, mimeType: 'image/png', uploadedAt: '2026-01-01T00:00:00Z'
    } })]), remote([computer()]))
    expect(result.categories).toContain('photo-pending')
    expect(result.photo.remoteReferenceMissing).toBe(true)
    expect(result.proposal).toBe('manual-review')
  })
  it('conserva varias operaciones pendientes, incluidas bajas explícitas', () => {
    const pending = [queue('upsert-computer'), queue('delete-session', 's1'), queue('cleanup-photo', 'gone', { photoFileId: 'file-1' })]
    const report = buildRecoveryReport(local([computer()], pending), remote([computer()]), 'alice')
    expect(report.localCounts.queue).toBe(3)
    expect(report.rows.flatMap((item) => item.pending).map((item) => item.operation).sort()).toEqual(['cleanup-photo', 'delete-session', 'upsert-computer'])
    expect(report.rows.every((item) => item.proposal !== 'create-after-review')).toBe(true)
  })
  it('no presenta una lectura remota fallida como ausencia en Firebase', () => {
    const result = row(local([computer()]), null)
    expect(result.categories).toContain('remote-unavailable')
    expect(result.categories).not.toContain('local-only')
  })
  it('es repetible tras un reinicio y no produce nuevas operaciones', () => {
    const a = local([computer()], [queue('upsert-computer')])
    const b = remote([computer()])
    const first = buildRecoveryReport(a, b, 'alice', '2026-01-02T00:00:00Z')
    const second = buildRecoveryReport(a, b, 'alice', '2026-01-02T00:00:00Z')
    expect(second).toEqual(first)
    expect(a.queue).toHaveLength(1)
    expect(first.writesEnabled).toBe(false)
  })
  it('lee registros y cola en una transacción sin modificarlos', async () => {
    const db = await getDatabase()
    await db.put('sessions', session())
    await db.put('computers', computer())
    await db.put('syncQueue', queue('upsert-computer'))
    const before = await readLocalRecoverySnapshot()
    const after = await readLocalRecoverySnapshot()
    expect(after).toEqual(before)
    expect(after.queue).toHaveLength(1)
  })
  it('exporta foto y cola completas con suma SHA-256 verificable', async () => {
    const snapshot = local([computer('c1', { photo: new Blob(['foto'], { type: 'image/png' }) })], [queue('upsert-computer')])
    const report = buildRecoveryReport(snapshot, remote(), 'alice')
    const exported = await exportRecoverySnapshot(snapshot, remote(), report)
    const actual = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exported.payload))
    const hex = [...new Uint8Array(actual)].map((value) => value.toString(16).padStart(2, '0')).join('')
    expect(exported.sha256).toBe(hex)
    expect(JSON.parse(exported.payload).local.computers[0].photoDataUrl).toContain('base64,')
    expect(JSON.parse(exported.payload).local.queue).toHaveLength(1)
  })
  it('el diagnóstico no invoca escrituras y no autoriza una cola antigua en bloque', async () => {
    const snapshot = local([computer()], [queue('upsert-computer')])
    const result = await runRecoveryDiagnostic('alice', {
      local: async () => snapshot,
      remote: async () => remote([computer()])
    })
    expect(result.needsReview).toBe(true)
    const state = afterDiagnostic(result.report, result.local, result.remote, result.needsReview)
    expect(syncAllowed(authorizeRecovery(state, 'alice'))).toBe(false)
    expect(snapshot.queue).toHaveLength(1)
  })
  it('un diagnóstico limpio solo permite sincronizar tras autorización explícita de la misma cuenta', () => {
    const snapshot = local([computer()])
    const server = remote([computer()])
    const report = buildRecoveryReport(snapshot, server, 'alice')
    const state = afterDiagnostic(report, snapshot, server, false)
    expect(syncAllowed(state)).toBe(false)
    expect(syncAllowed(authorizeRecovery(state, 'bob'))).toBe(false)
    expect(syncAllowed(authorizeRecovery(state, 'alice'))).toBe(true)
  })
})
