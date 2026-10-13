import { useState } from 'react'
import { CLEANUP_LABELS, type CleanupCategory, type CleanupPlan, type CleanupResult } from '../localCleanup'

interface Props {
  online: boolean
  /** Lee Firebase y calcula la vista previa. No modifica nada. */
  onPreview: () => Promise<CleanupPlan>
  /** Ejecuta la limpieza confirmada (vuelve a verificar antes de borrar). */
  onRun: (plan: CleanupPlan) => Promise<CleanupResult>
}

type Stage = 'idle' | 'loading' | 'preview' | 'confirm' | 'running' | 'result'

const STATUS_TEXT: Record<CleanupResult['status'], string> = {
  completed: 'Limpieza completada',
  partial: 'Limpieza parcial: algunas copias no se eliminaron',
  failed: 'La limpieza falló: no se eliminó ninguna copia',
  cancelled: 'Limpieza cancelada: no se eliminó nada'
}

/** Acción separada de la sincronización: retira copias LOCALES ya verificadas en Firebase. No escribe en Firebase ni en ImageKit. */
export function LocalCleanupCard({ online, onPreview, onRun }: Props) {
  const [stage, setStage] = useState<Stage>('idle')
  const [plan, setPlan] = useState<CleanupPlan | null>(null)
  const [result, setResult] = useState<CleanupResult | null>(null)
  const [understood, setUnderstood] = useState(false)
  const [error, setError] = useState('')

  const preview = async () => {
    setStage('loading'); setError(''); setResult(null); setUnderstood(false)
    try { setPlan(await onPreview()); setStage('preview') } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setStage('idle') }
  }
  const run = async () => {
    if (!plan) return
    setStage('running')
    try { setResult(await onRun(plan)) } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    setStage('result')
  }
  const categories = plan ? (Object.keys(plan.counts) as CleanupCategory[]).filter((code) => plan.counts[code] > 0) : []

  return <div className="tool-card local-cleanup">
    <h2>Limpiar copias locales verificadas en Firebase</h2>
    <p>Libera espacio en este dispositivo quitando copias locales de TUS equipos que ya están idénticas en Firebase. Es una acción aparte: no sincroniza ni sube nada, y no borra nada de Firebase ni de ImageKit.</p>
    {error && <p className="inline-note warning-box" role="alert">{error}</p>}

    {(stage === 'idle' || stage === 'loading') && <>
      <button className="secondary-button" disabled={!online || stage === 'loading'} onClick={() => void preview()}>{stage === 'loading' ? 'Consultando Firebase…' : 'Revisar qué copias se pueden limpiar'}</button>
      {!online && <p className="inline-note">Sin conexión no se puede verificar nada en Firebase, así que no se limpia nada.</p>}
    </>}

    {(stage === 'preview' || stage === 'confirm') && plan && <>
      {plan.blockedBy.map((reason) => <p className="inline-note warning-box" key={reason}>{reason}</p>)}
      <p><strong>{plan.candidates.length}</strong> {plan.candidates.length === 1 ? 'copia se puede limpiar' : 'copias se pueden limpiar'} · <strong>{plan.excluded.length}</strong> se conservan.</p>
      <ul className="recovery-reasons">{categories.map((code) => <li key={code}><small>{CLEANUP_LABELS[code]}: <strong>{plan.counts[code]}</strong></small></li>)}</ul>
      <details open={plan.candidates.length > 0}>
        <summary>Copias que se retirarían de este dispositivo: {plan.candidates.length}</summary>
        <ul className="recovery-reasons">{plan.candidates.map((item) => <li key={item.id}><small>Inventario {item.inventoryId} · ID {item.id} · {item.reason}</small></li>)}</ul>
      </details>
      <details>
        <summary>Registros que se conservan: {plan.excluded.length}</summary>
        <ul className="recovery-reasons">{plan.excluded.map((item) => <li key={item.id}><small>Inventario {item.inventoryId} · ID {item.id} · {item.reason}</small></li>)}</ul>
      </details>
      <p className="inline-note">Los registros siguen en Firebase. «Descargar datos» podría volver a traerlos a este dispositivo.</p>
      {stage === 'preview' && <div className="button-row">
        <button className="primary-button" disabled={plan.candidates.length === 0} onClick={() => setStage('confirm')}>Continuar a la confirmación</button>
        <button className="secondary-button" onClick={() => void preview()}>Actualizar vista previa</button>
        <button className="secondary-button" onClick={() => setStage('idle')}>Cancelar</button>
      </div>}
      {stage === 'confirm' && <div className="restore-category" role="group" aria-label="Segunda confirmación">
        <strong>Segunda confirmación</strong>
        <label className="checkbox-label"><input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} /> Entiendo que se eliminarán {plan.candidates.length} {plan.candidates.length === 1 ? 'copia local' : 'copias locales'} de este dispositivo. Siguen en Firebase y no se modifica la cola, las sesiones ni los registros de otras cuentas.</label>
        <p className="inline-note">Justo antes de eliminar se vuelve a consultar Firebase; si algo cambió, no se borra nada.</p>
        <div className="button-row">
          <button className="danger-button" disabled={!understood} onClick={() => void run()}>Eliminar {plan.candidates.length} {plan.candidates.length === 1 ? 'copia local' : 'copias locales'}</button>
          <button className="secondary-button" onClick={() => setStage('preview')}>Volver a la vista previa</button>
        </div>
      </div>}
    </>}

    {stage === 'running' && <div role="status"><div className="spinner" /><p>Verificando de nuevo y limpiando…</p></div>}

    {stage === 'result' && result && <div role="status">
      <h3>{STATUS_TEXT[result.status]}</h3>
      {result.cancelReason && <p className="inline-note warning-box">{result.cancelReason}</p>}
      <ul className="recovery-reasons">
        <li><small>Copias eliminadas: <strong>{result.removed.length}</strong></small></li>
        <li><small>Ya no estaban en este dispositivo: <strong>{result.alreadyAbsent.length}</strong></small></li>
        <li><small>Conservadas por un cambio de último momento: <strong>{result.kept.length}</strong></small></li>
        <li><small>Con error: <strong>{result.failed.length}</strong></small></li>
        <li><small>No intentadas: <strong>{result.notAttempted.length}</strong></small></li>
      </ul>
      {result.failed.length > 0 && <ul className="recovery-reasons">{result.failed.map((item) => <li key={item.id}><small>{item.id}: {item.error}</small></li>)}</ul>}
      {result.removed.length > 0 && <p className="inline-note">Eliminadas: {result.removed.join(', ')}</p>}
      {result.alreadyAbsent.length > 0 && <p className="inline-note">Ya ausentes: {result.alreadyAbsent.join(', ')}</p>}
      {result.kept.length > 0 && <ul className="recovery-reasons">{result.kept.map((item) => <li key={item.id}><small>Conservada {item.id}: {item.reason}</small></li>)}</ul>}
      {result.notAttempted.length > 0 && <p className="inline-note">No intentadas: {result.notAttempted.join(', ')}</p>}
      {result.status !== 'completed' && <p className="inline-note">Puedes reintentar: las copias ya eliminadas no se vuelven a tocar.</p>}
      <div className="button-row"><button className="secondary-button" onClick={() => void preview()}>{result.status === 'completed' ? 'Revisar de nuevo' : 'Reintentar'}</button><button className="secondary-button" onClick={() => setStage('idle')}>Cerrar</button></div>
    </div>}
    {stage === 'result' && !result && <button className="secondary-button" onClick={() => setStage('idle')}>Cerrar</button>}
  </div>
}
