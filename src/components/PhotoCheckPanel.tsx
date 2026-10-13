import { useEffect, useState } from 'react'
import { checkPhotoPair, type PhotoCheck, type RemoteLoader } from '../photoCheck'
import type { ComputerRecord } from '../types'

function Thumb({ blob, alt }: { blob?: Blob; alt: string }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!blob || !/^image\//.test(blob.type)) { setUrl(undefined); return }
    const created = URL.createObjectURL(blob)
    setUrl(created)
    return () => URL.revokeObjectURL(created)
  }, [blob])
  return url ? <img className="photo-check-thumb" src={url} alt={alt} /> : null
}

const dash = (value?: string | number | boolean) => value === undefined || value === '' ? 'No existe' : String(value)

/** Resultado de la comprobación: solo presenta lo calculado, no escribe nada. */
export function PhotoCheckResult({ check }: { check: PhotoCheck }) {
  const { local, remote } = check
  return <div className="photo-check" role="group" aria-label={`Comprobación de la fotografía del inventario ${check.inventoryId}`}>
    <p><strong>Inventario {check.inventoryId}</strong> · propietario local: {check.localOwner} · propietario remoto: {check.remoteOwner}</p>
    <div className="photo-check-columns">
      <div>
        <strong>Fotografía local (este dispositivo)</strong>
        {local.bytes === 'present'
          ? <><Thumb blob={local.blob} alt={`Miniatura local del inventario ${check.inventoryId}`} /><ul className="recovery-reasons"><li><small>Tamaño: {local.size} bytes</small></li><li><small>SHA-256: <code>{local.sha256}</code></small></li></ul></>
          : <p className="inline-note warning-box">{local.bytes === 'error' ? `No se pudieron leer los bytes locales (${local.error}).` : 'Los bytes locales no existen: no hay imagen ni hash.'}</p>}
        <ul className="recovery-reasons">
          <li><small>photoName: {dash(local.photoName)}</small></li>
          <li><small>photoLocalRevision: {dash(local.revision)}</small></li>
          <li><small>Estado de subida: {dash(local.uploadStatus)}{local.needsUpload ? ' · pendiente de subir' : ''}</small></li>
          <li><small>photoRemote: {local.reference}</small></li>
        </ul>
      </div>
      <div>
        <strong>Fotografía remota (Firebase / ImageKit)</strong>
        {remote.verification === 'verified'
          ? <><Thumb blob={remote.blob} alt={`Miniatura remota del inventario ${check.inventoryId}`} /><ul className="recovery-reasons"><li><small>Tamaño: {remote.size} bytes</small></li><li><small>SHA-256: <code>{remote.sha256}</code></small></li></ul></>
          : <p className="inline-note warning-box"><strong>No verificada.</strong>{remote.error ? ` ${remote.error}.` : ''}</p>}
        <ul className="recovery-reasons">
          <li><small>photoName: {dash(remote.photoName)}</small></li>
          <li><small>photoLocalRevision: {dash(remote.revision)}</small></li>
          <li><small>photoRemote: {remote.referenceText} ({remote.reference === 'valid' ? 'referencia válida' : remote.reference === 'invalid' ? 'referencia inválida' : 'sin referencia'})</small></li>
        </ul>
      </div>
    </div>
    {check.sameBytes === 'unknown' && <p className="inline-note warning-box" role="alert">No se puede determinar si las imágenes corresponden al mismo equipo. Mantén el conflicto sin resolver.</p>}
    <ul className="recovery-reasons">{check.warnings.map((warning) => <li key={warning}><small>{warning}</small></li>)}</ul>
  </div>
}

/** Botón de comprobación de solo lectura; el resultado vive en el estado del componente y nunca se guarda. */
export function PhotoCheckPanel({ local, remote, loadRemote }: { local?: ComputerRecord; remote?: ComputerRecord | null; loadRemote?: RemoteLoader }) {
  const [check, setCheck] = useState<PhotoCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try { setCheck(await checkPhotoPair({ local, remote, loadRemote })) } finally { setBusy(false) }
  }
  return <div className="photo-check-panel">
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void run()}>{busy ? 'Comprobando…' : 'Comprobar fotografías (solo lectura)'}</button>
    <small> No sube, descarga ni modifica nada: calcula tamaño y SHA-256 en memoria.</small>
    {check && <PhotoCheckResult check={check} />}
  </div>
}
