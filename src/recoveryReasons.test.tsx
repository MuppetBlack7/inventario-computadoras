import 'fake-indexeddb/auto'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {} }))

import { buildRecoveryReport, describeReviewReasons, needsRecoveryReview, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { RecoveryView } from './components/RecoveryView'
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
const snapshot = (computers: ComputerRecord[], queue: SyncQueueItem[] = []): RecoverySnapshot => ({ sessions: [session(), session('bob', 's2')], computers, queue })
const remoteOf = (computers: ComputerRecord[]): RemoteRecoverySnapshot => ({ sessions: [session(), session('bob', 's2')], computers })
const analyse = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null) => {
  const report = buildRecoveryReport(local, remote, 'alice', '2026-02-01T00:00:00Z')
  return { report, reasons: describeReviewReasons(local, remote, report), review: needsRecoveryReview(local, remote, report) }
}
const render = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null) => {
  const { report } = analyse(local, remote)
  return renderToStaticMarkup(<RecoveryView report={report} local={local} remote={remote} onRetry={() => undefined} onAuthorize={() => undefined} />)
}

/** Criterio anterior, escrito aparte para demostrar que la nueva explicación no cambia cuándo se exige revisión. */
const previousGate = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: ReturnType<typeof buildRecoveryReport>) =>
  !remote || local.queue.length > 0 || report.rows.some((row) => row.categories.includes('manual-review')
    || Boolean(row.localId) && (!row.categories.includes('exact-id') || row.differences.length > 0 || row.categories.includes('photo-pending')))

// El caso observado: muchos equipos propios y ajenos coincidentes y 2 equipos de otra cuenta con la foto solo en su dispositivo.
const observed = () => {
  const own = Array.from({ length: 30 }, (_, index) => computer(`own${index}`))
  const others = Array.from({ length: 28 }, (_, index) => computer(`bob${index}`, { ownerId: 'bob' }))
  const stuck = ['stuck1', 'stuck2'].map((id) => computer(id, { ownerId: 'bob', photoStoredLocally: true }))
  const all = [...own, ...others, ...stuck]
  return { local: snapshot(all), remote: remoteOf(all) }
}

