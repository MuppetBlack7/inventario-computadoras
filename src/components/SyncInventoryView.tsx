import type { ReactNode } from 'react'
import type { RecoveryReport, RecoverySnapshot, RemoteRecoverySnapshot } from '../recovery'
import { advance, type FlowAction, type FlowState } from '../syncFlow'
import { PhotoCheckPanel } from './PhotoCheckPanel'
import type { RemoteLoader } from '../photoCheck'
import { buildProposal, describeDifferences, explainNoOperations, isUpToDate, primaryAction, summarizePending, summarizeSync, type RecordChoice, type RowRef, type SyncDecisions, type SyncProposal } from '../syncPlan'
import { RecoveryView } from './RecoveryView'
import type { ControlId } from '../recoveryPermissions'
import type { ControlRun } from './RecoveryControls'
import { computeSyncDisplay, type SyncDisplay } from '../syncDisplay'

export interface SyncResultView {
  /** Qué se actualizó, qué se conservó y qué quedó pendiente. */
  updated: string[]
  kept: string[]
  pending: string[]
  errors: string[]
}

interface Props {
  report: RecoveryReport
  local: RecoverySnapshot
  remote: RemoteRecoverySnapshot | null
  online: boolean
  display?: SyncDisplay
  imageKitConfigured: boolean
  flow: FlowState
  /** Envía una acción del flujo. Solo `confirm` (desde el paso de confirmación) puede escribir datos. */
  onFlow: (action: FlowAction, proposal?: SyncProposal) => void
  result?: SyncResultView | null
  message?: string
  /** Vuelve a la pantalla principal del inventario. Siempre disponible, también durante una comparación o ejecución. */
  onBack: () => void
  onAuthorize: () => void
  /** Herramientas avanzadas (diagnóstico técnico y alcances separados). */
  onRetry: () => void
  busyControl?: ControlId | null
  controlMessage?: string
  onRunControl?: (run: ControlRun) => void
  /** Lector de solo lectura (a memoria) de la fotografía remota para la comprobación de identidad; sin él queda «No verificada». */
  loadRemotePhoto?: RemoteLoader
}

/** Tener internet no significa haber sincronizado: estos textos solo describen la conexión. */
const CONNECTION: Record<'online' | 'offline' | 'remote-unavailable', { text: string; level: 'ok' | 'neutral' | 'warning' }> = {
  online: { text: 'Conectado a Firebase', level: 'ok' },
  offline: { text: 'Modo sin conexión. Puedes seguir registrando y editando equipos. Los cambios se guardan en este dispositivo', level: 'neutral' },
  'remote-unavailable': { text: 'No se pudo conectar con Firebase. Tus cambios locales se conservan', level: 'warning' }
}

const short = (id: string) => id.slice(0, 22)
const kindName = (kind: 'session' | 'computer') => (kind === 'session' ? 'sesión' : 'equipo')

function RefList({ title, items, open = false, children }: { title: string; items: RowRef[]; open?: boolean; children?: (item: RowRef) => ReactNode }) {
  return <details open={open && items.length > 0}>
    <summary>{title}: {items.length}</summary>
    {items.length === 0 ? <small>Ninguno.</small> : <ul className="recovery-reasons">{items.slice(0, 20).map((item) => <li key={`${item.kind}-${item.id}`}><small>{kindName(item.kind)} {short(item.id)}</small>{children?.(item)}</li>)}</ul>}
    {items.length > 20 && <small>…y {items.length - 20} más.</small>}
  </details>
}

