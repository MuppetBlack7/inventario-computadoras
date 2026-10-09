import { createRemoteJWKSet, jwtVerify } from 'jose'

export interface Env {
  FIREBASE_PROJECT_ID: string
  IMAGEKIT_URL_ENDPOINT: string
  IMAGEKIT_PRIVATE_KEY: string
}

type FirestoreFields = Record<string, { stringValue?: string; mapValue?: { fields?: FirestoreFields } }>
type PhotoReference = {
  fileId: string
  url: string
  filePath: string
  name: string
  size: number
  width: number | null
  height: number | null
  mimeType: string
  uploadedAt: string
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const ALLOWED_ORIGINS = new Set([
  'https://inventario-computadoras-rc26.web.app',
  'https://inventario-computadoras-rc26.firebaseapp.com',
  'http://localhost:4173',
  'http://localhost:4174',
  'http://localhost:5173'
])
const firebaseJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'))

export const isAllowedOrigin = (origin: string) => !origin || ALLOWED_ORIGINS.has(origin)

const corsHeaders = (origin: string) => ({
  ...(ALLOWED_ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  Vary: 'Origin'
})

const json = (origin: string, body: unknown, status = 200) =>
  Response.json(body, { status, headers: corsHeaders(origin) })

const getBearerToken = (request: Request) => {
  const value = request.headers.get('authorization') || ''
  return value.startsWith('Bearer ') ? value.slice(7) : ''
}

async function verifyFirebaseUser(request: Request, env: Env) {
  const token = getBearerToken(request)
  if (!token) throw new Response('missing-token', { status: 401 })
  try {
    const result = await jwtVerify(token, firebaseJwks, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
      algorithms: ['RS256']
    })
    if (!result.payload.sub) throw new Error('missing-subject')
    return { uid: result.payload.sub, token }
  } catch {
    throw new Response('invalid-token', { status: 401 })
  }
}

async function loadComputer(computerId: string, token: string, env: Env) {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/inventoryComputers/${encodeURIComponent(computerId)}`
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (response.status === 404) throw new Response('record-not-found', { status: 404 })
  if (!response.ok) throw new Response('firestore-rejected-request', { status: response.status === 401 || response.status === 403 ? 403 : 502 })
  return await response.json() as { fields?: FirestoreFields }
}

const stringField = (fields: FirestoreFields | undefined, name: string) => fields?.[name]?.stringValue || ''
const remotePhotoFields = (fields: FirestoreFields | undefined) => fields?.photoRemote?.mapValue?.fields

const imageKitAuthHeader = (privateKey: string) => `Basic ${btoa(`${privateKey}:`)}`

async function imageKitUpload(request: Request, uid: string, computerId: string, env: Env): Promise<PhotoReference> {
  const mimeType = (request.headers.get('content-type') || '').split(';')[0]
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) throw new Response('unsupported-image-format', { status: 415 })
  const declaredSize = Number(request.headers.get('content-length') || 0)
  if (declaredSize > MAX_IMAGE_BYTES) throw new Response('image-too-large', { status: 413 })
  const bytes = await request.arrayBuffer()
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new Response('invalid-image-size', { status: 413 })
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'
  const safeName = `${computerId}.${extension}`
  const form = new FormData()
  form.set('file', new File([bytes], safeName, { type: mimeType }))
  form.set('fileName', safeName)
  form.set('folder', `/inventario/${uid}`)
  form.set('isPrivateFile', 'true')
  form.set('useUniqueFileName', 'false')
  form.set('overwriteFile', 'true')
  form.set('tags', `inventario-computadoras,owner-${uid},computer-${computerId}`)
  const response = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
    method: 'POST',
    headers: { Authorization: imageKitAuthHeader(env.IMAGEKIT_PRIVATE_KEY) },
    body: form
  })
  const result = await response.json() as Record<string, unknown>
  if (!response.ok || !result.fileId || !result.url || !result.filePath) throw new Response('imagekit-upload-failed', { status: 502 })
  return {
    fileId: String(result.fileId),
    url: String(result.url),
    filePath: String(result.filePath),
    name: String(result.name || safeName),
    size: Number(result.size || bytes.byteLength),
    width: typeof result.width === 'number' ? result.width : null,
    height: typeof result.height === 'number' ? result.height : null,
    mimeType,
    uploadedAt: new Date().toISOString()
  }
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')

export async function buildSignedImageUrl(endpoint: string, privateKey: string, filePath: string, thumbnail: boolean, now = Date.now()) {
  const normalizedEndpoint = endpoint.replace(/\/$/, '')
  if (!normalizedEndpoint.startsWith('https://ik.imagekit.io/')) throw new Error('imagekit-endpoint-not-configured')
  const cleanPath = filePath.replace(/^\/+/, '')
  const transformation = thumbnail ? 'tr:w-320,h-240,c-at_max,q-78,f-webp' : 'tr:q-85,f-webp'
  const resourcePath = `${transformation}/${cleanPath}`
  const expiresAt = Math.floor(now / 1000) + 300
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(privateKey), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${resourcePath}${expiresAt}`))
  return { url: `${normalizedEndpoint}/${resourcePath}?ik-t=${expiresAt}&ik-s=${hex(signature)}`, expiresAt }
}