describe('motivos exactos de la revisión pendiente', () => {
  it('2 fotos de otra cuenta que solo existen en el dispositivo de su propietario: único motivo, sin acción posible desde esta cuenta', () => {
    const { local, remote } = observed()
    const { report, reasons, review } = analyse(local, remote)
    expect(report.counts['manual-review']).toBe(0)
    expect(report.counts.different).toBe(0)
    expect(report.ownership.mismatch).toBe(0)
    expect(report.counts['photo-pending']).toBe(2)
    expect(review).toBe(true)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatchObject({ code: 'photo-pending-other-account', count: 2, actor: 'other-account' })
    expect(reasons[0].rows.map((row) => row.id).sort()).toEqual(['stuck1', 'stuck2'])
  })

  it('la pantalla explica el motivo en lugar de mostrar una «Decisión pendiente» vacía', () => {
    const { local, remote } = observed()
    const html = render(local, remote)
    expect(html).not.toContain('Decisión pendiente')
    expect(html).toContain('Por qué la sincronización sigue detenida')
    expect(html).toContain('2 equipos de otra cuenta con la fotografía solo en el dispositivo de su propietario')
    expect(html).toContain('solo la cuenta propietaria; desde esta cuenta no hay acción posible')
    expect(html).toContain('equipo stuck1')
    expect(html).toContain('Este panel solo diagnostica: no tiene botones para resolver nada')
    expect(html).toContain('solo ella puede subirla')
    expect(html).not.toContain('Autorizar y reanudar la sincronización')
  })

  it('un diagnóstico limpio no muestra motivos y sí el botón de autorización', () => {
    const records = [computer('a'), computer('b', { ownerId: 'bob' })]
    const { reasons, review } = analyse(snapshot(records), remoteOf(records))
    expect(reasons).toEqual([])
    expect(review).toBe(false)
    const html = render(snapshot(records), remoteOf(records))
    expect(html).not.toContain('Por qué la sincronización sigue detenida')
    expect(html).toContain('Autorizar y reanudar la sincronización')
  })

  it('distingue la foto pendiente de esta cuenta, que sí puede resolver ella', () => {
    const records = [computer('mine', { photoStoredLocally: true })]
    const { reasons } = analyse(snapshot(records), remoteOf(records))
    expect(reasons).toEqual([expect.objectContaining({ code: 'photo-pending-own', actor: 'this-account', count: 1 })])
    expect(render(snapshot(records), remoteOf(records))).toContain('esta cuenta')
  })

  it('cola, conflictos, diferencias, duplicados, sin coincidencia y sin lectura remota aparecen con su propio motivo', () => {
    const codes = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null) => analyse(local, remote).reasons.map((reason) => reason.code)
    expect(codes(snapshot([computer('a')], [op('a')]), remoteOf([computer('a')]))).toContain('queue-pending')
    expect(codes(snapshot([computer('a')], [op('a', { ownerId: 'bob' })]), remoteOf([computer('a')]))).toContain('foreign-pending-operation')
    expect(codes(snapshot([computer('a', { ownerId: 'bob' })]), remoteOf([computer('a', { ownerId: 'carol' })]))).toContain('owner-mismatch')
    expect(codes(snapshot([computer('a', { ownerId: undefined })]), remoteOf([computer('a')]))).toContain('owner-missing')
    expect(codes(snapshot([computer('a', { notes: 'x' })]), remoteOf([computer('a', { notes: 'y' })]))).toContain('different')
    expect(codes(snapshot([computer('a')]), remoteOf([computer('z', { serialNumber: 'SER-a', serialNormalized: 'SERa' })]))).toContain('probable-duplicate')
    expect(codes(snapshot([computer('a')]), remoteOf([]))).toContain('not-matched')
    expect(codes(snapshot([computer('a')]), null)).toContain('remote-unavailable')
  })

  it('la nueva lógica coincide con el criterio anterior en todos los escenarios: cambia la explicación, no cuándo se exige revisión', () => {
    const a = computer('a')
    const scenarios: Array<[RecoverySnapshot, RemoteRecoverySnapshot | null]> = [
      [snapshot([a]), remoteOf([a])],
      [snapshot([computer('a', { ownerId: 'bob' })]), remoteOf([computer('a', { ownerId: 'bob' })])],
      [snapshot([computer('a', { ownerId: 'bob', photoStoredLocally: true })]), remoteOf([computer('a', { ownerId: 'bob', photoStoredLocally: true })])],
      [snapshot([a], [op('a')]), remoteOf([a])],
      [snapshot([a], [op('a', { ownerId: 'bob' })]), remoteOf([a])],
      [snapshot([computer('a', { ownerId: 'bob' })]), remoteOf([computer('a', { ownerId: 'carol' })])],
      [snapshot([computer('a', { ownerId: undefined })]), remoteOf([a])],
      [snapshot([computer('a', { notes: 'x' })]), remoteOf([a])],
      [snapshot([a]), remoteOf([])],
      [snapshot([]), remoteOf([a])],
      [snapshot([computer('a', { ownerId: undefined })]), remoteOf([computer('a', { ownerId: undefined })])],
      [snapshot([a]), null],
      [snapshot([], [op('ghost')]), remoteOf([])],
      [snapshot([a]), remoteOf([computer('z', { serialNumber: 'SER-a', serialNormalized: 'SERa' })])]
    ]
    for (const [local, remote] of scenarios) {
      const { report, reasons, review } = analyse(local, remote)
      expect(review).toBe(previousGate(local, remote, report))
      expect(reasons.length > 0).toBe(review)
    }
  })

  it('el análisis de motivos es de solo lectura: no modifica el diagnóstico, los registros ni la cola', () => {
    const { local, remote } = observed()
    const before = JSON.stringify([local, remote])
    analyse(local, remote)
    render(local, remote)
    expect(JSON.stringify([local, remote])).toBe(before)
  })
})
