import { hasValidRemotePhoto } from './recovery'
import type { ComputerRecord, ImageKitPhotoReference } from './types'

/**
 * Comprobación de SOLO LECTURA de la identidad de una fotografía. Calcula tamaño y SHA-256 en memoria y nunca escribe en
 * IndexedDB, Firestore ni ImageKit. La imagen remota solo se lee (a memoria) si existe una referencia válida y el lector
 * inyectado la entrega; si no se puede verificar, queda «No verificada» en lugar de suponer que existe.
 */
export type RemoteLoader = (computerId: string, reference: ImageKitPhotoReference) => Promise<Blob>

export interface LocalPhotoCheck {
  bytes: 'present' | 'absent' | 'error'
  size?: number
  sha256?: string
  /** Solo para mostrar la miniatura de ESTE equipo. */
  blob?: Blob
  error?: string
  photoName?: string
  revision?: string
  uploadStatus?: string
  needsUpload?: boolean
  storedLocallyFlag?: boolean
  reference: string
}

export interface RemotePhotoCheck {
  /** `none`: el documento remoto no trae referencia; `invalid`: trae una referencia que no pasa la validación; `valid`: referencia correcta. */
  reference: 'none' | 'invalid' | 'valid'
  /** `verified` solo si se leyeron los bytes y se calculó el hash; en cualquier otro caso «No verificada». */
  verification: 'verified' | 'unverified'
  size?: number
  sha256?: string
  blob?: Blob
  error?: string
  photoName?: string
  revision?: string
  referenceText: string
  documentFound: boolean
}

export interface PhotoCheck {
  inventoryId: string
  localOwner: string
  remoteOwner: string
  ownersDiffer: boolean | 'unknown'
  local: LocalPhotoCheck
  remote: RemotePhotoCheck
  /** `true`/`false` solo cuando ambos hashes existen; si no, la identidad es desconocida. */
  sameBytes: boolean | 'unknown'
  /** La referencia remota solo se usa si el documento remoto es el mismo equipo (mismo inventario). */
  sameEquipment: boolean | 'unknown'
  warnings: string[]
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const ownerLabel = (record?: ComputerRecord) => record ? `${record.ownerName || 'sin nombre'} (${record.ownerId ? record.ownerId.slice(0, 8) : 'sin propietario'})` : 'No disponible'
const referenceText = (reference?: ImageKitPhotoReference) => reference ? `${reference.name} · ${reference.size} B · fileId ${reference.fileId.slice(0, 10)}…` : 'sin referencia'

export async function checkPhotoPair(input: { local?: ComputerRecord; remote?: ComputerRecord | null; loadRemote?: RemoteLoader }): Promise<PhotoCheck> {
  const { local, remote, loadRemote } = input
  const warnings: string[] = []
  const inventoryId = local?.inventoryId || remote?.inventoryId || 'sin inventario'

  const localCheck: LocalPhotoCheck = {
    bytes: 'absent', photoName: local?.photoName, revision: local?.photoLocalRevision, uploadStatus: local?.photoUploadStatus,
    needsUpload: local?.photoNeedsUpload, storedLocallyFlag: local?.photoStoredLocally, reference: referenceText(local?.photoRemote)
  }
  if (!local) warnings.push('No existe una copia local de este equipo.')
  else if (!(local.photo instanceof Blob) || local.photo.size === 0) warnings.push('Los bytes de la fotografía local NO existen en este dispositivo: no se puede mostrar ni calcular su hash.')
  else {
    try {
      localCheck.bytes = 'present'
      localCheck.size = local.photo.size
      localCheck.sha256 = await sha256Hex(local.photo)
      localCheck.blob = local.photo
    } catch (error) {
      localCheck.bytes = 'error'
      localCheck.error = error instanceof Error ? error.message : String(error)
      warnings.push('No se pudieron leer los bytes de la fotografía local.')
    }
  }

  const sameEquipment: PhotoCheck['sameEquipment'] = local && remote ? (local.inventoryId === remote.inventoryId && local.sessionId === remote.sessionId ? true : false) : 'unknown'
  const reference = remote?.photoRemote
  const remoteCheck: RemotePhotoCheck = {
    reference: !remote || !reference ? 'none' : hasValidRemotePhoto(remote) ? 'valid' : 'invalid',
    verification: 'unverified', photoName: remote?.photoName, revision: remote?.photoLocalRevision,
    referenceText: referenceText(reference), documentFound: Boolean(remote)
  }
  if (!remote) warnings.push('No se pudo leer el documento remoto de este equipo: su fotografía queda «No verificada».')
  else if (sameEquipment === false) warnings.push('El documento remoto no corresponde al mismo equipo (inventario o sesión distintos): no se muestra su fotografía.')
  else if (remoteCheck.reference === 'none') warnings.push('Firebase no tiene una referencia de fotografía (photoRemote) para este equipo: no hay imagen remota que verificar.')
  else if (remoteCheck.reference === 'invalid') warnings.push('La referencia remota de la fotografía no es válida (campos incompletos o ruta ajena al propietario): «No verificada».')
  else if (!loadRemote) warnings.push('No hay lector remoto disponible (sin conexión o sin ImageKit): la fotografía remota queda «No verificada».')
  else {
    try {
      const blob = await loadRemote(remote.cloudId || remote.id, reference!)
      if (!blob || blob.size === 0) throw new Error('La respuesta no contiene imagen')
      remoteCheck.size = blob.size
      remoteCheck.sha256 = await sha256Hex(blob)
      remoteCheck.blob = blob
      remoteCheck.verification = 'verified'
    } catch (error) {
      remoteCheck.error = error instanceof Error ? error.message : String(error)
      warnings.push(`No se pudo leer la fotografía remota (${remoteCheck.error}): «No verificada».`)
    }
  }

  const sameBytes: PhotoCheck['sameBytes'] = localCheck.sha256 && remoteCheck.sha256 ? localCheck.sha256 === remoteCheck.sha256 : 'unknown'
  const ownersDiffer: PhotoCheck['ownersDiffer'] = local && remote ? local.ownerId !== remote.ownerId : 'unknown'
  if (ownersDiffer === true) warnings.push('El propietario local y el remoto son distintos: no se debe subir ni reclamar esta fotografía.')
  if (sameBytes === true) warnings.push('Ambas imágenes tienen el mismo SHA-256: son el mismo archivo.')
  else if (sameBytes === false) warnings.push('Las imágenes local y remota son DISTINTAS (SHA-256 diferente): subir una versión reemplazaría la referencia a la otra.')
  else warnings.push('No se puede determinar si las imágenes corresponden al mismo equipo: falta al menos una imagen verificada. Los conflictos de nombre siguen sin resolver.')

  return { inventoryId, localOwner: ownerLabel(local), remoteOwner: ownerLabel(remote ?? undefined), ownersDiffer, local: localCheck, remote: remoteCheck, sameBytes, sameEquipment, warnings }
}
