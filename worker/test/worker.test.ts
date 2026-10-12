import { describe, expect, it } from 'vitest'
import worker, { buildSignedImageUrl, canCleanupImageKitFile, isAllowedOrigin, ownsImageKitFile } from '../src/index'

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
