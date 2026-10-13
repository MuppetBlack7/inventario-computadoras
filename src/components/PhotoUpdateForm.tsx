import { useState } from 'react'
import { saveSharedComputerPhoto } from '../db'
import type { ComputerRecord } from '../types'
import { compressPhoto } from '../utils'
import { PhotoPreview } from './PhotoPreview'

interface Props {
  initial: ComputerRecord
  actorId: string
  onCancel: () => void
  onSaved: (computer: ComputerRecord) => void
}

export function PhotoUpdateForm({ initial, actorId, onCancel, onSaved }: Props) {
  const [photo, setPhoto] = useState<Blob>()
  const [photoName, setPhotoName] = useState('foto.jpg')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const unavailable = !initial.photo && !initial.photoRemote && Boolean(initial.photoStoredLocally || initial.photoPath)

  const choosePhoto = async (file?: File) => {
    if (!file) return
    setBusy(true)
    setStatus('Procesando fotografía…')
    try {
      setPhoto(await compressPhoto(file))
      setPhotoName(file.name)
      setStatus('Fotografía lista · pendiente de subir')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'No fue posible procesar la fotografía')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!photo) return
    setBusy(true)
    setStatus('Guardando localmente…')
    try {
      const saved = await saveSharedComputerPhoto({
        ...initial,
        photo,
        photoName,
        photoNeedsUpload: true,
        photoUploadStatus: 'pending',
        photoUploadError: undefined
      }, actorId)
      setStatus('Guardado local · pendiente de sincronizar')
      onSaved(saved)
    } catch (error) {
      setStatus(error instanceof Error ? `No se pudo guardar: ${error.message}` : 'No se pudo guardar')
      setBusy(false)
    }
  }

  return <main className="screen narrow-screen">
    <div className="screen-heading">
      <button className="icon-button" onClick={onCancel} aria-label="Cancelar">←</button>
      <div><p className="eyebrow">Fotografía compartida</p><h1>Subir o reemplazar fotografía</h1></div>
    </div>
    {status && <div className="status-bar" role="status">{status}</div>}
    <section className="form-section photo-section">
      <div>
        <p className="section-label">Vista previa</p>
        <PhotoPreview blob={photo || initial.photo} remote={photo ? undefined : initial.photoRemote} computerId={initial.cloudId || initial.id} alt="Fotografía del equipo" className="form-photo" unavailableOnDevice={!photo && unavailable} />
        {unavailable && !photo && <p className="inline-note warning-box">La fotografía anterior no está disponible en este dispositivo. Puedes reemplazarla subiendo una nueva.</p>}
        <p className="inline-note">Solo se actualizará la fotografía. El propietario y los demás datos permanecerán intactos.</p>
      </div>
      <label className="upload-button">
        {busy ? 'Procesando…' : photo ? 'Elegir otra fotografía' : 'Tomar o adjuntar foto'}
        <input type="file" accept="image/*" capture="environment" disabled={busy} onChange={(event) => void choosePhoto(event.target.files?.[0])} />
      </label>
    </section>
    <div className="sticky-actions">
      <button className="secondary-button" disabled={busy} onClick={onCancel}>Cancelar</button>
      <button className="primary-button" disabled={busy || !photo} onClick={() => void save()}>Guardar fotografía</button>
    </div>
  </main>
}
