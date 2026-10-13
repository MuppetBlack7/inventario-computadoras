import { applyRestoreBatch, getComputer, getPendingSyncQueue, listSessions, PHOTO_FIELDS, preparePhotoForStorage, type RestoreBatch } from './db'
import { verifyRemoteDocuments } from './cloudSync'
import { imageKitConfigured } from './imageKitClient'
import type { ComputerRecord, ImageKitPhotoReference, InventoryBackup, InventorySession, StorageDrive } from './types'
import { dataUrlToBlob, normalizeKey } from './utils'

export type RestoreMode = 'merge' | 'replace'
export interface CategoryOption { enabled: boolean; mode: RestoreMode }
export interface RestoreOptions { sessions: CategoryOption; computers: CategoryOption; photos: CategoryOption }

export const defaultRestoreOptions = (): RestoreOptions => ({
  sessions: { enabled: true, mode: 'merge' },
  computers: { enabled: true, mode: 'merge' },
  photos: { enabled: true, mode: 'merge' }
})

export type ConflictType =
  | 'foreign-owner' | 'duplicate-key' | 'duplicate-in-file' | 'missing-session'
  | 'invalid' | 'local-newer' | 'ambiguous' | 'no-recipient'

export type SkipKind = 'identical' | 'local-newer' | 'foreign-owner' | 'invalid' | 'missing-session' | 'duplicate' | 'photo-exists' | 'no-recipient'

export const SKIP_KIND_LABELS: Record<SkipKind, string> = {
  identical: 'Ya existen y son idénticos',
  'local-newer': 'El registro local es más reciente o cambió después del respaldo',
  'foreign-owner': 'Pertenecen a otra cuenta: no se modifican ni se reclaman. Solo su creador puede restaurarlos conservando la propiedad (iniciando sesión con su cuenta); o usa «Importar respaldo compartido» para crear copias tuyas',
  invalid: 'Datos inválidos o incompletos',
  'missing-session': 'Su sesión no existe',
  duplicate: 'Duplicados por inventario o serie',
  'photo-exists': 'Ya tienen fotografía',
  'no-recipient': 'Sin equipo destinatario para la fotografía'
}

export interface RestoreItem {
  kind: 'session' | 'computer' | 'photo'
  id: string
  label: string
  action: 'create' | 'update' | 'skip' | 'delete'
  reason?: string
  conflict?: ConflictType
  /** Solo en omisiones: categoría del motivo. */
  skipKind?: SkipKind
}

interface PhotoSpec { dataUrl?: string; remote?: ImageKitPhotoReference; name?: string; isNew: boolean }

export interface PlannedComputer {
  record: ComputerRecord
  expectedUpdatedAt: string | null
  label: string
  photoSpec?: PhotoSpec
  /** Fotografía local en el momento de la vista previa, solo para detectar una fotografía idéntica. */
  existingPhoto?: Blob
}

export interface RestorePlan {
  options: RestoreOptions
  sessions: Array<{ record: InventorySession; expectedUpdatedAt: string | null }>
  computers: PlannedComputer[]
  deletes: Array<{ id: string; expectedUpdatedAt: string; ownerId: string; label: string }>
  items: RestoreItem[]
  conflicts: RestoreItem[]
  summary: {
    sessions: { create: number; update: number; skip: number }
    computers: { create: number; update: number; skip: number; delete: number }
    photos: { restore: number; skip: number }
  }
  blocking: string[]
  warnings: string[]
  /** Hay eliminaciones o sustituciones de registros existentes. */
  destructive: boolean
}

export interface LocalInventory { sessions: InventorySession[]; computers: ComputerRecord[] }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' ? value : ''
const numberOrNull = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
const validDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))
const PHOTO_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/

/** Validación estructural del archivo. No modifica ningún dato. */
export function assertBackupStructure(parsed: unknown): InventoryBackup {
  if (!isRecord(parsed)) throw new Error('El archivo no contiene un respaldo válido')
  if (parsed.format !== 'inventario-computadoras' || parsed.version !== 1) throw new Error('Formato o versión de respaldo no compatible')
  if (!Array.isArray(parsed.sessions) || !Array.isArray(parsed.computers)) throw new Error('El respaldo está incompleto')
  return parsed as unknown as InventoryBackup
}

export const countBackupPhotos = (backup: InventoryBackup) =>
  backup.computers.filter((computer) => isRecord(computer) && typeof computer.photoDataUrl === 'string' && computer.photoDataUrl).length

const normalizeDrives = (value: unknown): StorageDrive[] => Array.isArray(value)
  ? value.filter(isRecord).map((drive, index) => ({
    id: text(drive.id) || `drive-${index}`,
    capacityGB: numberOrNull(drive.capacityGB),
    type: drive.type === 'HDD' || drive.type === 'SSD' ? drive.type : 'Desconocido'
  }))
  : []

