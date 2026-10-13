import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {}, firebaseAuth: null }))

import { buildRecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { SyncInventoryView } from './components/SyncInventoryView'
import { initialFlow, type FlowStep } from './syncFlow'
import { defaultDecisions, isUpToDate, summarizeSync, type SyncDecisions } from './syncPlan'
import { afterDiagnostic, appUsable, authorizeRecovery, CHECKING, keepSyncStopped, mergeDiagnostic, syncAllowed } from './recoveryState'
import type { ComputerRecord, InventorySession, SyncQueueItem } from './types'

const stamp = '2026-01-01T00:00:00Z'
const session = (ownerId = 'alice', id = 's1'): InventorySession => ({ id, name: 'Sesión', date: '2026-01-01', location: '', ownerId, createdAt: stamp, updatedAt: stamp })
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: '', model: '', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '', scannedAt: '', timezone: '',
  latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice', ownerName: 'Alicia', createdAt: stamp, updatedAt: stamp, ...changes
})
const op = (entityId: string): SyncQueueItem => ({ id: `computer:${entityId}`, operation: 'upsert-computer', entityId, ownerId: 'alice', createdAt: stamp, revision: 'r1' })
const snap = (computers: ComputerRecord[], queue: SyncQueueItem[] = []): RecoverySnapshot => ({ sessions: [session()], computers, queue })
const remoteOf = (computers: ComputerRecord[]): RemoteRecoverySnapshot => ({ sessions: [session()], computers })
const steps: FlowStep[] = ['overview', 'comparing', 'proposal', 'confirm', 'running', 'result']

const render = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, step: FlowStep, decisions: SyncDecisions = defaultDecisions(), online = true) => {
  const report = buildRecoveryReport(local, remote, 'alice', '2026-02-01T00:00:00Z')
  return renderToStaticMarkup(<SyncInventoryView report={report} local={local} remote={remote} online={online} imageKitConfigured flow={{ ...initialFlow(), step, decisions }}
    onFlow={() => undefined} onBack={() => undefined} onAuthorize={() => undefined} onRetry={() => undefined} />)
}

// Todo al día: mismos registros en ambos lados, sin cola ni fotos pendientes.
const clean = () => ({ local: snap([computer('a'), computer('b')]), remote: remoteOf([computer('a'), computer('b')]) })
const pending = () => ({ local: snap([computer('a'), computer('only-local')], [op('only-local')]), remote: remoteOf([computer('a')]) })

