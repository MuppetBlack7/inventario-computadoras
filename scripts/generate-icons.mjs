import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(resolve(root, 'public'), { recursive: true })

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}

const crc32 = (buffer) => {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function makeIcon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const center = size / 2
  const radius = size * 0.22
  const bars = [
    { x: .37, y: .48, w: .07, h: .18 },
    { x: .47, y: .37, w: .07, h: .29 },
    { x: .57, y: .43, w: .07, h: .23 }
  ]
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      const index = row + 1 + x * 4
      const distance = Math.hypot(x - center, y - center)
      const insideDisc = distance < size * .36
      const insideInner = distance < radius
      let color = insideDisc ? [12, 46, 42] : [244, 247, 245]
      if (insideInner) color = [20, 68, 61]
      for (const bar of bars) {
        if (x >= size * bar.x && x <= size * (bar.x + bar.w) && y >= size * bar.y && y <= size * (bar.y + bar.h)) color = [198, 243, 95]
      }
      raw[index] = color[0]
      raw[index + 1] = color[1]
      raw[index + 2] = color[2]
      raw[index + 3] = 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

for (const [filename, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(resolve(root, 'public', filename), makeIcon(size))
}
const testQr = JSON.stringify({ inventario: 'QR-DEMO-001', serie: 'SN-DEMO-2026-001', marca: 'Equipo de prueba', modelo: 'Modelo demostración', año: 'Desconocido', ubicacion: 'Laboratorio de prueba', observaciones: 'Registro generado con el QR de prueba; completar especificaciones manualmente.' })
await QRCode.toFile(resolve(root, 'public', 'qr-prueba.png'), testQr, { width: 640, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#0c2e2a', light: '#ffffff' } })
console.log('Iconos PWA y QR de prueba generados.')