export const normalizeSession = (raw: unknown, fallbackDate: string): InventorySession | string => {
  if (!isRecord(raw)) return 'Sesión con formato inválido'
  const id = text(raw.id).trim()
  if (!id) return 'Sesión sin identificador'
  if (!text(raw.name).trim()) return 'Sesión sin nombre'
  const createdAt = validDate(raw.createdAt) ? raw.createdAt : fallbackDate
  return {
    ...(raw as unknown as InventorySession),
    id,
    name: text(raw.name),
    date: text(raw.date),
    location: text(raw.location),
    ownerId: text(raw.ownerId) || undefined,
    cloudId: text(raw.cloudId) || undefined,
    createdAt,
    updatedAt: validDate(raw.updatedAt) ? raw.updatedAt : createdAt
  }
}

export const normalizeComputer = (raw: unknown, fallbackDate: string): { record: ComputerRecord; photoDataUrl?: string; photoInvalid: boolean } | string => {
  if (!isRecord(raw)) return 'Equipo con formato inválido'
  const id = text(raw.id).trim()
  if (!id) return 'Equipo sin identificador'
  if (!text(raw.sessionId).trim()) return 'Equipo sin sesión'
  const inventoryId = text(raw.inventoryId)
  const serialNumber = text(raw.serialNumber)
  if (!inventoryId.trim() && !serialNumber.trim()) return 'Equipo sin número de inventario ni de serie'
  const { photoDataUrl, ...rest } = raw
  const createdAt = validDate(raw.createdAt) ? raw.createdAt : fallbackDate
  const dataUrl = typeof photoDataUrl === 'string' && photoDataUrl ? photoDataUrl : undefined
  const photoInvalid = Boolean(dataUrl && !PHOTO_URL.test(dataUrl))
  const record: ComputerRecord = {
    ...(rest as unknown as ComputerRecord),
    id,
    sessionId: text(raw.sessionId),
    inventoryId,
    inventoryNormalized: normalizeKey(inventoryId),
    serialNumber,
    serialNormalized: normalizeKey(serialNumber),
    equipmentType: (text(raw.equipmentType) || '') as ComputerRecord['equipmentType'],
    brand: text(raw.brand),
    model: text(raw.model),
    manufacturingYear: numberOrNull(raw.manufacturingYear),
    yearUnknown: typeof raw.yearUnknown === 'boolean' ? raw.yearUnknown : true,
    operatingSystem: text(raw.operatingSystem),
    ramGB: numberOrNull(raw.ramGB),
    drives: normalizeDrives(raw.drives),
    originalCode: text(raw.originalCode),
    scannedAt: text(raw.scannedAt) || createdAt,
    timezone: text(raw.timezone),
    latitude: numberOrNull(raw.latitude),
    longitude: numberOrNull(raw.longitude),
    accuracyMeters: numberOrNull(raw.accuracyMeters),
    writtenLocation: text(raw.writtenLocation),
    notes: text(raw.notes),
    ownerId: text(raw.ownerId) || undefined,
    cloudId: text(raw.cloudId) || undefined,
    createdAt,
    updatedAt: validDate(raw.updatedAt) ? raw.updatedAt : createdAt
  }
  return { record, photoDataUrl: photoInvalid ? undefined : dataUrl, photoInvalid }
}

export const stripPhotoAndSync = (record: ComputerRecord): ComputerRecord => {
  const copy: Record<string, unknown> = { ...record }
  for (const field of PHOTO_FIELDS) delete copy[field]
  delete copy.syncStatus
  delete copy.syncError
  return copy as unknown as ComputerRecord
}

/**
 * Dos registros son el mismo equipo si comparten número de serie, o comparten inventario sin series distintas.
 * Marcadores como "NO ETIQUETADO" se repiten en equipos con series diferentes y no deben tratarse como duplicados.
 */
export const sameEquipment = (a: Pick<ComputerRecord, 'serialNormalized' | 'inventoryNormalized'>, b: Pick<ComputerRecord, 'serialNormalized' | 'inventoryNormalized'>) => {
  if (a.serialNormalized && a.serialNormalized === b.serialNormalized) return true
  if (a.serialNormalized && b.serialNormalized) return false
  return Boolean(a.inventoryNormalized) && a.inventoryNormalized === b.inventoryNormalized
}

const hasPhoto = (computer: ComputerRecord) => Boolean(computer.photo || computer.photoRemote)
export const computerLabel = (computer: Pick<ComputerRecord, 'inventoryId' | 'serialNumber' | 'id'>) => computer.inventoryId || computer.serialNumber || computer.id

const skipKindOf = (item: RestoreItem): SkipKind => {
  switch (item.conflict) {
    case 'foreign-owner': return 'foreign-owner'
    case 'invalid': return 'invalid'
    case 'missing-session': return 'missing-session'
    case 'duplicate-key': case 'duplicate-in-file': case 'ambiguous': return 'duplicate'
    case 'local-newer': return 'local-newer'
    case 'no-recipient': return 'no-recipient'
    default: return 'identical'
  }
}

