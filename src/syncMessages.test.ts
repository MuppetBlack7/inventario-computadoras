import { describe, expect, it } from 'vitest'
import { statusAfterSync, syncToast } from './syncMessages'

const labels = { synced: 'Sincronizado', local: 'Guardado local', failed: 'Guardado local; error al sincronizar' }

describe('mensajes de sincronización', () => {
  it('solo informa sincronizado si no hubo errores ni quedan operaciones pendientes', () => {
    expect(syncToast({ errors: 0, pending: 0 }, labels)).toBe('Sincronizado')
    expect(syncToast({ errors: 0, pending: 2 }, labels)).toBe('Guardado local; 2 operaciones pendientes')
    expect(syncToast({ errors: 0, pending: 1 }, labels)).toBe('Guardado local; 1 operación pendiente')
    expect(syncToast({ errors: 1, pending: 1 }, labels)).toBe(labels.failed)
  })

  it('sin resultado (sin conexión o sin sincronización ejecutada) nunca dice sincronizado', () => {
    const message = syncToast(undefined, labels)
    expect(message).not.toMatch(/^Sincronizado/)
    expect(message).toMatch(/Guardado local/)
    expect(message).toMatch(/recuperar la conexión/)
  })

  it('el indicador permanece en local o error mientras haya pendientes', () => {
    expect(statusAfterSync({ errors: 0, pending: 3 })).toEqual({ status: 'local', message: '3 pendientes de sincronizar' })
    expect(statusAfterSync({ errors: 1, pending: 3, lastError: 'Sin permiso' })).toEqual({ status: 'error', message: 'Error al sincronizar · Sin permiso' })
    expect(statusAfterSync({ errors: 0, pending: 0 })).toEqual({ status: 'synced', message: 'Sincronizado' })
    expect(statusAfterSync({ errors: 0, pending: 0 }, true).message).toBe('Actualizado ahora')
  })
})
