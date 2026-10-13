import { buildRecoveryReport, hasValidRemotePhoto, type RecoveryRow, type RecoverySnapshot, type RemoteRecoverySnapshot } from './recovery'
import { sha256Hex, type RemoteLoader } from './photoCheck'
import type { ComputerRecord } from './types'
import { cleanupContent, cleanupLocalState } from './cleanupIdentity'

/**
 * «Limpiar copias locales verificadas en Firebase».
 *
 * Solo se retira la copia LOCAL de un equipo propio cuando existe en Firebase el mismo documento (mismo ID, mismo propietario,
 * mismo contenido) y su fotografía está verificada por separado. Nunca escribe en Firestore ni en ImageKit, no toca sesiones,
 * la cola de operaciones ni registros de otras cuentas. Si algo no puede demostrarse, el registro se conserva.
 */
export type CleanupCategory =
  | 'verified-copy'
  | 'other-account' | 'owner-unknown' | 'owner-mismatch' | 'not-in-firebase' | 'different-content' | 'local-changes' | 'queued-operations'
  | 'possible-duplicate' | 'conflict'
  | 'photo-only-local' | 'photo-upload-pending' | 'photo-reference-incomplete' | 'photo-unverified' | 'photo-mismatch'

export const CLEANUP_LABELS: Record<CleanupCategory, string> = {
  'verified-copy': 'Copia local verificada en Firebase (se puede limpiar)',
  'other-account': 'Pertenece a otra cuenta',
  'owner-unknown': 'Propietario desconocido',
  'owner-mismatch': 'Propietario distinto entre local y Firebase',
  'not-in-firebase': 'No existe en Firebase con el mismo ID',
  'different-content': 'Contenido distinto en Firebase',
  'local-changes': 'Cambios locales sin sincronizar',
  'queued-operations': 'Tiene operaciones en la cola',
  'possible-duplicate': 'Posible duplicado',
  conflict: 'Conflicto sin resolver',
  'photo-only-local': 'Sus bytes locales son la única copia conocida de la fotografía',
  'photo-upload-pending': 'Fotografía con subida pendiente o en curso',
  'photo-reference-incomplete': 'Referencia remota de la fotografía incompleta o ajena',
  'photo-unverified': 'No se pudo verificar la fotografía en Firebase/ImageKit',
  'photo-mismatch': 'La fotografía remota no coincide con la local'
}

export interface CleanupItem {
  id: string
  inventoryId: string
  decision: 'candidate' | 'excluded'
  category: CleanupCategory
  reason: string
  /** Huella de lo verificado; si cambia antes de borrar, se cancela. Solo existe en candidatos. */
  fingerprint?: string
  expect?: CleanupExpectation
}

/** Lo que debe seguir siendo cierto dentro de la transacción que elimina la copia. */
export interface CleanupExpectation {
  updatedAt: string
  ownerId: string
  cloudId?: string
  photoLocalRevision?: string
  photoSize: number | null
  photoRemoteFileId?: string
  localState?: string
  localPhotoSha256?: string
}

export interface CleanupPlan {
  accountId: string
  generatedAt: string
  /** Si no está vacío, no hay candidatos: lectura fallida, usuario distinto o sin conexión. */
  blockedBy: string[]
  items: CleanupItem[]
  candidates: CleanupItem[]
  excluded: CleanupItem[]
  counts: Record<CleanupCategory, number>
}

const emptyCounts = () => Object.fromEntries(Object.keys(CLEANUP_LABELS).map((code) => [code, 0])) as Record<CleanupCategory, number>

const blockedPlan = (accountId: string, blockedBy: string, generatedAt: string): CleanupPlan =>
  ({ accountId, generatedAt, blockedBy: [blockedBy], items: [], candidates: [], excluded: [], counts: emptyCounts() })

export interface PlanInput {
  local: RecoverySnapshot
  remote: RemoteRecoverySnapshot | null
  accountId: string
  /** Usuario autenticado en este momento; debe coincidir con la cuenta del análisis. */
  authUid: string | null | undefined
  loadRemote?: RemoteLoader
  now?: string
}

const queueTouches = (local: RecoverySnapshot, computer: ComputerRecord) =>
  local.queue.some((item) => [item.entityId, item.remoteId].some((id) => id && (id === computer.id || id === computer.cloudId))
    || Boolean(item.sessionId && item.sessionId === computer.sessionId)
    || Boolean(computer.photoRemote?.fileId && (item.photoFileId === computer.photoRemote.fileId || item.photoCandidate?.fileId === computer.photoRemote.fileId)))

