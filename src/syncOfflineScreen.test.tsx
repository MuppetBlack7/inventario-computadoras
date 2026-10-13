import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {}, firebaseAuth: null }))

import { buildRecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { SyncInventoryView } from './components/SyncInventoryView'
import { advance, decisionsForMode, initialFlow, type FlowStep } from './syncFlow'
import { buildProposal, defaultDecisions, describeOperationResults, primaryAction, summarizePending, summarizeSync } from './syncPlan'
import { clearAllData, getComputer, getDatabase, getPendingSyncQueue, listComputers, saveComputer } from './db'
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
const steps: FlowStep[] = ['overview', 'comparing', 'proposal', 'confirm', 'running', 'result']

const render = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, options: { online?: boolean; step?: FlowStep } = {}) => {
  const report = buildRecoveryReport(local, remote, 'alice')
  return renderToStaticMarkup(<SyncInventoryView report={report} local={local} remote={remote} online={options.online ?? true} imageKitConfigured flow={{ ...initialFlow(), step: options.step ?? 'overview' }}
    onFlow={() => undefined} onBack={() => undefined} onAuthorize={() => undefined} onRetry={() => undefined} />)
}
const pendingData = () => ({ local: snap([computer('a'), computer('new1'), computer('new2', { photo: photo(), photoNeedsUpload: true })], [op('new1'), op('new2')]), remote: remoteOf([computer('a')]) })
const cleanData = () => ({ local: snap([computer('a')]), remote: remoteOf([computer('a')]) })

describe('estado de conexión de la pantalla', () => {
  it('con internet y Firebase respondiendo: «Conectado a Firebase»', () => {
    expect(render(cleanData().local, cleanData().remote)).toContain('Conectado a Firebase')
  })

  it('sin internet: explica el modo sin conexión y que los cambios se guardan en el dispositivo', () => {
    const html = render(pendingData().local, pendingData().remote, { online: false })
    expect(html).toContain('Modo sin conexión. Puedes seguir registrando y editando equipos. Los cambios se guardan en este dispositivo')
    expect(html).not.toContain('Conectado a Firebase')
  })

  it('con internet pero sin respuesta de Firebase: lo dice sin confundirlo con estar sincronizado', () => {
    const html = render(pendingData().local, null, { online: true })
    expect(html).toContain('No se pudo conectar con Firebase. Tus cambios locales se conservan')
    expect(html).not.toContain('Conectado a Firebase')
    expect(html).not.toContain('Todo está al día')
    expect(html).toContain('Reintentar conexión')
  })

  it('tener conexión no equivale a estar sincronizado: con cambios pendientes sigue la tarjeta de datos locales', () => {
    const html = render(pendingData().local, pendingData().remote)
    expect(html).toContain('Conectado a Firebase')
    expect(html).toContain('Tienes cambios guardados en este dispositivo')
    expect(html).not.toContain('Todo está al día')
  })
})

describe('tarjeta «Tienes cambios guardados en este dispositivo»', () => {
  it('indica cuántos registros y fotografías están pendientes y ofrece las tres acciones', () => {
    const { local, remote } = pendingData()
    const pending = summarizePending(local, remote, buildRecoveryReport(local, remote, 'alice'))
    expect(pending).toMatchObject({ records: 2, photos: 1, reliable: true })
    const html = render(local, remote)
    expect(html).toContain('2 registros y 1 fotografía sin enviar')
    for (const action of ['Revisar cambios', 'Subir mis cambios', 'Seguir trabajando sin conexión']) expect(html).toContain(action)
    expect(html).toContain('Siguen a salvo aquí aunque pospongas o canceles la subida')
  })

  it('cuenta también los equipos solo locales sin operación y avisa cuando no se pudo comparar', () => {
    const local = snap([computer('lonely')])
    const withRemote = summarizePending(local, remoteOf([]), buildRecoveryReport(local, remoteOf([]), 'alice'))
    expect(withRemote).toMatchObject({ records: 1, reliable: true })
    const withoutRemote = summarizePending(local, null, buildRecoveryReport(local, null, 'alice'))
    expect(withoutRemote).toMatchObject({ records: 0, reliable: false })
    expect(render(snap([computer('a')], [op('a')]), null)).toContain('No se pudo comparar con Firebase, así que puede haber más')
  })

  it('«Subir mis cambios» está deshabilitado sin conexión y explica que los datos siguen guardados localmente', () => {
    const { local, remote } = pendingData()
    const offline = render(local, remote, { online: false })
    expect(offline).toMatch(/<button class="primary-button big-action"[^>]*disabled=""[^>]*>Subir mis cambios<\/button>/)
    expect(offline).toContain('Sin conexión: la subida está deshabilitada y tus datos siguen guardados en este dispositivo.')
    const online = render(local, remote)
    expect(online).not.toMatch(/<button class="primary-button big-action"[^>]*disabled=""[^>]*>Subir mis cambios<\/button>/)
  })

  it('«Seguir trabajando sin conexión» y «Revisar cambios» no dependen de la conexión', () => {
    const html = render(pendingData().local, pendingData().remote, { online: false })
    expect(html).toMatch(/<button class="secondary-button big-action">Seguir trabajando sin conexión<\/button>/)
    expect(html).toMatch(/<summary class="secondary-button">Revisar cambios<\/summary>/)
    expect(html).toContain('equipo new1')
  })
})

