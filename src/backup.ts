import { listComputers, listSessions, listVisibleComputers, listVisibleSessions } from './db'
import type { InventoryBackup } from './types'
import { downloadBlob, photoToDataUrl } from './utils'
import { applyRestore, assertBackupStructure, planRestore, type RestoreOptions } from './restore'
import { downloadRemotePhoto } from './imageKitClient'

export async function createBackup(ownerId: string | null = null): Promise<InventoryBackup> {
  const [sessions, computers] = await Promise.all([listVisibleSessions(ownerId), listVisibleComputers(ownerId)])
  return {
    format: 'inventario-computadoras',
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions,
    computers: await Promise.all(computers.map(async ({ photo, ...computer }) => {
      const availablePhoto = photo || (computer.photoRemote
        ? await downloadRemotePhoto(computer.cloudId || computer.id, computer.photoRemote).catch(() => undefined)
        : undefined)
      return { ...computer, photoDataUrl: availablePhoto ? await photoToDataUrl(availablePhoto) : undefined }
    }))
  }
}

export async function downloadBackup(ownerId: string | null = null) {
  const backup = await createBackup(ownerId)
  const date = new Date().toISOString().slice(0, 10)
  downloadBlob(new Blob([JSON.stringify(backup)], { type: 'application/json' }), `respaldo-inventario-${date}.json`)
  return backup
}

export async function readBackupFile(file: File): Promise<InventoryBackup> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    throw new Error('El archivo no es un JSON válido')
  }
  return assertBackupStructure(parsed)
}

/**
 * Restaura todas las categorías del respaldo (modo combinar o reemplazar) y encola su sincronización.
 * La interfaz usa `planRestore` y `applyRestore` directamente para elegir categorías.
 */
export async function restoreBackup(backup: InventoryBackup, replace: boolean, ownerId: string | null = null) {
  const mode = replace ? 'replace' : 'merge'
  const options: RestoreOptions = { sessions: { enabled: true, mode }, computers: { enabled: true, mode }, photos: { enabled: true, mode } }
  const plan = planRestore(backup, options, { sessions: await listSessions(), computers: await listComputers() }, ownerId)
  if (plan.blocking.length || !ownerId) throw new Error(plan.blocking[0] || 'Inicia sesión para restaurar')
  const result = await applyRestore(plan, ownerId)
  return { sessions: result.created.sessions + result.updated.sessions, computers: result.created.computers + result.updated.computers }
}
