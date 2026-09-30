const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { spawn } = require('child_process')

const SERVER_DIR = __dirname
const ROOT_DIR = path.dirname(SERVER_DIR)
const nbt = require(path.join(ROOT_DIR, 'Bots', 'node_modules', 'prismarine-nbt'))
const PORT = Number(process.env.SERVER_MANAGER_PORT || 3101)
const HOST = process.env.SERVER_MANAGER_HOST || '0.0.0.0'
const LOCAL_HOST = '127.0.0.1'
const SERVER_JAVA_EXE = process.env.SERVER_JAVA_EXE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium', 'jdk-25.0.4.1+1', 'bin', 'java.exe')
const LOG_DIR = path.join(ROOT_DIR, 'Logs', 'minecraft-server')
const OUT_LOG = path.join(LOG_DIR, 'server.out.log')
const ERR_LOG = path.join(LOG_DIR, 'server.err.log')
const PID_FILE = path.join(SERVER_DIR, 'server.pid')
const MANAGER_PID_FILE = path.join(SERVER_DIR, 'server-manager.pid')
const WORLD_BACKUP_DIR = path.join(ROOT_DIR, 'Data', 'backups', 'minecraft-worlds')
const TEXTURE_ROOT = path.join(ROOT_DIR, 'Bots', 'node_modules', 'prismarine-viewer', 'public', 'textures', '1.21.4')
const JSON_FILES = new Set(['ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'usercache.json'])
let serverChild = null

process.env.TZ ||= 'Europe/Amsterdam'
fs.writeFileSync(MANAGER_PID_FILE, String(process.pid), 'utf8')
process.once('exit', () => {
  try {
    if (fs.readFileSync(MANAGER_PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(MANAGER_PID_FILE)
  } catch {}
})

function stamp() {
  const d = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}`
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(data))
}

function text(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) reject(new Error('Request body is too large.'))
    })
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('Invalid JSON body.')) }
    })
    request.on('error', reject)
  })
}

function readJsonFile(name, fallback = []) {
  const file = path.join(SERVER_DIR, name)
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8') || '[]')
}

function writeJsonFile(name, data) {
  if (!JSON_FILES.has(name)) throw new Error('This JSON file is not editable here.')
  fs.writeFileSync(path.join(SERVER_DIR, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function parseProperties() {
  const file = path.join(SERVER_DIR, 'server.properties')
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : []
  const values = {}
  for (const line of lines) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const index = line.indexOf('=')
    values[line.slice(0, index)] = line.slice(index + 1)
  }
  return { file, lines, values }
}

function saveProperties(updates) {
  const { file, lines } = parseProperties()
  const next = { ...updates }
  const out = lines.map(line => {
    if (!line || line.startsWith('#') || !line.includes('=')) return line
    const key = line.slice(0, line.indexOf('='))
    if (!Object.prototype.hasOwnProperty.call(next, key)) return line
    const value = String(next[key] ?? '')
    delete next[key]
    return `${key}=${value.replace(/\n/g, '\\n')}`
  })
  for (const [key, value] of Object.entries(next)) out.push(`${key}=${String(value ?? '').replace(/\n/g, '\\n')}`)
  fs.copyFileSync(file, `${file}.backup-${stamp()}`)
  fs.writeFileSync(file, `${out.join(os.EOL)}${os.EOL}`, 'utf8')
}

function processAlive(pid) {
  if (!pid) return false
  try { process.kill(Number(pid), 0); return true } catch { return false }
}

function serverPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim())
    return processAlive(pid) ? pid : null
  } catch {
    return null
  }
}

function portListening(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: LOCAL_HOST, port })
    const finish = value => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(800)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function tail(file, lines = 160) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines)
}

function appendLog(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${line}${os.EOL}`, 'utf8')
}

function sendServerCommand(command) {
  const text = String(command || '').trim()
  if (!text) throw new Error('Command is empty.')
  if (!serverChild || !serverChild.stdin || serverChild.killed) {
    throw new Error('Server commands are only available after starting the server from this manager.')
  }
  serverChild.stdin.write(`${text}\n`)
  appendLog(OUT_LOG, `[${new Date().toLocaleTimeString('nl-NL', { hour12: false })}] [Manager/COMMAND]: ${text}`)
  return { command: text }
}

function cleanChatText(value, maxLength = 240) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength)
}

function sendDiscordChatMessage(username, message) {
  const name = cleanChatText(username || 'Discord', 32) || 'Discord'
  const text = cleanChatText(message, 220)
  if (!text) throw new Error('Message is empty.')
  const parts = [
    { text: `[Discord] ${name}: `, color: 'blue' },
    { text, color: 'white' }
  ]
  return sendServerCommand(`tellraw @a ${JSON.stringify(parts)}`)
}

function jars() {
  return fs.readdirSync(SERVER_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
    .map(entry => {
      const file = path.join(SERVER_DIR, entry.name)
      const stat = fs.statSync(file)
      const version = entry.name.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] || (entry.name === 'server.jar' ? 'active' : 'unknown')
      return { name: entry.name, version, size: stat.size, active: entry.name === 'server.jar', updatedAt: stat.mtime.toISOString() }
    })
}

function worlds() {
  return fs.readdirSync(SERVER_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => fs.existsSync(path.join(SERVER_DIR, entry.name, 'level.dat')) || fs.existsSync(path.join(SERVER_DIR, entry.name, 'region')))
    .map(entry => {
      const folder = path.join(SERVER_DIR, entry.name)
      const stat = fs.statSync(folder)
      return { name: entry.name, updatedAt: stat.mtime.toISOString(), active: entry.name === parseProperties().values['level-name'] }
    })
}

function dashedUuid(value) {
  const raw = String(value || '').replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(raw)) return String(value || '')
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

function uuidFileName(value) {
  return `${dashedUuid(value)}.dat`
}

function itemName(id) {
  return String(id || '').replace(/^minecraft:/, '')
}