describe('botón principal único según el estado', () => {
  const topButtons = (html: string) => [...html.matchAll(/<div class="sync-primary">(.*?)<\/div>/g)].flatMap((match) => [...match[1].matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((button) => button[1]))
  const state = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, online = true) => {
    const report = buildRecoveryReport(local, remote, 'alice')
    return primaryAction(summarizeSync(local, remote, report, online), summarizePending(local, remote, report))
  }

  it('con cambios pendientes y conexión: «Revisar y subir mis cambios»', () => {
    expect(state(pendingData().local, pendingData().remote)).toBe('upload')
    expect(topButtons(render(pendingData().local, pendingData().remote))).toEqual(['Revisar y subir mis cambios'])
  })

  it('sin conexión: «Seguir trabajando sin conexión»', () => {
    expect(state(pendingData().local, pendingData().remote, false)).toBe('offline')
    expect(topButtons(render(pendingData().local, pendingData().remote, { online: false }))).toEqual(['Seguir trabajando sin conexión'])
  })

  it('sin cambios pendientes: «Todo está al día»', () => {
    expect(state(cleanData().local, cleanData().remote)).toBe('up-to-date')
    expect(topButtons(render(cleanData().local, cleanData().remote))).toEqual(['Todo está al día'])
  })

  it('con internet pero Firebase sin responder: «Reintentar conexión»', () => {
    expect(state(pendingData().local, null)).toBe('reconnect')
    expect(topButtons(render(pendingData().local, null))).toEqual(['Reintentar conexión'])
  })

  it('no hay botón superior «Volver al inventario» ni «Sincronizar todo» en ningún paso', () => {
    for (const data of [pendingData(), cleanData()]) {
      for (const step of steps) {
        const html = render(data.local, data.remote, { step })
        expect(html).not.toContain('← Volver al inventario')
        expect(html).not.toContain('back-to-inventory')
        expect(html).not.toMatch(/Sincronizar todo/i)
        expect(html).not.toMatch(/<h1>[^<]*<\/h1>\s*<button[^>]*>Volver al inventario/)
      }
    }
  })
})

