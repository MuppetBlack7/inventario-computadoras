import type { ComputerRecord, InventorySession } from './types'
import {
  computerLabel,
  createPlanBuilder,
  normalizeComputer,
  normalizeSession,
  sameEquipment,
  stripPhotoAndSync,
  type LocalInventory,
  type PlannedComputer,
  type RestorePlan
} from './restore'
import type { InventoryBackup } from './types'

export interface SharedImportSelection {
  /** Sesiones a importar. Si se omite, todas. */
  sessionIds?: ReadonlySet<string>
  /** Equipos a importar. Si se omite, todos. */
  computerIds?: ReadonlySet<string>
  /** Importar las fotografías incluidas en el archivo. */
  photos: boolean
}

export interface SharedImportOwner { id: string; name?: string; email?: string }

/**
 * Identificador determinista del registro importado: depende de la cuenta que importa y del identificador original.
 * Evita choques con los documentos del exportador y hace idempotente una segunda importación del mismo archivo.
 */
export const sharedRecordId = (ownerId: string, originalId: string) => `imp-${ownerId.slice(0, 8)}-${originalId}`

/**
 * Planifica la importación de un respaldo creado por otra persona. Nunca modifica ni reclama los registros originales:
 * crea registros nuevos bajo la cuenta actual, con identificadores nuevos y sin referencias remotas del exportador
 * (cloudId, fotografías privadas de ImageKit). Las fotografías del archivo se conservan localmente y se suben con el
 * flujo normal de sincronización. Los equipos que ya existen en el inventario (de cualquier cuenta) se omiten.
 */