function itemTexturePath(id) {
  const name = itemName(id)
  const candidates = [
    path.join(TEXTURE_ROOT, 'items', `${name}.png`),
    path.join(TEXTURE_ROOT, 'blocks', `${name}.png`),
    path.join(TEXTURE_ROOT, 'blocks', `${name}_front.png`),
    path.join(TEXTURE_ROOT, 'blocks', `${name}_top.png`),
    name === 'shield' ? path.join(TEXTURE_ROOT, 'entity', 'shield_base.png') : ''
  ]
  return candidates.find(file => fs.existsSync(file)) || ''
}

function blockTexturePath(id, face = 'side') {
  const name = itemName(id)
  const candidates = face === 'top'
    ? [
        path.join(TEXTURE_ROOT, 'blocks', `${name}_top.png`),
        path.join(TEXTURE_ROOT, 'blocks', `${name}.png`),
        path.join(TEXTURE_ROOT, 'blocks', `${name}_side.png`)
      ]
    : [
        path.join(TEXTURE_ROOT, 'blocks', `${name}.png`),
        path.join(TEXTURE_ROOT, 'blocks', `${name}_side.png`),
        path.join(TEXTURE_ROOT, 'blocks', `${name}_front.png`)
      ]
  return candidates.find(file => fs.existsSync(file)) || ''
}

function isBlockIconItem(id) {
  const name = itemName(id)
  return Boolean(blockTexturePath(name, 'side')) && name !== 'shield'
}

function itemTextureUrl(id) {
  if (isBlockIconItem(id)) return `/block-icons/${encodeURIComponent(itemName(id))}.svg`
  const file = itemTexturePath(id)
  const fallback = path.join(TEXTURE_ROOT, 'items', 'barrier.png')
  const selected = file || (fs.existsSync(fallback) ? fallback : '')
  return selected ? `/textures/${selected.slice(TEXTURE_ROOT.length + 1).replace(/\\/g, '/')}` : ''
}

function textureHref(file) {
  return `/textures/${file.slice(TEXTURE_ROOT.length + 1).replace(/\\/g, '/')}`
}

