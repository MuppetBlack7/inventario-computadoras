import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { User } from 'firebase/auth'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {}, firebaseAuth: null }))

import { AuthSyncPanel } from './components/AuthSyncPanel'
import { SyncInventoryView } from './components/SyncInventoryView'
import { buildRecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { advance, initialFlow } from './syncFlow'
import { buildProposal, defaultDecisions, summarizeSync } from './syncPlan'
import type { ComputerRecord, InventorySession, SyncQueueItem } from './types'

const user = { uid: 'alice', displayName: 'Alicia', email: 'alice@example.com', photoURL: null } as User
const app = readFileSync('src/App.tsx', 'utf8')

const stamp = '2026-01-01T00:00:00Z'
const session = (ownerId = 'alice', id = 's1'): InventorySession => ({ id, name: 'Sesión', date: '2026-01-01', location: '', ownerId, createdAt: stamp, updatedAt: stamp })
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: '', model: '', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '', scannedAt: '', timezone: '',
  latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice', ownerName: 'Alicia', createdAt: stamp, updatedAt: stamp, ...changes
})
const op = (entityId: string): SyncQueueItem => ({ id: `computer:${entityId}`, operation: 'upsert-computer', entityId, ownerId: 'alice', createdAt: stamp, revision: 'r1' })
const snap = (computers: ComputerRecord[], queue: SyncQueueItem[] = []): RecoverySnapshot => ({ sessions: [session(), session('bob', 's2')], computers, queue })
const remoteOf = (computers: ComputerRecord[]): RemoteRecoverySnapshot => ({ sessions: [session(), session('bob', 's2')], computers })
const report = (local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null) => buildRecoveryReport(local, remote, 'alice', '2026-02-01T00:00:00Z')

const findButton = (node: ReactNode, className: string): ReactElement<{ className?: string; onClick?: (event: unknown) => void; children?: ReactNode }> | undefined => {
  if (Array.isArray(node)) return node.map((child) => findButton(child, className)).find(Boolean)
  if (!isValidElement(node)) return undefined
  const element = node as ReactElement<{ className?: string; onClick?: (event: unknown) => void; children?: ReactNode }>
  return element.props.className?.includes(className) ? element : findButton(element.props.children, className)
}

describe('qué hace el botón «Sincronizar ahora» del menú de perfil', () => {
  it('está conectado a openSyncReview (abrir la revisión), no a una sincronización directa', () => {
    expect(app).toContain('onSync={openSyncReview}')
    expect(app).not.toContain('onSync={() => void runSync(user, true)}')
    const start = app.indexOf('const openSyncReview = () => {')
    const body = app.slice(start, app.indexOf('/** Aplica una acción del flujo', start))
    expect(body).toContain("dispatchFlow({ type: 'sync-now' })")
    expect(body).toContain("setView({ name: 'sync' })")
    for (const forbidden of ['runSync', 'synchronize', 'pullCloudData', 'executeProposal', 'enqueueOwnUploads', 'recoveryHoldRef', 'authorize']) expect(body).not.toContain(forbidden)
  })

  it('el panel avisa de que solo abre la revisión, cierra el menú y llama una sola vez a onSync', () => {
    const onSync = vi.fn()
    const html = renderToStaticMarkup(<AuthSyncPanel configured user={user} status="local" message="Sincronización detenida" pending={0} isSyncing={false} lastSuccessfulAt={null} onLogin={vi.fn()} onLogout={vi.fn()} onSync={onSync} />)
    expect(html).toContain('Sincronizar ahora')
    expect(html).toContain('Abre la revisión de «Sincronizar inventario»: no se escribe nada hasta que confirmes.')
    const panel = AuthSyncPanel({ configured: true, user, status: 'local', message: 'Sincronización detenida', pending: 0, isSyncing: false, lastSuccessfulAt: null, onLogin: vi.fn(), onLogout: vi.fn(), onSync }) as ReactElement
    const button = findButton(panel, 'sync-now-button')!
    const removeAttribute = vi.fn()
    button.props.onClick!({ currentTarget: { closest: () => ({ removeAttribute }) } })
    expect(removeAttribute).toHaveBeenCalledWith('open')
    expect(onSync).toHaveBeenCalledTimes(1)
  })

  it('su primera consecuencia es una comparación de solo lectura; ningún efecto de escritura sale de esa acción', () => {
    const result = advance(initialFlow(), { type: 'sync-now' })
    expect(result.effect).toBe('compare')
    expect(result.state.step).toBe('comparing')
    // Aunque estuviera en medio de una confirmación, el botón nunca produce una escritura.
    for (const step of ['overview', 'comparing', 'proposal', 'confirm', 'running', 'result'] as const) {
      expect(advance({ ...initialFlow(), step }, { type: 'sync-now' }).effect).not.toBe('run')
    }
  })

  it('al abrir la sección solo se compara en lectura, sin repetir la comparación que ya inició el botón', () => {
    expect(app).toContain("flowRef.current.step === 'overview' || flowRef.current.step === 'result'")
    const effect = app.slice(app.indexOf("// Abrir «Sincronizar inventario» solo compara en lectura"))
    const body = effect.slice(0, effect.indexOf('}, [view.name'))
    expect(body).toContain('void compareNow()')
    for (const forbidden of ['executeProposal', 'synchronize(', 'pullCloudData(', 'enqueueOwnUploads', 'runSync']) expect(body).not.toContain(forbidden)
  })

  it('el menú de perfil ya no puede iniciar una sincronización completa: toda escritura exige la confirmación del flujo', () => {
    const calls = [...app.matchAll(/runSync\(user, true\)/g)]
    expect(calls).toHaveLength(1) // solo syncAfterRestore (restauraciones), nunca el botón de perfil
    expect(app).toContain("if (effect === 'run' && proposal) void executeProposal(proposal)")
  })
})

