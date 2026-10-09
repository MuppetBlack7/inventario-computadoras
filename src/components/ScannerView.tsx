import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser'
import type { ComputerRecord, InventorySession } from '../types'
import { findDuplicates } from '../db'
import { emptyComputer, nowWithZone } from '../utils'
import { parseScannedCode } from '../qr'

interface Props {
  sessions: InventorySession[]
  initialSessionId?: string
  onCancel: () => void
  onCreate: (computer: ComputerRecord) => void
  onOpenExisting: (id: string) => void
  onUpdateExisting: (computer: ComputerRecord) => void
}

const locate = () => new Promise<GeolocationPosition>((resolve, reject) => {
  if (!navigator.geolocation) return reject(new Error('La ubicación no está disponible en este navegador'))
  navigator.geolocation.getCurrentPosition(resolve, reject, {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 30000
  })
})

export function ScannerView({ sessions, initialSessionId, onCancel, onCreate, onOpenExisting, onUpdateExisting }: Props) {
  const [sessionId, setSessionId] = useState(initialSessionId || sessions[0]?.id || '')
  const [status, setStatus] = useState<'idle' | 'scanning' | 'locating' | 'ready' | 'error'>('idle')
  const [message, setMessage] = useState('Listo para escanear')
  const [manualCode, setManualCode] = useState('')
  const [draft, setDraft] = useState<ComputerRecord | null>(null)
  const [duplicates, setDuplicates] = useState<ComputerRecord[]>([])
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const lockedRef = useRef(false)

  const stopScanner = () => {
    controlsRef.current?.stop()
    controlsRef.current = null
    setStatus((current) => current === 'scanning' ? 'idle' : current)
  }

  useEffect(() => () => controlsRef.current?.stop(), [])

  const prepare = async (raw: string) => {
    if (!sessionId) {
      setStatus('error')
      setMessage('Primero selecciona una sesión')
      return
    }
    stopScanner()
    const stamp = nowWithZone()
    const parsed = parseScannedCode(raw)
    let next: ComputerRecord = {
      ...emptyComputer(sessionId),
      ...parsed,
      sessionId,
      originalCode: raw,
      scannedAt: stamp.iso,
      timezone: stamp.timezone,
      drives: parsed.drives?.length ? parsed.drives : emptyComputer(sessionId).drives
    }
    setStatus('locating')
    setMessage('Solicitando ubicación…')
    try {
      const position = await locate()
      next = {
        ...next,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy
      }
      setMessage('Ubicación registrada; revisa los datos')
    } catch {
      setMessage('Ubicación no disponible. Puedes continuar y añadir una referencia física.')
    }
    const matches = await findDuplicates(next.inventoryId, next.serialNumber)
    setDraft(next)
    setDuplicates(matches)
    setStatus('ready')
    lockedRef.current = false
    if (!matches.length) onCreate(next)
  }

  const startScanner = async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStatus('error')
      setMessage('La cámara requiere HTTPS. Usa la captura manual mientras tanto.')
      return
    }
    if (!sessionId) {
      setStatus('error')
      setMessage('Selecciona una sesión antes de escanear')
      return
    }
    setDuplicates([])
    setDraft(null)
    setMessage('Escaneando… apunta al QR o código de barras')
    setStatus('scanning')
    lockedRef.current = false
    try {
      const reader = new BrowserMultiFormatReader()
      controlsRef.current = await reader.decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: 'environment' } } },
        videoRef.current!,
        (result) => {
          if (result && !lockedRef.current) {
            lockedRef.current = true
            void prepare(result.getText())
          }
        }
      )
    } catch (error) {
      setStatus('error')
      setMessage(error instanceof Error ? `No fue posible abrir la cámara: ${error.message}` : 'No fue posible abrir la cámara')
    }
  }

  const submitManual = (event: React.FormEvent) => {
    event.preventDefault()
    if (!manualCode.trim()) return
    void prepare(manualCode.trim())
  }

  return (
    <main className="screen narrow-screen">
      <div className="screen-heading">
        <button className="icon-button" onClick={onCancel} aria-label="Volver">←</button>
        <div><p className="eyebrow">Captura</p><h1>Escanear y registrar</h1></div>
      </div>

      <label>Sesión de inventario
        <select value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
          <option value="">Selecciona una sesión</option>
          {sessions.map((session) => <option value={session.id} key={session.id}>{session.name}</option>)}
        </select>
      </label>

      <section className="scanner-card">
        <div className={`status-pill status-${status}`}><span />{message}</div>
        <div className="video-shell">
          <video ref={videoRef} playsInline muted aria-label="Vista de la cámara" />
          {status !== 'scanning' && <div className="scan-target"><span>⌗</span><small>La cámara aparecerá aquí</small></div>}
        </div>
        <div className="button-row">
          {status === 'scanning'
            ? <button className="secondary-button" onClick={stopScanner}>Detener cámara</button>
            : <button className="primary-button" onClick={() => void startScanner()}>Abrir cámara</button>}
        </div>
        {!window.isSecureContext && <p className="inline-note warning">Esta dirección no es HTTPS. La cámara y el GPS pueden estar bloqueados; la captura manual sigue disponible.</p>}
      </section>

      <form className="card manual-card" onSubmit={submitManual}>
        <h2>Captura manual</h2>
        <p className="muted">Pega o escribe el contenido del QR, serie o identificador.</p>
        <label>Contenido del código
          <textarea value={manualCode} onChange={(event) => setManualCode(event.target.value)} rows={3} placeholder="Ej. SN-ABC-123 o un JSON estructurado" />
        </label>
        <button className="secondary-button full-width" type="submit" disabled={!manualCode.trim()}>Continuar manualmente</button>
      </form>

      {duplicates.length > 0 && draft && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="duplicate-title">
          <section className="modal-card">
            <div className="modal-icon">!</div>
            <h2 id="duplicate-title">Posible duplicado</h2>
            <p>Coincide el número de serie o identificador con {duplicates.length === 1 ? 'un registro' : `${duplicates.length} registros`}.</p>
            <div className="duplicate-list">
              {duplicates.map((item) => (
                <article key={item.id}>
                  <strong>{item.inventoryId || 'Sin identificador'} · {item.serialNumber || 'Sin serie'}</strong>
                  <span>{item.brand} {item.model}</span>
                  <div className="button-row compact">
                    <button className="ghost-button" onClick={() => onOpenExisting(item.id)}>Abrir</button>
                    <button className="secondary-button" onClick={() => onUpdateExisting({
                      ...item,
                      originalCode: draft.originalCode,
                      scannedAt: draft.scannedAt,
                      timezone: draft.timezone,
                      latitude: draft.latitude,
                      longitude: draft.longitude,
                      accuracyMeters: draft.accuracyMeters
                    })}>Actualizar existente</button>
                  </div>
                </article>
              ))}
            </div>
            <button className="text-button" onClick={() => onCreate(draft)}>Registrar otro de todos modos</button>
          </section>
        </div>
      )}
    </main>
  )
}
