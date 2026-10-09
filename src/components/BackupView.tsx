import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { InventoryBackup, InventorySession } from '../types'
import { downloadBackup, readBackupFile, restoreBackup } from '../backup'
import { exportInventoryToExcel } from '../exportExcel'
import { TEST_QR_DATA } from '../sampleData'
import { downloadBlob } from '../utils'
import { queueLocalPhotoMigrations } from '../db'
import { imageKitConfigured } from '../imageKitClient'

interface Props {
  sessions: InventorySession[]
  ownerId: string | null
  onChanged: () => void
}

export function BackupView({ sessions, ownerId, onChanged }: Props) {
  const [selectedSession, setSelectedSession] = useState('all')
  const [status, setStatus] = useState('Listo')
  const [backup, setBackup] = useState<InventoryBackup | null>(null)
  const [backupFileName, setBackupFileName] = useState('')
  const [replace, setReplace] = useState(false)
  const [qrUrl, setQrUrl] = useState('')

  useEffect(() => {
    void QRCode.toDataURL(TEST_QR_DATA, { width: 360, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0c2e2a', light: '#ffffff' } }).then(setQrUrl)
  }, [])

  const exportExcel = async () => {
    setStatus('Generando Excel con miniaturas…')
    try {
      const result = await exportInventoryToExcel(selectedSession === 'all' ? undefined : selectedSession, ownerId)
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
      setBackupFileName(file.name)
      setStatus(`Respaldo válido: ${result.sessions.length} sesiones y ${result.computers.length} equipos`)
    } catch (error) {
      setBackup(null)
      setStatus(error instanceof Error ? error.message : 'No fue posible leer el respaldo')
    }
  }

  const restore = async () => {
    if (!backup) return
    if (replace && !window.confirm('Esto reemplazará todos los datos actuales. ¿Continuar?')) return
    setStatus('Restaurando datos y fotografías…')
    try {
      const result = await restoreBackup(backup, replace, ownerId)
      setStatus(`Restaurado: ${result.sessions} sesiones y ${result.computers} equipos`)
      setBackup(null)
      setBackupFileName('')
      onChanged()
    } catch (error) {
      setStatus(error instanceof Error ? `Error al restaurar: ${error.message}` : 'Error al restaurar')
    }
  }

  const downloadQr = async () => {
    const svg = await QRCode.toString(TEST_QR_DATA, { type: 'svg', width: 640, margin: 3, color: { dark: '#0c2e2a', light: '#ffffff' } })
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'qr-prueba-inventario.svg')
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
          {backup && <div className="restore-summary">
            <strong>{backupFileName}</strong>
            <span>{backup.sessions.length} sesiones · {backup.computers.length} equipos</span>
            <label className="checkbox-label"><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} /> Reemplazar datos actuales</label>
            <button className="primary-button full-width" onClick={() => void restore()}>{replace ? 'Reemplazar y restaurar' : 'Combinar y restaurar'}</button>
          </div>}
        </section>

        <section className="tool-card qr-card">
          <div>
            <p className="badge">PRUEBA</p>
            <h2>QR estructurado de prueba</h2>
            <p>Escanéalo desde otro dispositivo o descárgalo. Sus datos se identifican como demostración.</p>
            <button className="ghost-button" onClick={() => void downloadQr()}>Descargar QR</button>
          </div>
          {qrUrl && <img src={qrUrl} alt="QR de prueba con datos estructurados" />}
        </section>
      </div>
    </main>
  )
}
