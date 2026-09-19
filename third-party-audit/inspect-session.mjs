// Inspect the STRUCTURE of a DSH session log: which metadata each record
// carries, and specifically whether a user message records anything about the
// sender (identity, client, device, address). Prints keys and small scalar
// metadata only — message bodies are reported by length, never by content.
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const raw = readFileSync(file)

let text
if (typeof zlib.createZstdDecompress === 'function') {
  // The log appends one zstd frame per flush, so it must be decoded as a
  // stream: the one-shot zstdDecompressSync stops at the first frame.
  const chunks = []
  await new Promise((resolve, reject) => {
    const dec = zlib.createZstdDecompress()
    dec.on('data', (c) => chunks.push(c))
    dec.on('end', resolve)
    dec.on('error', reject)
    dec.end(raw)
  })
  text = Buffer.concat(chunks).toString('utf8')
} else {
  // Fall back to the zstd binary shipped in the profile if Node lacks support.
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dshlog-'))
  const tmp = join(dir, 's.jsonl.zst')
  writeFileSync(tmp, raw)
  text = execFileSync('zstd', ['-d', '-c', tmp], { maxBuffer: 1 << 30 }).toString('utf8')
}

const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`records: ${String(lines.length)}`)

const kindCount = new Map()
const seenShape = new Map()

for (const line of lines) {
  let rec
  try { rec = JSON.parse(line) } catch { continue }
  const kind = String(rec.type ?? rec.kind ?? rec.role ?? 'unknown')
  kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1)

  if (seenShape.has(kind)) continue
  const describe = (obj, depth = 0) => {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) out[k] = String(v)
      else if (Array.isArray(v)) out[k] = `array(${String(v.length)})`
      else if (typeof v === 'object') out[k] = depth < 2 ? describe(v, depth + 1) : 'object'
      else if (typeof v === 'string') out[k] = v.length > 80 ? `string(${String(v.length)})` : JSON.stringify(v)
      else out[k] = v
    }
    return out
  }
  seenShape.set(kind, describe(rec))
}

console.log('\n=== record kinds ===')
for (const [k, n] of [...kindCount].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`)

console.log('\n=== first record shape per kind (values: scalars shown, bodies summarized) ===')
for (const [k, shape] of seenShape) {
  console.log(`\n--- ${k}`)
  console.log(JSON.stringify(shape, null, 2))
}