describe('acciones con nombres inequívocos y flujo de subida con confirmación', () => {
  it('ofrece «Descargar datos», «Revisar diferencias» y «Seguir trabajando sin conexión», sin «Sincronizar ahora» inmediato', () => {
    const html = render(cleanData().local, cleanData().remote)
    for (const label of ['Descargar datos', 'Revisar diferencias', 'Seguir trabajando sin conexión']) expect(html).toContain(label)
    expect(html).toContain('Trae registros de Firebase sin borrar nada de este dispositivo')
    expect(html).not.toContain('Sincronizar ahora')
  })

  it('«Subir mis cambios» solo compara primero y prepara una propuesta solo de subida; nada se escribe hasta confirmar', () => {
    const start = advance(initialFlow(), { type: 'sync-now', mode: 'upload' })
    expect(start.effect).toBe('compare')
    expect(start.state.decisions).toMatchObject({ uploadMyChanges: true, localOnly: 'prepare', remoteOnly: 'skip', uploadPhotos: true })
    let state = advance(start.state, { type: 'compared' }).state
    expect(state.step).toBe('proposal')
    expect(advance(state, { type: 'confirm' }).effect).toBe('none')
    state = advance(state, { type: 'proceed' }).state
    expect(advance(state, { type: 'confirm' }).effect).toBe('run')
    expect(decisionsForMode('download', defaultDecisions())).toMatchObject({ uploadMyChanges: false, localOnly: 'keep', remoteOnly: 'download', uploadPhotos: false })
  })

  it('la propuesta de subida excluye registros ajenos, conflictos y posibles duplicados, con su motivo, y no descarga nada', () => {
    const local = snap([
      computer('mine'), computer('theirs', { ownerId: 'bob' }), computer('dup', { serialNumber: 'SER-z', serialNormalized: 'SERz' }),
      computer('mismatch', { ownerId: 'bob' }), computer('photo', { photo: photo(), photoNeedsUpload: true }),
      computer('stuck', { ownerId: 'bob', photoStoredLocally: true })
    ], [op('mine'), op('theirs'), op('dup'), op('mismatch'), op('photo')])
    const remote = remoteOf([computer('mine'), computer('theirs', { ownerId: 'bob' }), computer('other', { serialNumber: 'SER-z', serialNormalized: 'SERz' }), computer('mismatch', { ownerId: 'carol' }), computer('photo'), computer('stuck', { ownerId: 'bob', photoStoredLocally: true }), computer('only-remote')])
    const upload = buildProposal(local, remote, buildRecoveryReport(local, remote, 'alice'), decisionsForMode('upload', defaultDecisions()), { imageKitConfigured: true })
    expect(upload.steps.upload.map((item) => item.id).sort()).toEqual(['mine', 'photo'])
    expect(upload.steps.download).toEqual([])
    expect(upload.steps.photos.filter((item) => item.action === 'upload-photo').map((item) => item.id)).toEqual(['photo'])
    const reasons = (id: string) => upload.kept.filter((item) => item.id === id).map((item) => item.detail).join(' | ')
    expect(reasons('dup')).toContain('posible duplicado')
    expect(reasons('mismatch')).toContain('propietario distinto')
    expect(reasons('theirs')).toContain('otra cuenta')
    expect(reasons('stuck')).toContain('puede reemplazarse seleccionando una nueva')
    expect(upload.excludeIds.has('stuck')).toBe(false) // la advertencia de la foto ajena no oculta ni bloquea nada propio
  })

  it('el resultado de cada operación distingue lo hecho de lo que sigue pendiente, con su error', () => {
    const attempted = [
      { action: 'upsert-computer', kind: 'computer' as const, id: 'done' },
      { action: 'upsert-computer', kind: 'computer' as const, id: 'failed' },
      { action: 'upload-photo', kind: 'computer' as const, id: 'photo-done' }
    ]
    const queueAfter = [op('failed', { lastError: 'Red interrumpida' }), op('bob-op', { ownerId: 'bob' })]
    const result = describeOperationResults(attempted, queueAfter, 'alice')
    expect(result.done).toEqual(['equipo done: upsert-computer · hecho', 'equipo photo-done: fotografía subida · hecho'])
    expect(result.pending).toEqual(['equipo failed: upsert-computer sigue pendiente (Red interrumpida)'])
    // Una operación de otra cuenta con el mismo identificador no cuenta como pendiente propia.
    expect(describeOperationResults([{ action: 'x', kind: 'computer', id: 'bob-op' }], queueAfter, 'alice').done).toHaveLength(1)
  })

  it('cancelar o volver desde cualquier paso no toca los datos: «back» nunca produce una escritura', () => {
    for (const step of steps) expect(advance({ ...initialFlow(), step }, { type: 'back' }).effect).not.toBe('run')
  })
})

describe('datos locales sin internet', () => {
  beforeEach(async () => { await clearAllData() })

  it('registrar equipos con fotografía sin internet los conserva tras cerrar y reabrir IndexedDB, con su cola', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    try {
      await saveComputer(computer('offline-1', { photo: photo(), photoNeedsUpload: true, photoUploadStatus: 'pending', photoLocalRevision: 'rev-1' }))
      await saveComputer(computer('offline-2'))
      ;(await getDatabase()).close() // «recargar»
      const stored = await getComputer('offline-1')
      expect(Array.from(new Uint8Array(await stored!.photo!.arrayBuffer()))).toEqual([1, 2, 3])
      expect(stored).toMatchObject({ photoNeedsUpload: true, photoUploadStatus: 'pending' })
      expect((await listComputers()).map((item) => item.id).sort()).toEqual(['offline-1', 'offline-2'])
      expect((await getPendingSyncQueue()).map((item) => item.id).sort()).toEqual(['computer:offline-1', 'computer:offline-2'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('al recuperar la conexión no se sube nada por sí solo: el aviso de reconexión solo pide sincronizar si está autorizada', () => {
    const app = readFileSync('src/App.tsx', 'utf8')
    const handler = app.slice(app.indexOf('const handleOnline = () =>'), app.indexOf('const handleOffline'))
    expect(handler).toContain('runSync(user)')
    for (const forbidden of ['synchronize(', 'synchronizeAndPull(', 'pullCloudData(', 'executeProposal', 'recoveryHoldRef.current = false']) expect(handler).not.toContain(forbidden)
    // runSync devuelve antes de sincronizar mientras el bloqueo esté activo, y solo autorizar lo libera.
    const runSync = app.slice(app.indexOf('const runSync = useCallback('))
    expect(runSync.indexOf('recoveryHoldRef.current')).toBeLessThan(runSync.indexOf('synchronizeAndPull('))
    expect(runSync).toContain('held: true')
    expect([...app.matchAll(/recoveryHoldRef\.current = false/g)]).toHaveLength(1)
  })

  it('la comparación sin conexión no intenta leer Firebase', () => {
    const recovery = readFileSync('src/recovery.ts', 'utf8')
    expect(recovery).toContain("navigator.onLine === false ? Promise.reject(new Error('Sin conexión'))")
  })
})
