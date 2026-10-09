import type { EquipmentType, ParsedCodeData, StorageDrive } from './types'
import { newDrive } from './utils'

const firstValue = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null && String(value).trim()) return value
  }
  return undefined
}

const toText = (value: unknown) => (value === undefined ? undefined : String(value).trim())
const toNumber = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(String(value).replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : undefined
}

const toEquipmentType = (value: unknown): EquipmentType | undefined => {
  const normalized = toText(value)?.toLocaleLowerCase('es-MX')
  if (!normalized) return undefined
  if (['computadora de escritorio', 'escritorio', 'desktop'].includes(normalized)) return 'Computadora de escritorio'
  if (['laptop', 'portátil', 'portatil'].includes(normalized)) return 'Laptop'
  if (['todo en uno', 'all in one', 'aio'].includes(normalized)) return 'Todo en uno'
  if (normalized === 'otro') return 'Otro'
  return undefined
}

const parseDrives = (value: unknown): StorageDrive[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const drives = value.map((entry) => {
    const item = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}
    const typeText = String(firstValue(item, ['tipo', 'type']) || 'Desconocido').toUpperCase()
    return {
      ...newDrive(),
      capacityGB: toNumber(firstValue(item, ['capacidadGB', 'capacityGB', 'capacidad'])) ?? null,
      type: (typeText === 'HDD' || typeText === 'SSD' ? typeText : 'Desconocido') as StorageDrive['type']
    }
  })
  return drives.length ? drives : undefined
}

const mapStructured = (source: Record<string, unknown>): ParsedCodeData => {
  const yearValue = firstValue(source, ['año', 'anio', 'year', 'manufacturingYear'])
  const unknownYear = String(yearValue ?? '').toLocaleLowerCase('es-MX') === 'desconocido'
  return {
    inventoryId: toText(firstValue(source, ['inventario', 'idInventario', 'inventoryId', 'assetId', 'activo'])),
    equipmentType: toEquipmentType(firstValue(source, ['tipoEquipo', 'tipo de equipo', 'equipmentType'])),
    serialNumber: toText(firstValue(source, ['serie', 'numeroSerie', 'númeroSerie', 'serialNumber', 'serial', 'sn'])),
    brand: toText(firstValue(source, ['marca', 'brand'])),
    model: toText(firstValue(source, ['modelo', 'model'])),
    manufacturingYear: unknownYear ? null : (toNumber(yearValue) ?? undefined),
    yearUnknown: unknownYear || yearValue === undefined,
    operatingSystem: toText(firstValue(source, ['sistemaOperativo', 'sistema', 'operatingSystem', 'os'])),
    ramGB: toNumber(firstValue(source, ['ramGB', 'ram'])),
    drives: parseDrives(firstValue(source, ['unidades', 'almacenamiento', 'drives', 'storage'])),
    writtenLocation: toText(firstValue(source, ['ubicacion', 'ubicación', 'location', 'writtenLocation'])),
    notes: toText(firstValue(source, ['observaciones', 'notas', 'notes']))
  }
}

export function parseScannedCode(raw: string): ParsedCodeData {
  const trimmed = raw.trim()
  if (!trimmed) return {}

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return mapStructured(parsed as Record<string, unknown>)
    }
  } catch {
    // Continúa con formatos simples.
  }

  if (/[=:]/.test(trimmed) && /[;\n|]/.test(trimmed)) {
    const source: Record<string, string> = {}
    for (const segment of trimmed.split(/[;\n|]+/)) {
      const separator = segment.search(/[=:]/)
      if (separator > 0) source[segment.slice(0, separator).trim()] = segment.slice(separator + 1).trim()
    }
    const mapped = mapStructured(source)
    if (Object.values(mapped).some((value) => value !== undefined)) return mapped
  }

  if (/^(SN|S\/N|SERIE)[\s:._-]*/i.test(trimmed)) {
    return { serialNumber: trimmed.replace(/^(SN|S\/N|SERIE)[\s:._-]*/i, '') }
  }
  return { inventoryId: trimmed }
}
