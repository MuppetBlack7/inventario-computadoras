import { useMemo, useState } from 'react'
import { findDuplicates, saveComputer } from '../db'
import type { ComputerRecord } from '../types'
import { compressPhoto, displayEquipmentType, driveSummary, formatDateTime, formatNumber, newDrive } from '../utils'
import { PhotoPreview } from './PhotoPreview'

interface Props {
  initial: ComputerRecord
  sessionName: string
  onCancel: () => void
  onSaved: (computer: ComputerRecord) => void
  onOpenExisting: (id: string) => void
}

const inputNumber = (value: string) => value === '' ? null : Number(value)

export function ComputerForm({ initial, sessionName, onCancel, onSaved, onOpenExisting }: Props) {
  const [computer, setComputer] = useState<ComputerRecord>(initial)
  const [step, setStep] = useState<'form' | 'preview'>('form')
  const [status, setStatus] = useState('')
  const [missing, setMissing] = useState<string[]>([])
  const [duplicates, setDuplicates] = useState<ComputerRecord[]>([])
  const [allowDuplicate, setAllowDuplicate] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)

  const update = <K extends keyof ComputerRecord>(key: K, value: ComputerRecord[K]) =>
    setComputer((current) => ({ ...current, [key]: value }))

  const computedMissing = useMemo(() => {
    const fields: string[] = []
    if (!computer.photo && !computer.photoRemote) fields.push('fotografía')
    if (computer.latitude === null || computer.longitude === null) fields.push('coordenadas GPS')
    if (!computer.writtenLocation.trim()) fields.push('referencia física')
    if (!computer.brand.trim()) fields.push('marca')
    if (!computer.model.trim()) fields.push('modelo')
    if (computer.ramGB === null) fields.push('RAM')
    if (!computer.operatingSystem.trim()) fields.push('sistema operativo')
    return fields
  }, [computer])

  const choosePhoto = async (file?: File) => {
    if (!file) return
    setPhotoBusy(true)
    setStatus('Procesando fotografía…')
    try {
      const photo = await compressPhoto(file)
      setComputer((current) => ({ ...current, photo, photoName: file.name, photoNeedsUpload: true, photoUploadStatus: 'pending', photoUploadError: undefined }))
      setStatus('Fotografía lista · pendiente de subir')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'No fue posible procesar la fotografía')
    } finally {
      setPhotoBusy(false)
    }
  }

  const requestLocation = () => {
    if (!navigator.geolocation) {
      setStatus('La ubicación no está disponible; añade una referencia física')
      return
    }
    setStatus('Solicitando ubicación…')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setComputer((current) => ({
          ...current,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy
        }))
        setStatus(`Ubicación registrada (precisión aproximada: ${Math.round(position.coords.accuracy)} m)`)
      },
      () => setStatus('Ubicación no disponible. Puedes continuar manualmente.'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    )
  }

  const review = async (forceDuplicate = false) => {
    if (!computer.inventoryId.trim() && !computer.serialNumber.trim()) {
      setStatus('Indica al menos un número de inventario o de serie')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    const matches = await findDuplicates(computer.inventoryId, computer.serialNumber, computer.id)
    setDuplicates(matches)
    if (matches.length && !allowDuplicate && !forceDuplicate) {
      setStatus('Revisa el posible duplicado antes de continuar')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setMissing(computedMissing)
    setStep('preview')
    setStatus('Vista previa lista')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const save = async () => {
    setStatus('Guardando…')
    try {
      const saved = await saveComputer(computer)
      setStatus('Guardado local')
      window.setTimeout(() => onSaved(saved), 350)
    } catch (error) {
      setStatus(error instanceof Error ? `No se pudo guardar: ${error.message}` : 'No se pudo guardar')
    }
  }

  if (step === 'preview') {
    return (
      <main className="screen narrow-screen">
        <div className="screen-heading">
          <button className="icon-button" onClick={() => setStep('form')} aria-label="Volver a editar">←</button>
          <div><p className="eyebrow">Antes de guardar</p><h1>Revisa el registro</h1></div>
        </div>
        <div className="status-bar" role="status">{status}</div>
        <section className="preview-card">
          <PhotoPreview blob={computer.photo} remote={computer.photoRemote} computerId={computer.cloudId || computer.id} alt="Fotografía del equipo" className="preview-photo" unavailableOnDevice={!computer.photo && Boolean(computer.photoStoredLocally || computer.photoPath)} />
          <div className="preview-title">
            <span>{sessionName}</span>
            <h2>{displayEquipmentType(computer) || 'Tipo de equipo no indicado'}</h2>
            <p>Número de inventario: {computer.inventoryId || 'No indicado'}</p>
            <p>{computer.brand || 'Marca no indicada'} {computer.model}</p>
          </div>
          <dl className="detail-grid">
            <div><dt>Número de serie</dt><dd>{computer.serialNumber || 'No indicado'}</dd></div>
            <div><dt>Año</dt><dd>{computer.yearUnknown ? 'Desconocido' : computer.manufacturingYear}</dd></div>
            <div><dt>Sistema operativo</dt><dd>{computer.operatingSystem || 'No indicado'}</dd></div>
            <div><dt>RAM</dt><dd>{formatNumber(computer.ramGB, ' GB')}</dd></div>
            <div><dt>Almacenamiento</dt><dd>{driveSummary(computer.drives)}</dd></div>
            <div><dt>Escaneo</dt><dd>{formatDateTime(computer.scannedAt)} · {computer.timezone}</dd></div>
            <div><dt>Coordenadas</dt><dd>{computer.latitude === null ? 'No disponibles' : `${computer.latitude.toFixed(6)}, ${computer.longitude?.toFixed(6)} (±${Math.round(computer.accuracyMeters || 0)} m)`}</dd></div>
            <div><dt>Referencia física</dt><dd>{computer.writtenLocation || 'No indicada'}</dd></div>
            <div className="wide"><dt>Contenido original</dt><dd className="code-value">{computer.originalCode || 'Captura manual sin código'}</dd></div>
            <div className="wide"><dt>Observaciones</dt><dd>{computer.notes || 'Sin observaciones'}</dd></div>
          </dl>
          {missing.length > 0 && <div className="missing-box"><strong>Información faltante</strong><p>Puedes guardar y completarla después: {missing.join(', ')}.</p></div>}
        </section>
        <div className="sticky-actions">
          <button className="secondary-button" onClick={() => setStep('form')}>Editar</button>
          <button className="primary-button" onClick={() => void save()}>Guardar registro</button>
        </div>
      </main>
    )
  }

  return (
    <main className="screen narrow-screen">
      <div className="screen-heading">
        <button className="icon-button" onClick={onCancel} aria-label="Cancelar">←</button>
        <div><p className="eyebrow">{initial.inventoryId || initial.serialNumber ? 'Registro' : 'Nuevo equipo'}</p><h1>Datos de la computadora</h1></div>
      </div>
      {status && <div className="status-bar" role="status">{status}</div>}

      {duplicates.length > 0 && !allowDuplicate && (
        <section className="duplicate-warning">
          <strong>Posible registro duplicado</strong>
          <p>Coincide el número de inventario o de serie.</p>
          {duplicates.map((item) => <button className="ghost-button" key={item.id} onClick={() => onOpenExisting(item.id)}>Abrir {item.inventoryId || item.serialNumber}</button>)}
          <button className="text-button" onClick={() => { setAllowDuplicate(true); setDuplicates([]); void review(true) }}>Es correcto, continuar</button>
        </section>
      )}

      <section className="form-section photo-section">
        <div>
          <p className="section-label">Fotografía</p>
          <PhotoPreview blob={computer.photo} remote={computer.photoRemote} computerId={computer.cloudId || computer.id} alt="Fotografía seleccionada" className="form-photo" unavailableOnDevice={!computer.photo && Boolean(computer.photoStoredLocally || computer.photoPath)} />
          {computer.photoNeedsUpload && <p className="device-photo-note">Guardada localmente · pendiente de subir</p>}
          {!computer.photoNeedsUpload && computer.photoRemote && <p className="device-photo-note">Fotografía privada sincronizada</p>}
        </div>
        <label className="upload-button">
          {photoBusy ? 'Procesando…' : computer.photo || computer.photoRemote ? 'Cambiar fotografía' : 'Tomar o adjuntar foto'}
          <input type="file" accept="image/*" capture="environment" disabled={photoBusy} onChange={(event) => void choosePhoto(event.target.files?.[0])} />
        </label>
      </section>

      <section className="form-section">
        <h2>Identificación</h2>
        <div className="form-grid">
          <label>Tipo de equipo <span className="muted">(opcional)</span>
            <select value={computer.equipmentType || ''} onChange={(event) => {
              const equipmentType = event.target.value as ComputerRecord['equipmentType']
              setComputer((current) => ({ ...current, equipmentType, customEquipmentType: equipmentType === 'Otro' ? current.customEquipmentType || '' : '' }))
            }}>
              <option value="">Seleccionar…</option>
              <option>Computadora de escritorio</option>
              <option>Laptop</option>
              <option>Todo en uno</option>
              <option>Otro</option>
            </select>
          </label>
          {computer.equipmentType === 'Otro' && <label>Tipo personalizado
            <input value={computer.customEquipmentType || ''} onChange={(event) => update('customEquipmentType', event.target.value)} placeholder="Ej. impresora, monitor o servidor" />
          </label>}
          {(computer.equipmentType || computer.customEquipmentType) && <div className="wide"><button className="text-button" type="button" onClick={() => setComputer((current) => ({ ...current, equipmentType: '', customEquipmentType: '' }))}>Quitar tipo de equipo</button></div>}
          <label>Número de inventario
            <input value={computer.inventoryId} onChange={(event) => update('inventoryId', event.target.value)} autoCapitalize="characters" />
          </label>
          <label>Número de serie
            <input value={computer.serialNumber} onChange={(event) => update('serialNumber', event.target.value)} autoCapitalize="characters" />
          </label>
          <label>Marca
            <input value={computer.brand} onChange={(event) => update('brand', event.target.value)} />
          </label>
          <label>Modelo
            <input value={computer.model} onChange={(event) => update('model', event.target.value)} />
          </label>
          <label className="checkbox-label wide">
            <input type="checkbox" checked={computer.yearUnknown} onChange={(event) => {
              update('yearUnknown', event.target.checked)
              if (event.target.checked) update('manufacturingYear', null)
            }} /> Año de fabricación desconocido
          </label>
          {!computer.yearUnknown && <label>Año de fabricación
            <input type="number" inputMode="numeric" min="1970" max="2100" value={computer.manufacturingYear ?? ''} onChange={(event) => update('manufacturingYear', inputNumber(event.target.value))} />
          </label>}
        </div>
      </section>

      <section className="form-section">
        <h2>Especificaciones</h2>
        <div className="form-grid">
          <label>Sistema operativo
            <input value={computer.operatingSystem} onChange={(event) => update('operatingSystem', event.target.value)} placeholder="Ej. Windows 11 Pro" />
          </label>
          <label>RAM (GB)
            <input type="number" inputMode="decimal" min="0" step="0.5" value={computer.ramGB ?? ''} onChange={(event) => update('ramGB', inputNumber(event.target.value))} />
          </label>
        </div>
        <div className="drives-list">
          <div className="section-row"><h3>Unidades de almacenamiento</h3><button className="small-button" onClick={() => update('drives', [...computer.drives, newDrive()])}>+ Añadir</button></div>
          {computer.drives.map((drive, index) => (
            <div className="drive-row" key={drive.id}>
              <label>Capacidad (GB)
                <input type="number" inputMode="numeric" min="0" value={drive.capacityGB ?? ''} onChange={(event) => update('drives', computer.drives.map((item) => item.id === drive.id ? { ...item, capacityGB: inputNumber(event.target.value) } : item))} />
              </label>
              <label>Tipo
                <select value={drive.type} onChange={(event) => update('drives', computer.drives.map((item) => item.id === drive.id ? { ...item, type: event.target.value as typeof item.type } : item))}>
                  <option>SSD</option><option>HDD</option><option>Desconocido</option>
                </select>
              </label>
              {computer.drives.length > 1 && <button className="remove-button" aria-label={`Eliminar unidad ${index + 1}`} onClick={() => update('drives', computer.drives.filter((item) => item.id !== drive.id))}>×</button>}
            </div>
          ))}
        </div>
      </section>

      <section className="form-section">
        <h2>Escaneo y ubicación</h2>
        <p className="inline-note">El GPS es aproximado. Conservamos su precisión; añade edificio, salón u otra referencia.</p>
        <button className="secondary-button" onClick={requestLocation}>Actualizar ubicación GPS</button>
        <div className="coordinate-strip">
          <span>Latitud <strong>{computer.latitude?.toFixed(6) ?? '—'}</strong></span>
          <span>Longitud <strong>{computer.longitude?.toFixed(6) ?? '—'}</strong></span>
          <span>Precisión <strong>{computer.accuracyMeters === null ? '—' : `±${Math.round(computer.accuracyMeters)} m`}</strong></span>
        </div>
        <label>Ubicación escrita
          <input value={computer.writtenLocation} onChange={(event) => update('writtenLocation', event.target.value)} placeholder="Edificio, salón, oficina, mesa…" />
        </label>
        <label>Contenido original del QR o código
          <textarea value={computer.originalCode} onChange={(event) => update('originalCode', event.target.value)} rows={3} />
        </label>
        <p className="muted small">Escaneado: {formatDateTime(computer.scannedAt)} · {computer.timezone}</p>
      </section>

      <section className="form-section">
        <h2>Observaciones</h2>
        <label>Notas del equipo
          <textarea value={computer.notes} onChange={(event) => update('notes', event.target.value)} rows={4} placeholder="Estado físico, accesorios, reparaciones pendientes…" />
        </label>
      </section>

      <div className="sticky-actions">
        <button className="secondary-button" onClick={onCancel}>Cancelar</button>
        <button className="primary-button" onClick={() => void review()}>Revisar antes de guardar</button>
      </div>
    </main>
  )
}
