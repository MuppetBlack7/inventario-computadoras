import { firebaseAuth } from './firebaseClient'
import type { ImageKitPhotoReference } from './types'

const backendUrl = String(import.meta.env.VITE_IMAGEKIT_BACKEND_URL || '').replace(/\/$/, '')
export const imageKitConfigured = Boolean(backendUrl)

const signedUrlCache = new Map<string, { url: string; expiresAt: number }>()

async function authenticatedFetch(path: string, init: RequestInit = {}) {
  const user = firebaseAuth?.currentUser
  if (!user) throw new Error('Inicia sesión para acceder a las fotografías')
  const token = await user.getIdToken()
  const response = await fetch(`${backendUrl}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` }
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; code?: string }
    const error = Object.assign(new Error(body.error || `ImageKit respondió ${response.status}`), {
      code: body.code || (response.status >= 500 ? 'unavailable' : response.status === 409 ? 'aborted' : 'permission-denied')
    })
    throw error
  }
  return response
}

export async function uploadPhotoToImageKit(computerId: string, photo: Blob, fileName = 'foto.jpg', uploadKey = computerId) {
  if (!imageKitConfigured) throw new Error('ImageKit está pendiente de configurar')
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.type)) throw new Error('Formato de fotografía no admitido')
  if (photo.size > 5 * 1024 * 1024) throw new Error('La fotografía supera el límite de 5 MB')
  const response = await authenticatedFetch(`/upload?computerId=${encodeURIComponent(computerId)}`, {
    method: 'POST',
    headers: { 'Content-Type': photo.type, 'X-File-Name': encodeURIComponent(fileName), 'X-Upload-Key': uploadKey },
    body: photo
  })
  return await response.json() as ImageKitPhotoReference
}

export async function getSignedPhotoUrl(computerId: string, reference: ImageKitPhotoReference, thumbnail = false) {
  if (!imageKitConfigured) throw new Error('ImageKit está pendiente de configurar')
  const cacheKey = `${reference.fileId}:${thumbnail ? 'thumb' : 'full'}`
  const cached = signedUrlCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.url
  const response = await authenticatedFetch('/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ computerId, fileId: reference.fileId, thumbnail })
  })
  const result = await response.json() as { url: string; expiresAt: number }
  signedUrlCache.set(cacheKey, { url: result.url, expiresAt: Math.min(result.expiresAt * 1000, Date.now() + 4 * 60 * 1000) })
  return result.url
}

export async function downloadRemotePhoto(computerId: string, reference: ImageKitPhotoReference) {
  const url = await getSignedPhotoUrl(computerId, reference)
  const response = await fetch(url)
  if (!response.ok) throw new Error('No fue posible descargar la fotografía protegida')
  return await response.blob()
}

export async function cleanupImageKitPhoto(computerId: string, fileId: string) {
  if (!imageKitConfigured) throw new Error('ImageKit está pendiente de configurar')
  const response = await authenticatedFetch('/cleanup-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ computerId, fileId })
  })
  return await response.json() as { deleted: boolean; alreadyDeleted?: boolean }
}
