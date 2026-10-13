import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {}, firebaseAuth: null }))

import { buildRecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { SyncInventoryView, type SyncResultView } from './components/SyncInventoryView'
import { initialFlow, type FlowStep } from './syncFlow'
import type { ComputerRecord, InventorySession, SyncQueueItem } from './types'

const stamp = '2026-01-01T00:00:00Z'
const session = (ownerId = 'alice', id = 's1'): InventorySession => ({ id, name: 'Sesión', date: '2026-01-01', location: '', ownerId, createdAt: stamp, updatedAt: stamp })
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: '', model: '', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '', scannedAt: '', timezone: '',
  latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice', ownerName: 'Alicia', createdAt: stamp, updatedAt: stamp, ...changes
})
const op = (entityId: string): SyncQueueItem => ({ id: `computer:${entityId}`, operation: 'upsert-computer', entityId, ownerId: 'alice', createdAt: stamp, revision: 'r1' })

const local: RecoverySnapshot = {
  sessions: [session(), session('bob', 's2')],
  computers: [computer('only-local'), computer('diff', { notes: 'a' }), computer('diff2', { notes: 'a' }), computer('both'), computer('stuck', { ownerId: 'bob', ownerName: 'Su amigo', photoStoredLocally: true })],
  queue: [op('only-local'), op('diff2')]
}
const remote: RemoteRecoverySnapshot = {
  sessions: [session(), session('bob', 's2')],
  computers: [computer('diff', { notes: 'b' }), computer('diff2', { notes: 'b' }), computer('both'), computer('only-remote'), computer('stuck', { ownerId: 'bob', ownerName: 'Su amigo', photoStoredLocally: true })]
}

const render = (step: FlowStep, options: { focus?: boolean; result?: SyncResultView | null; online?: boolean; remoteData?: RemoteRecoverySnapshot | null } = {}) => {
  const remoteData = options.remoteData === undefined ? remote : options.remoteData
  const report = buildRecoveryReport(local, remoteData, 'alice', '2026-02-01T00:00:00Z')
  return renderToStaticMarkup(<SyncInventoryView report={report} local={local} remote={remoteData} online={options.online ?? true} imageKitConfigured flow={{ ...initialFlow(), step, focusDifferences: options.focus ?? false }}
    onFlow={() => undefined} result={options.result} onBack={() => undefined} onAuthorize={() => undefined} onRetry={() => undefined} />)
}

describe('pantalla «Sincronizar inventario»', () => {
  it('reemplaza la tarjeta de recuperación como centro y muestra el estado pedido', () => {
    const html = render('overview')
    expect(html).toContain('<h1>Sincronizar inventario</h1>')
    expect(html).not.toContain('<h1>Recuperación pendiente</h1>')
    expect(html).toContain('Conectado a Firebase')
    expect(html).toContain('Cambios locales pendientes de subir:</strong> 2')
    expect(html).toContain('Existen solo en este dispositivo:</strong> 1')
    expect(html).toContain('Existen solo en Firebase:</strong> 1')
    expect(html).toContain('Con cambios distintos en ambos lados:</strong> 2')
    expect(html).toContain('Fotografías pendientes:</strong> 0 mías · 1 de otras cuentas')
    expect(html).toContain('Registros de otras cuentas (solo lectura):</strong> 2')
    expect(html).toContain('Revisar y subir mis cambios')
    expect(html).toContain('Descargar datos')
    expect(html).toContain('Revisar diferencias')
    expect(html).toContain('Seguir trabajando sin conexión')
    expect(html).not.toContain('Sincronizar ahora')
    expect(html).toContain('Antes de escribir algo siempre se muestra una vista previa y se pide confirmación')
  })

  it('la fotografía que solo existe en el dispositivo de otra persona se muestra como advertencia con quién debe recuperarla', () => {
    const html = render('overview')
    expect(html).toContain('solo existe en el dispositivo de Su amigo')
    expect(html).toContain('esa cuenta debe recuperarla')
    expect(html).toContain('No se marca como recuperada')
    expect(html).toContain('no impide las demás operaciones')
  })

  it('las herramientas técnicas quedan en un detalle plegable, sin el encabezado «Recuperación pendiente»', () => {
    const html = render('overview')
    expect(html).toContain('Detalles técnicos y herramientas avanzadas')
    expect(html).toContain('Descargar copia y SHA-256')
    expect(html).not.toContain('Recuperación pendiente')
  })

  it('estado sin conexión o con Firebase sin responder', () => {
    expect(render('overview', { online: false })).toContain('Modo sin conexión')
    expect(render('overview', { remoteData: null })).toContain('No se pudo conectar con Firebase')
  })

  it('en la propuesta ofrece las opciones por categoría y la resolución registro por registro, sin botón de escritura', () => {
    const html = render('proposal')
    expect(html).toContain('Subir mis cambios')
    expect(html).toContain('Conservar localmente por ahora')
    expect(html).toContain('Preparar su subida')
    expect(html).toContain('Conservarlos solo aquí')
    expect(html).toContain('Descargar de forma segura (no elimina nada local)')
    expect(html).toContain('Conservar mi versión local (no cambia nada)')
    expect(html).toContain('Usar la versión de Firebase')
    expect(html).toContain('(no disponible: hay operaciones pendientes)') // diff2 tiene una operación pendiente
    expect(html).toContain('Subir mi versión')
    expect(html).toContain('Revisar y confirmar')
    expect(html).not.toContain('Confirmar y sincronizar')
  })

  it('«Revisar diferencias» abre directamente la lista de diferencias', () => {
    expect(render('proposal', { focus: true })).toMatch(/<details open=""><summary>Registros con cambios distintos en ambos lados: 2/)
    expect(render('proposal', { focus: false })).toMatch(/<details open=""><summary>Registros con cambios distintos en ambos lados: 2/)
  })

  it('el botón que escribe solo existe en el paso de confirmación, junto con el aviso de lectura previa', () => {
    for (const step of ['overview', 'comparing', 'proposal', 'running', 'result'] as const) expect(render(step)).not.toContain('Confirmar y sincronizar')
    const html = render('confirm')
    expect(html).toContain('Confirmar y sincronizar')
    expect(html).toContain('Al confirmar se escribirá únicamente lo listado arriba')
    expect(html).toContain('si algo cambió desde esta vista, no se ejecuta nada')
    expect(html).toContain('Ver cada registro que se escribiría')
    expect(html).toContain('Ver lo que se conserva')
  })

  it('la propuesta resume qué se prepara, descarga, sube y conserva', () => {
    const html = render('confirm')
    expect(html).toContain('Descargar de Firebase a este dispositivo: <strong>1</strong>')
    expect(html).toContain('Subir mis operaciones: <strong>1</strong>') // la operación de «diff2» queda fuera: tiene diferencias sin resolver
    expect(html).toContain('Conservar sin tocar: <strong>')
  })

  it('el resultado muestra qué se actualizó, qué se conservó y qué quedó pendiente, y los errores sin pérdidas', () => {
    const html = render('result', { result: { updated: ['Operaciones subidas: 2'], kept: ['equipo diff: diferencias sin resolver'], pending: ['1 operación(es) en la cola local'], errors: ['Subida incompleta: Red interrumpida'] } })
    expect(html).toContain('Se actualizó')
    expect(html).toContain('Operaciones subidas: 2')
    expect(html).toContain('Se conservó')
    expect(html).toContain('Quedó pendiente')
    expect(html).toContain('Errores (nada se perdió; puedes reintentar)')
    expect(html).toContain('Sincronizar de nuevo')
  })

  it('no ofrece una eliminación genérica de datos locales para «quedar igual que Firebase»', () => {
    for (const step of ['overview', 'proposal', 'confirm', 'result'] as const) {
      expect(render(step)).not.toMatch(/Eliminar datos|Borrar datos|Borrar todo|quedar igual|igual que Firebase|Reemplazar datos locales/i)
    }
  })

  it('durante la comparación y la ejecución muestra el estado de espera', () => {
    expect(render('comparing')).toContain('Comparando con Firebase (solo lectura)')
    expect(render('running')).toContain('Subiendo lo confirmado')
  })
})

