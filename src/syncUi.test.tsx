import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { User } from 'firebase/auth'
import { AuthSyncPanel } from './components/AuthSyncPanel'

const user = {
  uid: 'alice',
  displayName: 'Alicia',
  email: 'alice@example.com',
  photoURL: null
} as User

describe('estado visible de sincronización', () => {
  it('deshabilita el botón y muestra pendientes mientras sincroniza', () => {
    const html = renderToStaticMarkup(<AuthSyncPanel
      configured user={user} status="syncing" message="Sincronizando…" pending={3}
      isSyncing lastSuccessfulAt="2026-10-12T10:00:00.000Z"
      onLogin={vi.fn()} onLogout={vi.fn()} onSync={vi.fn()}
    />)
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Sincronizando…')
    expect(html).toContain('3 operaciones pendientes')
    expect(html).toContain('Última actualización correcta')
  })

  it('habilita Sincronizar ahora cuando termina', () => {
    const html = renderToStaticMarkup(<AuthSyncPanel
      configured user={user} status="synced" message="Sincronizado" pending={0}
      isSyncing={false} lastSuccessfulAt={null}
      onLogin={vi.fn()} onLogout={vi.fn()} onSync={vi.fn()}
    />)
    expect(html).toContain('Sincronizar ahora')
    expect(html).not.toContain('aria-busy="true"')
    expect(html).not.toContain('disabled=""')
  })
})
