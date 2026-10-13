import type { User } from 'firebase/auth'
import type { SyncStatus } from '../types'
import type { SyncDisplay } from '../syncDisplay'

interface Props {
  configured: boolean
  user: User | null
  status: SyncStatus
  message: string
  display?: SyncDisplay
  pending: number
  isSyncing: boolean
  lastSuccessfulAt: string | null
  onLogin: () => void
  onLogout: () => void
  onSync: () => void
}

export function AuthSyncPanel({ configured, user, status, message, display, pending, isSyncing, lastSuccessfulAt, onLogin, onLogout, onSync }: Props) {
  if (!configured) return <div className="sync-chip status-local"><span />Firebase pendiente</div>
  if (!user) return <button className="auth-button" onClick={onLogin}><span className="google-mark">G</span> Iniciar sesión</button>
  const title = display?.title || message
  const detail = display?.detail || (pending ? `${pending} pendiente${pending === 1 ? '' : 's'}` : 'Sin operaciones pendientes')
  const tone = display?.tone || status
  return (
    <details className="account-menu">
      <summary>
        {user.photoURL ? <img src={user.photoURL} alt="" /> : <span className="avatar-fallback">{(user.displayName || 'U')[0]}</span>}
        <span className={`sync-dot status-${tone}`} />
        <span className="account-copy"><strong>{title}</strong><small>{display ? detail : pending ? `${pending} pendiente${pending === 1 ? '' : 's'}` : user.displayName || 'Cuenta Google'}</small></span>
      </summary>
      <div className="account-popover">
        <strong>{user.displayName || 'Cuenta Google'}</strong>
        <span>{user.email}</span>
        <div className={`sync-detail status-${tone}`} role="status" aria-live="polite">
          <span className="sync-dot" />
          <div><strong>{title}</strong><small>{display ? detail : pending ? `${pending} ${pending === 1 ? 'operación pendiente' : 'operaciones pendientes'}` : 'Sin operaciones pendientes'}</small></div>
        </div>
        {display?.warning && <p className="inline-note warning-box" role="note">{display.warning}</p>}
        {lastSuccessfulAt && <small className="last-sync-time">Última actualización correcta: {new Date(lastSuccessfulAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}</small>}
        <button className="secondary-button full-width sync-now-button" disabled={isSyncing} aria-busy={isSyncing} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onSync() }}>
          {isSyncing && <span className="button-spinner" aria-hidden="true" />}
          {isSyncing ? 'Sincronizando…' : 'Sincronizar ahora'}
        </button>
        <small className="sync-now-hint">Abre la revisión de «Sincronizar inventario»: no se escribe nada hasta que confirmes.</small>
        <button className="text-button full-width" onClick={onLogout}>Cerrar sesión</button>
      </div>
    </details>
  )
}