export function SyncInventoryView(props: Props) {
  const { report, local, remote, online, imageKitConfigured, flow, onFlow, result, message } = props
  const overview = summarizeSync(local, remote, report, online)
  const proposal = buildProposal(local, remote, report, flow.decisions, { imageKitConfigured })
  const decide = (change: Partial<SyncDecisions>) => onFlow({ type: 'decide', decisions: { ...flow.decisions, ...change } })
  const choose = (id: string, choice: RecordChoice) => decide({ perRecord: { ...flow.decisions.perRecord, [id]: choice } })
  const differenceDetails = describeDifferences(local, remote, report)
  const noOperations = explainNoOperations(proposal, differenceDetails)
  const busy = flow.step === 'comparing' || flow.step === 'running'
  // La aplicación pasa el reloj real; el valor implícito permite renderizar instantáneas fijas en pruebas y SSR.
  const state = props.display ?? computeSyncDisplay({ online, paused: true, pending: local.queue.filter((item) => item.ownerId === report.accountId).length, failedOperations: 0, photoProblems: 0, syncStatus: 'local', report, now: Date.parse(report.generatedAt) })
  const upToDate = isUpToDate(overview) && state.dataCurrent
  const stopped = 'La sincronización automática está detenida: nada se envía ni se recibe hasta que lo confirmes aquí.'

  const pending = summarizePending(local, remote, report)
  const suggested = primaryAction(overview, pending)
  const primary = suggested === 'up-to-date' && !upToDate ? 'reconnect' : suggested
  const connected = overview.connection === 'online'
  const hasPending = pending.records > 0 || pending.photos > 0
  const connection = CONNECTION[overview.connection]
  const offlineReason = overview.connection === 'offline'
    ? 'Sin conexión: la subida está deshabilitada y tus datos siguen guardados en este dispositivo.'
    : 'Firebase no respondió: la subida está deshabilitada y tus datos siguen guardados en este dispositivo.'

  return <main className="screen sync-screen">
    <div className="page-intro">
      <p className="eyebrow">Sincronizar inventario</p>
      <h1>Sincronizar inventario</h1>
      <p>Tus cambios no se envían solos: tú decides cuándo subirlos.</p>
    </div>

    <div className={`connection-banner level-${state.tone === 'error' ? 'warning' : state.dataCurrent ? 'ok' : 'neutral'}`} role="status">
      <span className="connection-dot" aria-hidden="true" />
      <p><strong>{state.title}</strong><br />{state.detail}</p>
    </div>

    <div className={`connection-banner level-${connection.level}`} role="status">
      <span className="connection-dot" aria-hidden="true" />
      <p>{overview.connection === 'online' && !state.dataCurrent ? 'Firebase respondió en la última comparación; vuelve a verificar el estado actual' : connection.text}</p>
    </div>
    {overview.photos.otherAccount.map((photo) => <p className="inline-note warning-box" key={photo.id}>Advertencia: la fotografía del equipo {short(photo.id)} solo existe en el dispositivo de {photo.ownerName}; esa cuenta debe recuperarla. No se marca como recuperada y no impide las demás operaciones.</p>)}
    {message && <p role="status">{message}</p>}

    {flow.step === 'overview' && <div className="sync-primary">
      {primary === 'upload' && <button className="primary-button big-action" disabled={busy} onClick={() => onFlow({ type: 'sync-now', mode: 'upload' })}>Revisar y subir mis cambios</button>}
      {primary === 'offline' && <button className="primary-button big-action" onClick={props.onBack}>Seguir trabajando sin conexión</button>}
      {primary === 'reconnect' && <button className="primary-button big-action" onClick={props.onRetry}>Reintentar conexión</button>}
      {primary === 'up-to-date' && <button className="primary-button big-action" disabled aria-disabled="true">Todo está al día</button>}
      {primary === 'review' && <button className="primary-button big-action" disabled={busy} onClick={() => onFlow({ type: 'review-differences' })}>Revisar diferencias</button>}
    </div>}

    {flow.step === 'overview' && hasPending && <div className="tool-card pending-card">
      <h2>Tienes cambios guardados en este dispositivo</h2>
      <p>{pending.records} {pending.records === 1 ? 'registro' : 'registros'} y {pending.photos} {pending.photos === 1 ? 'fotografía' : 'fotografías'} sin enviar.{pending.reliable ? '' : ' No se pudo comparar con Firebase, así que puede haber más.'} Siguen a salvo aquí aunque pospongas o canceles la subida.</p>
      <details className="review-changes">
        <summary className="secondary-button">Revisar cambios</summary>
        <ul className="recovery-reasons">{pending.items.slice(0, 30).map((item) => <li key={`${item.kind}-${item.id}`}><small>{kindName(item.kind)} {short(item.id)} · {item.operation}</small></li>)}</ul>
        {pending.items.length > 30 && <small>…y {pending.items.length - 30} más.</small>}
      </details>
      <div className="button-row">
        <button className="primary-button big-action" disabled={!connected || busy} onClick={() => onFlow({ type: 'sync-now', mode: 'upload' })}>Subir mis cambios</button>
        <button className="secondary-button big-action" onClick={props.onBack}>Seguir trabajando sin conexión</button>
      </div>
      {!connected && <p className="inline-note">{offlineReason}</p>}
    </div>}

    {flow.step === 'overview' && <div className="tool-card sync-actions">
      <h2>¿Qué quieres hacer?</h2>
      <div className="action-grid">
        <div className="action-item"><button className="secondary-button" disabled={!connected || busy} onClick={() => onFlow({ type: 'sync-now', mode: 'download' })}>Descargar datos</button><small>Trae registros de Firebase sin borrar nada de este dispositivo.</small></div>
        <div className="action-item"><button className="secondary-button" disabled={!connected || busy} onClick={() => onFlow({ type: 'review-differences' })}>Revisar diferencias</button><small>Compara ambas versiones antes de decidir.</small></div>
        {!hasPending && <div className="action-item"><button className="secondary-button" onClick={props.onBack}>Seguir trabajando sin conexión</button><small>Mantén tus cambios en este dispositivo y vuelve al inventario.</small></div>}
      </div>
      {!connected && <p className="inline-note">{offlineReason}</p>}
      <p className="inline-note">Antes de escribir algo siempre se muestra una vista previa y se pide confirmación.</p>
    </div>}

    {flow.step === 'overview' && upToDate && <div className="tool-card" role="status">
      <h2>Todo está al día</h2>
      <p>No hay cambios pendientes, registros distintos ni fotografías propias por subir. Puedes seguir registrando, editando y consultando equipos.</p>
      <div className="button-row"><button className="primary-button" onClick={props.onBack}>Volver al inventario</button></div>
    </div>}

    {flow.step === 'comparing' && <div className="tool-card" role="status"><div className="spinner" /><p>Comparando con Firebase (solo lectura)…</p><button className="secondary-button" onClick={props.onBack}>Volver al inventario</button></div>}

    {(flow.step === 'proposal' || flow.step === 'confirm') && <div className="tool-card">
      <h2>{flow.step === 'proposal' ? 'Elige qué hacer' : 'Confirma la sincronización'}</h2>
      {flow.step === 'proposal' && <>
        {overview.myPendingOperations > 0 && <div className="restore-category">
          <strong>Cambios locales pendientes ({overview.myPendingOperations})</strong>
          <label className="checkbox-label"><input type="radio" name="mine" checked={flow.decisions.uploadMyChanges} onChange={() => decide({ uploadMyChanges: true })} /> Subir mis cambios</label>
          <label className="checkbox-label"><input type="radio" name="mine" checked={!flow.decisions.uploadMyChanges} onChange={() => decide({ uploadMyChanges: false })} /> Conservar localmente por ahora</label>
        </div>}
        {overview.localOnly.length > 0 && <div className="restore-category">
          <strong>Equipos solo locales ({overview.localOnly.length})</strong>
          <label className="checkbox-label"><input type="radio" name="localonly" checked={flow.decisions.localOnly === 'prepare'} onChange={() => decide({ localOnly: 'prepare' })} /> Preparar su subida (solo los míos, sin duplicados ni conflictos)</label>
          <label className="checkbox-label"><input type="radio" name="localonly" checked={flow.decisions.localOnly === 'keep'} onChange={() => decide({ localOnly: 'keep' })} /> Conservarlos solo aquí</label>
        </div>}
        {overview.remoteOnly.length > 0 && <div className="restore-category">
          <strong>Solo en Firebase ({overview.remoteOnly.length})</strong>
          <label className="checkbox-label"><input type="radio" name="remoteonly" checked={flow.decisions.remoteOnly === 'download'} onChange={() => decide({ remoteOnly: 'download' })} /> Descargar de forma segura (no elimina nada local)</label>
          <label className="checkbox-label"><input type="radio" name="remoteonly" checked={flow.decisions.remoteOnly === 'skip'} onChange={() => decide({ remoteOnly: 'skip' })} /> No descargar por ahora</label>
        </div>}
        {overview.photos.ownPending.length > 0 && <div className="restore-category">
          <label className="checkbox-label"><input type="checkbox" checked={flow.decisions.uploadPhotos} disabled={!imageKitConfigured} onChange={(event) => decide({ uploadPhotos: event.target.checked })} /> Subir mis {overview.photos.ownPending.length} fotografías pendientes{imageKitConfigured ? '' : ' (ImageKit no está configurado: se conservan en este dispositivo)'}</label>
        </div>}
        <RefList title="Registros con cambios distintos en ambos lados" items={overview.different} open>
          {(item) => {
            const detail = overview.different.find((entry) => entry.id === item.id)!
            const value = flow.decisions.perRecord[item.id] ?? 'keep-local'
            const info = differenceDetails.find((entry) => entry.id === item.id)
            const selected = info?.options.find((option) => option.choice === value)
            const row = report.rows.find((entry) => (entry.localId || entry.remoteId) === item.id)
            const localRecord = local.computers.find((entry) => entry.id === row?.localId)
            const remoteRecord = remote?.computers.find((entry) => entry.id === row?.remoteId || entry.cloudId === row?.remoteId || entry.id === row?.localId) ?? null
            return <>
              {info && <div className="difference-card">
                <strong>{info.title}</strong> <small>· propietario: {info.ownerName}{info.hasPendingOperation ? ' · con operaciones pendientes' : ''}</small>
                <ul className="recovery-reasons">{info.fields.map((field) => <li key={field.field}><small><strong>{field.label}</strong> — en este dispositivo: «{field.local}» · en Firebase: «{field.remote}»</small></li>)}</ul>
                <ul className="recovery-reasons">{info.options.map((option) => <li key={option.choice}><small><strong>{option.label}</strong>{option.available ? '' : ` (no disponible: ${option.reason})`}. {option.available ? option.effect : ''}</small></li>)}</ul>
                {info.kind === 'computer' && info.fields.some((field) => field.field === 'photoName') && <PhotoCheckPanel local={localRecord} remote={remoteRecord} loadRemote={props.loadRemotePhoto} />}
              </div>}
              <small> · campos: {detail.fields.join(', ')}</small>
              <select aria-label={`Resolver ${short(item.id)}`} value={value} onChange={(event) => choose(item.id, event.target.value as RecordChoice)}>
                <option value="keep-local">Conservar mi versión local (no cambia nada)</option>
                <option value="use-remote" disabled={detail.hasPendingOperation}>Usar la versión de Firebase{detail.hasPendingOperation ? ' (no disponible: hay operaciones pendientes)' : ''}</option>
                <option value="upload-mine" disabled={!detail.mine}>Subir mi versión{detail.mine ? '' : ' (no disponible: no es mi registro)'}</option>
              </select>
              {selected && <small> Elegido: {selected.label}. {selected.effect}</small>}
            </>
          }}
        </RefList>
        <RefList title="Solo locales" items={overview.localOnly} />
        <RefList title="Solo en Firebase" items={overview.remoteOnly} />
        {overview.conflicts.length > 0 && <RefList title="Conflictos (no se tocan)" items={overview.conflicts} open>{(item) => <small> · {overview.conflicts.find((entry) => entry.id === item.id)?.reason}</small>}</RefList>}
      </>}

      {upToDate && !proposal.allowed ? <div role="status"><h3>Todo está al día</h3><p>No hay nada que sincronizar. Puedes volver al inventario y seguir trabajando.</p></div> : <>
        <h3>Propuesta</h3>
        <ProposalSummary proposal={proposal} />
      </>}
      {flow.step === 'proposal' && <div className="button-row proposal-actions">
        <button className="primary-button big-action" disabled={!proposal.allowed} onClick={() => onFlow({ type: 'proceed' })}>Revisar y confirmar</button>
      </div>}
      {flow.step === 'confirm' && <div className="button-row">
        <button className="danger-button" disabled={!proposal.allowed || busy} onClick={() => onFlow({ type: 'confirm' }, proposal)}>Confirmar y sincronizar</button>
        <button className="secondary-button" disabled={busy} onClick={() => onFlow({ type: 'back' })}>Volver</button>
      </div>}
      {!upToDate && !proposal.allowed && proposal.blockedBy.map((reason) => <p className="inline-note warning-box" key={reason}>{reason}</p>)}
      {!upToDate && !proposal.allowed && noOperations.length > 0 && <div className="inline-note warning-box" role="status"><strong>¿Por qué no hay nada que ejecutar?</strong><ul className="recovery-reasons">{noOperations.map((reason) => <li key={reason}><small>{reason}</small></li>)}</ul></div>}
      {flow.step === 'confirm' && <div className="button-row"><button className="primary-button" onClick={props.onBack}>Volver al inventario</button></div>}
      {flow.step === 'confirm' && <p className="inline-note">Al confirmar se escribirá únicamente lo listado arriba. Antes de ejecutar se vuelve a leer todo: si algo cambió desde esta vista, no se ejecuta nada.</p>}
    </div>}

    {flow.step === 'running' && <div className="tool-card" role="status"><div className="spinner" /><p>Subiendo lo confirmado…</p><small>Puedes volver al inventario: la operación continúa y el resultado queda disponible aquí.</small><div className="button-row"><button className="secondary-button" onClick={props.onBack}>Volver al inventario</button></div></div>}

    {flow.step === 'result' && <div className="tool-card">
      <h2>Resultado</h2>
      {result ? <>
        <ResultList title="Se actualizó" items={result.updated} />
        <ResultList title="Se conservó" items={result.kept} />
        <ResultList title="Quedó pendiente" items={result.pending} />
        {result.errors.length > 0 && <ResultList title="Errores (nada se perdió; puedes reintentar)" items={result.errors} />}
      </> : <p>Sin resultado.</p>}
      <div className="button-row"><button className="secondary-button" onClick={() => onFlow({ type: 'back' })}>Volver al resumen</button><button className="secondary-button" onClick={() => onFlow({ type: 'sync-now' })}>Sincronizar de nuevo</button><button className="primary-button" onClick={props.onBack}>Volver al inventario</button></div>
    </div>}

    <details className="tool-card">
      <summary>Detalles técnicos y herramientas avanzadas</summary>
      <h3>Estado detallado</h3>
      <ul className="recovery-reasons">
        <li><strong>Conexión:</strong> {connection.text}</li>
        <li><strong>Cambios locales pendientes de subir:</strong> {overview.myPendingOperations}{overview.foreignPendingOperations ? ` · además ${overview.foreignPendingOperations} de otras cuentas (no se ejecutan)` : ''}</li>
        <li><strong>Existen solo en este dispositivo:</strong> {overview.localOnly.length}</li>
        <li><strong>Existen solo en Firebase:</strong> {overview.remoteOnly.length}</li>
        <li><strong>Con cambios distintos en ambos lados:</strong> {overview.different.length}</li>
        <li><strong>Fotografías pendientes:</strong> {overview.photos.ownPending.length} mías · {overview.photos.otherAccount.length} de otras cuentas{overview.photos.localBytesProtected ? ` · ${overview.photos.localBytesProtected} con copia local protegida` : ''}</li>
        <li><strong>Registros de otras cuentas (solo lectura):</strong> {overview.otherAccountRecords}</li>
        {overview.conflicts.length > 0 && <li><strong>Conflictos que no se tocan:</strong> {overview.conflicts.length}</li>}
      </ul>
      <RecoveryView embedded report={report} local={local} remote={remote} onRetry={props.onRetry} onAuthorize={props.onAuthorize} imageKitConfigured={imageKitConfigured} busyControl={props.busyControl} controlMessage={props.controlMessage} onRunControl={props.onRunControl} />
    </details>
  </main>
}

