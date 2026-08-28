import { createServer } from 'node:http'
import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import Database from 'better-sqlite3'
import { WebSocket, WebSocketServer } from 'ws'
import { COOLDOWN_MS, MAX_BATCH_SIZE, PALETTE, WORLD_SIZE, chunkKey, isInBounds, isPaletteId, type ClientMessage, type PaletteId, type ServerMessage, type Voxel } from '../shared/protocol.js'

const port = Number(process.env.PORT ?? 8787)
const secret = process.env.SESSION_SECRET ?? 'local-development-secret'
const database = new Database(process.env.DATABASE_PATH ?? './plac3d.db')
database.pragma('journal_mode = WAL')
database.exec(`CREATE TABLE IF NOT EXISTS voxels (x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, color TEXT NOT NULL, PRIMARY KEY (x, y, z));`)
database.exec(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, cooldown_until INTEGER NOT NULL DEFAULT 0);`)
if ((database.prepare('SELECT COUNT(*) AS count FROM voxels').get() as { count: number }).count === 0) {
  const seed = database.transaction(() => {
    const insert = database.prepare('INSERT INTO voxels (x, y, z, color) VALUES (?, ?, ?, ?)')
    for (let x = 490; x < 510; x += 1) for (let z = 490; z < 510; z += 1) {
      const distance = Math.hypot(x - 500, z - 500)
      const height = Math.max(0, Math.floor(8 - distance * 0.7))
      for (let y = 0; y <= height; y += 1) insert.run(x, y, z, 'white')
    }
  })
  seed()
}
const paletteIds = PALETTE.map(({ id }) => id)
const palettePlaceholders = paletteIds.map(() => '?').join(', ')
database.prepare(`UPDATE voxels SET color = ? WHERE color NOT IN (${palettePlaceholders})`).run('white', ...paletteIds)

const subscriptions = new Map<WebSocket, Set<string>>()
const tokenFor = (id: string) => `${id}.${createHmac('sha256', secret).update(id).digest('hex')}`
const validToken = (token: string) => {
  const [id, signature] = token.split('.')
  if (!id || !signature) return false
  const expected = tokenFor(id).split('.')[1]
  return signature === expected
}
const send = (socket: WebSocket, message: ServerMessage) => {
  if (socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(message))
    return true
  } catch (error) {
    console.error('Failed to send WebSocket message.', error)
    return false
  }
}
const getCooldown = database.prepare('SELECT cooldown_until AS cooldownUntil FROM sessions WHERE token = ?')
const createSession = database.prepare('INSERT INTO sessions (token, cooldown_until) VALUES (?, 0) ON CONFLICT(token) DO NOTHING')
const setCooldown = database.prepare('INSERT INTO sessions (token, cooldown_until) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET cooldown_until = excluded.cooldown_until')
const upsertVoxel = database.prepare('INSERT INTO voxels (x, y, z, color) VALUES (?, ?, ?, ?) ON CONFLICT(x, y, z) DO UPDATE SET color = excluded.color')
const deleteVoxel = database.prepare('DELETE FROM voxels WHERE x = ? AND y = ? AND z = ?')
const cooldownFor = (token: string) => (getCooldown.get(token) as { cooldownUntil: number } | undefined)?.cooldownUntil ?? 0
const parse = (raw: string): ClientMessage | null => {
  try { return JSON.parse(raw) as ClientMessage } catch { return null }
}
const voxelsInChunks = (keys: string[]) => {
  if (!keys.length) return {}
  const requested = new Set(keys)
  const result: Record<string, Voxel[]> = Object.fromEntries(
    keys.map((key) => [key, []]),
  )
  const rows = database.prepare('SELECT x, y, z, color FROM voxels').all() as Voxel[]
  for (const voxel of rows) {
    const key = chunkKey(voxel.x, voxel.y, voxel.z)
    if (requested.has(key)) result[key].push(voxel)
  }
  return result
}
const broadcast = (voxels: Voxel[], erased: Array<{ x: number; y: number; z: number }>) => {
  const affected = new Set([...voxels, ...erased].map(({ x, y, z }) => chunkKey(x, y, z)))
  for (const [socket, subscribed] of subscriptions) {
    if ([...affected].some((key) => subscribed.has(key))) send(socket, { type: 'updates', voxels, erased })
  }
}

const contentTypes: Record<string, string> = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const httpServer = createServer(async (request, response) => {
  if (request.url === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'ok' })); return }
  const requestedPath = decodeURIComponent((request.url ?? '/').split('?')[0])
  const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.slice(1)
  const filePath = normalize(join(process.cwd(), 'dist', relativePath))
  if (!filePath.startsWith(normalize(join(process.cwd(), 'dist')))) { response.writeHead(400); response.end('Invalid path'); return }
  try { const content = await readFile(filePath); response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' }); response.end(content) } catch { response.writeHead(404); response.end() }
})
const wss = new WebSocketServer({ server: httpServer, maxPayload: 256 * 1024 })
wss.on('connection', (socket) => {
  let token = ''
  subscriptions.set(socket, new Set())
  socket.on('message', (data) => {
    const message = parse(data.toString())
    if (!message) return send(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Message must be valid JSON.' })
    if (message.type === 'hello') {
      token = message.token && validToken(message.token) ? message.token : tokenFor(randomBytes(18).toString('hex'))
      createSession.run(token)
      return send(socket, { type: 'hello', token, cooldownUntil: cooldownFor(token) })
    }
    if (!token) return send(socket, { type: 'error', code: 'NOT_INITIALIZED', message: 'Send hello first.' })
    if (message.type === 'subscribe') {
      const keys = message.chunks.filter((key) => /^\d{1,3},\d{1,3},\d{1,3}$/.test(key)).slice(0, 256)
      subscriptions.set(socket, new Set(keys)); return send(socket, { type: 'chunks', chunks: voxelsInChunks(keys) })
    }
    if (message.type === 'place') {
      const cooldownUntil = cooldownFor(token)
      if (Date.now() < cooldownUntil) return send(socket, { type: 'error', requestId: message.requestId, code: 'COOLDOWN', message: 'Your next placement is not ready yet.', cooldownUntil })
      if (!Array.isArray(message.placements) || message.placements.length === 0 || message.placements.length > MAX_BATCH_SIZE) return send(socket, { type: 'error', requestId: message.requestId, code: 'BATCH_LIMIT', message: `Submit between 1 and ${MAX_BATCH_SIZE} voxels.` })
      const unique = new Set<string>(); const accepted: Voxel[] = []; const erased: Array<{ x: number; y: number; z: number }> = []
      for (const placement of message.placements) {
        if (!isInBounds(placement.x) || !isInBounds(placement.y) || !isInBounds(placement.z)) return send(socket, { type: 'error', requestId: message.requestId, code: 'OUT_OF_BOUNDS', message: `Coordinates must be within 0 and ${WORLD_SIZE - 1}.` })
        if (placement.color !== 'erase' && !isPaletteId(placement.color)) return send(socket, { type: 'error', requestId: message.requestId, code: 'INVALID_COLOR', message: 'Choose a color from the approved palette.' })
        const key = `${placement.x},${placement.y},${placement.z}`
        if (unique.has(key)) return send(socket, { type: 'error', requestId: message.requestId, code: 'DUPLICATE', message: 'A batch cannot contain duplicate coordinates.' })
        unique.add(key)
        if (placement.color === 'erase') erased.push(placement)
        else accepted.push({ ...placement, color: placement.color as PaletteId })
      }
      const nextCooldown = Date.now() + COOLDOWN_MS
      const transaction = database.transaction(() => {
        for (const voxel of accepted) upsertVoxel.run(voxel.x, voxel.y, voxel.z, voxel.color)
        for (const voxel of erased) deleteVoxel.run(voxel.x, voxel.y, voxel.z)
        setCooldown.run(token, nextCooldown)
      })
      try {
        transaction()
      } catch (error) {
        console.error('Failed to commit voxel placement.', error)
        return send(socket, {
          type: 'error',
          requestId: message.requestId,
          code: 'DATABASE_WRITE_FAILED',
          message: 'The batch could not be saved. Please try again.',
        })
      }
      broadcast(accepted, erased)
      return send(socket, {
        type: 'placed',
        requestId: message.requestId,
        cooldownUntil: nextCooldown,
        count: message.placements.length,
        voxels: accepted,
        erased,
      })
    }
  })
  socket.on('close', () => subscriptions.delete(socket))
})
httpServer.listen(port, () => console.log(`PLAC3D server listening on http://localhost:${port}`))