const IGNORED_FOR_COMPARISON = new Set(['updatedAt', 'createdAt', 'syncStatus', 'syncError', 'sharedCloud', 'ownerName', 'ownerEmail', 'ownerId', 'cloudId', 'photo', ...PHOTO_FIELDS])
/** Compara el contenido de un registro del respaldo con el local, ignorando fechas, propietario visible y estado de sincronización. */
const blank = (value: unknown) => value === undefined || value === '' ? null : value
const sameContent = (incoming: object, existing: object) => {
  const left = incoming as Record<string, unknown>
  const right = existing as Record<string, unknown>
  return Object.keys(left).every((key) => IGNORED_FOR_COMPARISON.has(key) || JSON.stringify(blank(left[key])) === JSON.stringify(blank(right[key])))
}

export interface SkipGroup { kind: SkipKind; label: string; count: number; items: Array<{ kind: RestoreItem['kind']; id: string; label: string; reason?: string }> }

/** Agrupa las omisiones por motivo, con el identificador de cada registro. */
export function summarizeSkips(plan: Pick<RestorePlan, 'items'>): SkipGroup[] {
  const groups = new Map<SkipKind, SkipGroup>()
  for (const item of plan.items) {
    if (item.action !== 'skip' || !item.skipKind) continue
    const group = groups.get(item.skipKind) ?? { kind: item.skipKind, label: SKIP_KIND_LABELS[item.skipKind], count: 0, items: [] }
    group.count += 1
    group.items.push({ kind: item.kind, id: item.id, label: item.label, reason: item.reason })
    groups.set(item.skipKind, group)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

export interface BackupOwnership { mine: number; others: number; unowned: number; otherAccounts: number }

/**
 * Cuenta a quién pertenecen los registros del archivo según su campo ownerId. Es informativo: el campo del JSON no
 * prueba identidad; la propiedad real la deciden las reglas de Firestore al escribir con la sesión de cada cuenta.
 */
export function summarizeBackupOwnership(backup: InventoryBackup, ownerId: string | null): BackupOwnership {
  const result: BackupOwnership = { mine: 0, others: 0, unowned: 0, otherAccounts: 0 }
  const accounts = new Set<string>()
  for (const record of [...backup.sessions, ...backup.computers]) {
    const id = isRecord(record) ? text(record.ownerId) : ''
    if (!id) result.unowned += 1
    else if (id === ownerId) result.mine += 1
    else { result.others += 1; accounts.add(id) }
  }
  result.otherAccounts = accounts.size
  return result
}

export const planHasChanges = (plan: RestorePlan) => plan.sessions.length + plan.computers.length + plan.deletes.length > 0

export function createPlanBuilder(options: RestoreOptions) {
  const plan: RestorePlan = {
    options, sessions: [], computers: [], deletes: [], items: [], conflicts: [],
    summary: { sessions: { create: 0, update: 0, skip: 0 }, computers: { create: 0, update: 0, skip: 0, delete: 0 }, photos: { restore: 0, skip: 0 } },
    blocking: [], warnings: [], destructive: false
  }
  const add = (item: RestoreItem) => {
    if (item.action === 'skip' && !item.skipKind) item.skipKind = skipKindOf(item)
    plan.items.push(item)
    if (item.conflict) plan.conflicts.push(item)
    if (item.kind === 'session') plan.summary.sessions[item.action === 'delete' ? 'skip' : item.action] += 1
    else if (item.kind === 'computer') plan.summary.computers[item.action] += 1
    else plan.summary.photos[item.action === 'skip' ? 'skip' : 'restore'] += 1
  }
  return { plan, add }
}

/**
 * Calcula, sin modificar nada, qué haría una restauración: altas, actualizaciones, omisiones, eliminaciones y conflictos.
 * Los registros de otros usuarios nunca se modifican, se reclaman ni se eliminan.
 */
export function planRestore(backup: InventoryBackup, options: RestoreOptions, local: LocalInventory, ownerId: string | null): RestorePlan {
  const { plan, add } = createPlanBuilder(options)
  if (!ownerId) plan.blocking.push('Inicia sesión para restaurar: los registros restaurados se sincronizan con tu cuenta.')
  if (!options.sessions.enabled && !options.computers.enabled && !options.photos.enabled) plan.blocking.push('Selecciona al menos una categoría para importar.')
  if (!ownerId) return plan
  const owner = ownerId

  const exportedAt = validDate(backup.exportedAt) ? backup.exportedAt : undefined
  const fallbackDate = exportedAt || new Date(0).toISOString()
  // Un cambio local posterior a la fecha del respaldo nunca se sobrescribe al reemplazar.
  const protectedAfter = (backupRecordUpdatedAt: string) => exportedAt || backupRecordUpdatedAt

  const localSessions = new Map<string, InventorySession>()
  for (const session of local.sessions) {
    localSessions.set(session.id, session)
    if (session.cloudId) localSessions.set(session.cloudId, session)
  }
  const findSession = (session: InventorySession) => localSessions.get(session.id) ?? (session.cloudId ? localSessions.get(session.cloudId) : undefined)

  const localById = new Map<string, ComputerRecord>()
  for (const computer of local.computers) {
    localById.set(computer.id, computer)
    if (computer.cloudId) localById.set(computer.cloudId, computer)
  }

  // --- Sesiones ---
  const sessionMap = new Map<string, string>()
  const seenSessions = new Set<string>()
  for (const raw of backup.sessions) {
    const normalized = normalizeSession(raw, fallbackDate)
    const rawId = isRecord(raw) ? text(raw.id) : ''
    if (typeof normalized === 'string') {
      add({ kind: 'session', id: rawId || '?', label: isRecord(raw) ? text(raw.name) || rawId || 'Sesión' : 'Sesión', action: 'skip', reason: normalized, conflict: 'invalid' })
      continue
    }
    if (seenSessions.has(normalized.id)) {
      add({ kind: 'session', id: normalized.id, label: normalized.name, action: 'skip', reason: 'Identificador repetido en el archivo', conflict: 'duplicate-in-file' })
      continue
    }
    seenSessions.add(normalized.id)
    const existing = findSession(normalized)
    const foreignRecord = normalized.ownerId && normalized.ownerId !== owner
    if (existing) {
      sessionMap.set(normalized.id, existing.id)
      if (existing.ownerId && existing.ownerId !== owner) {
        if (options.sessions.enabled) add({ kind: 'session', id: existing.id, label: normalized.name, action: 'skip', reason: 'La sesión pertenece a otro usuario; no se modifica', conflict: 'foreign-owner' })
        continue
      }
      if (!options.sessions.enabled) continue
      if (options.sessions.mode === 'merge' && existing.updatedAt >= normalized.updatedAt) {
        add({ kind: 'session', id: existing.id, label: normalized.name, action: 'skip', ...(existing.updatedAt === normalized.updatedAt || sameContent(normalized, existing) ? { skipKind: 'identical' as const, reason: 'Idéntica a la local' } : { skipKind: 'local-newer' as const, reason: 'El cambio local es más reciente' }) })
        continue
      }
      if (options.sessions.mode === 'replace' && existing.updatedAt > protectedAfter(normalized.updatedAt)) {
        add({ kind: 'session', id: existing.id, label: normalized.name, action: 'skip', reason: 'Cambió en este dispositivo después del respaldo', conflict: 'local-newer' })
        continue
      }
      const base = options.sessions.mode === 'merge' ? { ...existing, ...normalized } : { ...normalized }
      const record: InventorySession = {
        ...base,
        id: existing.id,
        cloudId: existing.cloudId ?? normalized.cloudId,
        sharedCloud: Boolean(existing.cloudId ?? normalized.cloudId),
        ownerId: existing.ownerId || owner,
        ownerName: existing.ownerName || normalized.ownerName || '',
        ownerEmail: existing.ownerEmail || normalized.ownerEmail || '',
        createdAt: existing.createdAt
      }
      plan.sessions.push({ record, expectedUpdatedAt: existing.updatedAt })
      if (options.sessions.mode === 'replace') plan.destructive = true
      add({ kind: 'session', id: existing.id, label: normalized.name, action: 'update' })
      continue
    }
    if (foreignRecord) {
      if (options.sessions.enabled) add({ kind: 'session', id: normalized.id, label: normalized.name, action: 'skip', reason: 'La sesión pertenece a otro usuario; no se reclama', conflict: 'foreign-owner' })
      continue
    }
    if (!options.sessions.enabled) continue
    sessionMap.set(normalized.id, normalized.id)
    plan.sessions.push({
      record: { ...normalized, ownerId: owner, sharedCloud: Boolean(normalized.cloudId), syncStatus: 'local', syncError: undefined },
      expectedUpdatedAt: null
    })
    add({ kind: 'session', id: normalized.id, label: normalized.name, action: 'create' })
  }

  // --- Equipos y fotografías ---
  const matchedLocalIds = new Set<string>()
  const seenIds = new Set<string>()
  const seenRecords: ComputerRecord[] = []
  const resolveSession = (sessionId: string) => sessionMap.get(sessionId) ?? localSessions.get(sessionId)?.id
  const photosOnly = !options.computers.enabled && options.photos.enabled
  let recipients = 0

  for (const raw of backup.computers) {
    const normalized = normalizeComputer(raw, fallbackDate)
    const rawId = isRecord(raw) ? text(raw.id) : ''
    if (typeof normalized === 'string') {
      add({ kind: 'computer', id: rawId || '?', label: rawId || 'Equipo', action: 'skip', reason: normalized, conflict: 'invalid' })
      continue
    }
    const { record: incoming, photoDataUrl, photoInvalid } = normalized
    const label = computerLabel(incoming)
    if (photoInvalid) plan.warnings.push(`La fotografía de ${label} no tiene un formato compatible (JPEG, PNG o WebP) y se omitirá.`)
    const repeated = seenIds.has(incoming.id) || seenRecords.some((previous) => sameEquipment(previous, incoming))
    seenIds.add(incoming.id)
    seenRecords.push(incoming)
    if (repeated) {
      add({ kind: 'computer', id: incoming.id, label, action: 'skip', reason: 'Mismo equipo (serie o inventario) repetido dentro del archivo', conflict: 'duplicate-in-file' })
      continue
    }

    // Coincidencia: identificador estable primero y después números normalizados.
    const candidates = new Set<ComputerRecord>()
    const byId = localById.get(incoming.id) ?? (incoming.cloudId ? localById.get(incoming.cloudId) : undefined)
    if (byId) candidates.add(byId)
    else for (const computer of local.computers) if (sameEquipment(incoming, computer)) candidates.add(computer)
    if (candidates.size > 1) {
      add({ kind: 'computer', id: incoming.id, label, action: 'skip', reason: 'Coincide con varios equipos existentes; revísalo manualmente', conflict: 'ambiguous' })
      for (const candidate of candidates) matchedLocalIds.add(candidate.id)
      continue
    }
    const existing = [...candidates][0]
    const matchedByKeyOnly = Boolean(existing && !byId)
    if (existing) matchedLocalIds.add(existing.id)

    if (existing && existing.ownerId && existing.ownerId !== owner) {
      add({ kind: 'computer', id: existing.id, label, action: 'skip', reason: matchedByKeyOnly ? 'Ya existe un equipo de otro usuario con el mismo inventario o serie' : 'El equipo pertenece a otro usuario; no se modifica', conflict: matchedByKeyOnly ? 'duplicate-key' : 'foreign-owner' })
      continue
    }
    if (!existing && incoming.ownerId && incoming.ownerId !== owner) {
      add({ kind: 'computer', id: incoming.id, label, action: 'skip', reason: 'El equipo pertenece a otro usuario; no se reclama', conflict: 'foreign-owner' })
      continue
    }

    const sessionId = resolveSession(incoming.sessionId)
    const photoWanted = options.photos.enabled && Boolean(photoDataUrl)

    if (!existing) {
      if (!options.computers.enabled) {
        if (photoWanted) add({ kind: 'photo', id: incoming.id, label, action: 'skip', reason: 'No existe un equipo destinatario en el inventario', conflict: 'no-recipient' })
        continue
      }
      if (!sessionId) {
        add({ kind: 'computer', id: incoming.id, label, action: 'skip', reason: 'Su sesión no existe en el inventario ni se está importando', conflict: 'missing-session' })
        continue
      }
      const withRemote = options.photos.enabled && incoming.photoRemote
      const record: ComputerRecord = {
        ...stripPhotoAndSync(incoming),
        sessionId,
        ownerId: owner,
        sharedCloud: Boolean(incoming.cloudId),
        syncStatus: 'local'
      }
      const photoSpec: PhotoSpec | undefined = photoWanted || withRemote
        ? { dataUrl: photoWanted ? photoDataUrl : undefined, remote: withRemote ? incoming.photoRemote : undefined, name: incoming.photoName, isNew: true }
        : undefined
      plan.computers.push({ record, expectedUpdatedAt: null, label, photoSpec })
      add({ kind: 'computer', id: incoming.id, label, action: 'create' })
      if (photoWanted) add({ kind: 'photo', id: incoming.id, label, action: 'create' })
      continue
    }

    // Equipo existente propio (o sin propietario) con coincidencia.
    recipients += photoWanted ? 1 : 0
    let recordUpdate: ComputerRecord | undefined
    if (options.computers.enabled) {
      const mode = options.computers.mode
      if (!sessionId) {
        add({ kind: 'computer', id: existing.id, label, action: 'skip', reason: 'Su sesión no existe en el inventario ni se está importando', conflict: 'missing-session' })
      } else if (mode === 'merge' && existing.updatedAt >= incoming.updatedAt) {
        add({ kind: 'computer', id: existing.id, label, action: 'skip', ...(existing.updatedAt === incoming.updatedAt || sameContent(incoming, existing) ? { skipKind: 'identical' as const, reason: 'Idéntico al local' } : { skipKind: 'local-newer' as const, reason: 'El cambio local es más reciente' }) })
      } else if (mode === 'replace' && existing.updatedAt > protectedAfter(incoming.updatedAt)) {
        add({ kind: 'computer', id: existing.id, label, action: 'skip', reason: 'Cambió en este dispositivo después del respaldo', conflict: 'local-newer' })
      } else {
        const base = mode === 'merge' ? { ...stripPhotoAndSync(existing), ...stripPhotoAndSync(incoming) } : stripPhotoAndSync(incoming)
        recordUpdate = {
          ...base,
          id: existing.id,
          sessionId,
          cloudId: existing.cloudId ?? incoming.cloudId,
          sharedCloud: Boolean(existing.cloudId ?? incoming.cloudId),
          ownerId: existing.ownerId || owner,
          ownerName: existing.ownerName || incoming.ownerName || '',
          ownerEmail: existing.ownerEmail || incoming.ownerEmail || '',
          createdAt: existing.createdAt,
          syncStatus: 'local'
        }
        if (mode === 'replace') plan.destructive = true
        if (matchedByKeyOnly) plan.conflicts.push({ kind: 'computer', id: existing.id, label, action: 'update', reason: 'Mismo inventario o serie que un equipo existente; se actualiza ese registro sin duplicar', conflict: 'duplicate-key' })
        add({ kind: 'computer', id: existing.id, label, action: 'update' })
      }
    }

    let photoSpec: PhotoSpec | undefined
    if (photoWanted) {
      if (options.photos.mode === 'merge' && hasPhoto(existing)) {
        add({ kind: 'photo', id: existing.id, label, action: 'skip', skipKind: 'photo-exists', reason: 'El equipo ya tiene fotografía' })
      } else if (options.photos.mode === 'replace' && existing.updatedAt > protectedAfter(incoming.updatedAt)) {
        add({ kind: 'photo', id: existing.id, label, action: 'skip', reason: 'Cambió en este dispositivo después del respaldo', conflict: 'local-newer' })
      } else {
        photoSpec = { dataUrl: photoDataUrl, name: incoming.photoName, isNew: false }
        if (options.photos.mode === 'replace' && hasPhoto(existing)) plan.destructive = true
        add({ kind: 'photo', id: existing.id, label, action: 'update' })
      }
    }
    if (recordUpdate || photoSpec) {
      plan.computers.push({
        record: recordUpdate ?? stripPhotoAndSync(existing),
        expectedUpdatedAt: existing.updatedAt,
        label,
        photoSpec,
        existingPhoto: existing.photo
      })
    }
  }

  // --- Reemplazo de equipos: elimina solo equipos propios de las sesiones incluidas en el archivo ---
  if (options.computers.enabled && options.computers.mode === 'replace') {
    const scope = new Set(sessionMap.values())
    for (const computer of local.computers) {
      if (!scope.has(computer.sessionId) || matchedLocalIds.has(computer.id)) continue
      if (computer.ownerId && computer.ownerId !== owner) continue
      const label = computerLabel(computer)
      if (exportedAt && computer.updatedAt > exportedAt) {
        add({ kind: 'computer', id: computer.id, label, action: 'skip', reason: 'No está en el respaldo pero cambió después de crearlo; se conserva', conflict: 'local-newer' })
        continue
      }
      plan.deletes.push({ id: computer.id, expectedUpdatedAt: computer.updatedAt, ownerId: owner, label })
      add({ kind: 'computer', id: computer.id, label, action: 'delete', reason: 'No está en el respaldo' })
    }
    if (plan.deletes.length) plan.destructive = true
  }

  if (photosOnly && recipients === 0 && countBackupPhotos(backup) > 0) {
    const message = 'No hay equipos destinatarios para las fotografías: ningún equipo del archivo coincide con tu inventario.'
    if (options.sessions.enabled) plan.warnings.push(message)
    else plan.blocking.push(message)
  }
  if (options.photos.enabled && countBackupPhotos(backup) === 0) plan.warnings.push('El archivo no contiene fotografías.')
  if (!plan.sessions.length && !plan.computers.length && !plan.deletes.length && !plan.blocking.length) plan.warnings.push('No hay cambios que aplicar con las opciones seleccionadas.')
  return plan
}

export interface RestoreResult {
  created: { sessions: number; computers: number }
  updated: { sessions: number; computers: number }
  skipped: number
  skippedBy: Partial<Record<SkipKind, number>>
  deleted: number
  photosRestored: number
  errors: string[]
  queuedIds: string[]
  sessionIds: string[]
  computerIds: string[]
  deletedRemoteIds: string[]
}

const sameBytes = async (left: Blob, right: Blob) => {
  if (left.size !== right.size) return false
  const [a, b] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]).then((buffers) => buffers.map((buffer) => new Uint8Array(buffer)))
  return a.every((value, index) => value === b[index])
}