function blockIconSvg(id) {
  const name = itemName(id)
  const side = blockTexturePath(name, 'side')
  if (!side) return ''
  const top = blockTexturePath(name, 'top') || side
  const right = blockTexturePath(`${name}_front`, 'side') || side
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <pattern id="top" patternUnits="userSpaceOnUse" width="16" height="16"><image href="${textureHref(top)}" width="16" height="16" image-rendering="pixelated"/></pattern>
    <pattern id="left" patternUnits="userSpaceOnUse" width="16" height="16"><image href="${textureHref(side)}" width="16" height="16" image-rendering="pixelated"/></pattern>
    <pattern id="right" patternUnits="userSpaceOnUse" width="16" height="16"><image href="${textureHref(right)}" width="16" height="16" image-rendering="pixelated"/></pattern>
    <filter id="shade"><feComponentTransfer><feFuncR type="linear" slope=".76"/><feFuncG type="linear" slope=".76"/><feFuncB type="linear" slope=".76"/></feComponentTransfer></filter>
    <filter id="light"><feComponentTransfer><feFuncR type="linear" slope="1.08"/><feFuncG type="linear" slope="1.08"/><feFuncB type="linear" slope="1.08"/></feComponentTransfer></filter>
  </defs>
  <polygon points="32,4 58,18 32,32 6,18" fill="url(#top)" filter="url(#light)"/>
  <polygon points="6,18 32,32 32,60 6,46" fill="url(#left)" filter="url(#shade)"/>
  <polygon points="58,18 32,32 32,60 58,46" fill="url(#right)"/>
  <path d="M32 4 58 18 58 46 32 60 6 46 6 18Z" fill="none" stroke="rgba(0,0,0,.45)" stroke-width="2"/>
</svg>`
}

async function loadPlayerNbt(uuid) {
  const id = dashedUuid(uuid)
  const file = path.join(SERVER_DIR, 'world', 'playerdata', uuidFileName(id))
  if (!fs.existsSync(file)) throw new Error('Playerdata file was not found.')
  return { id, file, parsed: await nbt.parse(fs.readFileSync(file)) }
}

function savePlayerNbt(file, parsed) {
  fs.copyFileSync(file, `${file}.backup-${stamp()}`)
  const raw = nbt.writeUncompressed(parsed.parsed, parsed.type || 'big')
  fs.writeFileSync(file, zlib.gzipSync(raw))
}

function setNbtValue(root, key, value) {
  const node = root[key]
  if (!node) return
  if (node.type === 'float') node.value = Number(value)
  else if (['int', 'short', 'byte', 'long'].includes(node.type)) node.value = Math.trunc(Number(value))
  else if (node.type === 'string') node.value = String(value)
}

function localServerAddress(port) {
  const interfaces = os.networkInterfaces()
  const rows = []
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list || []) {
      if (entry.family === 'IPv4' && !entry.internal) rows.push({ name, address: entry.address })
    }
  }
  const realAdapter = rows.find(row => !/vethernet|virtual|loopback|default switch/i.test(row.name) && !row.address.endsWith('.1'))
  if (realAdapter) return `${realAdapter.address}:${port}`
  const nonGateway = rows.find(row => !row.address.endsWith('.1'))
  if (nonGateway) return `${nonGateway.address}:${port}`
  if (rows[0]) return `${rows[0].address}:${port}`
  return `127.0.0.1:${port}`
}

function nbtRoot(parsed) {
  return parsed.parsed.value
}

function playerIsOnline(uuid) {
  const id = dashedUuid(uuid)
  const player = playerSummaries().find(row => row.uuid === id)
  return Boolean(player?.online)
}

function backupPlayerFile(file, name = 'player') {
  const target = path.join(ROOT_DIR, 'Data', 'backups', 'minecraft-players', `${name}-${stamp()}.dat`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(file, target)
  return target
}

async function updatePlayerStats(uuid, updates) {
  if (playerIsOnline(uuid)) throw new Error('Stop or kick this player before editing saved playerdata.')
  const loaded = await loadPlayerNbt(uuid)
  const root = nbtRoot(loaded.parsed)
  backupPlayerFile(loaded.file, `stats-${loaded.id}`)
  for (const key of ['Health', 'foodLevel', 'XpLevel', 'XpP', 'Score', 'Fire', 'Air']) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) setNbtValue(root, key, updates[key])
  }
  if (root.Pos?.value?.value && ['x', 'y', 'z'].some(key => Object.prototype.hasOwnProperty.call(updates, key))) {
    const pos = root.Pos.value.value
    if (Object.prototype.hasOwnProperty.call(updates, 'x')) pos[0].value = Number(updates.x)
    if (Object.prototype.hasOwnProperty.call(updates, 'y')) pos[1].value = Number(updates.y)
    if (Object.prototype.hasOwnProperty.call(updates, 'z')) pos[2].value = Number(updates.z)
  }
  savePlayerNbt(loaded.file, loaded.parsed)
}

async function deletePlayerData(uuid) {
  if (playerIsOnline(uuid)) throw new Error('Stop or kick this player before deleting saved playerdata.')
  const id = dashedUuid(uuid)
  const file = path.join(SERVER_DIR, 'world', 'playerdata', uuidFileName(id))
  if (fs.existsSync(file)) {
    const target = path.join(ROOT_DIR, 'Data', 'backups', 'minecraft-players', `deleted-${id}-${stamp()}.dat`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(file, target)
  }
}

async function deletePlayerItem(uuid, slot) {
  if (playerIsOnline(uuid)) throw new Error('Stop or kick this player before editing inventory.')
  const loaded = await loadPlayerNbt(uuid)
  const root = nbtRoot(loaded.parsed)
  const inventory = root.Inventory?.value
  if (!inventory?.value || !Array.isArray(inventory.value)) throw new Error('Inventory was not found.')
  const before = inventory.value.length
  inventory.value = inventory.value.filter(item => Number(item.value?.Slot?.value) !== Number(slot))
  if (inventory.value.length === before) throw new Error('Item slot was not found.')
  backupPlayerFile(loaded.file, `item-${loaded.id}`)
  savePlayerNbt(loaded.file, loaded.parsed)
}

async function clearPlayerInventory(uuid) {
  if (playerIsOnline(uuid)) throw new Error('Stop or kick this player before editing inventory.')
  const loaded = await loadPlayerNbt(uuid)
  const root = nbtRoot(loaded.parsed)
  if (!root.Inventory?.value) throw new Error('Inventory was not found.')
  backupPlayerFile(loaded.file, `inventory-${loaded.id}`)
  root.Inventory.value.value = []
  savePlayerNbt(loaded.file, loaded.parsed)
}

function onlinePlayerNames() {
  const online = new Set()
  for (const line of tail(OUT_LOG, 500)) {
    const joined = line.match(/\]: ([A-Za-z0-9_]{1,16}) joined the game/)
    const left = line.match(/\]: ([A-Za-z0-9_]{1,16}) left the game/)
    if (joined) online.add(joined[1])
    if (left) online.delete(left[1])
  }
  return online
}

function playerSummaries() {
  const cache = readJsonFile('usercache.json', [])
  const byUuid = new Map(cache.map(player => [dashedUuid(player.uuid), player]))
  const files = fs.existsSync(path.join(SERVER_DIR, 'world', 'playerdata'))
    ? fs.readdirSync(path.join(SERVER_DIR, 'world', 'playerdata')).filter(name => name.endsWith('.dat'))
    : []
  const online = onlinePlayerNames()
  const rows = files.map(file => {
    const uuid = dashedUuid(file.replace(/\.dat$/, ''))
    const cached = byUuid.get(uuid)
    const name = cached?.name || uuid
    return {
      uuid,
      name,
      online: online.has(name),
      file,
      updatedAt: fs.statSync(path.join(SERVER_DIR, 'world', 'playerdata', file)).mtime.toISOString()
    }
  })
  for (const player of cache) {
    const uuid = dashedUuid(player.uuid)
    if (!rows.some(row => row.uuid === uuid)) rows.push({ uuid, name: player.name, online: online.has(player.name), file: '', updatedAt: '' })
  }
  return rows.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
}

async function playerDetails(uuid) {
  const id = dashedUuid(uuid)
  const summary = playerSummaries().find(player => player.uuid === id) || { uuid: id, name: id, online: false }
  const file = path.join(SERVER_DIR, 'world', 'playerdata', uuidFileName(id))
  if (!fs.existsSync(file)) return { ...summary, found: false }
  const parsed = await nbt.parse(fs.readFileSync(file))
  const data = nbt.simplify(parsed.parsed || parsed)
  const allInventory = Array.isArray(data.Inventory) ? data.Inventory.map(item => ({
    id: item.id,
    count: item.Count ?? item.count ?? 1,
    slot: item.Slot,
    icon: itemTextureUrl(item.id),
    tag: item.tag || null
  })).sort((a, b) => Number(a.slot) - Number(b.slot)) : []
  const equipment = {
    helmet: allInventory.find(item => Number(item.slot) === 103) || null,
    chestplate: allInventory.find(item => Number(item.slot) === 102) || null,
    leggings: allInventory.find(item => Number(item.slot) === 101) || null,
    boots: allInventory.find(item => Number(item.slot) === 100) || null,
    offhand: allInventory.find(item => Number(item.slot) === -106) || null
  }
  const inventory = allInventory.filter(item => ![100, 101, 102, 103, -106].includes(Number(item.slot)))
  return {
    ...summary,
    found: true,
    health: data.Health ?? null,
    food: data.foodLevel ?? null,
    xpLevel: data.XpLevel ?? null,
    xpProgress: data.XpP ?? null,
    score: data.Score ?? null,
    dimension: data.Dimension || '',
    position: Array.isArray(data.Pos) ? { x: data.Pos[0], y: data.Pos[1], z: data.Pos[2] } : null,
    rotation: Array.isArray(data.Rotation) ? { yaw: data.Rotation[0], pitch: data.Rotation[1] } : null,
    inventory,
    equipment,
    selectedItemSlot: data.SelectedItemSlot ?? null,
    abilities: data.abilities || {},
    stats: {
      fire: data.Fire ?? null,
      air: data.Air ?? null,
      fallDistance: data.FallDistance ?? null,
      deathTime: data.DeathTime ?? null,
      hurtTime: data.HurtTime ?? null
    }
  }
}

function copyDir(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true })
}

function safeWorldName(name) {
  const value = String(name || '').trim()
  if (!/^[\w .-]{1,80}$/.test(value)) throw new Error('Invalid world name.')
  const folder = path.resolve(SERVER_DIR, value)
  if (!folder.startsWith(`${SERVER_DIR}${path.sep}`)) throw new Error('Invalid world folder.')
  return value
}

async function startServer() {
  const pid = serverPid()
  if (pid) return { pid, alreadyRunning: true }
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const outStream = fs.createWriteStream(OUT_LOG, { flags: 'a' })
  const errStream = fs.createWriteStream(ERR_LOG, { flags: 'a' })
  const child = spawn(SERVER_JAVA_EXE, ['-Xms4G', '-Xmx10G', '-jar', 'server.jar'], {
    cwd: SERVER_DIR,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdout.pipe(outStream)
  child.stderr.pipe(errStream)
  child.once('exit', () => {
    if (serverChild === child) serverChild = null
    try { fs.unlinkSync(PID_FILE) } catch {}
  })
  serverChild = child
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8')
  return { pid: child.pid, alreadyRunning: false }
}

async function stopServer() {
  const pid = serverPid()
  if (!pid) {
    try { fs.unlinkSync(PID_FILE) } catch {}
    return { stopped: false }
  }
  if (serverChild?.stdin && !serverChild.killed) {
    try { serverChild.stdin.write('stop\n') } catch {}
  } else {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  await new Promise(resolve => setTimeout(resolve, 8000))
  if (processAlive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
  serverChild = null
  try { fs.unlinkSync(PID_FILE) } catch {}
  return { stopped: true, pid }
}

async function state() {
  const props = parseProperties().values
  const port = Number(props['server-port'] || 25565)
  const pid = serverPid()
  const output = tail(OUT_LOG)
  const serverReady = output.slice().reverse().some(line => line.includes('Done (') || line.includes('For help, type "help"'))
  return {
    managerPort: PORT,
    serverDir: SERVER_DIR,
    status: {
      running: Boolean(pid),
      pid,
      port,
      listening: await portListening(port) || (Boolean(pid) && serverReady),
      address: localServerAddress(port)
    },
    properties: props,
    jars: jars(),
    worlds: worlds(),
    players: playerSummaries(),
    files: Object.fromEntries([...JSON_FILES].map(name => [name, readJsonFile(name, [])])),
    logs: {
      out: output,
      err: tail(ERR_LOG, 80)
    }
  }
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" href="/favicon.png">
  <title>Minecraft Server Manager</title>
  <style>
    :root{color-scheme:dark;--bg:#070b12;--panel:#101923;--line:#294055;--text:#f4f8ff;--muted:#9fb0c2;--green:#55d6a5;--blue:#2f7db8;--red:#e26b7f;--yellow:#f1c75b;font-family:Inter,ui-sans-serif,system-ui,Segoe UI,sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}button,input,select,textarea{font:inherit}.shell{min-height:100vh;display:grid;grid-template-columns:220px minmax(0,1fr)}aside{position:sticky;top:0;height:100vh;border-right:1px solid var(--line);background:#0a1018;padding:20px 14px}.brand{margin-bottom:24px}.brand small,.eyebrow{display:block;color:var(--green);font-size:.72rem;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.brand strong{display:block;margin-top:5px;font-size:1.1rem}nav{display:grid;gap:6px}nav button{text-align:left;background:transparent;border:1px solid transparent;color:var(--muted)}nav button.active,nav button:hover{background:#142231;border-color:var(--line);color:white}main{width:100%;max-width:1500px;margin:0 auto;padding:24px}header{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:18px}.top-status{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.copy-pill{min-height:34px;border:1px solid var(--line);border-radius:999px;background:#08121c;color:#bfe7ff;padding:6px 12px}h1{margin:4px 0 0;font-size:2rem}h2{margin:0 0 10px;font-size:1.05rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px}.wide{grid-column:1/-1}.card{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:14px}.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}.chat-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.player-layout{display:grid;grid-template-columns:minmax(330px,.38fr) minmax(0,1fr);gap:12px;align-items:start}.player-list{display:grid;gap:8px;max-height:72vh;overflow:auto}.player-card{display:grid;grid-template-columns:48px minmax(0,1fr) 38px;align-items:center;gap:12px;border:1px solid var(--line);border-radius:8px;background:#101923;padding:10px;text-align:left}.player-card img{width:48px;height:48px;image-rendering:pixelated;border-radius:3px}.player-card .arrow{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#9aa3aa;color:white;font-size:1.4rem}.player-card.active{border-color:var(--green)}.player-name{font-size:1rem;font-weight:900}.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#a9b0b6;margin-left:6px}.status-dot.online{background:var(--green)}.detail-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}.detail-head img{width:58px;height:58px;image-rendering:pixelated;border-radius:4px}.detail-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 14px}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.info-box{border:1px solid var(--line);border-radius:7px;background:#08121c;padding:10px}.info-box strong{display:block;margin-bottom:4px}.equipment-row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;margin-bottom:12px}.equipment-slot{display:grid;gap:5px;justify-items:center;color:var(--muted);font-size:.72rem;font-weight:900;text-transform:uppercase}.inventory-wrap{overflow:auto;border:1px solid var(--line);border-radius:8px;background:#303942;padding:12px}.mc-inventory{display:grid;grid-template-columns:repeat(9,44px);gap:3px;width:max-content}.slot{position:relative;width:44px;height:44px;background:#8b8b8b;border-top:3px solid #dadada;border-left:3px solid #dadada;border-right:3px solid #585858;border-bottom:3px solid #585858}.slot img{width:32px;height:32px;margin:3px;image-rendering:pixelated}.slot .empty-icon{width:32px;height:32px;margin:3px;opacity:.18;image-rendering:pixelated}.slot .count{position:absolute;right:3px;bottom:0;color:white;font-weight:900;text-shadow:2px 2px #333}.slot .del{position:absolute;top:1px;right:1px;width:17px;height:17px;min-height:0;padding:0;border-radius:3px;background:#8e3042;display:none;line-height:1}.slot:hover .del{display:block}.inv-note{margin-top:8px;color:var(--muted);font-size:.85rem}button{min-height:38px;border:1px solid transparent;border-radius:6px;background:var(--blue);color:white;font-weight:900;padding:8px 12px;cursor:pointer}button.secondary{background:#172838;border-color:var(--line)}button.danger{background:#8e3042}input,select,textarea{width:100%;min-width:0;border:1px solid var(--line);border-radius:6px;background:#08121c;color:var(--text);padding:9px 10px}.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;padding:6px 10px;color:var(--muted);font-weight:900}.pill.online{color:var(--green);border-color:#29614d}.item{display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--line);padding:9px 0;color:var(--muted)}.item:first-child{border-top:0}.item strong{color:var(--text)}label{display:grid;gap:5px;color:var(--muted);font-size:.75rem;font-weight:900;text-transform:uppercase}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.console{min-height:300px;max-height:58vh;overflow:auto;white-space:pre-wrap;background:#050a10;border:1px solid var(--line);border-radius:8px;padding:12px;color:#c9e3d8;font: .8rem Consolas,monospace}.hidden{display:none}.list{display:grid;gap:8px}@media(max-width:1000px){.player-layout{grid-template-columns:1fr}}@media(max-width:850px){.shell{grid-template-columns:1fr}aside{position:relative;height:auto}nav{grid-template-columns:1fr 1fr}main{padding:14px}}
  </style>
</head>
<body>
<div class="shell">
  <aside>
    <div class="brand"><small>Local controller</small><strong>Minecraft Server</strong></div>
    <nav>
      <button type="button" data-tab="overview" class="active">Overview</button>
      <button type="button" data-tab="chat">Chat</button>
      <button type="button" data-tab="console">Console</button>
      <button type="button" data-tab="properties">Properties</button>
      <button type="button" data-tab="worlds">Worlds</button>
      <button type="button" data-tab="players">Players</button>
      <button type="button" data-tab="files">Files</button>
      <button type="button" data-tab="logs">Logs</button>
    </nav>
  </aside>
  <main>
    <header><div><span class="eyebrow">Minecraft server control</span><h1 id="title">Overview</h1></div><div class="top-status"><button type="button" id="copyAddress" class="copy-pill" title="Copy server IP"><span id="serverAddress">Loading IP</span></button><span id="status" class="pill">Loading</span></div></header>
    <div class="toolbar"><button id="start">Start server</button><button id="stop" class="secondary">Stop server</button><button id="refresh" class="secondary">Refresh</button></div>
    <section id="overview" class="tab grid"></section>
    <section id="chat" class="tab hidden grid"><div class="card wide"><h2>Server chat</h2><div id="chatLog" class="console"></div><form id="chatForm" class="chat-form" style="margin-top:10px"><input id="chatInput" placeholder="Type as server, for example: Hello players"><button type="submit">Say</button></form></div></section>
    <section id="console" class="tab hidden grid"><div class="card wide"><h2>Console</h2><div id="consoleLog" class="console"></div><form id="commandForm" class="chat-form" style="margin-top:10px"><input id="commandInput" placeholder="Server command, for example: time set day"><button type="submit">Run command</button></form></div></section>
    <section id="properties" class="tab hidden"><div class="card"><h2>Server properties</h2><div id="propsForm" class="form-grid"></div><div class="toolbar" style="margin-top:12px"><button id="saveProps">Save properties</button></div></div></section>
    <section id="worlds" class="tab hidden grid"></section>
    <section id="players" class="tab hidden player-layout"><div class="card"><h2>Players</h2><div id="playerList" class="player-list"></div></div><div id="playerDetails" class="card"><h2>Player details</h2><p style="color:var(--muted)">Select a player.</p></div></section>
    <section id="files" class="tab hidden grid"></section>
    <section id="logs" class="tab hidden grid"><div class="card wide"><h2>Server output</h2><div id="outLog" class="console"></div></div><div class="card wide"><h2>Server errors</h2><div id="errLog" class="console"></div></div></section>
  </main>
</div>
<script>
let data=null
let selectedPlayer=''
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
async function api(url, options={}){const r=await fetch(url,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});const j=await r.json().catch(()=>({}));if(!r.ok||j.ok===false)throw new Error(j.error||'Request failed');return j}
function bytes(v){let n=Number(v||0),u=['B','KB','MB','GB'],i=0;while(n>1024&&i<u.length-1){n/=1024;i++}return n.toFixed(i?1:0)+' '+u[i]}
function head(name){return 'https://mc-heads.net/avatar/'+encodeURIComponent(name||'Steve')+'/48'}
function propInput(key,value){const bool=['true','false'].includes(String(value));return '<label>'+esc(key)+(bool?'<select data-prop="'+esc(key)+'"><option value="true" '+(value==='true'?'selected':'')+'>true</option><option value="false" '+(value==='false'?'selected':'')+'>false</option></select>':'<input data-prop="'+esc(key)+'" value="'+esc(value)+'">')+'</label>'}
function renderPlayerList(){document.getElementById('playerList').innerHTML=(data.players||[]).map(p=>'<button type="button" class="player-card '+(selectedPlayer===p.uuid?'active':'')+'" data-player="'+esc(p.uuid)+'"><img src="'+head(p.name)+'" alt=""><span><span class="player-name">'+esc(p.name)+'</span><span class="status-dot '+(p.online?'online':'')+'"></span><br><small>'+esc(p.online?'Online':'Offline')+'</small></span><span class="arrow">â€º</span></button>').join('')||'<p style="color:var(--muted)">No players found.</p>'}
function renderInventory(items,equipment={}){const bySlot=new Map((items||[]).map(item=>[Number(item.slot),item]));let html='';for(let slot=0;slot<36;slot++){html+=renderSlot(slot,bySlot.get(slot))}for(const item of (items||[]).filter(item=>Number(item.slot)<0||Number(item.slot)>35)){html+=renderSlot(Number(item.slot),item)}return '<div class="equipment-row">'+equipmentSlot('Helmet',equipment.helmet,'/textures/items/iron_helmet.png')+equipmentSlot('Chestplate',equipment.chestplate,'/textures/items/iron_chestplate.png')+equipmentSlot('Leggings',equipment.leggings,'/textures/items/iron_leggings.png')+equipmentSlot('Boots',equipment.boots,'/textures/items/iron_boots.png')+equipmentSlot('Shield place',equipment.offhand,'/textures/gui/sprites/container/slot/shield.png')+'</div><div class="mc-inventory">'+html+'</div>'}
function equipmentSlot(label,item,emptyIcon){return '<div class="equipment-slot"><span>'+esc(label)+'</span>'+renderSlot(label,item,emptyIcon)+'</div>'}
function renderSlot(slot,item,emptyIcon=''){if(!item)return '<div class="slot" title="Empty slot '+esc(slot)+'">'+(emptyIcon?'<img class="empty-icon" src="'+esc(emptyIcon)+'" alt="">':'')+'</div>';const icon='<img src="'+esc(item.icon||'/textures/items/barrier.png')+'" alt="">';return '<div class="slot" title="'+esc(item.id)+' | slot '+esc(item.slot??slot)+'">'+icon+'<span class="count">'+esc(item.count>1?item.count:'')+'</span><button type="button" class="del" data-delete-item-slot="'+esc(item.slot??slot)+'">x</button></div>'}
async function showPlayer(uuid){selectedPlayer=uuid;renderPlayerList();const result=await api('/api/player/'+encodeURIComponent(uuid));const p=result.player;const pos=p.position||{};const posText=p.position?Math.round(pos.x)+' / '+Math.round(pos.y)+' / '+Math.round(pos.z):'-';document.getElementById('playerDetails').innerHTML='<div class="detail-head"><img src="'+head(p.name)+'" alt=""><div><h2>'+esc(p.name)+'</h2><span class="pill '+(p.online?'online':'')+'">'+esc(p.online?'Online':'Offline')+'</span><p style="color:var(--muted);margin:6px 0 0">'+esc(p.uuid)+'</p></div></div><div class="detail-actions"><button type="button" data-save-player-stats>Save stats</button><button type="button" class="secondary" data-clear-inventory>Clear inventory</button><button type="button" class="danger" data-delete-player>Delete player data</button></div><div class="stats-grid"><label>Health<input data-player-stat="Health" type="number" step="0.5" value="'+esc(p.health??'')+'"></label><label>Food<input data-player-stat="foodLevel" type="number" step="1" value="'+esc(p.food??'')+'"></label><label>XP level<input data-player-stat="XpLevel" type="number" step="1" value="'+esc(p.xpLevel??'')+'"></label><label>XP progress<input data-player-stat="XpP" type="number" step="0.01" value="'+esc(p.xpProgress??'')+'"></label><label>Score<input data-player-stat="Score" type="number" step="1" value="'+esc(p.score??'')+'"></label><label>X<input data-player-stat="x" type="number" step="0.01" value="'+esc(pos.x??'')+'"></label><label>Y<input data-player-stat="y" type="number" step="0.01" value="'+esc(pos.y??'')+'"></label><label>Z<input data-player-stat="z" type="number" step="0.01" value="'+esc(pos.z??'')+'"></label></div><div class="stats-grid" style="margin-top:10px"><div class="info-box"><strong>Position</strong>'+esc(posText)+'</div><div class="info-box"><strong>Dimension</strong>'+esc(p.dimension||'-')+'</div><div class="info-box"><strong>Selected slot</strong>'+esc(p.selectedItemSlot??'-')+'</div></div><h2 style="margin-top:14px">Inventory</h2><div class="inventory-wrap">'+renderInventory(p.inventory||[],p.equipment||{})+'</div><p class="inv-note">Hover over an item slot to remove that single item stack. Playerdata edits work best while that player is offline.</p>'}
function editing(){return Boolean(document.activeElement?.matches?.('input,textarea,select'))}
function render(force=false){const isEditing=editing();document.getElementById('status').textContent=data.status.running?'Online PID '+data.status.pid:'Offline';document.getElementById('status').classList.toggle('online',data.status.running);document.getElementById('serverAddress').textContent=data.status.address||('127.0.0.1:'+data.status.port)
if(force||!isEditing)document.getElementById('overview').innerHTML='<div class="card"><h2>Status</h2><div class="item"><strong>Running</strong><span>'+esc(data.status.running?'Yes':'No')+'</span></div><div class="item"><strong>Port</strong><span>'+esc(data.status.port)+'</span></div><div class="item"><strong>Listening</strong><span>'+esc(data.status.listening?'Yes':'No')+'</span></div><div class="item"><strong>Folder</strong><span>'+esc(data.serverDir)+'</span></div></div><div class="card"><h2>Version / jar</h2><div class="list">'+data.jars.map(j=>'<div class="item"><strong>'+esc(j.name)+'</strong><span>'+esc(j.version)+' | '+bytes(j.size)+' '+(j.active?'| active':'')+'</span></div>').join('')+'</div><label style="margin-top:10px">Switch server.jar<select id="jarSelect">'+data.jars.filter(j=>j.name!=='server.jar').map(j=>'<option value="'+esc(j.name)+'">'+esc(j.name)+'</option>').join('')+'</select></label><button id="switchJar" class="secondary" style="margin-top:8px">Switch version</button></div>'
const important=['server-port','motd','difficulty','gamemode','max-players','online-mode','white-list','enforce-whitelist','pvp','allow-flight','view-distance','simulation-distance','level-name','enable-command-block','enable-rcon','rcon.port','rcon.password','pause-when-empty-seconds']
const propKeys=[...important,...Object.keys(data.properties).filter(k=>!important.includes(k)).sort()]
if(force||!isEditing)document.getElementById('propsForm').innerHTML=propKeys.map(k=>propInput(k,data.properties[k]??'')).join('')
if(force||!isEditing)document.getElementById('worlds').innerHTML='<div class="card wide"><h2>Worlds</h2>'+data.worlds.map(w=>'<div class="item"><strong>'+esc(w.name)+(w.active?' (active)':'')+'</strong><span><button class="secondary" data-world-active="'+esc(w.name)+'">Make active</button> <button class="secondary" data-world-backup="'+esc(w.name)+'">Backup</button> <button class="danger" data-world-delete="'+esc(w.name)+'">Move to backup</button></span></div>').join('')+'</div>'
if(force||!isEditing){renderPlayerList();document.getElementById('files').innerHTML=Object.entries(data.files).map(([name,rows])=>'<div class="card"><h2>'+esc(name)+'</h2><textarea data-json="'+esc(name)+'" rows="10">'+esc(JSON.stringify(rows,null,2))+'</textarea><button data-json-save="'+esc(name)+'" style="margin-top:8px">Save '+esc(name)+'</button></div>').join('')}
document.getElementById('chatLog').textContent=(data.logs.out||[]).slice(-120).join('\\n')||'No server chat yet.'
document.getElementById('consoleLog').textContent=(data.logs.out||[]).join('\\n')||'No console output yet.'
document.getElementById('outLog').textContent=(data.logs.out||[]).join('\\n')||'No output yet.';document.getElementById('errLog').textContent=(data.logs.err||[]).join('\\n')||'No errors.'}
async function refresh(force=false){data=await api('/api/state');render(force)}
document.querySelector('nav').onclick=e=>{const b=e.target.closest('button[data-tab]');if(!b)return;document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('hidden',x.id!==b.dataset.tab));document.getElementById('title').textContent=b.textContent}
document.getElementById('playerList').onclick=e=>{const b=e.target.closest('[data-player]');if(!b)return;showPlayer(b.dataset.player).catch(err=>alert(err.message))}
document.getElementById('chatForm').onsubmit=async e=>{e.preventDefault();const input=document.getElementById('chatInput');const message=input.value.trim();if(!message)return;try{await api('/api/chat',{method:'POST',body:JSON.stringify({message})});input.value='';await refresh(false)}catch(err){alert(err.message)}}
document.getElementById('commandForm').onsubmit=async e=>{e.preventDefault();const input=document.getElementById('commandInput');const command=input.value.trim();if(!command)return;try{await api('/api/command',{method:'POST',body:JSON.stringify({command})});input.value='';await refresh(false)}catch(err){alert(err.message)}}
document.body.onclick=async e=>{try{if(e.target.id==='copyAddress'||e.target.closest?.('#copyAddress')){const value=document.getElementById('serverAddress').textContent.trim();await navigator.clipboard.writeText(value);document.getElementById('copyAddress').title='Copied '+value}if(e.target.id==='refresh')await refresh(true);if(e.target.id==='start'){await api('/api/start',{method:'POST',body:'{}'});setTimeout(()=>refresh(true),1000)}if(e.target.id==='stop'){await api('/api/stop',{method:'POST',body:'{}'});setTimeout(()=>refresh(true),1000)}if(e.target.id==='saveProps'){const properties={};document.querySelectorAll('[data-prop]').forEach(i=>properties[i.dataset.prop]=i.value);await api('/api/properties',{method:'POST',body:JSON.stringify({properties})});await refresh(true)}if(e.target.id==='switchJar'){if(!confirm('Switch server.jar? Stop the server first.'))return;await api('/api/version',{method:'POST',body:JSON.stringify({jar:document.getElementById('jarSelect').value})});await refresh(true)}if(e.target.dataset.savePlayerStats!==undefined){const updates={};document.querySelectorAll('[data-player-stat]').forEach(i=>{if(i.value!=='')updates[i.dataset.playerStat]=i.value});await api('/api/player/'+encodeURIComponent(selectedPlayer)+'/stats',{method:'POST',body:JSON.stringify({updates})});await showPlayer(selectedPlayer);await refresh(false)}if(e.target.dataset.deletePlayer!==undefined){if(!confirm('Delete this playerdata? A backup will be made first.'))return;await api('/api/player/'+encodeURIComponent(selectedPlayer),{method:'DELETE'});selectedPlayer='';await refresh(true);document.getElementById('playerDetails').innerHTML='<h2>Player details</h2><p style="color:var(--muted)">Select a player.</p>'}if(e.target.dataset.clearInventory!==undefined){if(!confirm('Clear this inventory? A backup will be made first.'))return;await api('/api/player/'+encodeURIComponent(selectedPlayer)+'/inventory/clear',{method:'POST',body:'{}'});await showPlayer(selectedPlayer)}if(e.target.dataset.deleteItemSlot!==undefined){if(!confirm('Remove this item stack? A backup will be made first.'))return;await api('/api/player/'+encodeURIComponent(selectedPlayer)+'/item',{method:'DELETE',body:JSON.stringify({slot:e.target.dataset.deleteItemSlot})});await showPlayer(selectedPlayer)}if(e.target.dataset.jsonSave){const name=e.target.dataset.jsonSave;await api('/api/json/'+encodeURIComponent(name),{method:'POST',body:document.querySelector('[data-json="'+CSS.escape(name)+'"]').value});await refresh(true)}if(e.target.dataset.worldActive){await api('/api/world/active',{method:'POST',body:JSON.stringify({name:e.target.dataset.worldActive})});await refresh(true)}if(e.target.dataset.worldBackup){await api('/api/world/backup',{method:'POST',body:JSON.stringify({name:e.target.dataset.worldBackup})});await refresh(true)}if(e.target.dataset.worldDelete){if(!confirm('Move this world to backups?'))return;await api('/api/world/delete',{method:'POST',body:JSON.stringify({name:e.target.dataset.worldDelete})});await refresh(true)}}catch(err){alert(err.message)}}
refresh(true);setInterval(()=>refresh(false),5000)
</script>
</body>
</html>`
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
  try {
    if (request.method === 'GET' && url.pathname === '/') return text(response, 200, html(), 'text/html; charset=utf-8')
    if (request.method === 'GET' && url.pathname === '/favicon.png') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
      fs.createReadStream(path.join(SERVER_DIR, 'server-icon.png')).pipe(response)
      return
    }    if (request.method === 'GET' && url.pathname.startsWith('/textures/')) {
      const rel = decodeURIComponent(url.pathname.slice('/textures/'.length)).replace(/\//g, path.sep)
      const file = path.resolve(TEXTURE_ROOT, rel)
      const root = path.resolve(TEXTURE_ROOT)
      if (!file.toLowerCase().startsWith((root + path.sep).toLowerCase()) || !fs.existsSync(file)) return text(response, 404, 'Not found.')
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
      fs.createReadStream(file).pipe(response)
      return
    }
    if (request.method === 'GET' && url.pathname.startsWith('/block-icons/')) {
      const name = decodeURIComponent(url.pathname.slice('/block-icons/'.length).replace(/\.svg$/i, ''))
      const svg = blockIconSvg(name)
      if (!svg) return text(response, 404, 'Not found.')
      return text(response, 200, svg, 'image/svg+xml; charset=utf-8')
    }
    if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, await state())
    if (request.method === 'GET' && url.pathname.startsWith('/api/player/')) {
      return json(response, 200, { ok: true, player: await playerDetails(decodeURIComponent(url.pathname.slice('/api/player/'.length))) })
    }
    if (request.method === 'POST' && url.pathname.startsWith('/api/player/') && url.pathname.endsWith('/stats')) {
      const uuid = decodeURIComponent(url.pathname.slice('/api/player/'.length, -'/stats'.length))
      const body = await readBody(request)
      await updatePlayerStats(uuid, body.updates || {})
      return json(response, 200, { ok: true })
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/player/') && url.pathname.endsWith('/item')) {
      const uuid = decodeURIComponent(url.pathname.slice('/api/player/'.length, -'/item'.length))
      const body = await readBody(request)
      await deletePlayerItem(uuid, body.slot)
      return json(response, 200, { ok: true })
    }
    if (request.method === 'POST' && url.pathname.startsWith('/api/player/') && url.pathname.endsWith('/inventory/clear')) {
      const uuid = decodeURIComponent(url.pathname.slice('/api/player/'.length, -'/inventory/clear'.length))
      await clearPlayerInventory(uuid)
      return json(response, 200, { ok: true })
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/player/')) {
      await deletePlayerData(decodeURIComponent(url.pathname.slice('/api/player/'.length)))
      return json(response, 200, { ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/api/start') return json(response, 200, { ok: true, ...(await startServer()) })
    if (request.method === 'POST' && url.pathname === '/api/stop') return json(response, 200, { ok: true, ...(await stopServer()) })
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readBody(request)
      if (body.source === 'discord') {
        return json(response, 200, { ok: true, ...sendDiscordChatMessage(body.username, body.message) })
      }
      const message = cleanChatText(body.message)
      return json(response, 200, { ok: true, ...sendServerCommand(`say ${message}`) })
    }
    if (request.method === 'POST' && url.pathname === '/api/command') {
      const body = await readBody(request)
      return json(response, 200, { ok: true, ...sendServerCommand(body.command) })
    }
    if (request.method === 'POST' && url.pathname === '/api/properties') {
      const body = await readBody(request)
      saveProperties(body.properties || {})
      return json(response, 200, { ok: true })
    }
    if (request.method === 'POST' && url.pathname.startsWith('/api/json/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/json/'.length))
      const body = await readBody(request)
      writeJsonFile(name, body)
      return json(response, 200, { ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/api/version') {
      if (serverPid()) throw new Error('Stop the server before switching version.')
      const body = await readBody(request)
      const jar = String(body.jar || '')
      if (!/^[\w .-]+\.jar$/i.test(jar) || jar === 'server.jar') throw new Error('Choose a valid jar file.')
      const source = path.join(SERVER_DIR, jar)
      if (!fs.existsSync(source)) throw new Error('Jar file was not found.')
      const current = path.join(SERVER_DIR, 'server.jar')
      if (fs.existsSync(current)) fs.copyFileSync(current, path.join(SERVER_DIR, `server-before-version-${stamp()}.jar`))
      fs.copyFileSync(source, current)
      return json(response, 200, { ok: true, jar })
    }
    if (request.method === 'POST' && url.pathname === '/api/world/active') {
      const body = await readBody(request)
      const name = safeWorldName(body.name)
      if (!fs.existsSync(path.join(SERVER_DIR, name))) throw new Error('World does not exist.')
      saveProperties({ 'level-name': name })
      return json(response, 200, { ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/api/world/backup') {
      const body = await readBody(request)
      const name = safeWorldName(body.name)
      copyDir(path.join(SERVER_DIR, name), path.join(WORLD_BACKUP_DIR, `${name}-${stamp()}`))
      return json(response, 200, { ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/api/world/delete') {
      if (serverPid()) throw new Error('Stop the server before moving worlds.')
      const body = await readBody(request)
      const name = safeWorldName(body.name)
      if (name === parseProperties().values['level-name']) throw new Error('Make another world active before moving this one.')
      const source = path.join(SERVER_DIR, name)
      const target = path.join(WORLD_BACKUP_DIR, `deleted-${name}-${stamp()}`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.renameSync(source, target)
      return json(response, 200, { ok: true })
    }
    return json(response, 404, { ok: false, error: 'Not found.' })
  } catch (err) {
    return json(response, 400, { ok: false, error: err.message || 'Request failed.' })
  }
}

http.createServer(route).listen(PORT, HOST, () => {
  console.log(`Minecraft Server Manager open: http://localhost:${PORT}`)
})