describe('siempre se puede volver al inventario', () => {
  const exit = /<button class="(?:primary-button|secondary-button)(?: big-action)?"[^>]*>(?:Volver al inventario|Seguir trabajando sin conexión)<\/button>/

  it('no hay botón superior junto al encabezado; en cada paso queda otra salida habilitada hacia el inventario', () => {
    for (const data of [clean(), pending()]) {
      for (const step of steps) {
        const html = render(data.local, data.remote, step)
        expect(html, `paso ${step}`).not.toContain('back-to-inventory')
        expect(html).not.toContain('← Volver al inventario')
        const button = html.match(exit)
        if (step === 'proposal') { expect(button, 'la propuesta solo conserva «Revisar y confirmar»; se vuelve con la navegación inferior').toBeNull(); continue }
        expect(button, `paso ${step}`).not.toBeNull()
        expect(button![0]).not.toContain('disabled')
      }
    }
  })

  it('la navegación inferior sigue siempre disponible para volver', () => {
    const app = readFileSync('src/App.tsx', 'utf8')
    expect(app).toContain('{user && appUsable(recovery) && <BottomNav')
    expect(app).toContain('viewForNav(key, currentSessionId)')
  })

  it('sin lectura remota o sin conexión también se puede volver', () => {
    for (const step of steps.filter((item) => item !== 'proposal')) {
      expect(render(clean().local, null, step)).toMatch(/Volver al inventario|Seguir trabajando sin conexión/)
      expect(render(clean().local, clean().remote, step, defaultDecisions(), false)).toMatch(/Volver al inventario|Seguir trabajando sin conexión/)
    }
  })

  it('con la propuesta vacía muestra «Todo está al día» y un botón «Volver al inventario»', () => {
    const { local, remote } = clean()
    expect(isUpToDate(summarizeSync(local, remote, buildRecoveryReport(local, remote, 'alice'), true))).toBe(true)
    for (const step of ['overview', 'proposal', 'confirm'] as const) {
      const html = render(local, remote, step)
      expect(html).toContain('Todo está al día')
      if (step !== 'proposal') expect(html).toContain('>Volver al inventario</button>')
    }
    const proposal = render(local, remote, 'proposal')
    expect(proposal).not.toContain('No hay nada que sincronizar con las opciones elegidas')
    expect(proposal).toMatch(/<button class="primary-button big-action"[^>]*disabled=""[^>]*>Revisar y confirmar<\/button>/) // no hay nada que confirmar
  })

  it('con cambios pendientes no dice «Todo está al día»; si las opciones elegidas excluyen todo, lo explica y deja volver', () => {
    const { local, remote } = pending()
    expect(render(local, remote, 'overview')).not.toContain('Todo está al día')
    const keepAll = render(local, remote, 'proposal', { ...defaultDecisions(), uploadMyChanges: false, localOnly: 'keep' })
    expect(keepAll).not.toContain('Todo está al día')
    expect(keepAll).toContain('No hay nada que sincronizar con las opciones elegidas')
    expect(keepAll).not.toContain('>Volver al inventario</button>')
    expect(keepAll).not.toContain('>Volver</button>')
    expect(keepAll).toMatch(/<button class="primary-button big-action"[^>]*disabled=""[^>]*>Revisar y confirmar<\/button>/)
  })

  it('en la propuesta solo queda «Revisar y confirmar»; en la confirmación se conservan Volver y Volver al inventario', () => {
    const { local, remote } = pending()
    const proposal = render(local, remote, 'proposal')
    expect(proposal.match(/>Revisar y confirmar<\/button>/g)).toHaveLength(1)
    expect(proposal).not.toContain('>Volver</button>')
    expect(proposal).not.toContain('>Volver al inventario</button>')
    const confirm = render(local, remote, 'confirm')
    expect(confirm).toContain('>Volver</button>')
    expect(confirm).toContain('>Volver al inventario</button>')
    expect(confirm).toContain('Confirmar y sincronizar')
  })

  it('el resultado también ofrece volver al inventario', () => {
    const html = render(pending().local, pending().remote, 'result')
    expect(html).toContain('>Volver al inventario</button>')
    expect(html).toContain('Volver al resumen')
  })

  it('«Todo está al día» ignora lo que no requiere acción: registros y fotos de otras cuentas son solo advertencias', () => {
    const local = snap([computer('a'), computer('theirs', { ownerId: 'bob', photoStoredLocally: true })])
    const remote = remoteOf([computer('a'), computer('theirs', { ownerId: 'bob', photoStoredLocally: true })])
    expect(isUpToDate(summarizeSync(local, remote, buildRecoveryReport(local, remote, 'alice'), true))).toBe(true)
    expect(render(local, remote, 'overview')).toContain('esa cuenta debe recuperarla')
    expect(isUpToDate(summarizeSync(local, remote, buildRecoveryReport(local, remote, 'alice'), false))).toBe(false) // sin conexión no se puede afirmar
    expect(isUpToDate(summarizeSync(local, null, buildRecoveryReport(local, null, 'alice'), true))).toBe(false)
  })
})

