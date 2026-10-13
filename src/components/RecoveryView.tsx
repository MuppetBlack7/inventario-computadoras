import { useState } from 'react'
import { describeReviewReasons, exportRecoverySnapshot, type ReviewReason, type RecoveryReport, type RecoverySnapshot, type RemoteRecoverySnapshot } from '../recovery'
import { downloadBlob } from '../utils'
import { RecoveryControls, type ControlRun } from './RecoveryControls'
import type { ControlId } from '../recoveryPermissions'

interface Props {
  report: RecoveryReport
  local: RecoverySnapshot
  remote: RemoteRecoverySnapshot | null
  onRetry: () => void
  /** Autorización explícita: libera la sincronización. Nunca se invoca desde el diagnóstico. */
  onAuthorize: () => void
  imageKitConfigured?: boolean
  busyControl?: ControlId | null
  controlMessage?: string
  onRunControl?: (run: ControlRun) => void
  /** Dentro de «Sincronizar inventario»: sin encabezado ni contenedor principal propios. */
  embedded?: boolean
}

export function RecoveryView({ report, local, remote, onRetry, onAuthorize, imageKitConfigured = false, busyControl = null, controlMessage, onRunControl, embedded = false }: Props) {
  const [exportState, setExportState] = useState('')
  const [backedUp, setBackedUp] = useState(false)
  const reasons = describeReviewReasons(local, remote, report)
  const requiresReview = reasons.length > 0
  const download = async () => {
    setExportState('Preparando copia íntegra…')
    try {
      const { payload, sha256, size } = await exportRecoverySnapshot(local, remote, report)
      const name = `recuperacion-${report.generatedAt.slice(0, 10)}`
      downloadBlob(new Blob([payload], { type: 'application/json' }), `${name}.json`)
      downloadBlob(new Blob([`${sha256}  ${name}.json\n`], { type: 'text/plain' }), `${name}.sha256.txt`)
      setExportState(`Copia exportada (${size} bytes). SHA-256: ${sha256}`)
    } catch (error) {
      setExportState(error instanceof Error ? error.message : 'No se pudo exportar la copia')
    }
  }

  const Wrapper = embedded ? 'section' : 'main'
  return <Wrapper className="screen recovery-screen">
    {!embedded && <div className="page-intro">
      <p className="eyebrow">Diagnóstico de solo lectura</p>
      <h1>Recuperación pendiente</h1>
      <p>La sincronización está detenida para conservar los registros de este dispositivo. Actualizar el diagnóstico solo lee datos: no sincroniza ni modifica nada. Revisa y guarda una copia antes de resolver conflictos.</p>
    </div>}
    <div className="tool-card">
      <p>Cuenta: <strong>{report.accountId}</strong></p>
      <p>Origen: {report.browser?.origin || 'no disponible'} · Navegador: {report.browser?.userAgent || 'no identificado'}</p>
      <p>Locales: {report.localCounts.sessions} sesiones, {report.localCounts.computers} equipos y {report.localCounts.queue} operaciones pendientes.</p>
      <p>{report.remoteAvailable ? `Firestore: ${report.remoteCounts?.sessions} sesiones y ${report.remoteCounts?.computers} equipos.` : 'Firestore no se pudo consultar en el servidor. No se proponen escrituras.'}</p>
      <p>Por ID: {report.counts['exact-id']} · Posibles duplicados: {report.counts['probable-duplicate']} · Solo locales: {report.counts['local-only']} · Cambios diferentes: {report.counts.different} · Fotos pendientes: {report.counts['photo-pending']}</p>
      <p><strong>Propiedad</strong> · Propios: {report.ownership.own} · Informativos de otras cuentas (solo lectura, sin acción): {report.ownership.otherAccount} · Conflictos reales de propietario: {report.ownership.mismatch} · Sin propietario: {report.ownership.missing}</p>
      <p><strong>Operaciones pendientes</strong> · En la cola: {report.ownership.pendingOperations} · De otra cuenta o sobre registros ajenos (no se ejecutan): {report.ownership.foreignPending}</p>
      <p>Filas que requieren revisión manual: {report.counts['manual-review']}</p>
      <div className="button-row">
        <button className="primary-button" onClick={() => void download()}>Descargar copia y SHA-256</button>
        <button className="secondary-button" onClick={onRetry}>Actualizar diagnóstico (solo lectura)</button>
      </div>
      {exportState && <p role="status">{exportState}</p>}
      <p className="inline-note">La copia contiene datos y fotografías locales. Consérvala en un lugar privado. Este diagnóstico no aprueba ni ejecuta cambios.</p>
    </div>
    <RecoveryControls report={report} local={local} remote={remote} imageKitConfigured={imageKitConfigured} busy={busyControl} message={controlMessage} onRun={onRunControl} />
    {!requiresReview && <div className="tool-card">
      <h2>Reanudar la sincronización</h2>
      <p>El diagnóstico no encontró datos locales pendientes ni diferencias. La sincronización normal solo se reanuda cuando tú la autorices aquí.</p>
      <label className="checkbox-label"><input type="checkbox" checked={backedUp} onChange={(event) => setBackedUp(event.target.checked)} /> Descargué y verifiqué la copia con su SHA-256</label>
      <button className="danger-button" disabled={!backedUp} onClick={() => { if (window.confirm('Se reanudará la sincronización y se escribirán datos en Firestore. ¿Autorizar?')) onAuthorize() }}>Autorizar y reanudar la sincronización</button>
    </div>}
    {requiresReview && <div className="tool-card">
      <h2>Por qué la sincronización sigue detenida</h2>
      <p>Este panel solo diagnostica: no tiene botones para resolver nada. La sincronización no se puede reanudar mientras exista cualquiera de estos motivos:</p>
      <ul className="recovery-reasons">{reasons.map((reason) => <li key={reason.code}><strong>{reasonText(reason)}</strong>
        <small> Quién puede resolverlo: {reason.actor === 'this-account' ? 'esta cuenta' : reason.actor === 'other-account' ? 'solo la cuenta propietaria; desde esta cuenta no hay acción posible' : 'requiere una decisión que esta versión aún no ofrece'}.</small>
        {reason.rows.length > 0 && <small> Registros: {reason.rows.slice(0, 10).map((item) => `${item.kind === 'session' ? 'sesión' : 'equipo'} ${item.id.slice(0, 8)}`).join(', ')}{reason.rows.length > 10 ? ` y ${reason.rows.length - 10} más` : ''}.</small>}
      </li>)}</ul>
    </div>}
    <div className="tool-card">
      <h2>Plan por registro</h2>
      <div className="recovery-list">
        {[...report.rows].sort((a, b) => Number(b.categories.includes('manual-review')) - Number(a.categories.includes('manual-review'))).map((row, index) => <div className="restore-category" key={`${row.kind}-${row.localId || row.remoteId}-${index}`}>
          <strong>{row.kind === 'computer' ? 'Equipo' : 'Sesión'} · {row.localId || 'solo remoto'}</strong>
          <small>ID remoto: {row.remoteId || 'sin confirmar'} · Sesión: {row.sessionId || '—'} · Propietario local: {row.ownerId || 'no confirmado'} · Propietario remoto: {row.remoteOwnerId || '—'}</small>
          <small>{row.categories.join(', ')}</small>
          {row.differences.length > 0 && <small>Campos diferentes: {row.differences.join(', ')}</small>}
          {row.categories.includes('photo-pending') && !row.photo.local && !row.photo.remoteFileId && <small>Foto: no disponible en este dispositivo ni referenciada en la nube. Existe solo en el dispositivo de su propietario{row.ownerId && row.ownerId !== report.accountId ? ' (otra cuenta): solo ella puede subirla' : ''}.</small>}
          {row.photo.local || row.photo.remoteFileId || row.photo.needsUpload || row.photo.remoteReferenceMissing ? <small>Foto local: {row.photo.local ? 'sí' : 'no'} · Referencia registrada: {row.photo.remoteFileId || 'ninguna'} · Subida pendiente: {row.photo.needsUpload ? 'sí' : 'no'}{row.photo.remoteReferenceMissing ? ' · No figura en Firestore' : ''}</small> : null}
          {row.pending.map((item) => <small key={item.id}>Cola: {item.operation} · {item.id}{item.lastError ? ` · ${item.lastError}` : ''}</small>)}
          <small>Propuesta: {row.proposal === 'keep' ? 'conservar'
            : row.proposal === 'no-action' ? 'sin acción: registro de otra cuenta, solo lectura'
            : row.proposal === 'create-after-review' ? 'crear tras revisión y respaldo'
            : row.differences.length ? 'decisión manual; conservar ambas versiones'
            : 'decisión manual; no se modifica nada hasta revisarlo'}</small>
        </div>)}
      </div>
    </div>
  </Wrapper>
}

