// 앱 아이콘 생성기: 파란 바탕 + 돋보기(DiskLens) 모양을 직접 그려 build/icon.ico (PNG 내장, 16/32/48/256)와 build/icon.png 를 만든다.
// 외부 이미지 도구/네트워크 없이 Node 만 쓴다. 사용: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

function crc32(buf) {
  let c
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** size x size RGBA 이미지를 그린다 (슈퍼샘플링 3x3 으로 가장자리를 부드럽게) */
function draw(size) {
  const px = Buffer.alloc(size * size * 4)
  const S = 3
  const shade = (x, y) => {
    // 좌표를 0..1 로
    const u = x / size
    const v = y / size
    // 둥근 사각형 바탕
    const r = 0.2
    const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0)
    const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0)
    if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0]
    const t = v
    let col = [37 + 20 * t, 99 - 20 * t, 235 - 40 * t, 255] // 파란 그라데이션
    // 돋보기 고리
    const cx = 0.44
    const cy = 0.44
    const d = Math.hypot(u - cx, v - cy)
    if (d < 0.27 && d > 0.19) col = [255, 255, 255, 255]
    else if (d <= 0.19) col = [col[0] + 40, col[1] + 60, Math.min(col[2] + 15, 255), 255]
    // 손잡이 (대각선 굵은 선)
    const ax = 0.62
    const ay = 0.62
    const bx = 0.82
    const by = 0.82
    const abx = bx - ax
    const aby = by - ay
    const tt = Math.max(0, Math.min(1, ((u - ax) * abx + (v - ay) * aby) / (abx * abx + aby * aby)))
    if (Math.hypot(u - (ax + tt * abx), v - (ay + tt * aby)) < 0.055) col = [255, 255, 255, 255]
    return col
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = shade(x + (sx + 0.5) / S, y + (sy + 0.5) / S)
          r += c[0] * c[3]
          g += c[1] * c[3]
          b += c[2] * c[3]
          a += c[3]
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        px[o] = Math.round(r / a)
        px[o + 1] = Math.round(g / a)
        px[o + 2] = Math.round(b / a)
      }
      px[o + 3] = Math.round(a / (S * S))
    }
  }
  return px
}

function png(size) {
  const px = draw(size)
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const sizes = [16, 32, 48, 256]
const images = sizes.map((s) => png(s))
const header = Buffer.alloc(6)
header.writeUInt16LE(1, 2) // type = icon
header.writeUInt16LE(sizes.length, 4)
const dir = Buffer.alloc(16 * sizes.length)
let offset = 6 + dir.length
sizes.forEach((s, i) => {
  const o = i * 16
  dir[o] = s === 256 ? 0 : s
  dir[o + 1] = s === 256 ? 0 : s
  dir.writeUInt16LE(1, o + 4) // planes
  dir.writeUInt16LE(32, o + 6) // bpp
  dir.writeUInt32LE(images[i].length, o + 8)
  dir.writeUInt32LE(offset, o + 12)
  offset += images[i].length
})
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.ico', Buffer.concat([header, dir, ...images]))
writeFileSync('build/icon.png', images[sizes.length - 1])
console.log('build/icon.ico, build/icon.png 생성')
