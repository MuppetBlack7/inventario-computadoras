import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { buildSignedImageUrl, canCleanupImageKitFile, isAllowedOrigin, isSafePhotoPath, ownsImageKitFile } from '../src/index'

vi.mock('jose', () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: async () => ({ payload: { sub: 'alice' } })
}))

describe('ImageKit Worker', () => {
  it('solo admite los orígenes de la aplicación y desarrollo local', () => {
    expect(isAllowedOrigin('https://inventario-computadoras-rc26.web.app')).toBe(true)
    expect(isAllowedOrigin('http://localhost:4174')).toBe(true)
    expect(isAllowedOrigin('https://sitio-ajeno.example')).toBe(false)
  })

  it('genera URL firmada temporal sin incluir la clave privada', async () => {
    const result = await buildSignedImageUrl('https://ik.imagekit.io/demo', 'private_test_only', '/inventario/foto.jpg', true, 1_000_000)
    expect(result.url).toContain('ik-t=1300')
    expect(result.url).toContain('ik-s=')
    expect(result.url).not.toContain('private_test_only')
  })

  it('rechaza solicitudes sin sesión antes de comprobar secretos', async () => {
    const response = await worker.fetch(new Request('https://worker.example/sign', {
      method: 'POST',
      headers: {
        Origin: 'https://inventario-computadoras-rc26.web.app',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ computerId: 'equipo-1', fileId: 'foto-1' })
    }), {
      FIREBASE_PROJECT_ID: 'inventario-computadoras-rc26',
      IMAGEKIT_URL_ENDPOINT: 'CONFIGURAR_EN_CLOUDFLARE',
      IMAGEKIT_PRIVATE_KEY: ''
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'missing-token' })
  })

  it('solo autoriza limpiar archivos etiquetados para el usuario y equipo correctos', () => {
    const file = { fileId: 'photo-1', filePath: '/inventario/alice/photo-1.jpg', tags: ['inventario-computadoras', 'owner-alice', 'computer-equipo-1'] }
    expect(ownsImageKitFile(file, 'alice', 'equipo-1')).toBe(true)
    expect(canCleanupImageKitFile(file, 'alice', 'equipo-1', false)).toBe(true)
    expect(canCleanupImageKitFile(file, 'bob', 'equipo-1', false)).toBe(false)
    expect(canCleanupImageKitFile(file, 'alice', 'equipo-2', false)).toBe(false)
    expect(canCleanupImageKitFile(file, 'alice', 'equipo-1', true)).toBe(false)
  })
})

describe('firma de fotografías', () => {
  const env = { FIREBASE_PROJECT_ID: 'inventario-computadoras-rc26', IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/demo', IMAGEKIT_PRIVATE_KEY: 'private_test_only' }
  const document = (ownerId: string, filePath: string) => ({
    fields: {
      ownerId: { stringValue: ownerId },
      photoRemote: { mapValue: { fields: { fileId: { stringValue: 'file-1' }, filePath: { stringValue: filePath } } } }
    }
  })
  const sign = async (filePath: string, ownerId = 'bob') => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(document(ownerId, filePath))))
    return worker.fetch(new Request('https://worker.example/sign', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json', Authorization: 'Bearer token-de-prueba' },
      body: JSON.stringify({ computerId: 'equipo-1', fileId: 'file-1', thumbnail: true })
    }), env)
  }
  afterEach(() => vi.unstubAllGlobals())

  it('acepta solo rutas simples dentro de la carpeta del propietario del documento', () => {
    expect(isSafePhotoPath('/inventario/bob/equipo-1-abc.jpg', 'bob')).toBe(true)
    expect(isSafePhotoPath('/inventario/alice/equipo-1.jpg', 'bob')).toBe(false)
    expect(isSafePhotoPath('/otra-carpeta/secreto.jpg', 'bob')).toBe(false)
    expect(isSafePhotoPath('/inventario/bob/../alice/foto.jpg', 'bob')).toBe(false)
    expect(isSafePhotoPath('/inventario/bob/sub/foto.jpg', 'bob')).toBe(false)
    expect(isSafePhotoPath('/inventario/bob/foto.jpg?x=1', 'bob')).toBe(false)
    expect(isSafePhotoPath('/inventario/bob/', 'bob')).toBe(false)
    expect(isSafePhotoPath('/inventario//foto.jpg', '')).toBe(false)
  })

  it('firma una fotografía legítima sin exponer la clave privada', async () => {
    const response = await sign('/inventario/bob/equipo-1-abc.jpg')
    expect(response.status).toBe(200)
    const body = await response.json() as { url: string }
    expect(body.url).toContain('/tr:w-320,h-240,c-at_max,q-78,f-webp/inventario/bob/equipo-1-abc.jpg?ik-t=')
    expect(body.url).not.toContain('private_test_only')
  })

  it('un documento manipulado no obtiene enlaces firmados de archivos ajenos a /inventario', async () => {
    for (const path of ['/otra-carpeta/privado.jpg', '/inventario/alice/foto-de-alice.jpg', '/inventario/bob/../../privado.jpg']) {
      const response = await sign(path)
      expect(response.status).toBe(403)
      expect(JSON.stringify(await response.json())).not.toContain('ik-s=')
    }
  })
})