function reasonText(reason: ReviewReason) {
  const n = reason.count
  const s = n === 1 ? '' : 's'
  switch (reason.code) {
    case 'remote-unavailable': return 'Firestore no se pudo leer en el servidor'
    case 'queue-pending': return `${n} operación${n === 1 ? '' : 'es'} pendiente${s} de esta cuenta en la cola`
    case 'foreign-pending-operation': return `${n} operación${n === 1 ? '' : 'es'} pendiente${s} de otra cuenta o sobre registros ajenos (no se ejecuta${n === 1 ? '' : 'n'})`
    case 'owner-mismatch': return `${n} registro${s} con propietario distinto entre local y remoto`
    case 'owner-missing': return `${n} registro${s} sin propietario`
    case 'probable-duplicate': return `${n} posible${s} duplicado${s}`
    case 'not-matched': return `${n} registro${s} local${n === 1 ? '' : 'es'} sin coincidencia exacta en Firestore`
    case 'different': return `${n} registro${s} con contenido distinto entre local y remoto`
    case 'photo-pending-own': return `${n} equipo${s} de esta cuenta con la fotografía pendiente de subir o sin referencia`
    case 'photo-pending-other-account': return `${n} equipo${s} de otra cuenta con la fotografía solo en el dispositivo de su propietario (sin copia aquí ni referencia en la nube)`
    case 'photo-pending-no-owner': return `${n} equipo${s} sin propietario con fotografía pendiente`
    default: return `${n} registro${s} marcado${s} para revisión manual`
  }
}