const completePhotoReference = (record: ComputerRecord) => {
  const ref = record.photoRemote
  return hasValidRemotePhoto(record) && Boolean(ref && typeof ref.name === 'string' && ref.name.trim()
    && Number.isFinite(ref.size) && ref.size > 0 && typeof ref.mimeType === 'string' && ref.mimeType.startsWith('image/')
    && typeof ref.uploadedAt === 'string' && ref.uploadedAt.trim())
}

export async function planLocalCleanup(input: PlanInput): Promise<CleanupPlan> {
  const { local, remote, accountId, authUid, loadRemote } = input
  const generatedAt = input.now ?? new Date().toISOString()
  if (!authUid || authUid !== accountId) return blockedPlan(accountId, 'La cuenta autenticada no coincide con la del análisis: no se limpia nada.', generatedAt)
  if (!remote) return blockedPlan(accountId, 'No se pudo leer Firebase: sin una lectura completa no se puede verificar ninguna copia.', generatedAt)

  const report = buildRecoveryReport(local, remote, accountId, generatedAt)
  const rows = new Map<string, RecoveryRow>()
  for (const row of report.rows) if (row.kind === 'computer' && row.localId) rows.set(row.localId, row)
  const items: CleanupItem[] = []

  for (const computer of local.computers) {
    const row = rows.get(computer.id)
    const base = { id: computer.id, inventoryId: computer.inventoryId || computer.serialNumber || computer.id }
    const exclude = (category: CleanupCategory, detail?: string) => items.push({ ...base, decision: 'excluded', category, reason: detail ? `${CLEANUP_LABELS[category]}: ${detail}` : CLEANUP_LABELS[category] })
    const remoteRecord = remote.computers.find((entry) => entry.id === (computer.cloudId || computer.id))

    // 1) Propiedad
    if (!computer.ownerId) { exclude('owner-unknown'); continue }
    if (computer.ownerId !== accountId) { exclude('other-account'); continue }
    // 2) Cola de operaciones
    if (queueTouches(local, computer) || (row?.pending.length ?? 0) > 0) { exclude('queued-operations'); continue }
    // 3) Existencia remota por ID
    if (!remoteRecord || !row) {
      const duplicate = row?.categories.includes('probable-duplicate')
      exclude(duplicate ? 'possible-duplicate' : 'not-in-firebase', duplicate ? 'coincide por inventario o serie con otro registro, no por ID' : undefined)
      continue
    }
    if (!remoteRecord.ownerId) { exclude('owner-unknown', 'el documento de Firebase no tiene propietario'); continue }
    if (remoteRecord.ownerId !== computer.ownerId || row.categories.includes('owner-mismatch') || row.categories.includes('owner-missing')) { exclude('owner-mismatch'); continue }
    const localSession = local.sessions.find((entry) => entry.id === computer.sessionId)
    const remoteSession = localSession && remote.sessions.find((entry) => entry.id === (localSession.cloudId || localSession.id))
    if (!localSession || !remoteSession || localSession.ownerId !== accountId || remoteSession.ownerId !== accountId
      || localSession.id !== computer.sessionId || remoteRecord.sessionId !== remoteSession.id) {
      exclude('conflict', 'la sesión relacionada no pudo verificarse para esta cuenta')
      continue
    }
    // 4) Duplicados: otro registro (local o remoto) con el mismo inventario o serie no vinculado por ID
    const sharesKey = (other: ComputerRecord) => other.id !== computer.id && other.id !== remoteRecord.id && (other.cloudId ?? other.id) !== remoteRecord.id
      && Boolean((computer.inventoryNormalized && other.inventoryNormalized === computer.inventoryNormalized) || (computer.serialNormalized && other.serialNormalized === computer.serialNormalized))
    if (local.computers.some((other) => other.id !== computer.id && (other.cloudId || other.id) === remoteRecord.id)
      || local.computers.some(sharesKey) || remote.computers.some(sharesKey)) { exclude('possible-duplicate', 'otro registro comparte el ID remoto, inventario o serie'); continue }
    // 5) Contenido y cambios locales
    if (computer.syncStatus !== 'synced' || computer.updatedAt !== remoteRecord.updatedAt) { exclude('local-changes', computer.updatedAt !== remoteRecord.updatedAt ? 'la fecha de modificación difiere de la de Firebase' : `estado local «${computer.syncStatus ?? 'sin estado'}»`); continue }
    if (cleanupContent(computer) !== cleanupContent(remoteRecord)) { exclude('different-content', row.differences.length ? `campos: ${row.differences.join(', ')}` : 'el documento completo no coincide'); continue }
    if (row.categories.includes('manual-review') || row.categories.includes('foreign-pending-operation')) { exclude('conflict'); continue }

    // 6) Fotografía, por separado
    let photoSha: string | undefined
    if (computer.photoNeedsUpload || computer.photoUploadStatus === 'uploading' || computer.photoUploadStatus === 'pending' || computer.photoUploadStatus === 'error') { exclude('photo-upload-pending'); continue }
    const hasBytes = computer.photo instanceof Blob && computer.photo.size > 0
    if (computer.photoStoredLocally && !hasBytes) { exclude('photo-only-local', 'está marcada como guardada solo en un dispositivo y aquí no hay bytes'); continue }
    if (hasBytes) {
      if (!remoteRecord.photoRemote) { exclude('photo-only-local', 'Firebase no tiene referencia de fotografía'); continue }
      if (!completePhotoReference(remoteRecord)) { exclude('photo-reference-incomplete'); continue }
      if (computer.photoRemote?.fileId !== remoteRecord.photoRemote.fileId) { exclude('photo-reference-incomplete', 'la referencia local no coincide con la de Firebase'); continue }
      if (!loadRemote) { exclude('photo-unverified', 'no hay lector remoto disponible'); continue }
      try {
        const blob = await loadRemote(remoteRecord.cloudId || remoteRecord.id, remoteRecord.photoRemote)
        if (!blob || blob.size === 0 || blob.size !== remoteRecord.photoRemote.size) throw new Error('respuesta vacía o tamaño distinto de la referencia')
        const [remoteHash, localHash] = [await sha256Hex(blob), await sha256Hex(computer.photo as Blob)]
        if (remoteHash !== localHash) { exclude('photo-mismatch', 'el SHA-256 de ambas imágenes es distinto'); continue }
        photoSha = localHash
      } catch (error) {
        exclude('photo-unverified', error instanceof Error ? error.message : String(error))
        continue
      }
    } else if (remoteRecord.photoRemote || computer.photoRemote) {
      // Sin bytes locales: la copia local solo conserva la referencia, que debe existir y ser igual en Firebase.
      if (!completePhotoReference(remoteRecord)) { exclude('photo-reference-incomplete'); continue }
      if (computer.photoRemote?.fileId !== remoteRecord.photoRemote?.fileId) { exclude('photo-reference-incomplete', 'la referencia local no coincide con la de Firebase'); continue }
      if (!loadRemote) { exclude('photo-unverified', 'no hay lector remoto disponible'); continue }
      try {
        const blob = await loadRemote(remoteRecord.cloudId || remoteRecord.id, remoteRecord.photoRemote!)
        if (!blob || blob.size === 0 || blob.size !== remoteRecord.photoRemote!.size) throw new Error('respuesta vacía o tamaño distinto de la referencia')
        photoSha = await sha256Hex(blob)
      } catch (error) {
        exclude('photo-unverified', error instanceof Error ? error.message : String(error))
        continue
      }
    }

    const expect: CleanupExpectation = {
      updatedAt: computer.updatedAt, ownerId: computer.ownerId, cloudId: computer.cloudId, photoLocalRevision: computer.photoLocalRevision,
      photoSize: hasBytes ? (computer.photo as Blob).size : null, photoRemoteFileId: computer.photoRemote?.fileId,
      localState: cleanupLocalState(computer), localPhotoSha256: hasBytes ? photoSha : undefined
    }
    const fingerprint = JSON.stringify({ expect, remoteId: remoteRecord.id, remote: cleanupContent(remoteRecord), photoSha: photoSha ?? null })
    items.push({ ...base, decision: 'candidate', category: 'verified-copy', reason: CLEANUP_LABELS['verified-copy'], fingerprint, expect })
  }

  const counts = emptyCounts()
  for (const item of items) counts[item.category] += 1
  return { accountId, generatedAt, blockedBy: [], items, candidates: items.filter((item) => item.decision === 'candidate'), excluded: items.filter((item) => item.decision === 'excluded'), counts }
}

