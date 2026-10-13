import 'fake-indexeddb/auto'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), getDocsFromServer: vi.fn() }))
vi.mock('./firebaseClient', () => ({ firestore: {}, firebaseAuth: null }))

import { buildRecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { SyncInventoryView } from './components/SyncInventoryView'
import { initialFlow } from './syncFlow'
import { buildProposal, defaultDecisions, describeDifferences, explainNoOperations } from './syncPlan'
import type { ComputerRecord, InventorySession } from './types'

const stamp = '2026-01-01T00:00:00Z'
const session = (ownerId = 'alice', id = 's1'): InventorySession => ({ id, name: 'Sesión', date: '2026-01-01', location: '', ownerId, createdAt: stamp, updatedAt: stamp })
const computer = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: 'Dell', model: 'Optiplex', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: null, drives: [], originalCode: '', scannedAt: '', timezone: '',
  latitude: null, longitude: null, accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice', ownerName: 'Alicia', createdAt: stamp, updatedAt: stamp, ...changes
})
const photo = { fileId: 'f1', url: 'https://ik.example/f1.jpg', filePath: '/inventario/bob/f1.jpg', name: 'f1.jpg', size: 3, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: stamp }

// Dos diferencias: un equipo mío con notas distintas y un equipo de otra cuenta cuyo propietario ya subió la fotografía.
const local: RecoverySnapshot = { sessions: [session()], computers: [computer('mine', { notes: 'local' }), computer('theirs', { ownerId: 'bob', ownerName: 'Su amigo', photoStoredLocally: true })], queue: [] }
const remote: RemoteRecoverySnapshot = { sessions: [session()], computers: [computer('mine', { notes: 'firebase' }), computer('theirs', { ownerId: 'bob', ownerName: 'Su amigo', photoRemote: photo })] }
const report = buildRecoveryReport(local, remote, 'alice', '2026-02-01T00:00:00Z')

describe('dos conflictos sin operaciones ejecutables', () => {
  const proposal = buildProposal(local, remote, report, defaultDecisions(), { imageKitConfigured: true })

  it('por defecto no hay nada ejecutable porque conservar la versión local no escribe; no se habilita artificialmente', () => {
    expect(report.rows.filter((row) => row.differences.length).length).toBe(2)
    expect(proposal.allowed).toBe(false)
    expect(proposal.steps.upload).toEqual([])
    expect(proposal.steps.photos).toEqual([])
    expect(proposal.kept.filter((item) => item.detail?.startsWith('diferencias sin resolver')).length).toBe(2)
  })

  it('cada conflicto describe el equipo, el propietario, los valores de ambos lados y las opciones seguras', () => {
    const details = describeDifferences(local, remote, report)
    expect(details).toHaveLength(2)
    const mine = details.find((item) => item.id === 'mine')!
    expect(mine.title).toContain('INV-mine')
    expect(mine.ownerName).toBe('tú')
    expect(mine.fields).toEqual([{ field: 'notes', label: 'Notas', local: 'local', remote: 'firebase' }])
    expect(mine.options.map((option) => [option.choice, option.available])).toEqual([['keep-local', true], ['use-remote', true], ['upload-mine', true]])
    const theirs = details.find((item) => item.id === 'theirs')!
    expect(theirs.ownerName).toBe('Su amigo')
    expect(theirs.fields[0]).toMatchObject({ field: 'photoRemote', local: 'sin fotografía subida' })
    expect(theirs.fields[0].remote).toContain('f1.jpg')
    const upload = theirs.options.find((option) => option.choice === 'upload-mine')!
    expect(upload.available).toBe(false)
    expect(upload.reason).toContain('solo su propietario')
    expect(theirs.options.find((option) => option.choice === 'use-remote')!.effect).toContain('Firebase, los propietarios y las fotografías locales no se tocan')
  })

  it('explica por qué no hay nada que ejecutar y avisa de que los datos siguen a salvo', () => {
    const reasons = explainNoOperations(proposal, describeDifferences(local, remote, report))
    expect(reasons[0]).toContain('2 registros tienen cambios distintos')
    expect(reasons.join(' ')).toContain('1 es de otra cuenta')
    expect(reasons.join(' ')).toContain('no se pierde nada')
    expect(explainNoOperations({ ...proposal, allowed: true }, [])).toEqual([])
  })

  it('elegir resolver el registro ajeno con Firebase habilita solo descargar esa copia local; el mío no sube sin elegirlo', () => {
    const chosen = buildProposal(local, remote, report, { ...defaultDecisions(), perRecord: { theirs: 'use-remote' } }, { imageKitConfigured: true })
    expect(chosen.allowed).toBe(true)
    expect(chosen.steps.download.map((item) => item.id)).toEqual(['theirs'])
    expect(chosen.steps.upload).toEqual([])
    expect(chosen.enqueueIds).toEqual([])
    const forced = buildProposal(local, remote, report, { ...defaultDecisions(), perRecord: { theirs: 'upload-mine' } }, { imageKitConfigured: true })
    expect(forced.allowed).toBe(false)
    expect(forced.enqueueIds).toEqual([])
  })

  it('la pantalla muestra las dos tarjetas, la explicación, el botón deshabilitado y solo el botón principal', () => {
    const html = renderToStaticMarkup(<SyncInventoryView report={report} local={local} remote={remote} online imageKitConfigured flow={{ ...initialFlow(), step: 'proposal' }}
      onFlow={() => undefined} onBack={() => undefined} onAuthorize={() => undefined} onRetry={() => undefined} />)
    expect(html).toContain('Equipo INV-mine')
    expect(html).toContain('Equipo INV-theirs')
    expect(html).toContain('en este dispositivo: «local» · en Firebase: «firebase»')
    expect(html).toContain('Subir mi versión</strong> (no disponible: es un registro de Su amigo')
    expect(html).toContain('¿Por qué no hay nada que ejecutar?')
    expect(html).toContain('No hay nada que sincronizar con las opciones elegidas')
    expect(html).toMatch(/<button class="primary-button big-action"[^>]*disabled=""[^>]*>Revisar y confirmar<\/button>/)
    // La salida es la navegación inferior de la aplicación; la propuesta solo tiene el botón principal.
    expect(html).not.toContain('>Volver al inventario</button>')
    expect(html).not.toContain('>Volver</button>')
  })
})