export function planSharedImport(backup: InventoryBackup, selection: SharedImportSelection, local: LocalInventory, owner: SharedImportOwner | null): RestorePlan {
  const { plan, add } = createPlanBuilder({
    sessions: { enabled: true, mode: 'merge' },
    computers: { enabled: true, mode: 'merge' },
    photos: { enabled: selection.photos, mode: 'merge' }
  })
  if (!owner) {
    plan.blocking.push('Inicia sesión para importar: los registros se crean bajo tu cuenta.')
    return plan
  }
  const importedAt = new Date().toISOString()
  const fallbackDate = Number.isNaN(Date.parse(backup.exportedAt)) ? new Date(0).toISOString() : backup.exportedAt
  const importedFrom = (id: string) => ({ id, importedAt })

  const localSessions = new Map<string, InventorySession>()
  for (const session of local.sessions) {
    localSessions.set(session.id, session)
    if (session.cloudId) localSessions.set(session.cloudId, session)
  }

  const sessionMap = new Map<string, string>()
  for (const raw of backup.sessions) {
    const normalized = normalizeSession(raw, fallbackDate)
    if (typeof normalized === 'string') {
      add({ kind: 'session', id: typeof raw === 'object' && raw && 'id' in raw ? String(raw.id) : '?', label: 'Sesión', action: 'skip', reason: normalized, conflict: 'invalid' })
      continue
    }
    const selected = !selection.sessionIds || selection.sessionIds.has(normalized.id)
    const newId = sharedRecordId(owner.id, normalized.id)
    const existing = localSessions.get(normalized.id) ?? localSessions.get(newId)
    if (existing) {
      // La sesión ya está en el inventario (propia, ajena o importada antes): los equipos se enlazan a ella sin duplicarla.
      sessionMap.set(normalized.id, existing.id)
      if (selected) add({ kind: 'session', id: existing.id, label: normalized.name, action: 'skip', skipKind: 'identical', reason: 'Ya existe en el inventario; los equipos se enlazan a ella' })
      continue
    }
    if (!selected) continue
    sessionMap.set(normalized.id, newId)
    plan.sessions.push({
      record: {
        ...normalized,
        id: newId,
        ownerId: owner.id,
        ownerName: owner.name || '',
        ownerEmail: owner.email || '',
        cloudId: undefined,
        sharedCloud: false,
        syncStatus: 'local',
        syncError: undefined,
        importedFrom: importedFrom(normalized.id)
      },
      expectedUpdatedAt: null
    })
    add({ kind: 'session', id: newId, label: normalized.name, action: 'create' })
  }

  const seen: ComputerRecord[] = []
  const seenIds = new Set<string>()
  let remoteOnlyPhotos = 0
  for (const raw of backup.computers) {
    const normalized = normalizeComputer(raw, fallbackDate)
    if (typeof normalized === 'string') {
      add({ kind: 'computer', id: typeof raw === 'object' && raw && 'id' in raw ? String(raw.id) : '?', label: 'Equipo', action: 'skip', reason: normalized, conflict: 'invalid' })
      continue
    }
    const { record: incoming, photoDataUrl, photoInvalid } = normalized
    if (selection.computerIds && !selection.computerIds.has(incoming.id)) continue
    const label = computerLabel(incoming)
    if (photoInvalid) plan.warnings.push(`La fotografía de ${label} no tiene un formato compatible (JPEG, PNG o WebP) y se omitirá.`)
    if (seenIds.has(incoming.id) || seen.some((previous) => sameEquipment(previous, incoming))) {
      add({ kind: 'computer', id: incoming.id, label, action: 'skip', reason: 'Mismo equipo (serie o inventario) repetido dentro del archivo', conflict: 'duplicate-in-file' })
      continue
    }
    seenIds.add(incoming.id)
    seen.push(incoming)

    const newId = sharedRecordId(owner.id, incoming.id)
    const alreadyImported = local.computers.find((computer) => computer.id === newId || (computer.ownerId === owner.id && computer.importedFrom?.id === incoming.id))
    if (alreadyImported) {
      add({ kind: 'computer', id: alreadyImported.id, label, action: 'skip', skipKind: 'identical', reason: 'Ya se importó antes' })
      continue
    }
    const existing = local.computers.find((computer) => computer.id === incoming.id || computer.cloudId === incoming.id || sameEquipment(incoming, computer))
    if (existing) {
      add({
        kind: 'computer', id: existing.id, label, action: 'skip', conflict: 'duplicate-key',
        reason: existing.ownerId && existing.ownerId !== owner.id ? 'Ya existe en el inventario compartido (de otra cuenta)' : 'Ya existe un equipo tuyo con la misma serie o inventario; no se modifica'
      })
      continue
    }
    const sessionId = sessionMap.get(incoming.sessionId) ?? localSessions.get(incoming.sessionId)?.id
    if (!sessionId) {
      add({ kind: 'computer', id: incoming.id, label, action: 'skip', reason: 'Su sesión no está seleccionada ni existe en el inventario', conflict: 'missing-session' })
      continue
    }
    const record: ComputerRecord = {
      ...stripPhotoAndSync(incoming),
      id: newId,
      sessionId,
      ownerId: owner.id,
      ownerName: owner.name || '',
      ownerEmail: owner.email || '',
      cloudId: undefined,
      sharedCloud: false,
      syncStatus: 'local',
      importedFrom: importedFrom(incoming.id)
    }
    // Nunca se reutiliza photoRemote: pertenece al exportador y su limpieza podría borrar su fotografía.
    const photoSpec: PlannedComputer['photoSpec'] = selection.photos && photoDataUrl
      ? { dataUrl: photoDataUrl, name: incoming.photoName, isNew: true }
      : undefined
    if (selection.photos && !photoDataUrl && incoming.photoRemote) remoteOnlyPhotos += 1
    plan.computers.push({ record, expectedUpdatedAt: null, label, photoSpec })
    add({ kind: 'computer', id: newId, label, action: 'create' })
    if (photoSpec) add({ kind: 'photo', id: newId, label, action: 'create' })
  }
  if (remoteOnlyPhotos) plan.warnings.push(`${remoteOnlyPhotos} equipo${remoteOnlyPhotos === 1 ? '' : 's'} tenía${remoteOnlyPhotos === 1 ? '' : 'n'} la fotografía solo en el almacenamiento privado del exportador (sin copia en el archivo); se importará${remoteOnlyPhotos === 1 ? '' : 'n'} sin foto.`)
  if (!plan.sessions.length && !plan.computers.length && !plan.blocking.length) plan.warnings.push('No hay registros nuevos que importar con la selección actual.')
  return plan
}