describe('el estado de recuperación nunca bloquea el inventario', () => {
  const local: RecoverySnapshot = { sessions: [], computers: [], queue: [] }
  const report = buildRecoveryReport(local, { sessions: [], computers: [] }, 'alice')

  it('el inventario es utilizable en todas las fases y la sincronización sigue sin autorizarse sola', () => {
    const server = { sessions: [], computers: [] }
    for (const state of [CHECKING, afterDiagnostic(report, local, server, true), afterDiagnostic(report, local, server, false), keepSyncStopped(afterDiagnostic(report, local, server, false))]) {
      expect(appUsable(state)).toBe(true)
      expect(syncAllowed(state)).toBe(false)
    }
  })

  it('una comparación de solo lectura conserva la autorización existente y no autoriza nada por sí sola', () => {
    const server = { sessions: [], computers: [] }
    const ready = afterDiagnostic(report, local, server, false)
    const authorized = authorizeRecovery(ready, 'alice')
    expect(syncAllowed(authorized)).toBe(true)
    expect(syncAllowed(mergeDiagnostic(authorized, report, local, server, true))).toBe(true) // no se revoca
    expect(mergeDiagnostic(authorized, report, local, server, true).phase).toBe('authorized')
    expect(mergeDiagnostic(CHECKING, report, local, server, false).phase).toBe('ready') // no se autoriza
    expect(syncAllowed(mergeDiagnostic(CHECKING, report, local, server, false))).toBe(false)
    expect(mergeDiagnostic(ready, report, local, server, true).phase).toBe('review')
    expect(mergeDiagnostic(keepSyncStopped(ready), report, local, server, false).phase).toBe('local-only')
  })
})

describe('navegación en la aplicación', () => {
  const app = readFileSync('src/App.tsx', 'utf8')

  it('«Sincronizar inventario» es una vista independiente con su propio acceso, y el inventario nunca depende del estado de recuperación', () => {
    expect(app).toContain("| { name: 'sync' }")
    expect(app).toContain('viewForNav(key, currentSessionId)')
    expect(app).toContain("view.name === 'sync' && (recovery.report && recovery.local")
    // La pantalla principal no está condicionada por la fase de recuperación.
    expect(app).not.toMatch(/recovery\.phase === 'checking' \? \(/)
    expect(app).not.toMatch(/recovery\.phase === 'review' \|\| recovery\.phase === 'ready'\) && recovery\.report/)
    expect(app).toContain('{user && appUsable(recovery) && <BottomNav')
  })

  it('la vista de sincronización siempre ofrece volver, también cuando no hay datos de comparación', () => {
    const view = app.slice(app.indexOf("view.name === 'sync' && (recovery.report"), app.indexOf("{view.name === 'sessions' && <SessionsScreen"))
    expect(view).toContain("onBack={() => setView({ name: 'sessions' })}")
    expect(view).not.toContain('back-to-inventory')
    expect(view.match(/Volver al inventario/g)!.length).toBeGreaterThanOrEqual(1)
    expect(view).toContain('Reintentar comparación')
  })

  it('con la sincronización detenida se avisa sin bloquear, con acceso directo a «Sincronizar inventario»', () => {
    expect(app).not.toContain('puedes registrar, editar y consultar equipos con normalidad')
    expect(app).not.toContain('Abrir «Sincronizar inventario»</button>')
    expect(app).toContain('<SyncAlertBar alert={syncAlert}')
  })

  it('el inventario se abre antes del diagnóstico y abrir la sección solo compara en lectura', () => {
    expect(app).toMatch(/await refresh\(nextUser\.uid\)\r?\n\s+void inspectRecovery\(nextUser\.uid\)/)
    const effect = app.slice(app.indexOf("// Abrir «Sincronizar inventario» solo compara en lectura"))
    const body = effect.slice(0, effect.indexOf('}, [view.name'))
    expect(body).toContain('void compareNow()')
    for (const forbidden of ['executeProposal', 'enqueueOwnUploads', 'synchronize(', 'pullCloudData(', 'runSync', 'recoveryHoldRef']) expect(body).not.toContain(forbidden)
    const compare = app.slice(app.indexOf('const compareNow = useCallback('), app.indexOf('const executeProposal = useCallback('))
    for (const forbidden of ['recoveryHoldRef', 'synchronize(', 'pullCloudData(', 'enqueueOwnUploads']) expect(compare).not.toContain(forbidden)
    expect(compare).toContain('mergeDiagnostic(')
  })

  it('ni la comparación ni la ejecución revocan o conceden la autorización de sincronización', () => {
    const start = app.indexOf('const compareNow = useCallback(')
    const region = app.slice(start, app.indexOf('/** Aplica una acción del flujo'))
    expect(region).not.toMatch(/setRecovery\(afterDiagnostic/)
    expect([...app.matchAll(/recoveryHoldRef\.current = false/g)]).toHaveLength(1)
  })
})