export type RestoreProgress = (stage: string, done?: number, total?: number) => void

/** Prepara las fotografías y escribe todo en una sola transacción. Si algo falla, no se aplica ningún cambio. */
export async function applyRestore(plan: RestorePlan, ownerId: string, onProgress: RestoreProgress = () => undefined): Promise<RestoreResult> {
  if (plan.blocking.length) throw new Error(plan.blocking[0])
  const errors: string[] = []
  const batch: RestoreBatch = {
    sessions: plan.sessions.map(({ record, expectedUpdatedAt }) => ({ record, expectedUpdatedAt })),
    computers: [],
    deletes: plan.deletes.map(({ id, expectedUpdatedAt, ownerId: owner }) => ({ id, expectedUpdatedAt, ownerId: owner }))
  }
  let index = 0
  for (const planned of plan.computers) {
    index += 1
    if (planned.photoSpec?.dataUrl) onProgress('Preparando fotografías', index, plan.computers.length)
    const spec = planned.photoSpec
    let photo: Blob | undefined
    let photoFields: Partial<ComputerRecord> | undefined
    if (spec) {
      if (spec.dataUrl) {
        try {
          photo = await preparePhotoForStorage(dataUrlToBlob(spec.dataUrl))
          if (planned.existingPhoto && await sameBytes(photo, planned.existingPhoto).catch(() => false)) photo = undefined
          else photoFields = {
            photoName: spec.name || 'respaldo',
            photoNeedsUpload: !(spec.isNew && spec.remote),
            photoUploadStatus: spec.isNew && spec.remote ? 'uploaded' : 'pending',
            photoUploadError: undefined,
            photoStoredLocally: undefined,
            photoLocalRevision: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
            ...(spec.isNew && spec.remote ? { photoRemote: spec.remote } : {})
          }
        } catch (error) {
          errors.push(`${planned.label}: no se pudo restaurar la fotografía (${error instanceof Error ? error.message : 'error desconocido'}); se conserva la existente.`)
        }
      } else if (spec.isNew && spec.remote) {
        photoFields = { photoRemote: spec.remote, photoNeedsUpload: false, photoUploadStatus: 'uploaded' }
      }
    }
    batch.computers.push({ record: planned.record, photo, photoFields, expectedUpdatedAt: planned.expectedUpdatedAt })
  }

  onProgress('Guardando en este dispositivo')
  let written
  try {
    written = await applyRestoreBatch(batch)
  } catch (error) {
    throw new Error(`No se aplicó ningún cambio: ${error instanceof Error ? error.message : 'error desconocido'}`)
  }
  for (const changed of written.changedMeanwhile) errors.push(`${changed.kind === 'session' ? 'Sesión' : 'Equipo'} ${changed.id}: cambió mientras se restauraba y se conservó sin modificar.`)
  const photoIds = new Set(batch.computers.filter((entry) => entry.photo || entry.photoFields?.photoRemote).map((entry) => entry.record.id))
  const appliedComputers = new Set(written.computers.map((entry) => entry.id))
  void ownerId
  return {
    created: { sessions: written.sessions.filter((entry) => entry.created).length, computers: written.computers.filter((entry) => entry.created).length },
    updated: { sessions: written.sessions.filter((entry) => !entry.created).length, computers: written.computers.filter((entry) => !entry.created).length },
    skipped: plan.items.filter((item) => item.action === 'skip' && item.kind !== 'photo').length,
    skippedBy: Object.fromEntries(summarizeSkips(plan).map((group) => [group.kind, group.count])),
    deleted: written.deleted.length,
    photosRestored: [...photoIds].filter((id) => appliedComputers.has(id)).length,
    errors,
    queuedIds: written.queuedIds,
    sessionIds: written.sessions.map((entry) => entry.id),
    computerIds: written.computers.map((entry) => entry.id),
    deletedRemoteIds: written.deleted.map((entry) => entry.remoteId || entry.id)
  }
}