export type RemoveOutcome = 'removed' | 'absent' | 'changed' | 'queued'

export interface CleanupDeps {
  currentUserId: () => string | null | undefined
  readLocal: () => Promise<RecoverySnapshot>
  readRemote: () => Promise<RemoteRecoverySnapshot>
  loadRemote?: RemoteLoader
  /** Elimina únicamente la copia local de un equipo, validando de nuevo dentro de la transacción. */
  removeCopy: (item: CleanupItem) => Promise<RemoveOutcome>
  /** Registro de resultados (no contiene datos de los equipos). */
  log?: (result: CleanupResult) => void
}

export interface CleanupResult {
  status: 'completed' | 'partial' | 'failed' | 'cancelled'
  accountId: string
  finishedAt: string
  cancelReason?: string
  removed: string[]
  alreadyAbsent: string[]
  kept: Array<{ id: string; reason: string }>
  failed: Array<{ id: string; error: string }>
  notAttempted: string[]
}

const emptyResult = (plan: CleanupPlan): CleanupResult => ({ status: 'cancelled', accountId: plan.accountId, finishedAt: new Date().toISOString(), removed: [], alreadyAbsent: [], kept: [], failed: [], notAttempted: [] })

/**
 * Ejecuta la limpieza ya confirmada. Antes de borrar vuelve a leer Firebase y recalcula; si algo de lo verificado cambió,
 * falla la lectura o cambió el usuario, se cancela sin borrar nada. Es idempotente: una copia ya ausente cuenta como hecha.
 */
