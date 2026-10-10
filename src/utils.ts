import type { ComputerRecord, StorageDrive } from './types'

export const uid = () => crypto.randomUUID()

export const normalizeKey = (value: string) =>
  value.trim().toLocaleUpperCase('es-MX').replace(/[^A-Z0-9]/g, '')

export const nowWithZone = () => ({
  iso: new Date().toISOString(),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Zona local desconocida'
})

export const formatDateTime = (iso: string) => {
  if (!iso) return 'No disponible'
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(iso))
}

export const formatNumber = (value: number | null, suffix = '') =>
  value === null || Number.isNaN(value) ? 'No indicado' : `${value}${suffix}`

export const newDrive = (): StorageDrive => ({ id: uid(), capacityGB: null, type: 'Desconocido' })

export const emptyComputer = (sessionId: string): ComputerRecord => {
  const stamp = nowWithZone()
  return {
    id: uid(),
    sessionId,
    inventoryId: '',
    equipmentType: '',
    customEquipmentType: '',
    inventoryNormalized: '',
    serialNumber: '',
    serialNormalized: '',
    brand: '',
    model: '',
    manufacturingYear: null,
    yearUnknown: true,
    operatingSystem: '',
    ramGB: null,
    drives: [newDrive()],
    originalCode: '',
    scannedAt: stamp.iso,
    timezone: stamp.timezone,
    latitude: null,
    longitude: null,
    accuracyMeters: null,
    writtenLocation: '',
    notes: '',
    createdAt: stamp.iso,
    updatedAt: stamp.iso
  }
}

export const displayEquipmentType = (computer: Pick<ComputerRecord, 'equipmentType' | 'customEquipmentType'>) =>
  computer.equipmentType === 'Otro'
    ? computer.customEquipmentType?.trim() || ''
    : computer.equipmentType || ''

export const photoToDataUrl = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`
}

export const dataUrlToBlob = (dataUrl: string) => {
  const [metadata, payload] = dataUrl.split(',')
  if (!metadata || !payload) throw new Error('Fotografía inválida en el respaldo')
  const type = metadata.match(/data:([^;]+)/)?.[1] || 'image/jpeg'
  const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
  return new Blob([bytes], { type })
}

export const compressPhoto = async (file: File): Promise<Blob> => {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = objectUrl
    await image.decode()
    const maximum = 1600
    const scale = Math.min(1, maximum / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No fue posible procesar la fotografía')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No fue posible guardar la fotografía'))), 'image/jpeg', 0.82)
    )
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export const driveSummary = (drives: StorageDrive[]) =>
  drives
    .filter((drive) => drive.capacityGB !== null)
    .map((drive) => `${drive.type}: ${drive.capacityGB} GB`)
    .join(' + ') || 'No indicado'
