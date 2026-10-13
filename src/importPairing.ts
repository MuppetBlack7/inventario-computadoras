import type { ComputerRecord } from './types'
import { normalizeKey } from './utils'

/**
 * SOLO ANÁLISIS: empareja copias creadas por «Importar respaldo compartido» con sus registros originales y describe,
 * como datos, los pasos de una transferencia de propiedad. No escribe en IndexedDB, Firestore ni ImageKit, no cambia
 * propietarios y no se usa en la aplicación. Nada de lo que devuelve se ejecuta solo.
 */

export type PairStatus = 'paired' | 'copy-without-original' | 'ambiguous-original'

export interface PairingInput {
  /** Registros de la cuenta que importó (los que tienen `importedFrom`). */
  copies: ComputerRecord[]
  /** Registros originales (respaldo o dispositivo del propietario). */
  originals: ComputerRecord[]
  /** Hashes de fotografías ya calculados por quien llama (id del registro → hash), solo para comprobar. */
  photoDigests?: Record<string, string>
}

export interface PairRow {
  status: PairStatus
  copyId: string
  originalId: string
  originalOwnerId?: string
  copyOwnerId?: string
  /** Campos con contenido distinto (ignora IDs, propietario, fechas, estado de sincronización y fotos). */
  differences: string[]
  /** Comprobaciones auxiliares: nunca deciden el emparejamiento. */
  aux: { inventoryEqual: boolean | null; serialEqual: boolean | null; sessionEqual: boolean | null; photoDigestEqual: boolean | null }
  photo: { originalHasBytes: boolean; copyHasBytes: boolean; copyHasRemoteReference: boolean; originalHasRemoteReference: boolean }
}

export interface PairingReport {
  rows: PairRow[]
  /** Originales que no tienen copia (no forman parte de la transferencia). */
  originalsWithoutCopy: string[]
}

const IGNORED = new Set(['id', 'cloudId', 'ownerId', 'ownerName', 'ownerEmail', 'importedFrom', 'syncStatus', 'syncError', 'sharedCloud', 'createdAt', 'updatedAt',
  'photo', 'photoRemote', 'photoNeedsUpload', 'photoUploadStatus', 'photoUploadError', 'photoLocalRevision', 'photoStoredLocally', 'photoPath', 'photoName',
  'inventoryNormalized', 'serialNormalized'])

// Comparación estable: el orden de las claves de los objetos anidados no cuenta (Firestore las devuelve en otro orden).
const canonical = (value: unknown): string => JSON.stringify(value ?? null, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : item)
const blank = (value: unknown) => (value === '' || value === undefined ? null : value)

export const contentDifferences = (original: object, copy: object) => {
  const a = original as Record<string, unknown>
  const b = copy as Record<string, unknown>
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !IGNORED.has(key) && canonical(blank(a[key])) !== canonical(blank(b[key]))).sort()
}

/** Empareja SOLO por `importedFrom.id` = ID original. Inventario, serie y fotos son comprobaciones auxiliares. */
export function pairImportedCopies({ copies, originals, photoDigests = {} }: PairingInput): PairingReport {
  const byId = new Map<string, ComputerRecord[]>()
  for (const original of originals) byId.set(original.id, [...(byId.get(original.id) ?? []), original])
  const claimed = new Map<string, number>()
  for (const copy of copies) if (copy.importedFrom) claimed.set(copy.importedFrom.id, (claimed.get(copy.importedFrom.id) ?? 0) + 1)
  const rows: PairRow[] = copies.filter((copy) => copy.importedFrom).map((copy) => {
    const originalId = copy.importedFrom!.id
    const candidates = byId.get(originalId) ?? []
    // Dos copias que declaran el mismo original, o dos originales con el mismo ID, no se resuelven automáticamente.
    const status: PairStatus = candidates.length === 0 ? 'copy-without-original' : candidates.length > 1 || (claimed.get(originalId) ?? 0) > 1 ? 'ambiguous-original' : 'paired'
    const original = status === 'paired' ? candidates[0] : undefined
    return {
      status, copyId: copy.id, originalId, originalOwnerId: original?.ownerId, copyOwnerId: copy.ownerId,
      differences: original ? contentDifferences(original, copy) : [],
      aux: {
        inventoryEqual: original ? normalizeKey(original.inventoryId) === normalizeKey(copy.inventoryId) : null,
        serialEqual: original ? normalizeKey(original.serialNumber) === normalizeKey(copy.serialNumber) : null,
        sessionEqual: original ? original.sessionId === copy.sessionId : null,
        photoDigestEqual: original && photoDigests[original.id] && photoDigests[copy.id] ? photoDigests[original.id] === photoDigests[copy.id] : null
      },
      photo: { originalHasBytes: Boolean(original?.photo), copyHasBytes: Boolean(copy.photo), copyHasRemoteReference: Boolean(copy.photoRemote), originalHasRemoteReference: Boolean(original?.photoRemote) }
    }
  })
  const paired = new Set(rows.filter((row) => row.status === 'paired').map((row) => row.originalId))
  return { rows, originalsWithoutCopy: originals.filter((original) => !paired.has(original.id)).map((original) => original.id).sort() }
}

