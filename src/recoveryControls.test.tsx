import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {} }))

import { buildRecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { RecoveryControls } from './components/RecoveryControls'
import { RecoveryView } from './components/RecoveryView'
import type { ControlId } from './recoveryPermissions'
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

const render = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, options: { imageKitConfigured?: boolean; initialPreview?: ControlId | null; onRun?: () => void } = {}) => {
  const report = buildRecoveryReport(local, remote, 'alice', '2026-02-01T00:00:00Z')
  return renderToStaticMarkup(<RecoveryControls report={report} local={local} remote={remote} imageKitConfigured={options.imageKitConfigured ?? true} initialPreview={options.initialPreview ?? null} onRun={options.onRun} />)
}

// El caso observado: equipos propios y 2 equipos de otra cuenta con la foto solo en su dispositivo.
const observed = () => {
  const stuck = ['0150430', '0447137'].map((id) => computer(`stuck-${id}`, { ownerId: 'bob', photoStoredLocally: true }))
  const all = [computer('own1'), computer('own2'), ...stuck]
  return { local: snap(all), remote: remoteOf(all) }
}

describe('los cuatro controles de la pantalla de recuperación', () => {
  it('se muestran con su propio alcance y las advertencias de las fotos ajenas siguen visibles', () => {
    const { local, remote } = observed()
    const html = render(local, remote)
    for (const title of ['Actualizar archivos locales', 'Mantener detenida la sincronización', 'Actualizar fotografías', 'Actualizar todos los equipos']) expect(html).toContain(title)
    expect(html.match(/Ver vista previa/g)).toHaveLength(4)
    expect(html).toContain('Advertencia: 2 fotografías pendientes de otra cuenta')
    expect(html).toContain('ninguna cambia propietarios, elimina registros ni vacía la cola'.replace('ninguna', 'Ninguna'))
  })

  it('cada control se deshabilita con su motivo: sin lectura remota, sin ImageKit o sin fotos propias', () => {
    const { local, remote } = observed()
    const noRemote = render(local, null)
    expect(noRemote).toContain('Firestore no se pudo leer en el servidor')
    const noImageKit = render(snap([computer('own', { photo: photo(), photoNeedsUpload: true })]), remoteOf([computer('own')]), { imageKitConfigured: false })
    expect(noImageKit).toContain('ImageKit no está configurado en esta aplicación')
    const none = render(local, remote)
    expect(none).toContain('no hay fotografías propias pendientes de subir')
    // «Mantener detenida» nunca depende de la nube.
    expect(noRemote.split('Mantener detenida la sincronización')[1].split('Actualizar fotografías')[0]).not.toContain('No disponible')
  })

  it('la vista previa de fotografías lista solo las propias y excluye las de otra cuenta, con confirmación separada', () => {
    const mine = computer('mine', { photo: photo(), photoNeedsUpload: true, photoUploadStatus: 'pending' })
    const stuck = computer('stuck', { ownerId: 'bob', photoStoredLocally: true })
    const local = snap([mine, stuck])
    const html = render(local, remoteOf([{ ...mine, photo: undefined }, stuck]), { initialPreview: 'photos' })
    expect(html).toContain('Se aplicaría a: 2')
    expect(html).toContain('write-document')
    expect(html).toContain('el documento COMPLETO del equipo')
    expect(html).toContain('upload-photo')
    expect(html).toContain('3 bytes')
    expect(html).toContain('Excluido: 1')
    expect(html).toContain('puede reemplazarse seleccionando una nueva')
    expect(html).toContain('Confirmar: Actualizar fotografías')
    expect(html).not.toContain('Confirmar: Actualizar todos los equipos')
  })

  it('«actualizar todos» muestra el orden, lo que se aplica y lo excluido por conflicto o riesgo', () => {
    const mine = [computer('ok'), computer('diff', { notes: 'a' }), computer('noowner', { ownerId: undefined })]
    const theirs = [computer('ok'), computer('diff', { notes: 'b' }), computer('noowner')]
    const html = render(snap(mine, [op('ok'), op('diff')]), remoteOf(theirs), { initialPreview: 'all' })
    expect(html).toContain('Orden: 1) descargar, 2) subir mis operaciones (sin fotografías ni limpiezas de ImageKit), 3) subir mis fotografías')
    expect(html).toContain('2·subir:upsert-computer')
    expect(html).toContain('excluido por contenido distinto (notes)')
    expect(html).toContain('excluido por owner-missing')
    expect(html).toContain('Confirmar: Actualizar todos los equipos')
  })

  it('la vista previa de descargar y la de mantener detenida aclaran que no escriben en Firestore', () => {
    const { local, remote } = observed()
    expect(render(local, remote, { initialPreview: 'local-files' })).toContain('no se escribe en Firestore')
    expect(render(local, remote, { initialPreview: 'keep-stopped' })).toContain('No se escribirá nada en Firestore ni en ImageKit')
  })

  it('un control bloqueado no muestra vista previa ni botón de confirmación aunque se intente abrir', () => {
    const { local, remote } = observed()
    const html = render(local, remote, { initialPreview: 'photos' }) // sin fotos propias: bloqueado
    expect(html).not.toContain('Confirmar: Actualizar fotografías')
  })

  it('renderizar los controles no ejecuta ninguna acción', () => {
    const { local, remote } = observed()
    const onRun = vi.fn()
    render(local, remote, { initialPreview: 'all', onRun })
    expect(onRun).not.toHaveBeenCalled()
  })

  it('la pantalla de recuperación incluye los controles y conserva el botón de autorización solo con diagnóstico limpio', () => {
    const { local, remote } = observed()
    const report = buildRecoveryReport(local, remote, 'alice')
    const html = renderToStaticMarkup(<RecoveryView report={report} local={local} remote={remote} onRetry={() => undefined} onAuthorize={() => undefined} />)
    expect(html).toContain('Acciones separadas')
    expect(html).not.toContain('Autorizar y reanudar la sincronización') // las 2 fotos ajenas siguen bloqueando la autorización global
  })
})

describe('conexión de los controles en la aplicación', () => {
  const app = readFileSync('src/App.tsx', 'utf8')
  const start = app.indexOf('const runControl = useCallback(')
  const body = app.slice(start, app.indexOf('}, [controlBusy', start))

  it('cada control usa su alcance y ninguno llama a la sincronización general ni libera el bloqueo', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toContain("scope: 'operations'")
    expect(body).toContain("scope: 'photos'")
    expect(body).toContain('pullCloudData(user.uid, { exclude: excludeIds, keepLocalRecords: true })')
    for (const forbidden of ['runSync', 'synchronizeAndPull', 'recoveryHoldRef.current = false', 'authorizeRecovery', 'claimLocalData', 'deleteComputer', 'replaceAllData']) expect(body).not.toContain(forbidden)
    expect(body).toContain("recovery.phase !== 'review' && recovery.phase !== 'ready'")
  })

  it('tras cada acción se vuelve a diagnosticar (solo lectura) y la sincronización general sigue detenida', () => {
    expect(body).toContain('await inspectRecovery(user.uid)')
    expect(body).toContain("reportSync('local', 'Sincronización detenida')")
  })
})
