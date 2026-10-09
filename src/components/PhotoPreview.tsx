import { useEffect, useState } from 'react'
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
  useEffect(() => {
    let active = true
    if (blob) {
      const nextUrl = URL.createObjectURL(blob)
      setUrl(nextUrl)
      setRemoteState('idle')
      return () => { active = false; URL.revokeObjectURL(nextUrl) }
    }
    setUrl('')
    if (!remote || !computerId || !imageKitConfigured) return () => { active = false }
    setRemoteState('loading')
    void getSignedPhotoUrl(computerId, remote, thumbnail)
      .then((nextUrl) => { if (active) { setUrl(nextUrl); setRemoteState('idle') } })
      .catch(() => { if (active) setRemoteState('error') })
    return () => { active = false }
  }, [blob, computerId, remote, thumbnail])

  if (!url) {
    const message = remoteState === 'loading'
      ? 'Cargando fotografía protegida…'
      : remoteState === 'error'
        ? 'Error al cargar la fotografía'
        : remote && !imageKitConfigured
          ? 'Fotografía en la nube pendiente de configurar'
          : unavailableOnDevice
            ? 'Fotografía no disponible en este dispositivo'
            : 'Sin fotografía'
    return <div className={`photo-placeholder ${className || ''}`} aria-label={message}><b>⌁</b><span>{message}</span></div>
  }
  return <img className={className} src={url} alt={alt} />
}