export type TransferStepKind =
  | 'preserve-backup'                 // copia íntegra del JSON y del informe, con SHA-256, antes de cualquier cambio
  | 'owner-verify-original'           // el propietario confirma que su registro original existe y es correcto
  | 'owner-publish-original'          // el propietario sube su registro con su ID original, desde su cuenta
  | 'owner-verify-photo'              // el propietario comprueba la foto subida y su referencia en Firestore
  | 'importer-retire-copy'            // quien importó borra su copia, solo cuando todo lo anterior está verificado
  | 'blocked'

export interface TransferStep {
  kind: TransferStepKind
  actor: 'importer' | 'owner' | 'anyone'
  copyId: string
  originalId: string
  reason?: string
}

export interface TransferChecks {
  /** IDs originales ya publicados bajo la cuenta del propietario y confirmados en Firestore. */
  publishedOriginals?: ReadonlySet<string>
  /** IDs originales cuya fotografía está subida, con referencia guardada en Firestore. */
  verifiedPhotos?: ReadonlySet<string>
  backupPreserved?: boolean
}

/**
 * Plan de transferencia como datos. Garantías:
 * - no contiene operaciones que creen IDs nuevos ni cambien `ownerId`;
 * - la copia solo se retira después de verificar el original publicado y su fotografía;
 * - una copia sin pareja única queda bloqueada y nunca se retira;
 * - es determinista: el mismo informe produce el mismo plan, así que repetirlo no añade nada.
 */
export function planOwnershipTransfer(report: PairingReport, checks: TransferChecks = {}): TransferStep[] {
  const published = checks.publishedOriginals ?? new Set<string>()
  const photos = checks.verifiedPhotos ?? new Set<string>()
  const steps: TransferStep[] = []
  if (!checks.backupPreserved) steps.push({ kind: 'preserve-backup', actor: 'anyone', copyId: '*', originalId: '*' })
  for (const row of [...report.rows].sort((a, b) => a.copyId.localeCompare(b.copyId))) {
    const base = { copyId: row.copyId, originalId: row.originalId }
    if (row.status !== 'paired') {
      steps.push({ ...base, kind: 'blocked', actor: 'anyone', reason: row.status === 'copy-without-original' ? 'No hay registro original para esta copia' : 'El original es ambiguo; requiere revisión manual' })
      continue
    }
    if (row.differences.length) {
      steps.push({ ...base, kind: 'blocked', actor: 'anyone', reason: `La copia difiere del original en: ${row.differences.join(', ')}` })
      continue
    }
    steps.push({ ...base, kind: 'owner-verify-original', actor: 'owner' })
    if (!published.has(row.originalId)) { steps.push({ ...base, kind: 'owner-publish-original', actor: 'owner' }); continue }
    if (!photos.has(row.originalId) && (row.photo.originalHasBytes || row.photo.copyHasBytes || row.photo.copyHasRemoteReference)) {
      steps.push({ ...base, kind: 'owner-verify-photo', actor: 'owner' })
      continue
    }
    if (checks.backupPreserved) steps.push({ ...base, kind: 'importer-retire-copy', actor: 'importer' })
  }
  return steps
}
