import { useMemo, useState } from 'react'
import type { ComputerRecord, InventoryBackup, InventorySession } from '../types'
import { downloadBackup, readBackupFile } from '../backup'
import { planSharedImport } from '../sharedImport'
import { applyRestore, countBackupPhotos, defaultRestoreOptions, planHasChanges, planRestore, summarizeBackupOwnership, summarizeSkips, syncAndVerifyRestore, type SkipGroup, type CategoryOption, type RestoreOptions, type RestoreOutcome, type RestoreResult } from '../restore'
import { exportInventoryToExcel } from '../exportExcel'
import { queueLocalPhotoMigrations } from '../db'
import { imageKitConfigured } from '../imageKitClient'

interface Props {
  sessions: InventorySession[]
  computers: ComputerRecord[]
  ownerId: string | null
  ownerName?: string
  ownerEmail?: string
  onChanged: () => void
  /** Ejecuta la sincronización de la aplicación y devuelve su resultado (undefined si no hay sesión o conexión). */
  onSyncRestore: () => Promise<{ errors: number; lastError?: string; held?: boolean } | undefined>
  /** La sincronización está detenida a propósito (modo local de la recuperación): nada se enviará solo. */
  syncHeld?: boolean
}

export function BackupView({ sessions, computers, ownerId, ownerName, ownerEmail, onChanged, onSyncRestore, syncHeld = false }: Props) {
  const [selectedSession, setSelectedSession] = useState('all')
  const [status, setStatus] = useState('Listo')
  const [backup, setBackup] = useState<InventoryBackup | null>(null)
  const [backupFileName, setBackupFileName] = useState('')
  const [options, setOptions] = useState<RestoreOptions>(defaultRestoreOptions)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ stage: string; done?: number; total?: number } | null>(null)
  const [report, setReport] = useState<{ result: RestoreResult; outcome?: RestoreOutcome; groups: SkipGroup[] } | null>(null)
  const [mode, setMode] = useState<'own' | 'shared'>('own')
  const [sessionSel, setSessionSel] = useState<Set<string>>(new Set())
  const [computerSel, setComputerSel] = useState<Set<string>>(new Set())
  const [sharedPhotos, setSharedPhotos] = useState(true)
  const ownPlan = useMemo(() => backup ? planRestore(backup, options, { sessions, computers }, ownerId) : null, [backup, options, sessions, computers, ownerId])
  const sharedPlan = useMemo(() => backup && mode === 'shared'
    ? planSharedImport(backup, { sessionIds: sessionSel, computerIds: computerSel, photos: sharedPhotos }, { sessions, computers }, ownerId ? { id: ownerId, name: ownerName, email: ownerEmail } : null)
    : null, [backup, mode, sessionSel, computerSel, sharedPhotos, sessions, computers, ownerId, ownerName, ownerEmail])
  const plan = mode === 'shared' ? sharedPlan : ownPlan
  const ownership = useMemo(() => backup ? summarizeBackupOwnership(backup, ownerId) : null, [backup, ownerId])
  const toggle = (set: Set<string>, id: string, on: boolean) => { const next = new Set(set); if (on) next.add(id); else next.delete(id); return next }
  const skipGroups = useMemo(() => plan ? summarizeSkips(plan) : [], [plan])
  const setCategory = (key: keyof RestoreOptions, change: Partial<CategoryOption>) => setOptions((current) => ({ ...current, [key]: { ...current[key], ...change } }))

  const exportExcel = async () => {
    setStatus('Generando Excel con miniaturas…')
    try {
      const result = await exportInventoryToExcel(selectedSession === 'all' ? undefined : selectedSession, ownerId, { sessions, computers })
      setStatus(`Exportado: ${result.rows} equipo${result.rows === 1 ? '' : 's'} en ${result.filename}`)
    } catch (error) {
      setStatus(error instanceof Error ? `Error al exportar: ${error.message}` : 'Error al exportar')
    }
  }

  const createFullBackup = async () => {
    setStatus('Preparando respaldo con fotografías…')
    try {
      const result = await downloadBackup(ownerId)
      setStatus(`Respaldo descargado: ${result.sessions.length} sesiones y ${result.computers.length} equipos`)
    } catch (error) {
      setStatus(error instanceof Error ? `Error al respaldar: ${error.message}` : 'Error al respaldar')
    }
  }

  const chooseBackup = async (file?: File) => {
    if (!file) return
    setStatus('Revisando respaldo…')
    try {
      const result = await readBackupFile(file)
      setBackup(result)
      setSessionSel(new Set(result.sessions.map((item) => String((item as { id?: unknown }).id))))
      setComputerSel(new Set(result.computers.map((item) => String((item as { id?: unknown }).id))))
      setBackupFileName(file.name)
      setStatus(`Respaldo válido: ${result.sessions.length} sesiones y ${result.computers.length} equipos`)
    } catch (error) {
      setBackup(null)
      setStatus(error instanceof Error ? error.message : 'No fue posible leer el respaldo')
    }
  }

  const restore = async () => {
    if (!backup || !plan || !ownerId || busy) return
    if (plan.blocking.length) { setStatus(plan.blocking[0]); return }
    if (!planHasChanges(plan)) { setStatus('No hay nada que importar con las opciones elegidas'); return }
    if (plan.destructive) {
      const parts = [
        plan.deletes.length ? `se eliminarán ${plan.deletes.length} equipo${plan.deletes.length === 1 ? '' : 's'} que no están en el archivo` : '',
        Object.values(options).some((option) => option.enabled && option.mode === 'replace') ? 'los registros existentes incluidos en el archivo se sustituirán' : ''
      ].filter(Boolean).join(' y ')
      if (!window.confirm(`Reemplazo destructivo: ${parts}. ${syncHeld ? 'Los cambios solo se guardarán en este dispositivo y quedarán en la cola local: no se enviarán mientras la sincronización esté detenida.' : 'Los cambios se sincronizarán con Firebase y los demás dispositivos.'} ¿Continuar?`)) return
    }
    setBusy(true)
    setReport(null)
    setStatus('Restaurando…')
    try {
      const result = await applyRestore(plan, ownerId, (stage, done, total) => setProgress({ stage, done, total }))
      onChanged()
      const groups = summarizeSkips(plan)
      setReport({ result, groups })
      setStatus(syncHeld ? 'Importación local completada. La sincronización está detenida: los cambios quedan en la cola local.' : 'Importación local completada. Sincronizando con Firebase…')
      setProgress(syncHeld ? null : { stage: 'Sincronizando con Firebase' })
      const outcome = await syncAndVerifyRestore(result, ownerId, onSyncRestore)
      setProgress(null)
      setReport({ result, outcome, groups })
      setStatus(outcome.state === 'synced' ? 'Restauración sincronizada y verificada en Firebase' : `Importación local completada · ${outcome.message}`)
      setBackup(null)
      setBackupFileName('')
      onChanged()
    } catch (error) {
      setProgress(null)
      setStatus(error instanceof Error ? `Error al restaurar: ${error.message}` : 'Error al restaurar')
    } finally {
      setBusy(false)
    }
  }

  const retryPhotos = async (result: RestoreResult) => {
    if (!ownerId || busy) return
    setBusy(true)
    setStatus('Reintentando la subida de fotografías…')
    try {
      const outcome = await syncAndVerifyRestore(result, ownerId, onSyncRestore)
      setReport((current) => current ? { ...current, outcome } : current)
      setStatus(outcome.message)
      onChanged()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'No fue posible reintentar')
    } finally {
      setBusy(false)
    }
  }

  const migratePhotos = async () => {
    if (!ownerId || !imageKitConfigured) return
    setStatus('Preparando fotografías locales para subir…')
    const queued = await queueLocalPhotoMigrations(ownerId)
    onChanged()
    setStatus(queued ? `${queued} fotografía${queued === 1 ? '' : 's'} preparada${queued === 1 ? '' : 's'} para sincronizar` : 'No hay fotografías locales pendientes de tu cuenta')
  }

  return (
    <main className="screen">
      <div className="page-intro">
        <p className="eyebrow">Tus datos bajo tu control</p>
        <h1>Exportar y respaldar</h1>
        <p>Los datos se comparten mediante Firestore. ImageKit protege las fotografías y entrega enlaces temporales a usuarios autenticados.</p>
      </div>
      <div className="status-bar" role="status">{status}</div>

      <div className="tool-grid">
        <section className="tool-card accent-card">
          <div className="tool-icon">X</div>
          <h2>Exportar a Excel</h2>
          <p>Incluye todos los campos y una miniatura por equipo.</p>
          <label>Contenido
            <select value={selectedSession} onChange={(event) => setSelectedSession(event.target.value)}>
              <option value="all">Todo el inventario</option>
              {sessions.map((session) => <option value={session.id} key={session.id}>{session.name}</option>)}
            </select>
          </label>
          <button className="primary-button full-width" onClick={() => void exportExcel()}>Descargar .xlsx</button>
        </section>

        <section className="tool-card">
          <div className="tool-icon">↧</div>
          <h2>Respaldo completo</h2>
          <p>Archivo JSON restaurable con sesiones, equipos y fotografías.</p>
          <button className="secondary-button full-width" onClick={() => void createFullBackup()}>Descargar respaldo</button>
        </section>

        <section className="tool-card">
          <div className="tool-icon">☁</div>
          <h2>Migrar fotografías locales</h2>
          <p>Sube las fotografías de registros creados por tu cuenta. Los originales permanecen en este dispositivo hasta verificar la asociación.</p>
          {!imageKitConfigured && <p className="inline-note warning-box">Pendiente: configura el backend privado de ImageKit.</p>}
          <button className="secondary-button full-width" disabled={!imageKitConfigured || !ownerId} onClick={() => void migratePhotos()}>Migrar y verificar</button>
        </section>

        <section className="tool-card">
          <div className="tool-icon">↥</div>
          <h2>Restaurar respaldo</h2>
          <p>Selecciona un archivo creado por esta aplicación.</p>
          <label className="upload-button full-width">
            Elegir archivo .json
            <input type="file" accept="application/json,.json" onChange={(event) => void chooseBackup(event.target.files?.[0])} />
          </label>
          {backup && plan && <div className="restore-summary">
            <strong>{backupFileName}</strong>
            <span>{backup.exportedAt ? `Exportado: ${new Date(backup.exportedAt).toLocaleString('es-MX')}` : 'Sin fecha de exportación'}</span>
            <span>{backup.sessions.length} sesiones · {backup.computers.length} equipos · {countBackupPhotos(backup)} fotografías</span>
            {ownership && ownership.others > 0 && <p className="inline-note warning-box">{ownership.others} registro{ownership.others === 1 ? '' : 's'} del archivo figura{ownership.others === 1 ? '' : 'n'} a nombre de {ownership.otherAccounts === 1 ? 'otra cuenta' : `${ownership.otherAccounts} cuentas más`}. Para conservar su propiedad original, su creador debe iniciar sesión con su cuenta y restaurar este archivo: tu cuenta no puede escribir registros a nombre de otra persona. Con «Importar respaldo compartido» se crean copias tuyas; los originales no cambian.</p>}
            <div className="restore-category">
              <label className="checkbox-label"><input type="radio" name="restore-mode" checked={mode === 'own'} disabled={busy} onChange={() => setMode('own')} /> <strong>Restaurar mi respaldo</strong></label>
              <label className="checkbox-label"><input type="radio" name="restore-mode" checked={mode === 'shared'} disabled={busy} onChange={() => setMode('shared')} /> <strong>Importar respaldo compartido</strong></label>
              {mode === 'shared' && <small>Para un archivo creado por otra persona: se crean registros nuevos bajo tu cuenta. No se modifican ni reclaman los originales, y no se reemplaza ni elimina nada tuyo.</small>}
            </div>
            {mode === 'shared' && <div className="restore-category">
              <strong>Sesiones a importar</strong>
              {backup.sessions.map((item) => { const id = String((item as { id?: unknown }).id); return <label className="checkbox-label" key={id}><input type="checkbox" checked={sessionSel.has(id)} disabled={busy} onChange={(event) => { setSessionSel((current) => toggle(current, id, event.target.checked)); if (!event.target.checked) setComputerSel((current) => new Set([...current].filter((computerId) => { const found = backup.computers.find((entry) => String((entry as { id?: unknown }).id) === computerId); return String((found as { sessionId?: unknown } | undefined)?.sessionId) !== id }))) }} /> {String((item as { name?: unknown }).name || id)}</label> })}
              <strong>Equipos a importar</strong>
              <details>
                <summary>{computerSel.size} de {backup.computers.length} seleccionados</summary>
                <div className="restore-conflicts">{backup.computers.map((item) => { const entry = item as unknown as { id: string; sessionId: string; inventoryId?: string; serialNumber?: string }; return <label className="checkbox-label" key={entry.id}><input type="checkbox" checked={computerSel.has(entry.id)} disabled={busy} onChange={(event) => { setComputerSel((current) => toggle(current, entry.id, event.target.checked)); if (event.target.checked) setSessionSel((current) => toggle(current, entry.sessionId, true)) }} /> {entry.inventoryId || entry.serialNumber || entry.id}</label> })}</div>
              </details>
              <label className="checkbox-label"><input type="checkbox" checked={sharedPhotos} disabled={busy} onChange={(event) => setSharedPhotos(event.target.checked)} /> <strong>Importar fotografías</strong> <small>(se guardan aquí y se suben con tu cuenta)</small></label>
              <small>{plan?.summary.sessions.create ?? 0} sesiones nuevas · {plan?.summary.computers.create ?? 0} equipos nuevos · {plan?.summary.photos.restore ?? 0} fotografías · {(plan?.summary.sessions.skip ?? 0) + (plan?.summary.computers.skip ?? 0)} omitidos</small>
            </div>}
            {mode === 'own' && ([
              ['sessions', 'Sesiones', `${plan.summary.sessions.create} nuevas · ${plan.summary.sessions.update} actualizadas · ${plan.summary.sessions.skip} omitidas`],
              ['computers', 'Equipos', `${plan.summary.computers.create} nuevos · ${plan.summary.computers.update} actualizados · ${plan.summary.computers.skip} omitidos · ${plan.summary.computers.delete} a eliminar`],
              ['photos', 'Fotografías', `${plan.summary.photos.restore} a restaurar · ${plan.summary.photos.skip} omitidas`]
            ] as const).map(([key, title, detail]) => (
              <div className="restore-category" key={key}>
                <label className="checkbox-label"><input type="checkbox" checked={options[key].enabled} disabled={busy} onChange={(event) => setCategory(key, { enabled: event.target.checked })} /> <strong>{title}</strong></label>
                <select aria-label={`Modo para ${title}`} value={options[key].mode} disabled={busy || !options[key].enabled} onChange={(event) => setCategory(key, { mode: event.target.value as CategoryOption['mode'] })}>
                  <option value="merge">{key === 'photos' ? 'Solo equipos sin foto' : 'Combinar'}</option>
                  <option value="replace">{key === 'photos' ? 'Sustituir fotos existentes' : key === 'sessions' ? 'Reemplazar las del archivo' : 'Reemplazar los de las sesiones del archivo'}</option>
                </select>
                {options[key].enabled && <small>{detail}</small>}
              </div>
            ))}
            {mode === 'own' && options.photos.enabled && !options.computers.enabled && <span>Las fotografías se asignarán solo a equipos que ya existen en tu inventario.</span>}
            {plan.blocking.map((message) => <p className="inline-note warning-box" key={message}>{message}</p>)}
            {plan.warnings.map((message) => <p className="inline-note" key={message}>{message}</p>)}
            {!planHasChanges(plan) && !plan.blocking.length && <p className="inline-note warning-box">No hay cambios que importar: los {plan.summary.sessions.skip + plan.summary.computers.skip + plan.summary.photos.skip} registros se omitirán por los motivos de abajo.</p>}
            <SkipGroups groups={skipGroups} />
            {plan.conflicts.length > 0 && <details>
              <summary>{plan.conflicts.length} conflicto{plan.conflicts.length === 1 ? '' : 's'} o duplicado{plan.conflicts.length === 1 ? '' : 's'}</summary>
              <ul className="restore-conflicts">{plan.conflicts.slice(0, 50).map((item, index) => <li key={`${item.kind}-${item.id}-${index}`}><strong>{item.label}</strong>: {item.reason}{item.action === 'skip' ? ' (se omite)' : ''}</li>)}</ul>
              {plan.conflicts.length > 50 && <small>…y {plan.conflicts.length - 50} más.</small>}
            </details>}
            {mode === 'own' && plan.destructive && <p className="inline-note warning-box">Esta combinación sustituye o elimina registros existentes; se pedirá confirmación.</p>}
            {progress && <div role="status"><span>{progress.stage}{progress.total ? ` ${progress.done}/${progress.total}` : '…'}</span><progress value={progress.done} max={progress.total} /></div>}
            <button className="primary-button full-width" disabled={busy || plan.blocking.length > 0 || !planHasChanges(plan)} onClick={() => void restore()}>{busy ? 'Restaurando…' : mode === 'shared' ? 'Importar como registros nuevos' : 'Restaurar selección'}</button>
          </div>}
          {report && <div className="restore-summary" role="status">
            <strong>{report.outcome?.state === 'synced' ? 'Sincronización completa' : report.outcome?.state === 'photos-pending' ? 'Datos sincronizados · fotografías pendientes' : 'Importación local completada'}</strong>
            <span>{report.result.created.sessions + report.result.created.computers} importados · {report.result.updated.sessions + report.result.updated.computers} actualizados · {report.result.skipped} omitidos · {report.result.deleted} eliminados · {report.result.photosRestored} fotografías</span>
            {report.outcome ? <>
              <span>{report.outcome.message}</span>
              {report.outcome.pending > 0 && <span>Pendientes de sincronizar: {report.outcome.pending}</span>}
              {report.outcome.photosPending > 0 && <span>Fotografías pendientes de subir: {report.outcome.photosPending}</span>}
              {report.outcome.photosPending > 0 && imageKitConfigured && ownerId && <button className="secondary-button full-width" disabled={busy} onClick={() => void retryPhotos(report.result)}>Reintentar subida de fotografías</button>}
              {report.outcome.problems.slice(0, 5).map((problem) => <small key={problem}>{problem}</small>)}
            </> : <span>{syncHeld ? 'Sincronización detenida: nada se envió.' : 'Sincronizando con Firebase…'}</span>}
            {report.result.created.sessions + report.result.created.computers + report.result.updated.sessions + report.result.updated.computers + report.result.deleted === 0 && <span>No se importó nada: ningún registro cumplió las condiciones para crearse o actualizarse.</span>}
            <SkipGroups groups={report.groups} />
            {report.result.errors.map((problem) => <small key={problem}>{problem}</small>)}
          </div>}
        </section>

      </div>
    </main>
  )
}

function SkipGroups({ groups }: { groups: SkipGroup[] }) {
  if (!groups.length) return null
  return <div className="restore-skips">
    <strong>Omitidos por motivo</strong>
    {groups.map((group) => <details key={group.kind}>
      <summary>{group.count} · {group.label}</summary>
      <ul className="restore-conflicts">{group.items.slice(0, 100).map((item, index) => <li key={`${item.kind}-${item.id}-${index}`}>{item.kind === 'session' ? 'Sesión' : item.kind === 'photo' ? 'Foto' : 'Equipo'} <strong>{item.label}</strong> <small>({item.id.slice(0, 8)})</small>{item.reason ? ` · ${item.reason}` : ''}</li>)}</ul>
      {group.items.length > 100 && <small>…y {group.items.length - 100} más.</small>}
    </details>)}
  </div>
}
