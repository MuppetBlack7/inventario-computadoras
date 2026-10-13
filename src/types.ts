export type DriveType = 'HDD' | 'SSD' | 'Desconocido'
export type EquipmentType = '' | 'Computadora de escritorio' | 'Laptop' | 'Todo en uno' | 'Otro'
export type SyncStatus = 'local' | 'syncing' | 'synced' | 'error'
export type PhotoUploadStatus = 'local' | 'pending' | 'uploading' | 'uploaded' | 'error'

export interface ImageKitPhotoReference {
  fileId: string
  url: string
  filePath: string
  name: string
  size: number
  width: number | null
  height: number | null
  mimeType: string
  uploadedAt: string
}

/** Origen de un registro importado desde un respaldo compartido. No contiene datos del exportador. */
export interface ImportedFrom {
  /** Identificador que tenía el registro en el respaldo. */
  id: string
  importedAt: string
}

export interface StorageDrive {
  id: string
  capacityGB: number | null
  type: DriveType
}

export interface InventorySession {
  id: string
  name: string
  date: string
  location: string
  isExample?: boolean
  ownerId?: string
  ownerName?: string
  ownerEmail?: string
  cloudId?: string
  sharedCloud?: boolean
  syncStatus?: SyncStatus
  syncError?: string
  importedFrom?: ImportedFrom
  createdAt: string
  updatedAt: string
}

export interface ComputerRecord {
  id: string
  sessionId: string
  inventoryId: string
  equipmentType?: EquipmentType
  customEquipmentType?: string
  inventoryNormalized: string
  serialNumber: string
  serialNormalized: string
  photo?: Blob
  photoName?: string
  brand: string
  model: string
  manufacturingYear: number | null
  yearUnknown: boolean
  operatingSystem: string
  ramGB: number | null
  drives: StorageDrive[]
  originalCode: string
  scannedAt: string
  timezone: string
  latitude: number | null
  longitude: number | null
  accuracyMeters: number | null
  writtenLocation: string
  notes: string
  isExample?: boolean
  ownerId?: string
  ownerName?: string
  ownerEmail?: string
  cloudId?: string
  sharedCloud?: boolean
  photoPath?: string
  photoRemote?: ImageKitPhotoReference
  photoStoredLocally?: boolean
  photoNeedsUpload?: boolean
  photoUploadStatus?: PhotoUploadStatus
  photoUploadError?: string
  /** Cuenta que seleccionó la foto local pendiente; solo se conserva en este dispositivo. */
  photoPendingActorId?: string
  /** Cambia cada vez que el usuario selecciona una fotografía local distinta. */
  photoLocalRevision?: string
  importedFrom?: ImportedFrom
  syncStatus?: SyncStatus
  syncError?: string
  createdAt: string
  updatedAt: string
}

export type SyncOperation = 'upsert-session' | 'delete-session' | 'upsert-computer' | 'update-computer-photo' | 'delete-computer' | 'cleanup-photo'
export type PhotoCleanupReason = 'replaced-photo' | 'deleted-computer' | 'orphan-upload'

export interface SyncQueueItem {
  id: string
  operation: SyncOperation
  entityId: string
  remoteId?: string
  sessionId?: string
  ownerId?: string
  /** Propietario inmutable del registro cuando otra cuenta actualiza únicamente su fotografía. */
  recordOwnerId?: string
  photoFileId?: string
  photoCandidate?: ImageKitPhotoReference
  photoSourceRevision?: string
  cleanupFileIds?: string[]
  cleanupReason?: PhotoCleanupReason
  blockedByQueueItemId?: string
  createdAt: string
  revision?: string
  attempts?: number
  nextAttemptAt?: string
  lastError?: string
  retryable?: boolean
}

export interface ParsedCodeData {
  inventoryId?: string
  equipmentType?: EquipmentType
  serialNumber?: string
  brand?: string
  model?: string
  manufacturingYear?: number | null
  yearUnknown?: boolean
  operatingSystem?: string
  ramGB?: number | null
  drives?: StorageDrive[]
  writtenLocation?: string
  notes?: string
}

export interface BackupComputer extends Omit<ComputerRecord, 'photo'> {
  photoDataUrl?: string
}

export interface InventoryBackup {
  format: 'inventario-computadoras'
  version: 1
  exportedAt: string
  sessions: InventorySession[]
  computers: BackupComputer[]
}