describe('conexión en la aplicación: nada se ejecuta al abrir ni sin confirmar', () => {
  const app = readFileSync('src/App.tsx', 'utf8')

  it('executeProposal solo se invoca desde el efecto «run» del flujo y exige la propuesta confirmada', () => {
    const calls = [...app.matchAll(/executeProposal\(/g)]
    expect(calls).toHaveLength(1) // única llamada (la definición es `const executeProposal = useCallback`)
    expect(app).toContain("if (effect === 'run' && proposal) void executeProposal(proposal)")
  })

  it('al abrir la aplicación no se ejecuta sincronización: ningún efecto llama al flujo ni a las acciones de escritura', () => {
    for (const match of app.matchAll(/useEffect\(\(\) => \{([^]*?)\n  \}, \[[^\]]*\]\)/g)) {
      expect(match[1]).not.toMatch(/executeProposal|dispatchFlow|enqueueOwnUploads|synchronize\(|pullCloudData\(/)
    }
  })

  it('antes de cualquier escritura se relee todo y se compara con la propuesta confirmada', () => {
    const start = app.indexOf('const executeProposal = useCallback(')
    const body = app.slice(start, app.indexOf('const dispatchFlow', start))
    const guard = body.indexOf('current.key !== proposal.key')
    expect(guard).toBeGreaterThan(-1)
    for (const write of ['enqueueOwnUploads(', 'pullCloudData(', "scope: 'operations'", "scope: 'photos'"]) expect(body.indexOf(write)).toBeGreaterThan(guard)
    expect(body.indexOf('runRecoveryDiagnostic(')).toBeLessThan(guard)
    expect(body).toContain('no se ejecutó nada')
  })

  it('cada paso es independiente: un error parcial no impide informar el resto ni pierde la cola', () => {
    const start = app.indexOf('const executeProposal = useCallback(')
    const body = app.slice(start, app.indexOf('const dispatchFlow', start))
    expect([...body.matchAll(/try \{/g)].length).toBeGreaterThanOrEqual(5)
    expect(body).toContain("result.errors.push(`Descarga incompleta")
    expect(body).toContain("result.errors.push(`Subida incompleta")
    expect(body).toContain("result.errors.push(`Fotografías incompletas")
    // Tras la ejecución se vuelve a diagnosticar (solo lectura) y el bloqueo general se mantiene.
    expect(body).toContain("reportSync('local', 'Sincronización detenida')")
    expect(body).not.toContain('recoveryHoldRef.current = false')
    for (const forbidden of ['deleteComputer', 'deleteSessionAndComputers', 'replaceAllData', 'claimLocalData', 'clearAllData', 'runSync(']) expect(body).not.toContain(forbidden)
  })

  it('la descarga de la propuesta nunca elimina registros locales', () => {
    const start = app.indexOf('const executeProposal = useCallback(')
    const body = app.slice(start, app.indexOf('const dispatchFlow', start))
    expect(body).toContain('keepLocalRecords: true')
  })
})
