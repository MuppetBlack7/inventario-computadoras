import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { User } from 'firebase/auth'
import { AuthSyncPanel } from './components/AuthSyncPanel'
import { SyncInventoryView } from './components/SyncInventoryView'
import { computeSyncDisplay, MAX_VERIFICATION_AGE_MS, type SyncDisplayInput } from './syncDisplay'
import { initialFlow } from './syncFlow'
import type { RecoveryReport } from './recovery'

const now = Date.parse('2026-10-12T20:00:00Z')
const report = (changes: Partial<RecoveryReport> = {}): RecoveryReport => ({
  generatedAt: new Date(now - 60_000).toISOString(), accountId: 'alice', remoteAvailable: true,
  rows: [], counts: {} as RecoveryReport['counts'], ownership: {} as RecoveryReport['ownership'],
  localCounts: { sessions: 0, computers: 0, queue: 0 }, writesEnabled: false, ...changes
})
const input = (changes: Partial<SyncDisplayInput> = {}): SyncDisplayInput => ({
  online: true, paused: true, pending: 0, failedOperations: 0, photoProblems: 0,
  syncStatus: 'local', report: report(), now, ...changes
})

describe('estado visible de sincronización', () => {
  it('dice Sincronizado y a la vez informa que la sincronización automática está pausada', () => {
    const state = computeSyncDisplay(input())
    expect(state).toMatchObject({ title: 'Sincronizado', dataCurrent: true, paused: true })
    expect(state.detail).toContain('Sincronización pausada')
    expect(state.detail).toContain('datos al día')
  })
  it('no confunde pausa con datos desactualizados cuando la automática está activa', () => {
    const state = computeSyncDisplay(input({ paused: false }))
    expect(state.title).toBe('Sincronizado')
    expect(state.detail).toContain('automática activa')
  })
  it('muestra Cambios pendientes para operaciones locales sin enviar', () => {
    const state = computeSyncDisplay(input({ pending: 2 }))
    expect(state.title).toBe('Cambios pendientes')
    expect(state.dataCurrent).toBe(false)
  })
  it('da prioridad a Sin conexión y conserva el conteo pendiente', () => {
    const state = computeSyncDisplay(input({ online: false, pending: 1 }))
    expect(state.title).toBe('Sin conexión')
    expect(state.detail).toContain('1 cambio pendiente')
  })
  it('dice Estado remoto sin verificar si internet funciona pero falló la consulta remota', () => {
    const state = computeSyncDisplay(input({ report: report({ remoteAvailable: false }) }))
    expect(state.title).toBe('Estado remoto sin verificar')
    expect(state.dataCurrent).toBe(false)
  })
  it('no afirma Sincronizado sin una comparación reciente', () => {
    const stale = report({ generatedAt: new Date(now - MAX_VERIFICATION_AGE_MS - 1).toISOString() })
    expect(computeSyncDisplay(input({ report: stale })).title).toBe('Sincronización pausada')
    expect(computeSyncDisplay(input({ report: undefined })).dataCurrent).toBe(false)
    expect(computeSyncDisplay(input({ invalidated: true })).dataCurrent).toBe(false)
  })
  it('no afirma Sincronizado con errores o conflictos', () => {
    expect(computeSyncDisplay(input({ failedOperations: 1 })).dataCurrent).toBe(false)
    expect(computeSyncDisplay(input({ syncStatus: 'error' })).dataCurrent).toBe(false)
    const conflict = report({ rows: [{ categories: ['manual-review'] }] as RecoveryReport['rows'] })
    expect(computeSyncDisplay(input({ report: conflict })).title).toBe('Revisión necesaria')
    const photo = report({ rows: [{ categories: ['photo-pending', 'own-record'] }] as RecoveryReport['rows'] })
    expect(computeSyncDisplay(input({ report: photo })).title).toBe('Cambios pendientes')
  })
  it('muestra el mismo estado en el resumen y el menú del perfil', () => {
    const display = computeSyncDisplay(input())
    const user = { uid: 'alice', displayName: 'Alicia', email: 'alice@example.com', photoURL: null } as User
    const html = renderToStaticMarkup(<AuthSyncPanel configured user={user} status="local" message="Sincronización detenida" display={display} pending={0} isSyncing={false} lastSuccessfulAt={null} onLogin={vi.fn()} onLogout={vi.fn()} onSync={vi.fn()} />)
    expect(html).toContain('Sincronizado')
    expect(html).toContain('Sincronización pausada · datos al día')
    expect(html).not.toContain('Sincronización detenida')
    const screen = renderToStaticMarkup(<SyncInventoryView report={report()} local={{ sessions: [], computers: [], queue: [] }} remote={{ sessions: [], computers: [] }} online display={display} imageKitConfigured flow={initialFlow()} onFlow={vi.fn()} onBack={vi.fn()} onAuthorize={vi.fn()} onRetry={vi.fn()} />)
    expect(screen).toContain('Sincronizado')
    expect(screen).toContain('Sincronización pausada · datos al día')
  })

  describe('fotografías de otras cuentas', () => {
    const foreign = () => report({ rows: [{ categories: ['photo-pending', 'other-account-record'], localId: 'a', differences: [], pending: [], kind: 'computer', photo: { local: false, needsUpload: false, remoteReferenceMissing: false }, proposal: 'no-action' }, { categories: ['photo-pending', 'other-account-record'], localId: 'b', differences: [], pending: [], kind: 'computer', photo: { local: false, needsUpload: false, remoteReferenceMissing: false }, proposal: 'no-action' }] as unknown as RecoveryReport['rows'] })
    it('no cuentan como cambios pendientes propios: salen como advertencia independiente', () => {
      const state = computeSyncDisplay(input({ report: foreign() }))
      expect(state.title).toBe('Sincronizado')
      expect(state.title).not.toBe('Cambios pendientes')
      expect(state.detail).not.toContain('fotos pendientes')
      expect(state.foreignPhotos).toBe(2)
      expect(state.warning).toContain('otras cuentas')
    })
    it('las fotografías propias sí son cambios pendientes', () => {
      const own = report({ rows: [{ categories: ['photo-pending', 'own-record'] }, { categories: ['photo-pending', 'other-account-record'] }] as RecoveryReport['rows'] })
      const state = computeSyncDisplay(input({ report: own }))
      expect(state.title).toBe('Cambios pendientes')
      expect(state.detail).toContain('1 fotos pendientes')
      expect(state.foreignPhotos).toBe(1)
    })
    it('sin operaciones propias y en pausa sin comparación válida dice Sincronización pausada, nunca Cambios pendientes', () => {
      const state = computeSyncDisplay(input({ report: undefined }))
      expect(state.title).toBe('Sincronización pausada')
      const withForeign = computeSyncDisplay(input({ invalidated: true, report: foreign() }))
      expect(withForeign.title).toBe('Sincronización pausada')
      expect(withForeign.foreignPhotos).toBe(2)
    })
    it('si Firebase no se pudo consultar no dice Sincronizado', () => {
      const state = computeSyncDisplay(input({ report: report({ remoteAvailable: false, rows: foreign().rows }) }))
      expect(state.title).toBe('Estado remoto sin verificar')
      expect(state.dataCurrent).toBe(false)
    })
    it('el menú del perfil y la pantalla principal muestran el mismo resultado y la misma advertencia', () => {
      const rep = foreign()
      const display = computeSyncDisplay(input({ report: rep }))
      const user = { uid: 'alice', displayName: 'Alicia', email: 'alice@example.com', photoURL: null } as User
      const menu = renderToStaticMarkup(<AuthSyncPanel configured user={user} status="local" message="x" display={display} pending={0} isSyncing={false} lastSuccessfulAt={null} onLogin={vi.fn()} onLogout={vi.fn()} onSync={vi.fn()} />)
      const screen = renderToStaticMarkup(<SyncInventoryView report={rep} local={{ sessions: [], computers: [], queue: [] }} remote={{ sessions: [], computers: [] }} online display={display} imageKitConfigured flow={initialFlow()} onFlow={vi.fn()} onBack={vi.fn()} onAuthorize={vi.fn()} onRetry={vi.fn()} />)
      for (const html of [menu, screen]) { expect(html).toContain(display.title); expect(html).toContain(display.detail) }
      expect(menu).toContain(display.warning!)
      expect(menu).not.toContain('Cambios pendientes')
      expect(screen).not.toContain('Cambios pendientes')
    })
    it('el cálculo no cuenta la cola de otras cuentas en la pantalla sin display explícito', () => {
      const queue = [{ id: 'computer:z', operation: 'upsert-computer', entityId: 'z', ownerId: 'bob', createdAt: '', revision: 'r' }] as never
      const screen = renderToStaticMarkup(<SyncInventoryView report={report()} local={{ sessions: [], computers: [], queue }} remote={{ sessions: [], computers: [] }} online imageKitConfigured flow={initialFlow()} onFlow={vi.fn()} onBack={vi.fn()} onAuthorize={vi.fn()} onRetry={vi.fn()} />)
      expect(screen).not.toContain('Cambios pendientes')
    })
  })
})