export async function runLocalCleanup(plan: CleanupPlan, confirmed: boolean, deps: CleanupDeps): Promise<CleanupResult> {
  const finish = (result: CleanupResult) => { result.finishedAt = new Date().toISOString(); try { deps.log?.(result) } catch { /* el registro es opcional */ } return result }
  const cancelled = (reason: string) => finish({ ...emptyResult(plan), cancelReason: reason, notAttempted: plan.candidates.map((item) => item.id) })
  if (!confirmed) return cancelled('Falta la segunda confirmación explícita.')
  if (plan.blockedBy.length) return cancelled(plan.blockedBy[0])
  if (plan.candidates.length === 0) return cancelled('No hay copias candidatas.')
  if (deps.currentUserId() !== plan.accountId) return cancelled('Cambió el usuario autenticado: se canceló la limpieza.')

  let fresh: CleanupPlan
  try {
    const remote = await deps.readRemote()
    const local = await deps.readLocal()
    if (deps.currentUserId() !== plan.accountId) return cancelled('Cambió el usuario autenticado: se canceló la limpieza.')
    fresh = await planLocalCleanup({ local, remote, accountId: plan.accountId, authUid: deps.currentUserId(), loadRemote: deps.loadRemote })
  } catch (error) {
    return cancelled(`Firebase o la lectura local fallaron antes de borrar (${error instanceof Error ? error.message : String(error)}): no se eliminó nada.`)
  }
  if (fresh.blockedBy.length) return cancelled(fresh.blockedBy[0])
  const freshById = new Map(fresh.candidates.map((item) => [item.id, item]))
  for (const item of plan.candidates) {
    const current = freshById.get(item.id)
    if (!current || current.fingerprint !== item.fingerprint) return cancelled(`La información de ${item.inventoryId} cambió desde la vista previa: se canceló la limpieza sin borrar nada.`)
  }

  const result = emptyResult(plan)
  result.status = 'completed'
  for (const [index, item] of plan.candidates.entries()) {
    if (deps.currentUserId() !== plan.accountId) {
      result.notAttempted.push(...plan.candidates.slice(index).map((entry) => entry.id))
      result.cancelReason = 'Cambió el usuario autenticado durante la limpieza.'
      break
    }
    let current: CleanupItem | undefined
    try {
      // Una lectura fresca por candidato reduce la ventana entre verificar el servidor y borrar en IndexedDB.
      const remote = await deps.readRemote()
      const local = await deps.readLocal()
      if (deps.currentUserId() !== plan.accountId) throw new Error('Cambió el usuario autenticado durante la limpieza')
      const checked = await planLocalCleanup({ local, remote, accountId: plan.accountId, authUid: deps.currentUserId(), loadRemote: deps.loadRemote })
      current = checked.candidates.find((entry) => entry.id === item.id)
      if (!current || current.fingerprint !== item.fingerprint) throw new Error(`La información de ${item.inventoryId} cambió desde la vista previa`)
    } catch (error) {
      result.notAttempted.push(...plan.candidates.slice(index).map((entry) => entry.id))
      result.cancelReason = `Se canceló el resto de la limpieza: ${error instanceof Error ? error.message : String(error)}.`
      break
    }
    try {
      const outcome = await deps.removeCopy(current)
      if (outcome === 'removed') result.removed.push(item.id)
      else if (outcome === 'absent') result.alreadyAbsent.push(item.id)
      else result.kept.push({ id: item.id, reason: outcome === 'queued' ? 'apareció una operación en la cola: se conservó' : 'cambió localmente: se conservó' })
    } catch (error) {
      result.failed.push({ id: item.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const done = result.removed.length + result.alreadyAbsent.length
  result.status = result.failed.length || result.kept.length || result.notAttempted.length ? (done ? 'partial' : result.failed.length ? 'failed' : 'cancelled') : 'completed'
  return finish(result)
}
