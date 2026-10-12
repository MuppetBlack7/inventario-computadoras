import type { User } from 'firebase/auth'
import type { SyncStatus } from '../types'

interface Props {
  configured: boolean
  user: User | null
  status: SyncStatus
  message: string
  pending: number
  isSyncing: boolean
  lastSuccessfulAt: string | null
  onLogin: () => void
  onLogout: () => void
  onSync: () => void
}

export function AuthSyncPanel({ configured, user, status, message, pending, isSyncing, lastSuccessfulAt, onLogin, onLogout, onSync }: Props) {
  if (!configured) return <div className="sync-chip status-local"><span />Firebase pendiente</div>
  if (!user) return <button className="auth-button" onClick={onLogin}><span className="google-mark">G</span> Iniciar sesión</button>
  return (
    <details className="account-menu">
      <summary>
        {user.photoURL ? <img src={user.photoURL} alt="" /> : <span className="avatar-fallback">{(user.displayName || 'U')[0]}</span>}
        <span className={`sync-dot status-${status}`} />
        <span className="account-copy"><strong>{message}</strong><small>{pending ? `${pending} pendiente${pending === 1 ? '' : 's'}` : user.displayName || 'Cuenta Google'}</small></span>
      </summary>
      <div className="account-popover">
        <strong>{user.displayName || 'Cuenta Google'}</strong>
        <span>{user.email}</span>
        <div className={`sync-detail status-${status}`} role="status" aria-live="polite">
          <span className="sync-dot" />
          <div><strong>{message}</strong><small>{pending ? `${pending} ${pending === 1 ? 'operación pendiente' : 'operaciones pendientes'}` : 'Sin operaciones pendientes'}</small></div>
        </div>
        {lastSuccessfulAt && <small className="last-sync-time">Última actualización correcta: {new Date(lastSuccessfulAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}</small>}
        <button className="secondary-button full-width sync-now-button" disabled={isSyncing} aria-busy={isSyncing} onClick={onSync}>
          {isSyncing && <span className="button-spinner" aria-hidden="true" />}
          {isSyncing ? 'Sincronizando…' : 'Sincronizar ahora'}
        </button>
        <button className="text-button full-width" onClick={onLogout}>Cerrar sesión</button>
      </div>
    </details>
  )
}
