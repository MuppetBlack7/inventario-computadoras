import { useState } from 'react'
import type { RecoveryReport, RecoverySnapshot, RemoteRecoverySnapshot } from '../recovery'
import { evaluateScopes, planUpdateAll, previewControl, type ControlId, type PreviewItem, type ScopeBlocker } from '../recoveryPermissions'

export interface ControlRun {
  control: ControlId
  /** Registros que no deben tocarse en esta ejecución (conflictos, duplicados, propietario dudoso). */
  excludeIds: ReadonlySet<string>
  /** Huella de la vista previa confirmada: si los datos cambian antes de ejecutar, la acción se cancela. */
  previewKey: string
}

interface Props {
  report: RecoveryReport
  local: RecoverySnapshot
  remote: RemoteRecoverySnapshot | null
  imageKitConfigured: boolean
  /** Control que se está ejecutando; deshabilita los demás. */
  busy?: ControlId | null
  message?: string
  /** Solo para pruebas: abre la vista previa de un control. */
  initialPreview?: ControlId | null
  onRun?: (run: ControlRun) => void
}

const BLOCKERS: Record<string, string> = {
  'remote-unavailable': 'Firestore no se pudo leer en el servidor',
  'owner-mismatch': 'hay registros con propietario distinto entre local y remoto',
  'owner-missing': 'hay registros sin propietario',
  'probable-duplicate': 'hay posibles duplicados',
  different: 'hay registros con contenido distinto entre local y remoto',
  'local-record-missing-remotely': 'hay registros locales que ya no existen en Firestore',
  'imagekit-not-configured': 'ImageKit no está configurado en esta aplicación',
  'nothing-to-upload': 'no hay fotografías propias pendientes de subir',
  'owner-only-by-rules': 'solo el propietario puede modificar sus registros'
}
const blockerText = (blockers: ScopeBlocker[]) => blockers.map((code) => BLOCKERS[code] ?? code).join('; ')

const TITLES: Record<ControlId, string> = {
  'local-files': 'Actualizar archivos locales',
  'keep-stopped': 'Mantener detenida la sincronización',
  photos: 'Actualizar fotografías',
  all: 'Actualizar todos los equipos'
}
const SUMMARIES: Record<ControlId, string> = {
  'local-files': 'Descarga a este dispositivo los cambios de Firestore. No escribe en Firestore.',
  'keep-stopped': 'Usa la aplicación con la sincronización detenida: solo editas tus registros en este dispositivo y los cambios quedan en la cola.',
  photos: 'Sube a ImageKit las fotografías pendientes de TUS equipos y guarda su referencia en Firestore.',
  all: 'Concilia primero (descarga), luego sube tus operaciones y tus fotografías, excluyendo cualquier registro con conflicto o riesgo.'
}

function ItemList({ title, items }: { title: string; items: PreviewItem[] }) {
  if (!items.length) return <p><strong>{title}:</strong> ninguno</p>
  return <div>
    <p><strong>{title}: {items.length}</strong></p>
    <ul className="recovery-reasons">{items.slice(0, 15).map((item, index) => <li key={`${item.kind}-${item.id}-${index}`}><small>{item.action} · {item.kind === 'session' ? 'sesión' : 'equipo'} {item.id.slice(0, 22)}{item.detail ? ` · ${item.detail}` : ''}</small></li>)}</ul>
    {items.length > 15 && <small>…y {items.length - 15} más.</small>}
  </div>
}

export function RecoveryControls({ report, local, remote, imageKitConfigured, busy = null, message, initialPreview = null, onRun }: Props) {
  const [open, setOpen] = useState<ControlId | null>(initialPreview)
  const context = { imageKitConfigured }
  const decisions = evaluateScopes(local, remote, report, context)
  const all = planUpdateAll(local, remote, report, context)
  const state: Record<ControlId, { allowed: boolean; why: string }> = {
    'local-files': { allowed: decisions['pull-remote'].allowed, why: blockerText(decisions['pull-remote'].blockedBy) },
    'keep-stopped': { allowed: decisions['local-edits'].allowed, why: '' },
    photos: { allowed: decisions['upload-own-photos'].allowed, why: blockerText(decisions['upload-own-photos'].blockedBy) },
    all: { allowed: all.allowed, why: blockerText(all.blockedBy) }
  }
  const warnings = decisions['push-own'].warnings

  const preview = (control: ControlId) => previewControl(control, local, remote, report, context)

  return <div className="tool-card recovery-controls">
    <h2>Acciones separadas</h2>
    <p>Cada acción tiene su propio alcance, muestra qué hará antes de ejecutarse y pide confirmación. Ninguna cambia propietarios, elimina registros ni vacía la cola, y ninguna toca registros u operaciones de otras cuentas.</p>
    {warnings.map((warning) => <p className="inline-note warning-box" key={warning}>Advertencia: {warning}.</p>)}
    {message && <p role="status">{message}</p>}
    {(Object.keys(TITLES) as ControlId[]).map((control) => <div className="restore-category" key={control}>
      <strong>{TITLES[control]}</strong>
      <small>{SUMMARIES[control]}</small>
      {!state[control].allowed && <small>No disponible: {state[control].why}.</small>}
      <button className="secondary-button" disabled={!state[control].allowed || Boolean(busy)} onClick={() => setOpen(open === control ? null : control)}>{open === control ? 'Ocultar vista previa' : 'Ver vista previa'}</button>
      {open === control && state[control].allowed && (() => {
        const result = preview(control)
        return <div className="recovery-preview">
          {result.notes.map((note) => <p key={note}>{note}</p>)}
          <ItemList title="Se aplicaría a" items={result.items} />
          <ItemList title="Excluido" items={result.excluded} />
          <div className="button-row">
            <button className="danger-button" disabled={Boolean(busy)} onClick={() => { onRun?.({ control, excludeIds: control === 'all' ? all.excludeIds : new Set<string>(), previewKey: result.key }); setOpen(null) }}>Confirmar: {TITLES[control]}</button>
            <button className="secondary-button" onClick={() => setOpen(null)}>Cancelar</button>
          </div>
        </div>
      })()}
    </div>)}
  </div>
}