function ResultList({ title, items }: { title: string; items: string[] }) {
  return <div><strong>{title}</strong>{items.length === 0 ? <small> · nada</small> : <ul className="recovery-reasons">{items.map((item) => <li key={item}><small>{item}</small></li>)}</ul>}</div>
}

export function ProposalSummary({ proposal }: { proposal: SyncProposal }) {
  const lines: Array<[string, number]> = [
    ['Preparar la subida de (operaciones locales en la cola)', proposal.steps.enqueue.length],
    ['Descargar de Firebase a este dispositivo', proposal.steps.download.length],
    ['Subir mis operaciones', proposal.steps.upload.length],
    ['Subir mis fotografías (también se escribe el documento del equipo)', proposal.steps.photos.length],
    ['Conservar sin tocar', proposal.kept.length]
  ]
  return <div>
    <ul className="recovery-reasons">{lines.map(([label, count]) => <li key={label}><small>{label}: <strong>{count}</strong></small></li>)}</ul>
    {[...proposal.steps.enqueue, ...proposal.steps.download, ...proposal.steps.upload, ...proposal.steps.photos].length > 0 && <details>
      <summary>Ver cada registro que se escribiría</summary>
      <ul className="recovery-reasons">{[...proposal.steps.enqueue, ...proposal.steps.download, ...proposal.steps.upload, ...proposal.steps.photos].slice(0, 40).map((item, index) => <li key={`${item.action}-${item.id}-${index}`}><small>{item.action} · {kindName(item.kind)} {short(item.id)}{item.detail ? ` · ${item.detail}` : ''}</small></li>)}</ul>
    </details>}
    {proposal.kept.length > 0 && <details>
      <summary>Ver lo que se conserva</summary>
      <ul className="recovery-reasons">{proposal.kept.slice(0, 40).map((item, index) => <li key={`${item.id}-${index}`}><small>{item.id === '*' ? 'varios' : `${kindName(item.kind)} ${short(item.id)}`} · {item.detail}</small></li>)}</ul>
    </details>}
  </div>
}

export { advance }
