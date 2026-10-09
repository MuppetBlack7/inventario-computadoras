import { listVisibleComputers, listVisibleSessions, mergeAllData, replaceAllData, saveComputer, saveSession } from './db'
import type { ComputerRecord, InventoryBackup } from './types'
import { dataUrlToBlob, downloadBlob, photoToDataUrl } from './utils'
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
  const parsed: unknown = JSON.parse(await file.text())
  if (!parsed || typeof parsed !== 'object') throw new Error('El archivo no contiene un respaldo válido')
  const backup = parsed as Partial<InventoryBackup>
  if (backup.format !== 'inventario-computadoras' || backup.version !== 1) {
    throw new Error('Formato o versión de respaldo no compatible')
  }
  if (!Array.isArray(backup.sessions) || !Array.isArray(backup.computers)) {
    throw new Error('El respaldo está incompleto')
  }
  return backup as InventoryBackup
}

export async function restoreBackup(backup: InventoryBackup, replace: boolean, ownerId: string | null = null) {
  const sessions = backup.sessions.map<InventoryBackup['sessions'][number]>((session) => {
    const recordOwner = session.ownerId || ownerId || undefined
    return { ...session, ownerId: recordOwner, sharedCloud: Boolean(session.cloudId), syncStatus: recordOwner === ownerId ? 'local' : 'synced', syncError: undefined }
  })
  const computers: ComputerRecord[] = backup.computers.map(({ photoDataUrl, ...computer }) => ({
    ...computer,
    equipmentType: computer.equipmentType || '',
    ownerId: computer.ownerId || ownerId || undefined,
    sharedCloud: Boolean(computer.cloudId),
    syncStatus: (computer.ownerId || ownerId) === ownerId ? 'local' : 'synced',
    syncError: undefined,
    photo: photoDataUrl ? dataUrlToBlob(photoDataUrl) : undefined,
    photoNeedsUpload: Boolean(photoDataUrl && !computer.photoRemote),
    photoUploadStatus: computer.photoRemote ? 'uploaded' : photoDataUrl ? 'pending' : computer.photoUploadStatus
  }))
  if (replace) await replaceAllData(sessions, computers)
  else await mergeAllData(sessions, computers)
  if (ownerId) {
    for (const session of sessions.filter((item) => item.ownerId === ownerId)) await saveSession(session, true)
    for (const computer of computers.filter((item) => item.ownerId === ownerId)) await saveComputer(computer, true)
  }
  return { sessions: sessions.length, computers: computers.length }
}