export type RestoreSyncState = 'nothing' | 'local-only' | 'pending' | 'unverified' | 'photos-pending' | 'synced'
export interface RestoreOutcome {
  state: RestoreSyncState
  message: string
  pending: number
  confirmed: number
  photosPending: number
  problems: string[]
}

/**
 * Ejecuta la sincronización y comprueba en Firestore que los documentos restaurados existen (o ya no existen, si se eliminaron).
 * Solo devuelve `synced` cuando no queda ninguna operación de la restauración en la cola y Firebase confirmó cada documento.
 */
export async function syncAndVerifyRestore(
  result: RestoreResult,
  ownerId: string,
  runSync: () => Promise<{ errors: number; lastError?: string; held?: boolean } | undefined>
): Promise<RestoreOutcome> {
  if (!result.queuedIds.length) return { state: 'nothing', message: 'No hubo cambios que sincronizar.', pending: 0, confirmed: 0, photosPending: 0, problems: [] }
  const queued = new Set(result.queuedIds)
  const remaining = async () => (await getPendingSyncQueue()).filter((item) => queued.has(item.id)).length
  const problems: string[] = []
  let summary: Awaited<ReturnType<typeof runSync>>
  try {
    summary = await runSync()
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'No fue posible sincronizar')
  }
  if (summary?.lastError) problems.push(summary.lastError)
  const pending = await remaining()
  const sessionsLocal = await listSessions()
  const photosPending = (await Promise.all(result.computerIds.map((id) => getComputer(id)))).filter((computer) => computer?.photo && !computer.photoRemote).length
  if (summary?.held) {
    // La sincronización está detenida a propósito (recuperación pendiente o modo local): no se reintentará sola al volver Internet.
    return {
      state: 'local-only',
      message: `Importación local completada. La sincronización está detenida (modo recuperación): ${pending} operación${pending === 1 ? '' : 'es'} queda${pending === 1 ? '' : 'n'} en la cola local y no se enviará${pending === 1 ? '' : 'n'} hasta que autorices la sincronización.`,
      pending, confirmed: 0, photosPending, problems
    }
  }
  if (pending > 0) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    const never = summary === undefined && !problems.length
    return {
      state: offline || never ? 'local-only' : 'pending',
      message: offline || never
        ? `Importación local completada. ${pending} operación${pending === 1 ? '' : 'es'} pendiente${pending === 1 ? '' : 's'} de subir a Firebase; se reintentará al recuperar la conexión.`
        : `Importación local completada, pero ${pending} operación${pending === 1 ? '' : 'es'} sigue${pending === 1 ? '' : 'n'} pendiente${pending === 1 ? '' : 's'} de subir a Firebase.`,
      pending, confirmed: 0, photosPending, problems
    }
  }
  try {
    const computers = await Promise.all(result.computerIds.map((id) => getComputer(id)))
    // Las copias importadas que ya existían en Firebase se descartan durante la sincronización para no duplicarlas.
    const dropped = computers.filter((computer) => !computer).length
    if (dropped) problems.push(`${dropped} equipo${dropped === 1 ? '' : 's'} importado${dropped === 1 ? '' : 's'} ya existía${dropped === 1 ? '' : 'n'} en Firebase y no se duplicó`)
    const verification = await verifyRemoteDocuments(ownerId, {
      sessions: result.sessionIds.map((id) => sessionsLocal.find((session) => session.id === id)?.cloudId || id),
      computers: computers.filter((computer): computer is ComputerRecord => Boolean(computer)).map((computer) => computer.cloudId || computer.id),
      deletedComputers: result.deletedRemoteIds
    })
    const unconfirmed = [...verification.missing, ...verification.foreign, ...verification.stillPresent]
    if (unconfirmed.length) {
      return { state: 'unverified', message: `Firebase no confirmó ${unconfirmed.length} documento${unconfirmed.length === 1 ? '' : 's'}.`, pending: 0, confirmed: verification.confirmed, photosPending, problems: [...problems, ...unconfirmed] }
    }
    const confirmedText = `Firebase confirmó ${verification.confirmed} documento${verification.confirmed === 1 ? '' : 's'}${result.deletedRemoteIds.length ? ` y ${result.deletedRemoteIds.length} eliminación${result.deletedRemoteIds.length === 1 ? '' : 'es'}` : ''}`
    if (photosPending > 0) {
      const sample = computers.find((computer) => computer?.photo && !computer.photoRemote)?.photoUploadError
      const reason = !imageKitConfigured
        ? 'El servicio de fotografías (ImageKit) no está configurado en esta aplicación (falta VITE_IMAGEKIT_BACKEND_URL); las fotos se conservan en este dispositivo y se subirán cuando se configure.'
        : `Las fotografías se conservan en este dispositivo y se reintentarán${sample ? ` (último error: ${sample})` : ''}.`
      return {
        state: 'photos-pending',
        message: `Datos sincronizados: ${confirmedText}. ${photosPending} fotografía${photosPending === 1 ? '' : 's'} sigue${photosPending === 1 ? '' : 'n'} pendiente${photosPending === 1 ? '' : 's'} de subir. ${reason}`,
        pending: 0, confirmed: verification.confirmed, photosPending, problems
      }
    }
    return {
      state: 'synced',
      message: `Sincronización completa: Firebase confirmó ${verification.confirmed} documento${verification.confirmed === 1 ? '' : 's'}${result.deletedRemoteIds.length ? ` y ${result.deletedRemoteIds.length} eliminación${result.deletedRemoteIds.length === 1 ? '' : 'es'}` : ''}.`,
      pending: 0, confirmed: verification.confirmed, photosPending, problems
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'No fue posible verificar en Firebase')
    return { state: 'unverified', message: 'La cola se vació pero no se pudo verificar en Firebase.', pending: 0, confirmed: 0, photosPending, problems }
  }
}
