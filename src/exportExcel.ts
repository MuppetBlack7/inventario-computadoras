import ExcelJS from 'exceljs'
import { listVisibleComputers, listVisibleSessions } from './db'
import { displayEquipmentType, downloadBlob, driveSummary, photoToDataUrl } from './utils'
import { downloadRemotePhoto } from './imageKitClient'

const safeName = (value: string) => value.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 50)

export const INVENTORY_EXCEL_HEADERS = [
  'Tipo de equipo',
  'Número de serie',
  'Modelo',
  'Número de inventario',
  'Foto',
  'RAM',
  'Unidades',
  'Sistema operativo'
] as const

export async function buildInventoryWorkbook(sessionId?: string, ownerId: string | null = null) {
  const [sessions, computers] = await Promise.all([listVisibleSessions(ownerId), listVisibleComputers(ownerId, sessionId)])
  const sessionMap = new Map(sessions.map((session) => [session.id, session]))
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Inventario de computadoras PWA'
  workbook.created = new Date()
  const worksheet = workbook.addWorksheet('Inventario', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 24 }
  })

  worksheet.columns = [
    { header: INVENTORY_EXCEL_HEADERS[0], key: 'equipmentType', width: 28 },
    { header: INVENTORY_EXCEL_HEADERS[1], key: 'serialNumber', width: 24 },
    { header: INVENTORY_EXCEL_HEADERS[2], key: 'model', width: 24 },
    { header: INVENTORY_EXCEL_HEADERS[3], key: 'inventoryId', width: 24 },
    { header: INVENTORY_EXCEL_HEADERS[4], key: 'photo', width: 20 },
    { header: INVENTORY_EXCEL_HEADERS[5], key: 'ram', width: 14 },
    { header: INVENTORY_EXCEL_HEADERS[6], key: 'drives', width: 36 },
    { header: INVENTORY_EXCEL_HEADERS[7], key: 'os', width: 28 }
  ]

  const header = worksheet.getRow(1)
  header.height = 32
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0C2E2A' } }
  header.alignment = { vertical: 'middle', wrapText: true }
  worksheet.autoFilter = { from: 'A1', to: 'H1' }

  for (const computer of computers) {
    const availablePhoto = computer.photo || (computer.photoRemote
      ? await downloadRemotePhoto(computer.cloudId || computer.id, computer.photoRemote).catch(() => undefined)
      : undefined)
    const row = worksheet.addRow({
      equipmentType: displayEquipmentType(computer) || 'No indicado',
      serialNumber: computer.serialNumber,
      model: computer.model,
      inventoryId: computer.inventoryId,
      photo: availablePhoto ? '' : computer.photoRemote || computer.photoStoredLocally || computer.photoPath ? 'No disponible' : 'Sin fotografía',
      ram: computer.ramGB === null ? 'No indicada' : `${computer.ramGB} GB`,
      drives: driveSummary(computer.drives),
      os: computer.operatingSystem
    })
    row.alignment = { vertical: 'middle', wrapText: true }
    if (availablePhoto) {
      const dataUrl = await photoToDataUrl(availablePhoto)
      const extension = availablePhoto.type.includes('png') ? 'png' : 'jpeg'
      const imageId = workbook.addImage({ base64: dataUrl, extension })
      worksheet.addImage(imageId, {
        tl: { col: 4.12, row: row.number - 0.88 },
        ext: { width: 118, height: 78 },
        editAs: 'oneCell'
      })
      row.height = 66
    }
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const selected = sessionId ? sessionMap.get(sessionId)?.name || 'sesion' : 'completo'
  const filename = `inventario-${safeName(selected)}-${new Date().toISOString().slice(0, 10)}.xlsx`
  return { buffer, rows: computers.length, filename }
}

export async function exportInventoryToExcel(sessionId?: string, ownerId: string | null = null) {
  const result = await buildInventoryWorkbook(sessionId, ownerId)
  downloadBlob(new Blob([result.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), result.filename)
  return { rows: result.rows, filename: result.filename }
}
