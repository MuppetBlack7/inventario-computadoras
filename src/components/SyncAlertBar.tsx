import type { SyncAlert } from '../syncAlert'

interface Props {
  alert: SyncAlert
  /** Abre «Sincronizar inventario». Solo navega: no ejecuta ninguna operación. */
  onReview: () => void
}

/** Alerta compacta y única. No bloquea el registro ni la edición de equipos. */
export function SyncAlertBar({ alert, onReview }: Props) {
  return <div className="sync-alert-wrap">
    <div className={`sync-alert level-${alert.level}`} role={alert.level === 'error' ? 'alert' : 'status'}>
      <span className="sync-alert-icon" aria-hidden="true">{alert.level === 'error' ? '!' : alert.level === 'warning' ? '▲' : 'i'}</span>
      <p><strong>{alert.title}</strong><span>{alert.reasons.join(' · ')}</span></p>
      <button type="button" className="sync-alert-action" onClick={onReview}>Revisar</button>
    </div>
  </div>
}