async function deleteImageKitFile(fileId: string, env: Env) {
  const response = await fetch(`https://api.imagekit.io/v1/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: imageKitAuthHeader(env.IMAGEKIT_PRIVATE_KEY) }
  })
  if (!response.ok && response.status !== 404) throw new Response('imagekit-delete-failed', { status: 502 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin') || ''
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })
    if (request.method !== 'POST') return json(origin, { error: 'Método no permitido' }, 405)
    if (!isAllowedOrigin(origin)) return json(origin, { error: 'Origen no autorizado' }, 403)
    try {
      const { uid, token } = await verifyFirebaseUser(request, env)
      if (!env.IMAGEKIT_PRIVATE_KEY || !env.IMAGEKIT_URL_ENDPOINT.startsWith('https://ik.imagekit.io/')) {
        return json(origin, { error: 'ImageKit no está configurado' }, 503)
      }
      const url = new URL(request.url)
      const action = url.pathname.replace(/^\/+|\/+$/g, '')
      const body = request.headers.get('content-type')?.includes('application/json')
        ? await request.clone().json() as { computerId?: string; fileId?: string; thumbnail?: boolean }
        : {}
      const computerId = url.searchParams.get('computerId') || body.computerId || ''
      if (!computerId || computerId.includes('/')) return json(origin, { error: 'Identificador inválido' }, 400)
      const computer = await loadComputer(computerId, token, env)
      const fields = computer.fields
      const ownerId = stringField(fields, 'ownerId')
      const storedPhoto = remotePhotoFields(fields)
      const storedFileId = stringField(storedPhoto, 'fileId')

      if (action === 'upload') {
        if (ownerId !== uid) return json(origin, { error: 'Solo el creador puede subir fotografías' }, 403)
        return json(origin, await imageKitUpload(request, uid, computerId, env))
      }
      if (action === 'sign') {
        if (!storedFileId || storedFileId !== body.fileId) return json(origin, { error: 'Fotografía no asociada' }, 404)
        const filePath = stringField(storedPhoto, 'filePath')
        return json(origin, await buildSignedImageUrl(env.IMAGEKIT_URL_ENDPOINT, env.IMAGEKIT_PRIVATE_KEY, filePath, Boolean(body.thumbnail)))
      }
      if (ownerId !== uid) return json(origin, { error: 'Solo el creador puede eliminar fotografías' }, 403)
      if (!body.fileId) return json(origin, { error: 'Falta fileId' }, 400)
      if (action === 'delete-current') {
        if (storedFileId !== body.fileId) return json(origin, { error: 'La fotografía activa cambió' }, 409)
        await deleteImageKitFile(body.fileId, env)
        return json(origin, { deleted: true })
      }
      if (action === 'cleanup-replaced') {
        if (storedFileId === body.fileId) return json(origin, { error: 'No se elimina la fotografía activa' }, 409)
        await deleteImageKitFile(body.fileId, env)
        return json(origin, { deleted: true })
      }
      return json(origin, { error: 'Operación no encontrada' }, 404)
    } catch (error) {
      if (error instanceof Response) {
        const message = await error.text()
        return json(origin, { error: message }, error.status)
      }
      console.error('ImageKit gateway error', error instanceof Error ? error.message : 'unknown')
      return json(origin, { error: 'No fue posible completar la operación' }, 502)
    }
  }
} satisfies ExportedHandler<Env>
