import { useEffect, useRef, useState } from 'react'
import { getSignedPhotoUrl, imageKitConfigured } from '../imageKitClient'
import type { ImageKitPhotoReference } from '../types'

interface Props {
  blob?: Blob
  alt: string
  className?: string
  unavailableOnDevice?: boolean
  computerId?: string
  remote?: ImageKitPhotoReference
  thumbnail?: boolean
}

export function PhotoPreview({ blob, alt, className, unavailableOnDevice = false, computerId, remote, thumbnail = false }: Props) {
  const [url, setUrl] = useState('')
  const [remoteState, setRemoteState] = useState<'idle' | 'loading' | 'error'>('idle')
  const holder = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  // Carga progresiva: la URL firmada solo se pide cuando la foto entra en pantalla.
  useEffect(() => {
    if (visible || !holder.current) return
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '200px' })
    observer.observe(holder.current)
    return () => observer.disconnect()
  }, [visible])
  useEffect(() => {
    let active = true
    if (blob) {
      const nextUrl = URL.createObjectURL(blob)
      setUrl(nextUrl)
      setRemoteState('idle')
      return () => { active = false; URL.revokeObjectURL(nextUrl) }
    }
    setUrl('')
    if (!remote || !computerId || !imageKitConfigured || !visible) return () => { active = false }
    setRemoteState('loading')
    void getSignedPhotoUrl(computerId, remote, thumbnail)
      .then((nextUrl) => { if (active) { setUrl(nextUrl); setRemoteState('idle') } })
      .catch(() => { if (active) setRemoteState('error') })
    return () => { active = false }
  }, [blob, computerId, remote, thumbnail, visible])

  if (!url) {
    const message = remoteState === 'loading' || (remote && !visible && imageKitConfigured)
      ? 'Cargando fotografía protegida…'
      : remoteState === 'error'
        ? 'Error al cargar la fotografía'
        : remote && !imageKitConfigured
          ? 'Fotografía en la nube pendiente de configurar'
          : unavailableOnDevice
            ? 'Fotografía no disponible en este dispositivo'
            : 'Sin fotografía'
    return <div ref={holder} className={`photo-placeholder ${className || ''}`} aria-label={message}><b>⌁</b><span>{message}</span></div>
  }
  return <img className={className} src={url} alt={alt} />
}