describe('«Todo está al día» no inicia una sincronización innecesaria', () => {
  const local = snap([computer('a'), computer('b')])
  const remote = remoteOf([computer('a'), computer('b')])

  it('con todo al día la propuesta no tiene nada que ejecutar y el botón de confirmar está deshabilitado', () => {
    const proposal = buildProposal(local, remote, report(local, remote), defaultDecisions(), { imageKitConfigured: true })
    expect(proposal).toMatchObject({ allowed: false, runDownload: false, runUpload: false, runPhotos: false })
    expect(proposal.enqueueIds).toEqual([])
    const flow = { ...initialFlow(), step: 'confirm' as const }
    const html = renderToStaticMarkup(<SyncInventoryView report={report(local, remote)} local={local} remote={remote} online imageKitConfigured flow={flow} onFlow={() => undefined} onBack={() => undefined} onAuthorize={() => undefined} onRetry={() => undefined} />)
    expect(html).toContain('Todo está al día')
    expect(html).toMatch(/<button class="danger-button"[^>]*disabled=""[^>]*>Confirmar y sincronizar<\/button>/)
  })

  it('la vista general también dice «Todo está al día» sin proponer ni ofrecer ejecutar nada', () => {
    const html = renderToStaticMarkup(<SyncInventoryView report={report(local, remote)} local={local} remote={remote} online imageKitConfigured flow={initialFlow()} onFlow={() => undefined} onBack={() => undefined} onAuthorize={() => undefined} onRetry={() => undefined} />)
    expect(html).toContain('Todo está al día')
    expect(html).not.toContain('Confirmar y sincronizar')
  })
})

describe('el estado de sincronización detenida no se presenta como un error', () => {
  it('usa el estado neutro «local» y un texto sin «error» ni «Recuperación pendiente»', () => {
    for (const message of [...app.matchAll(/reportSync\('local', '(Sincronización detenida)'\)/g)]) expect(message[1]).toBe('Sincronización detenida')
    expect([...app.matchAll(/reportSync\('local', 'Sincronización detenida'\)/g)].length).toBeGreaterThanOrEqual(3)
    expect(app).not.toContain('Recuperación pendiente')
    // Solo los fallos reales usan el estado «error».
    expect(app).not.toMatch(/reportSync\('error', 'Sincronización detenida'/)
  })

  it('el menú de perfil muestra el estado detenido con el indicador «local» (no el de error)', () => {
    const html = renderToStaticMarkup(<AuthSyncPanel configured user={user} status="local" message="Sincronización detenida" pending={2} isSyncing={false} lastSuccessfulAt={null} onLogin={vi.fn()} onLogout={vi.fn()} onSync={vi.fn()} />)
    expect(html).toContain('sync-dot status-local')
    expect(html).not.toContain('status-error')
    expect(html).toContain('Sincronización detenida')
    expect(html).not.toMatch(/Recuperación pendiente|Error/)
  })

  it('el aviso de sincronización detenida tampoco usa el estilo de error salvo que haya un problema real', () => {
    const css = readFileSync('src/styles.css', 'utf8')
    expect(css).toMatch(/\.sync-dot\.status-local[^{]*\{[^}]*#d69e2e/)
  })
})

describe('las 2 fotografías de otra cuenta no bloquean operaciones propias seguras', () => {
  const stuck = ['0150430', '0447137'].map((id) => computer(`stuck-${id}`, { ownerId: 'bob', ownerName: 'Su amigo', photoStoredLocally: true }))
  const own = computer('mine')
  const local = snap([own, ...stuck], [op('mine')])
  const remote = remoteOf([computer('mine'), ...stuck])

  it('la propuesta sigue permitida: sube mi operación y deja las dos fotos como advertencia', () => {
    const proposal = buildProposal(local, remote, report(local, remote), defaultDecisions(), { imageKitConfigured: true })
    expect(proposal.allowed).toBe(true)
    expect(proposal.steps.upload.map((item) => item.id)).toEqual(['mine'])
    const everything = [...proposal.steps.enqueue, ...proposal.steps.download, ...proposal.steps.upload, ...proposal.steps.photos].map((item) => item.id)
    expect(everything.some((id) => id.startsWith('stuck-'))).toBe(false)
    expect(proposal.kept.filter((item) => item.id.startsWith('stuck-')).map((item) => item.detail)).toEqual(['fotografía de otra cuenta: solo su propietario puede subirla', 'fotografía de otra cuenta: solo su propietario puede subirla'])
  })

  it('no se marcan como recuperadas: siguen apareciendo como pendientes de otra cuenta', () => {
    const overview = summarizeSync(local, remote, report(local, remote), true)
    expect(overview.photos.otherAccount.map((item) => item.ownerName)).toEqual(['Su amigo', 'Su amigo'])
    expect(overview.photos.ownPending).toEqual([])
    const html = renderToStaticMarkup(<SyncInventoryView report={report(local, remote)} local={local} remote={remote} online imageKitConfigured flow={initialFlow()} onFlow={() => undefined} onBack={() => undefined} onAuthorize={() => undefined} onRetry={() => undefined} />)
    expect(html).toContain('No se marca como recuperada')
    expect(html).toContain('no impide las demás operaciones')
    expect(stuck.every((item) => !item.photo && !item.photoRemote)).toBe(true)
  })
})
