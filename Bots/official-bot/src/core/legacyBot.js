const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const minecraftData = require('minecraft-data')
const minecraftProtocol = require('minecraft-protocol')
const collectBlock = require('mineflayer-collectblock').plugin
const pvp = require('mineflayer-pvp').plugin
const { getCooldown } = require('mineflayer-pvp')
const tool = require('mineflayer-tool').plugin
const armorManager = require('mineflayer-armor-manager')
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { monitorEventLoopDelay } = require('perf_hooks')
const { Vec3 } = require('vec3')
const { safeName, writeJsonSafe, flushJsonWrites, cleanupStaleJsonTemps, copyRuntimeData, restoreRuntimeData } = require('../runtime-storage')
const { TaskController } = require('../task-controller')
const { CombatBrain } = require('../brains/combatBrain')
const { PerceptionBrain } = require('../brains/perceptionBrain')
const { PlannerBrain } = require('../brains/plannerBrain')
const { ActionExecutor } = require('../brains/actionExecutor')
const { createNavigationService } = require('../services/navigation')
const { createInventoryService } = require('../services/inventory')
const { KnowledgeService } = require('../services/knowledgeService')
const { TaskService } = require('../services/taskService')
const { FeedbackService } = require('../services/feedbackService')
const { RankingService } = require('../services/rankingService')
const { WorldScanner } = require('../systems/worldScanner')
const { ItemPickupSystem } = require('../systems/itemPickupSystem')
const { TeamClient } = require('../team/teamClient')
const { rankBotsForPassage } = require('../team/conflictResolver')
const { TaskManager, PRIORITY } = require('./taskManager')
const { SkillRegistry } = require('../skills/skillRegistry')
const { registerVerticalSkills } = require('../skills/verticalSkills')
const { KnowledgeStore } = require('../memory/knowledgeStore')
const { ExperienceMemory } = require('../memory/experienceMemory')
const { SkillStats } = require('../learning/skillStats')
const { Curriculum } = require('../learning/curriculum')
const { worldIdentity } = require('../memory/worldIdentity')
const skillResult = require('../skills/skillResult')
const { ErrorCodes } = require('../recovery/errorCodes')
const APP_TIME_ZONE = 'Europe/Amsterdam'
const SUPPORTED_MINECRAFT_VERSIONS = [...minecraftProtocol.supportedVersions].reverse()
process.env.TZ ||= APP_TIME_ZONE
// Info: Gekloonde bots kunnen dezelfde productiecode gebruiken met volledig gescheiden runtime-data.
const APP_ROOT = path.resolve(process.env.BOT_APP_ROOT || path.resolve(__dirname, '../..'))
const botSettingsFile = path.join(APP_ROOT, 'bot-settings.json')

function defaultBotSettings() {
  return {
    host: 'localhost',
    port: 25565,
    username: 'WhiteCoffee',
    auth: 'offline',
    version: SUPPORTED_MINECRAFT_VERSIONS[0],
    worldId: 'default',
    dataProfile: 'default',
    ownerPlayer: '',
    offlineSkinMode: 'off',
    offlineSkinValue: '',
    offlineSkinVariant: 'classic',
    eliteMode: true,
    whitelistedPlayers: [],
    learning: { enabled: true, curriculumEnabled: true, maxSkillRetries: 3, taskTimeoutMs: 120000, memoryResultLimit: 5, minimumSkillSuccessRate: 0.7, minimumCurriculumSuccesses: 3, experienceDeduplicationWindowMs: 3600000 },
    safety: { minimumHealth: 10, minimumFood: 8, fleeDistance: 16 }
  }
}

function normalizeBotSettings(value = {}) {
  const defaults = defaultBotSettings()
  const port = Math.floor(Number(value.port))
  const auth = ['microsoft', 'offline'].includes(String(value.auth || '').toLowerCase())
    ? String(value.auth).toLowerCase()
    : defaults.auth
  const whitelistedPlayers = [...new Map(
    (Array.isArray(value.whitelistedPlayers) ? value.whitelistedPlayers : [])
      .map(name => String(name || '').trim())
      .filter(name => /^[A-Za-z0-9_]{1,16}$/.test(name))
      .map(name => [name.toLowerCase(), name])
  ).values()]
  const offlineSkinMode = ['off', 'player', 'url'].includes(String(value.offlineSkinMode || '').toLowerCase())
    ? String(value.offlineSkinMode).toLowerCase()
    : defaults.offlineSkinMode
  const offlineSkinVariant = ['classic', 'slim'].includes(String(value.offlineSkinVariant || '').toLowerCase())
    ? String(value.offlineSkinVariant).toLowerCase()
    : defaults.offlineSkinVariant
  return {
    host: String(value.host || defaults.host).trim(),
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : defaults.port,
    username: String(value.username || defaults.username).trim(),
    auth,
    version: SUPPORTED_MINECRAFT_VERSIONS.includes(String(value.version || ''))
      ? String(value.version)
      : defaults.version,
    worldId: safeName(value.worldId, defaults.worldId),
    dataProfile: safeName(value.dataProfile, defaults.dataProfile),
    ownerPlayer: /^[A-Za-z0-9_]{1,16}$/.test(String(value.ownerPlayer || '').trim()) ? String(value.ownerPlayer).trim() : '',
    offlineSkinMode,
    offlineSkinValue: String(value.offlineSkinValue || '').trim(),
    offlineSkinVariant,
    eliteMode: value.eliteMode !== false,
    whitelistedPlayers,
    learning: { ...defaults.learning, ...(value.learning || {}) },
    safety: { ...defaults.safety, ...(value.safety || {}) }
  }
}

function loadBotSettings() {
  try {
    return normalizeBotSettings(JSON.parse(fs.readFileSync(botSettingsFile, 'utf8')))
  } catch {
    return defaultBotSettings()
  }
}

function saveBotSettings(value) {
  const settings = normalizeBotSettings(value)
  writeJsonFileSafe(botSettingsFile, settings)
  return settings
}

function appTimestamp(value = Date.now()) {
  const date = new Date(value)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date).map(part => [part.type, part.value]))
  const localUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  )
  const offsetMinutes = Math.round((localUtc - date.getTime()) / 60000)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`
}

function runSupervisor() {
  let child = null
  let stopping = false
  let quickFailures = 0
  let startedAt = 0

  const stop = () => {
    stopping = true
    if (child && !child.killed) child.kill()
  }

  const start = () => {
    if (stopping) return
    startedAt = Date.now()
    const childEnv = { ...process.env, MINECRAFT_AI_WORKER: '1' }
    child = spawn(process.execPath, [__filename], {
      cwd: APP_ROOT,
      stdio: 'inherit',
      env: childEnv
    })
    child.on('exit', (code, signal) => {
      if (stopping) return
      const livedFor = Date.now() - startedAt
      quickFailures = livedFor < 60000 ? quickFailures + 1 : 0
      const delay = Math.min(60000, 3000 * (2 ** Math.min(quickFailures - 1, 5)))
      console.log(`Bot worker stopped (${signal || code}). Restarting in ${Math.round(delay / 1000)} seconds...`)
      setTimeout(start, delay)
    })
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  start()
}

if (process.env.MINECRAFT_AI_WORKER !== '1' && process.env.NO_AUTO_RECONNECT !== '1') {
  runSupervisor()
} else {

const app = express()
const server = http.createServer(app)
const io = new Server(server)
const hudPort = Number(process.env.PORT || 3000)
const viewerAutoStart = process.env.VIEWER_AUTOSTART === '1'
const hudIntervalMs = Number(process.env.HUD_INTERVAL_MS || 2000)
const priorityIntervalMs = Number(process.env.PRIORITY_INTERVAL_MS || 1400)
const worldScanIntervalMs = Number(process.env.WORLD_SCAN_INTERVAL_MS || 30000)
const brainPlannerIntervalMs = Number(process.env.BRAIN_PLANNER_INTERVAL_MS || 6000)
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
eventLoopDelay.enable()
let previousCpuUsage = process.cpuUsage()
let previousCpuSampleAt = Date.now()
let lastPlannerLogAt = 0
let lastPlannerLogKey = ''
const viewerDistance = Number(process.env.VIEWER_DISTANCE || 2)
const viewerPort = Number(process.env.VIEWER_PORT || 3001)
const hudUrl = `HUD port ${hudPort}`
const viewerUrl = `viewer port ${viewerPort}`
const botSettings = loadBotSettings()
// Info: De Hub kan owner en command-whitelist per botinstantie instellen zonder de gedeelde codefolder te wijzigen.
if (process.env.BOT_OWNER_PLAYER !== undefined) botSettings.ownerPlayer = /^[A-Za-z0-9_]{1,16}$/.test(process.env.BOT_OWNER_PLAYER) ? process.env.BOT_OWNER_PLAYER : ''
if (process.env.BOT_WHITELISTED_PLAYERS) {
  try { botSettings.whitelistedPlayers = normalizeBotSettings({ whitelistedPlayers:JSON.parse(process.env.BOT_WHITELISTED_PLAYERS) }).whitelistedPlayers } catch {}
}
const eliteMode = botSettings.eliteMode === true
const taskController = new TaskController()
const minecraftHost = process.env.MC_HOST || botSettings.host
const minecraftPort = Number(process.env.MC_PORT || botSettings.port)
const minecraftUsername = process.env.MC_USERNAME || botSettings.username
const minecraftAuth = process.env.MC_AUTH || botSettings.auth
const minecraftVersion = process.env.MC_VERSION || botSettings.version
const runtimeRoot = botSettings.dataProfile === 'default'
  ? APP_ROOT
  : path.join(APP_ROOT, 'profiles', botSettings.dataProfile)
const backupsRoot = path.join(APP_ROOT, 'backups', botSettings.dataProfile)
const microsoftProfilesFolder = path.join(runtimeRoot, 'microsoft-auth')
const coordinationRoot = path.join(path.dirname(APP_ROOT), '.bot-coordination')
const learnedKnowledgeFile = path.join(runtimeRoot, 'knowledge', 'learned.json')
const identity = worldIdentity({ host: minecraftHost, port: minecraftPort, version: minecraftVersion, worldName: botSettings.worldId })
const textureBaseRoot = path.join(path.dirname(APP_ROOT), 'node_modules', 'prismarine-viewer', 'public', 'textures')
const textureRoot = fs.existsSync(path.join(textureBaseRoot, minecraftVersion))
  ? path.join(textureBaseRoot, minecraftVersion)
  : path.join(textureBaseRoot, '1.21.4')
let lastRuntimeBackupAt = 0

function itemTexturePath(name) {
  const safeItem = String(name || '').replace(/^minecraft:/, '')
  const candidates = [
    path.join(textureRoot, 'items', `${safeItem}.png`),
    path.join(textureRoot, 'blocks', `${safeItem}.png`),
    path.join(textureRoot, 'blocks', `${safeItem}_front.png`),
    path.join(textureRoot, 'blocks', `${safeItem}_top.png`),
    safeItem === 'shield' ? path.join(textureRoot, 'entity', 'shield_base.png') : ''
  ]
  return candidates.find(file => fs.existsSync(file)) || ''
}

function blockTexturePath(name, face = 'side') {
  const safeItem = String(name || '').replace(/^minecraft:/, '')
  const candidates = face === 'top'
    ? [
        path.join(textureRoot, 'blocks', `${safeItem}_top.png`),
        path.join(textureRoot, 'blocks', `${safeItem}.png`),
        path.join(textureRoot, 'blocks', `${safeItem}_side.png`)
      ]
    : [
        path.join(textureRoot, 'blocks', `${safeItem}.png`),
        path.join(textureRoot, 'blocks', `${safeItem}_side.png`),
        path.join(textureRoot, 'blocks', `${safeItem}_front.png`)
      ]
  return candidates.find(file => fs.existsSync(file)) || ''
}

function isBlockIconItem(name) {
  const safeItem = String(name || '').replace(/^minecraft:/, '')
  return Boolean(blockTexturePath(safeItem, 'side')) && safeItem !== 'shield'
}

function itemTextureUrl(name) {
  if (isBlockIconItem(name)) return `/block-icons/${encodeURIComponent(String(name || '').replace(/^minecraft:/, ''))}.svg`
  const file = itemTexturePath(name)
  const fallback = path.join(textureRoot, 'items', 'barrier.png')
  const selected = file || (fs.existsSync(fallback) ? fallback : '')
  return selected ? `/textures/${selected.slice(textureRoot.length + 1).replace(/\\/g, '/')}` : ''
}

function textureHref(file) {
  return `/textures/${file.slice(textureRoot.length + 1).replace(/\\/g, '/')}`
}

function blockIconSvg(name) {
  const safeItem = String(name || '').replace(/^minecraft:/, '')
  const side = blockTexturePath(safeItem, 'side')
  if (!side) return ''
  const top = blockTexturePath(safeItem, 'top') || side
  const left = side
  const right = blockTexturePath(`${safeItem}_front`, 'side') || side
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <pattern id="top" patternUnits="userSpaceOnUse" width="16" height="16"><image href="${textureHref(top)}" width="16" height="16" image-rendering="pixelated"/></pattern>
    <pattern id="left" patternUnits="userSpaceOnUse" width="16" height="16"><image href="${textureHref(left)}" width="16" height="16" image-rendering="pixelated"/></pattern>
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

function hudItem(item) {
  if (!item) return null
  return {
    name: item.name,
    count: item.count,
    slot: item.slot,
    icon: itemTextureUrl(item.name),
    category: itemCategory(item.name),
    durability: durabilityInfo(item)
  }
}

app.use('/textures', (request, response) => {
  const rel = decodeURIComponent(request.path.replace(/^\/+/, '')).replace(/\//g, path.sep)
  const file = path.resolve(textureRoot, rel)
  const root = path.resolve(textureRoot)
  if (!file.toLowerCase().startsWith((root + path.sep).toLowerCase()) || !fs.existsSync(file)) {
    response.status(404).send('Not found.')
    return
  }
  response.setHeader('Content-Type', 'image/png')
  response.setHeader('Cache-Control', 'public, max-age=86400')
  fs.createReadStream(file).pipe(response)
})

app.use('/block-icons', (request, response) => {
  const name = decodeURIComponent(request.path.replace(/^\/+/, '').replace(/\.svg$/i, ''))
  const svg = blockIconSvg(name)
  if (!svg) {
    response.status(404).send('Not found.')
    return
  }
  response.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
  response.setHeader('Cache-Control', 'public, max-age=86400')
  response.send(svg)
})

app.use(express.static(path.join(APP_ROOT, 'public')))

server.listen(hudPort, () => {
  console.log(`HUD open: ${hudUrl}`)
})

function startViewer() {
  viewerEnabled = true
  if (viewerStarted) return true
  try {
    startIntegratedViewer()
    viewerStarted = true
    console.log(`AI POV open: ${viewerUrl}`)
    return true
  } catch (err) {
    console.log('AI POV viewer failed:', err.message)
    viewerStarted = false
    return false
  }
}

function setViewer(enabled) {
  viewerEnabled = enabled
  if (enabled) {
    const started = startViewer()
    bot.chat(started ? `AI POV viewer is ON: ${viewerUrl}` : 'AI POV viewer could not start.')
    updateHud()
    return
  }
  try {
    if (bot.viewer?.close) bot.viewer.close()
  } catch {}
  viewerStarted = false
  bot.chat('AI POV viewer is OFF.')
  updateHud()
}

function startIntegratedViewer() {
  const { mineflayer: mineflayerViewer } = require('prismarine-viewer')
  mineflayerViewer(bot, {
    port: viewerPort,
    firstPerson: true,
    viewDistance: viewerDistance
  })
}

const bot = mineflayer.createBot({
  host: minecraftHost,
  port: minecraftPort,
  username: minecraftUsername,
  auth: minecraftAuth,
  version: minecraftVersion,
  profilesFolder: microsoftProfilesFolder,
  onMsaCode: data => {
    const url = data?.verification_uri_complete || data?.verification_uri || 'https://www.microsoft.com/link'
    const code = data?.user_code || ''
    console.log('MICROSOFT LOGIN REQUIRED')
    console.log(`Open: ${url}`)
    if (code) console.log(`Code: ${code}`)
    if (data?.message) console.log(data.message)
  },
  logErrors: false
})

process.on('unhandledRejection', err => {
  if (expectedPathError(err)) return
  console.log('Unhandled promise rejection:', err?.message || err)
})
let workerStopping = false
const stopWorkerGracefully = async signal => {
  if (workerStopping) return
  workerStopping = true
  teamClient?.close?.()
  await reliableTaskManager?.close?.(`worker ${signal}`).catch(() => {})
  await flushJsonWrites()
  process.exit(signal === 'SIGINT' ? 130 : 0)
}
process.on('SIGINT', () => stopWorkerGracefully('SIGINT'))
process.on('SIGTERM', () => stopWorkerGracefully('SIGTERM'))

let chatThrottleInstalled = false
let commandReplyTarget = ''
let minecraftConnected = false
let viewerStarted = false
let viewerEnabled = viewerAutoStart
let reconnectTimer = null
const runtimeIntervals = []
const chatHistory = []
const recentPrivateMessages = new Map()
const recentRecordedChat = new Map()

function recordChat(role, author, message) {
  const normalizedMessage = String(message || '').replace(/\s+/g, ' ').trim()
  if (!normalizedMessage) return
  const now = Date.now()
  for (const [key, at] of recentRecordedChat) {
    if (now - at > 2500) recentRecordedChat.delete(key)
  }
  const key = `${role}\u0000${author}\u0000${normalizedMessage.toLowerCase()}`
  if (recentRecordedChat.has(key) && now - recentRecordedChat.get(key) < 1500) return
  recentRecordedChat.set(key, now)
  chatHistory.unshift({
    role,
    author,
    message: normalizedMessage,
    at: appTimestamp()
  })
  chatHistory.splice(30)
}

function markPrivateMessageSeen(username, message) {
  const now = Date.now()
  for (const [key, at] of recentPrivateMessages) {
    if (now - at > 3000) recentPrivateMessages.delete(key)
  }
  const key = `${username}\u0000${normalizeCommandMessage(String(message || '').toLowerCase())}`
  if (recentPrivateMessages.has(key) && now - recentPrivateMessages.get(key) < 1500) return false
  recentPrivateMessages.set(key, now)
  return true
}

function privateMessageFromJson(jsonMsg) {
  const raw = String(jsonMsg?.toString?.() || jsonMsg || '').replace(/\u00a7[0-9a-fklmnor]/gi, '').trim()
  if (!raw) return null
  const patterns = [
    /^([A-Za-z0-9_]{1,16}) whispers(?: to you)?:\s+(.+)$/i,
    /^From ([A-Za-z0-9_]{1,16}):\s+(.+)$/i,
    /^\[From ([A-Za-z0-9_]{1,16})\]\s+(.+)$/i,
    /^\[?([A-Za-z0-9_]{1,16})\s*(?:->|»|=>)\s*(?:you|me|[^\]:]+)\]?:\s*(.+)$/i
  ]
  for (const pattern of patterns) {
    const match = raw.match(pattern)
    if (!match) continue
    const username = match[1]
    const message = match[2]
    if (normalizeCommandMessage(String(message || '').toLowerCase()).startsWith('ai ')) return { username, message }
  }
  return null
}

function serverMessageFromJson(jsonMsg) {
  const raw = String(jsonMsg?.toString?.() || jsonMsg || '').replace(/\u00a7[0-9a-fklmnor]/gi, '').replace(/\s+/g, ' ').trim()
  if (!raw) return null
  if (privateMessageFromJson(jsonMsg)) return null
  if (raw === bot.username) return null
  return raw
}

function addRuntimeInterval(callback, delay) {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try { await callback() } catch (error) { logActionError('Runtime interval failed', error) }
    finally { running = false }
  }
  const botKey = String(process.env.BOT_ID || process.env.MC_USERNAME || 'bot')
  let hash = 0
  for (const char of botKey) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const initialDelay = delay + (hash % Math.min(1200, Math.max(1, Math.floor(delay / 2))))
  const initialTimer = setTimeout(() => {
    const intervalTimer = setInterval(run, delay)
    const trackedIndex = runtimeIntervals.indexOf(initialTimer)
    if (trackedIndex >= 0) runtimeIntervals[trackedIndex] = intervalTimer
    else clearInterval(intervalTimer)
    run()
  }, initialDelay)
  runtimeIntervals.push(initialTimer)
  return initialTimer
}

function clearRuntimeIntervals() {
  while (runtimeIntervals.length) clearInterval(runtimeIntervals.pop())
}

function scheduleReconnect(reason) {
  if (reconnectTimer || process.env.NO_AUTO_RECONNECT === '1') return
  clearRuntimeIntervals()
  const delayMs = 5000
  reconnectTimer = setTimeout(async () => {
    console.log(`Restarting worker after ${reason}...`)
    await flushJsonWrites()
    process.exit(75)
  }, delayMs)
  console.log(`Reconnect scheduled in ${delayMs / 1000} seconds (${reason}).`)
}

function resetDisconnectedSession() {
  reliableTaskManager?.cancelAll?.('bot disconnected')
  minecraftConnected = false
  state.busy = false
  state.activeRoute = null
  state.pathGoal = null
  state.pathGoalDynamic = false
  state.stuckPosition = null
  state.stuckChecks = 0
  state.unstuckFailures = 0
  state.navigationRecoveryAttempts = 0
  state.navigationRecoveryAnchor = null
  state.navigationRecoveryStartedAt = 0
  state.navigationBlockedUntil = 0
  state.actionRecoveryPendingAt = 0
  state.actionRecoveryBusySince = 0
  state.craftInProgress = null
  state.spawnedAt = 0
  clearRuntimeIntervals()
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.pvp.stop() } catch {}
  try { bot.clearControlStates() } catch {}
}

function installChatThrottle() {
  if (chatThrottleInstalled) return
  const sendChat = bot.chat.bind(bot)
  bot.sendServerCommand = message => {
    if (!minecraftConnected) return false
    try {
      sendChat(String(message))
      return true
    } catch (err) {
      console.log('Server command skipped:', err.message)
      return false
    }
  }
  bot.chat = message => {
    if (!minecraftConnected) return
    const text = String(message)
    if (commandReplyTarget && !text.startsWith('/')) {
      try { sendChat(`/msg ${commandReplyTarget} ${text}`) } catch (err) { console.log('Private reply skipped:', err.message) }
    }
    recordChat('ai', bot.username || 'AI', text)
  }
  chatThrottleInstalled = true
}

bot.loadPlugin(pathfinder)
bot.loadPlugin(collectBlock)
// mineflayer-pvp@1.3.2 still subscribes to Mineflayer's deprecated event name.
// Translate it while loading the plugin so its combat loop runs on physicsTick.
function modernPvpPlugin(bot) {
  const originalBotOn = bot.on
  bot.on = function (event, ...args) {
    return originalBotOn.call(this, event === 'physicTick' ? 'physicsTick' : event, ...args)
  }
  try {
    pvp(bot)
  } finally {
    bot.on = originalBotOn
  }
}
bot.loadPlugin(modernPvpPlugin)
bot.loadPlugin(tool)
bot.loadPlugin(armorManager)

let mcData
let movements
let playerPvpEnabled = false
const memoryFile = path.join(runtimeRoot, 'ai-memory.json')
const recipesFile = path.join(runtimeRoot, 'ai-recipes.json')
const knowledgeDir = path.join(runtimeRoot, 'knowledge')
const worldsDir = path.join(runtimeRoot, 'worlds')
const removedStaleJsonTemps = cleanupStaleJsonTemps(knowledgeDir) + cleanupStaleJsonTemps(worldsDir)
if (removedStaleJsonTemps) console.log(`Removed ${removedStaleJsonTemps} stale JSON temp file(s).`)
const memory = loadMemory()
const worldMemory = loadWorldMemory()
const knowledge = loadKnowledge()
let recipeBook = loadRecipeBook()
const discoveredRecipes = knowledge.crafting.discoveredRecipes ||= {}
const FOOD_RULES = knowledge.crafting.foodRules
const COOKABLE_FOOD = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato'
}
const TOOL_MATERIAL_TIERS = {
  wooden: 1,
  golden: 1,
  stone: 2,
  iron: 3,
  diamond: 4,
  netherite: 5
}
const FUEL_SMELT_CAPACITY = {
  lava_bucket: 100,
  coal_block: 80,
  dried_kelp_block: 20,
  blaze_rod: 12,
  coal: 8,
  charcoal: 8,
  scaffolding: 0.25,
  bamboo: 0.25
}
const SURVIVAL_CRAFTS = knowledge.crafting.survivalCrafts
const WATER_BLOCK_NAMES = ['water', 'bubble_column']
const BOAT_ITEMS = ['oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat', 'acacia_boat', 'dark_oak_boat', 'mangrove_boat', 'cherry_boat']
const skills = memory.skills || { woodcutting: 0, mining: 0, combat: 0, crafting: 0, building: 0 }
const autonomy = memory.autonomy ||= { enabled: true }
autonomy.focus ||= null
const state = {
  mode: 'idle',
  owner: null,
  deathPosition: null,
  deathRecovery: null,
  lastDamage: null,
  lastInventorySnapshot: [],
  lastPosition: null,
  lastGroundY: null,
  airborneStartPosition: null,
  airborneSince: null,
  stuckPosition: null,
  stuckChecks: 0,
  lastUnstuckAt: 0,
  pathGoal: null,
  pathGoalDynamic: false,
  recovering: false,
  busy: false,
  busySince: 0,
  actionRecoveryPendingAt: 0,
  actionRecoveryBusySince: 0,
  lastActionRecoveryAt: 0,
  lastNavigationRecoveryChatAt: 0,
  navigationRecoveryAttempts: 0,
  navigationRecoveryAnchor: null,
  navigationRecoveryStartedAt: 0,
  navigationBlockedUntil: 0,
  unstucking: false,
  gatherTask: null,
  progressionGatherTask: null,
  miningTask: null,
  farmTask: null,
  hitmanTask: null,
  guardTask: null,
  guardAllies: [],
  beatMinecraft: null,
  lastAutoStorageAt: 0,
  lastAutoCookAt: 0,
  lastFurnaceCheckAt: 0,
  furnaceDebug: null,
  failedUtilities: {},
  craftInProgress: null,
  craftRetryAfter: {},
  craftFailureCounts: {},
  repairTask: null,
  lastWorldResetWarningAt: 0,
  resumeMode: null,
  smeltingTask: null,
  activeRoute: null,
  currentTask: null,
  taskLog: [],
  infoLog: [],
  lastTaskKey: null,
  lastTaskAt: 0,
  // Info: Items die de bot zelf bewust weggooit worden kort genegeerd om een pickup/toss-lus te voorkomen.
  pickupIgnoreUntilByName: {},
  lastMovementAt: 0,
  lastMovementPosition: null,
  lastPriorityAt: 0,
  lastWatchdogWakeAt: 0,
  lastWorldScanAt: 0,
  lastEliteResourceScanAt: 0,
  eliteResourceScanCache: [],
  eliteResourceKnowledgeDirty: false,
  lastEliteResourceSaveAt: 0,
  lastCombatBlockedAt: 0,
  lastRangedAttackAt: 0,
  lastPlayerMeleeAt: 0,
  lastShieldBlockAt: 0,
  activeDig: null,
  hitmanClutching: false,
  lastEliteClutchAt: 0,
  lastDrowningEscapeAt: 0,
  drowningEscapeUntil: 0,
  lastEndermanGazeAvoidAt: 0,
  automaticBridgeBlockedUntil: 0,
  combatRetreating: false,
  eliteCombat: {
    phase: 'idle',
    target: null,
    lastDecisionAt: 0,
    lastStrafeAt: 0,
    strafeSide: 'left',
    comboUntil: 0,
    lastUtilityAt: 0,
    lastPearlAt: 0,
    lastLavaAt: 0,
    lastWaterAt: 0,
    lastGappleAt: 0,
    lastTotemAt: 0,
    reengageAt: 0
  },
  retaliationTask: null,
  combatTraining: false,
  pathStatus: 'idle',
  pathUpdatedAt: null,
  currentPath: [],
  pendingNavigationRecovery: false,
  unstuckFailures: 0,
  recoveryBlockFailures: {},
  bridgeBlockFailures: {},
  safetyBlockFailures: {},
  peerBots: [],
  coordinationReservation: null,
  lastCoordinationWriteAt: 0,
  idleAutonomySince: 0,
  coordinationSpreadUntil: 0,
  teamPeers: [],
  teamConflictSince: 0,
  teamYieldUntil: 0,
  routeStartedAt: 0,
  manualPriorityUntil: 0,
  spawnedAt: 0,
  rejoinRequested: false,
  hardStopped: false,
  manualControlOnly: !autonomy.enabled,
  stopVersion: 0,
  planner: memory.planner || { goal: 'max_gear', nextAction: 'observing', reason: 'startup' }
}

const navigation = createNavigationService(bot, goals)
const inventory = createInventoryService(bot)
const combatBrain = new CombatBrain({
  bot,
  state,
  knowledge,
  navigation,
  inventory,
  playerPvpEnabled: () => playerPvpEnabled
})
const knowledgeService = new KnowledgeService(knowledge)
const feedbackService = new FeedbackService({ knowledge })
const rankingService = new RankingService({ feedbackService })
const brainTaskService = new TaskService({ state })
const perceptionBrain = new PerceptionBrain({
  bot,
  state,
  knowledge,
  mcData: () => mcData,
  knowledgeService,
  playerPvpEnabled: () => playerPvpEnabled
})
const plannerBrain = new PlannerBrain({ knowledgeService, rankingService, feedbackService })
const actionExecutor = new ActionExecutor({
  bot,
  state,
  knowledge,
  log: message => console.log(message),
  taskService: brainTaskService,
  feedbackService,
  actions: {
    heal_or_retreat: async (plan, situation) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      if (await eatFoodIfNeeded({ force: true })) return true
      const threat = nearestThreatFromSituation(situation)
      if (threat) return retreatAndHeal(threat)
      startFarmMode()
      return true
    },
    eat: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      return eatFoodIfNeeded({ force: true })
    },
    get_food: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      startFarmMode()
      await runFarmStep()
      return true
    },
    fight_or_flee: async (plan, situation) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      const threat = nearestThreatFromSituation(situation)
      if (!threat) return false
      return defendAgainst(threat)
    },
    get_wood: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      startGatherTask('ai gather oak_log 8')
      return true
    },
    craft_crafting_table: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      return craftSmart('crafting_table')
    },
    craft_pickaxe: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      if (itemCount('cobblestone') >= 3) return craftSmart('stone_pickaxe')
      return craftSmart('wooden_pickaxe')
    },
    get_stone_tools: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      if (itemCount('cobblestone') >= 3 && !hasItem('stone_pickaxe')) return craftSmart('stone_pickaxe')
      if (itemCount('cobblestone') >= 2 && !hasItem('stone_sword')) return craftSmart('stone_sword')
      startGatherTask('ai gather cobblestone 16')
      return true
    },
    craft_shield: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      return craftSmart('shield')
    },
    get_iron: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      startTargetedMining('raw_iron', 24)
      return true
    },
    craft_iron_gear: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      if (!hasItem('iron_pickaxe')) return craftSmart('iron_pickaxe')
      if (!hasItem('shield')) return craftSmart('shield')
      if (!hasItem('iron_sword')) return craftSmart('iron_sword')
      if (!hasItem('iron_chestplate')) return craftSmart('iron_chestplate')
      if (!hasItem('iron_leggings')) return craftSmart('iron_leggings')
      if (!hasItem('iron_helmet')) return craftSmart('iron_helmet')
      if (!hasItem('iron_boots')) return craftSmart('iron_boots')
      await equipBestArmor()
      return equippedArmorNames().length >= 4
    },
    equip_armor: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      const before = equippedArmorNames().length
      await equipBestArmor()
      return equippedArmorNames().length > before || equippedArmorNames().length >= 4
    },
    use_nether_portal: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      return enterNearestNetherPortal()
    },
    build_nether_portal: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      return buildOrUseNetherPortal()
    },
    mine_diamonds: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      startTargetedMining('diamond', 24)
      return true
    },
    prepare_nether: async (plan) => {
      updatePlanner(plan.goal, plan.action, plan.reason)
      await equipBestArmor()
      if (!hasItem('flint_and_steel')) return craftSmart('flint_and_steel')
      if (!hasItem('obsidian', 10)) {
        startGatherTask('ai gather obsidian 10')
        return true
      }
      return buildOrUseNetherPortal()
    }
  }
})
const learnedStore = new KnowledgeStore(learnedKnowledgeFile)
const experienceMemory = new ExperienceMemory(learnedStore, { deduplicationWindowMs: botSettings.learning.experienceDeduplicationWindowMs })
const skillStats = new SkillStats(learnedStore)
const skillRegistry = registerVerticalSkills(new SkillRegistry(), {
  ensureSafety: async context => bot.health >= botSettings.safety.minimumHealth ? skillResult.success() : (await eliteEmergencySurvival({ ignoreFood:Boolean(context?.ignoreFood) }) ? skillResult.success() : skillResult.failure(ErrorCodes.LOW_HEALTH, true)),
  findFood: async () => (bot.food >= botSettings.safety.minimumFood || bot.inventory.items().some(item => isFood(item.name))) ? skillResult.success() : (await eliteAcquireFood(), bot.inventory.items().some(item => isFood(item.name)) ? skillResult.success() : skillResult.failure(ErrorCodes.NO_FOOD, true)),
  eat: async () => bot.food >= botSettings.safety.minimumFood ? skillResult.success() : (await eatFoodIfNeeded({ force: true }) ? skillResult.success() : skillResult.failure(ErrorCodes.NO_FOOD, true)),
  collectWood: async context => context.target?.amount ? gatherTeamItems(context, context.target.item || 'oak_log') : (await ensureWood(), bot.inventory.items().some(item => item.name.endsWith('_log')) ? skillResult.success() : skillResult.failure(ErrorCodes.TARGET_MISSING, true)),
  craftPlanks: async () => (await craftAvailablePlanks(), bot.inventory.items().some(item => item.name.endsWith('_planks')) ? skillResult.success() : skillResult.failure(ErrorCodes.CRAFT_FAILED, true)),
  craftCraftingTable: async () => hasItem('crafting_table') ? skillResult.success() : (await craftSmart('crafting_table') ? skillResult.success() : skillResult.failure(ErrorCodes.CRAFT_FAILED, true)),
  craftTool: async context => { const wanted=context.target?.item||(itemCount('cobblestone')>=3?'stone_pickaxe':'wooden_pickaxe');return hasItem(wanted)?skillResult.success():(await craftSmart(wanted)?skillResult.success():skillResult.failure(ErrorCodes.NO_TOOL,true)) },
  collectStone: async context => context.target?.amount ? gatherTeamItems(context, context.target.item || 'cobblestone') : (await ensureCobblestone(8), itemCount('cobblestone') >= 8 ? skillResult.success() : skillResult.failure(ErrorCodes.TARGET_MISSING, true)),
  craftFurnace: async () => hasItem('furnace') || await hasAvailableFurnace() ? skillResult.success() : (await craftSmart('furnace') ? skillResult.success() : skillResult.failure(ErrorCodes.CRAFT_FAILED, true)),
  mineResource: async context => context.target?.amount ? gatherTeamItems(context, context.target.item || 'raw_iron') : gatherTeamItems({ ...context,target:{item:'raw_iron',amount:3} },'raw_iron'),
  smeltItem: async context => { const wanted=Math.max(1,Number(context.target?.amount||itemCount('raw_iron')));if(itemCount('iron_ingot')>=wanted)return skillResult.success();await ensureSmelted('raw_iron','iron_ingot',wanted);return itemCount('iron_ingot')>=wanted?skillResult.success():skillResult.failure(ErrorCodes.SMELT_FAILED,true,{expected:wanted,actual:itemCount('iron_ingot')}) },
  returnHome: async () => await goHome() !== false ? skillResult.success() : skillResult.failure(ErrorCodes.PATH_FAILED, true),
  storeItems: async context => context.destination && context.target?.item
    ? depositTeamItems(context.target, context.destination)
    : await depositInventory(false) !== false ? skillResult.success() : skillResult.failure(ErrorCodes.VALIDATION_FAILED, true)
})
skillRegistry.register({name:'buildSchematic',description:'Builds an approved .schem assignment at exact coordinates.',goals:['build_schematic'],requirements:[],timeoutMs:600000,maxRetries:1,version:1,execute:buildSchematicAssignment,validate:context=>context.result})
const reliableTaskManager = new TaskManager({ registry: skillRegistry, taskTimeoutMs: botSettings.learning.taskTimeoutMs })
const curriculum = new Curriculum(learnedStore.data.skillStats, { enabled: botSettings.learning.curriculumEnabled, minimumSuccesses: botSettings.learning.minimumCurriculumSuccesses, minimumSuccessRate: botSettings.learning.minimumSkillSuccessRate })
reliableTaskManager.on('complete', task => {
  const skill = skillRegistry.get(task.currentStep)
  if (skill && task.result) skillStats.record(skill, task.result, { dimension: currentDimension() })
  if (botSettings.learning.enabled && skill && task.result && (!task.result.success || task.result.data?.lesson)) experienceMemory.record({ task: task.goal, skill: skill.name, context: { dimension: currentDimension(), health: bot.health, food: bot.food, inventorySummary: Object.fromEntries(bot.inventory.items().map(item => [item.name, itemCount(item.name)])) }, success: task.result.success, durationMs: task.finishedAt-task.startedAt, attempts: task.attempt, errorCode: task.result.reason, problems: [], lesson: task.result.data?.lesson || null, createdAt: new Date().toISOString(), botId: path.basename(APP_ROOT), worldId: identity.worldId })
})
const worldScanner = new WorldScanner(bot, state, worldMemory, {
  mcData: () => mcData,
  save: saveWorldMemory,
  timestamp: appTimestamp,
  dimension: currentDimension
})

// Info: Eén pickup-systeem verwerkt zowel HUD/chatopdrachten als automatische loot na mining, farming en combat.
const itemPickupSystem = new ItemPickupSystem(bot, {
  radius: 16,
  maxBatch: 6,
  itemName: droppedItemName,
  isImportant: entity => shouldPickupUsefulDrop(entity),
  shouldCollect: (_entity, name) => !name || Number(state.pickupIgnoreUntilByName[name] || 0) <= Date.now(),
  isSafe: () => Boolean(bot.entity && !state.hardStopped && !state.unstucking && !state.recovering && !state.combatRetreating && !bestEliteHostileTarget(8)),
  navigate: entity => safeGoto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 1), 'picking up dropped items'),
  onStatus: entry => setCurrentTask('pickup', `picking up ${entry.important ? 'important ' : ''}${entry.name || 'item'}`, {
    target: entry.name || 'item',
    position: `${entry.entity.position.x.toFixed(1)} ${entry.entity.position.y.toFixed(1)} ${entry.entity.position.z.toFixed(1)}`
  }),
  onCollected: entry => bumpKnowledgeStat('items', 'pickedUp', entry.name || 'unknown')
})

// Info: De teamclient gebruikt dezelfde lokale TaskManager en skill registry; er ontstaat geen tweede planner.
const teamClient = new TeamClient({
  bot,
  botId: process.env.BOT_ID || path.basename(APP_ROOT),
  botType: process.env.BOT_TYPE || path.basename(APP_ROOT),
  worldId: identity.worldId,
  minecraft: { host:minecraftHost,port:minecraftPort,version:minecraftVersion },
  registry: skillRegistry,
  taskManager: reliableTaskManager,
  heartbeatIntervalMs: Number(process.env.TEAM_HEARTBEAT_INTERVAL_MS || 3000),
  enabled: process.env.TEAM_ENABLED !== '0',
  currentDimension,
  inventorySummary: () => Object.fromEntries(bot.inventory.items().map(item => [item.name,itemCount(item.name)])),
  skillStats: () => learnedStore.data.skillStats,
  safetyState: () => bot.health < botSettings.safety.minimumHealth || state.combatRetreating ? 'unsafe' : 'safe'
  ,onPeers: peers => { state.teamPeers = peers }
  ,handleControl: async (action, payload = {}) => {
    if(action==='pause'){reliableTaskManager.pause();return true}
    if(action==='resume'){reliableTaskManager.resume();return true}
    if(action==='cancel-task'){return reliableTaskManager.cancelActive('dashboard cancellation')}
    if(action==='return-home'){reliableTaskManager.enqueue({name:'dashboard:return-home',goal:'return_home',source:'dashboard',priority:65,plan:['returnHome']});return true}
    if(action==='idle'){reliableTaskManager.cancelAll('dashboard idle');stopEverything();return true}
    if(action==='emergency-stop'){reliableTaskManager.cancelAll('dashboard emergency stop');stopEverything();return true}
    if(action==='reconnect'){reliableTaskManager.cancelAll('dashboard reconnect');rejoinServer();return true}
    if(action==='update-command-access'){
      botSettings.ownerPlayer = /^[A-Za-z0-9_]{1,16}$/.test(String(payload.ownerPlayer||'')) ? String(payload.ownerPlayer) : ''
      botSettings.whitelistedPlayers = normalizeBotSettings({ whitelistedPlayers:payload.whitelistedPlayers }).whitelistedPlayers
      return { updated:true }
    }
    if(action==='build-schematic'){
      if(!Array.isArray(payload.blocks)||!payload.origin)throw new Error('INVALID_SCHEMATIC_TASK')
      // Info: Veiligheid wordt eerst hersteld; daarna bouwt dezelfde centrale TaskManager en rapporteert het gevalideerde eindresultaat.
      let task
      const completion = new Promise(resolve=>{const listener=finished=>{if(finished!==task)return;reliableTaskManager.off('complete',listener);resolve(finished)};reliableTaskManager.on('complete',listener)})
      task = reliableTaskManager.enqueue({name:`schematic:${payload.schematicName||payload.schematicId}`,goal:'build_schematic',source:'dashboard',priority:70,timeoutMs:660000,context:{target:{blocks:payload.blocks,origin:payload.origin,schematicId:payload.schematicId}},plan:[{skill:'ensureSafety',context:{ignoreFood:true}},'buildSchematic']})
      return { taskId:task.id,queued:true,completion }
    }
    return false
  }
})

const commands = [
  'ai help',
  'ai help <category>',
  'ai inv',
  'ai status',
  'ai info',
  'ai rejoin',
  'ai follow',
  'ai stop',
  'ai gather <item> <amount>',
  'ai explore',
  'ai auto on',
  'ai auto off',
  'ai auto mine',
  'ai auto farm',
  'ai auto combat',
  'ai auto movement',
  'ai auto crafting',
  'ai auto world',
  'ai auto progression',
  'ai auto general',
  'ai viewer on',
  'ai viewer off',
  'ai pickup items',
  'ai storage',
  'ai dump junk',
  'ai sort',
  'ai equip armor',
  'ai combat learn',
  'ai hitman <playername>',
  'ai hitman stop',
  'ai guard <playername>',
  'ai guard ally <playername>',
  'ai recipes',
  'ai get stronger',
  'ai pvp',
  'ai craft <item>',
  'ai go to <x> <y> <z>',
  'ai bridge <length>',
  'ai bridge speed <length>',
  'ai bridge up <length>',
  'ai set home',
  'ai home',
  'ai remember village',
  'ai remember mine',
  'ai memories',
  'ai farm',
  'ai harvest',
  'ai replant',
  'ai breed animals',
  'ai cave',
  'ai nearest cave',
  'ai return cave',
  'ai diamonds',
  'ai iron',
  'ai beat minecraft'
]

const HELP_GROUPS = {
  basics: ['ai status', 'ai info', 'ai inv', 'ai follow', 'ai stop', 'ai rejoin'],
  auto: ['ai auto on', 'ai auto off', 'ai auto mine', 'ai auto farm', 'ai auto combat', 'ai auto movement', 'ai auto crafting', 'ai auto world', 'ai auto progression', 'ai auto general'],
  inventory: ['ai pickup items', 'ai storage', 'ai dump junk', 'ai sort', 'ai equip armor'],
  movement: ['ai follow', 'ai explore', 'ai go to <x> <y> <z>', 'ai bridge <length>', 'ai bridge speed <length>', 'ai bridge up <length>', 'ai home'],
  world: ['ai set home', 'ai home', 'ai remember village', 'ai remember mine', 'ai memories'],
  farming: ['ai farm', 'ai harvest', 'ai replant', 'ai breed animals'],
  mining: ['ai gather <item> <amount>', 'ai cave', 'ai nearest cave', 'ai return cave', 'ai diamonds', 'ai iron'],
  combat: ['ai pvp', 'ai combat learn', 'ai hitman <playername>', 'ai hitman stop', 'ai guard <playername>', 'ai guard ally <playername>', 'ai equip armor'],
  crafting: ['ai craft <item>', 'ai recipes'],
  progression: ['ai get stronger', 'ai beat minecraft'],
  viewer: ['ai viewer on', 'ai viewer off']
}

bot.once('spawn', () => {
  minecraftConnected = true
  state.spawnedAt = Date.now()
  console.log(`Minecraft spawn complete (${bot.username}).`)
  installChatThrottle()
  mcData = minecraftData(bot.version)
  movements = new Movements(bot, mcData)
  movements.allow1by1towers = true
  movements.allowParkour = eliteMode
  movements.allowSprinting = true
  movements.canDig = true
  movements.placeCost = Math.max(1, Number(knowledge.movement.rules?.bridgePlaceCost) || 1)
  bot.pathfinder.setMovements(movements)
  refreshRecipeBook()
  if (viewerEnabled) startViewer()
  setTimeout(() => {
    applyConfiguredSkin().catch(err => recordChat('system', 'Skin changer', err.message))
  }, 4000)

  updateHud()
  setTimeout(() => {
    if (!minecraftConnected) return
    bot.chat(`AI online. HUD: ${hudUrl}${viewerEnabled ? ` | POV: ${viewerUrl}` : ''}`)
  }, 2500)

  addRuntimeInterval(async () => {
    if (Date.now() - (state.spawnedAt || 0) < 2500) return
    try {
      await runPriorities()
    } catch (err) {
      if (!expectedPathError(err)) console.log('Priority loop error:', shortError(err))
    }
    updateHud()
  }, priorityIntervalMs)

  addRuntimeInterval(async () => {
    try {
      await recoverIfStuck()
    } catch (err) {
      console.log('Stuck recovery error:', err.message)
    }
  }, 1500)

  addRuntimeInterval(async () => {
    try {
      await wakeIfStalled()
    } catch (err) {
      console.log('Watchdog error:', err.message)
    }
  }, brainPlannerIntervalMs)

  addRuntimeInterval(async () => {
    try {
      await runCoordinationStep()
    } catch (err) {
      console.log('Coordination warning:', err.message)
    }
  }, 2000)

  addRuntimeInterval(async () => {
    try {
      await runPlannerBrainTick()
    } catch (err) {
      console.log('[Planner] error:', shortError(err))
    }
  }, 3000)
})

bot.on('login', () => console.log(`Minecraft login accepted (${bot.username}). Waiting for spawn...`))

async function handlePlayerMessage(username, message, options = {}) {
  if (username === bot.username) return
  if (options.private && !markPrivateMessageSeen(username, message)) return
  recordChat(options.private ? 'private' : 'player', username, message)
  message = normalizeCommandMessage(message.toLowerCase())
  if (!message.startsWith('ai ')) return
  commandReplyTarget = /^[A-Za-z0-9_]{1,16}$/.test(username) ? username : ''
  if (!isCommandWhitelisted(username)) {
    recordChat('system', 'Command security', `Blocked command from ${username}: ${message}`)
    bot.chat(`${username}: you are not whitelisted to use AI commands.`)
    commandReplyTarget = ''
    return
  }

  try {
    if (!await markManualCommand(message)) return
    if (shouldCancelRecoveryForCommand(message)) cancelDeathRecovery(`new command: ${message}`)
    if (message === 'ai help' || message.startsWith('ai help ')) showHelp(message.replace('ai help', '').trim())
    else if (message === 'ai inv') showInventory()
    else if (message === 'ai status') showStatus()
    else if (message === 'ai info') showInfo()
    else if (message === 'ai rejoin') rejoinServer()
    else if (message === 'ai follow') followPlayer(username === 'HUD' ? state.owner : username)
    else if (message === 'ai stop') stopEverything()
    else if (message.startsWith('ai gather ')) startGatherTask(message)
    else if (message === 'ai explore') startExploration('command')
    else if (message === 'ai auto on') setAutonomy(true)
    else if (message === 'ai auto off') setAutonomy(false)
    else if (message.startsWith('ai auto ')) setAutonomyFocus(message.replace('ai auto ', '').trim())
    else if (message === 'ai viewer on') setViewer(true)
    else if (message === 'ai viewer off') setViewer(false)
    else if (message === 'ai pickup items') await pickupNearbyItems()
    else if (message === 'ai equip armor') await equipBestArmor()
    else if (message === 'ai combat learn') startCombatLearning()
    else if (message === 'ai hitman stop') stopHitman('stopped by command')
    else if (message.startsWith('ai hitman ')) startHitman(message.replace('ai hitman ', '').trim())
    else if (message.startsWith('ai guard ally ')) addGuardAlly(message.replace('ai guard ally ', '').trim())
    else if (message.startsWith('ai guard ')) startGuard(message.replace('ai guard ', '').trim())
    else if (message === 'ai pvp') togglePlayerPvp()
    else if (message === 'ai storage') await depositInventory(false)
    else if (message === 'ai dump junk') await dumpJunk()
    else if (message === 'ai sort') await sortStorage()
    else if (message === 'ai recipes') showRecipeSummary()
    else if (message === 'ai get stronger') startProgression()
    else if (message === 'ai set home') setHome()
    else if (message === 'ai home') await goHome()
    else if (message === 'ai remember village') rememberCurrentPlace('villages', 'Village')
    else if (message === 'ai remember mine') rememberCurrentPlace('mines', 'Mine')
    else if (message === 'ai memories') summarizeWorldMemory()
    else if (message === 'ai farm') startFarmMode()
    else if (message === 'ai harvest') await harvestNearbyCrops()
    else if (message === 'ai replant') await replantNearbyFarmland()
    else if (message === 'ai breed animals') await breedNearbyAnimals()
    else if (message === 'ai cave') startCaveMode()
    else if (message === 'ai nearest cave') await goNearestMemory('caves', 'cave')
    else if (message === 'ai return cave') await goNearestMemory('caves', 'cave')
    else if (message === 'ai diamonds') startTargetedMining('diamond', 3)
    else if (message === 'ai iron') startTargetedMining('raw_iron', 3)
    else if (message === 'ai beat minecraft') startBeatMinecraft()
    else if (message.startsWith('ai craft ')) await craftSmart(message.replace('ai craft ', '').trim())
    else if (message === 'ai bridge' || message.startsWith('ai bridge ')) await bridgeCommand(message)
    else if (message.startsWith('ai go to')) goToCommand(message)
    else bot.chat('Unknown command. Type: ai help')

    updateHud()
  } catch (err) {
    console.log(err)
    bot.chat('Something went wrong.')
  } finally {
    commandReplyTarget = ''
  }
}

bot.on('chat', (username, message) => {
  handlePlayerMessage(username, message).catch(err => {
    console.log('Chat command failed:', err)
    commandReplyTarget = ''
  })
})

bot.on('whisper', (username, message) => {
  handlePlayerMessage(username, message, { private: true }).catch(err => {
    console.log('Private command failed:', err)
    commandReplyTarget = ''
  })
})

bot.on('message', jsonMsg => {
  const privateMessage = privateMessageFromJson(jsonMsg)
  if (privateMessage) {
    handlePlayerMessage(privateMessage.username, privateMessage.message, { private: true }).catch(err => {
      console.log('Private message parse command failed:', err)
      commandReplyTarget = ''
    })
    return
  }
  const serverMessage = serverMessageFromJson(jsonMsg)
  if (serverMessage) {
    recordChat('server', 'Server', serverMessage)
    updateHud()
  }
})

async function resolveMinecraftPlayerSkin(playerName) {
  const profileResponse = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(playerName)}`)
  if (!profileResponse.ok) throw new Error(`Minecraft player "${playerName}" was not found.`)
  const profile = await profileResponse.json()
  const sessionResponse = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${profile.id}`)
  if (!sessionResponse.ok) throw new Error(`Could not load the skin for "${playerName}".`)
  const session = await sessionResponse.json()
  const texturesProperty = session.properties?.find(property => property.name === 'textures')
  if (!texturesProperty?.value) throw new Error(`No skin is available for "${playerName}".`)
  const textures = JSON.parse(Buffer.from(texturesProperty.value, 'base64').toString('utf8'))
  const skin = textures.textures?.SKIN
  if (!skin?.url) throw new Error(`No skin is available for "${playerName}".`)
  return {
    url: skin.url,
    variant: skin.metadata?.model === 'slim' ? 'slim' : 'classic'
  }
}

async function applyMicrosoftSkin() {
  if (!minecraftConnected) return { ok: false, message: 'The Minecraft bot is not connected.' }
  if (minecraftAuth !== 'microsoft') return { ok: false, message: 'The active connection is not using Microsoft authentication.' }
  const mode = botSettings.offlineSkinMode
  const value = botSettings.offlineSkinValue
  if (mode === 'off') return { ok: true, message: 'Online account skin changer is disabled.' }
  if (!value) return { ok: false, message: 'Enter a Minecraft player name or public PNG URL.' }
  const accessToken = bot._client?.session?.accessToken
  if (!accessToken) return { ok: false, message: 'No Minecraft Services access token is available. Rejoin the account and try again.' }

  try {
    const source = mode === 'player'
      ? await resolveMinecraftPlayerSkin(value)
      : { url: value, variant: botSettings.offlineSkinVariant }
    if (!/^https?:\/\/\S+$/i.test(source.url)) return { ok: false, message: 'Skin URL must be a public HTTP(S) URL.' }
    const response = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ variant: source.variant, url: source.url })
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240)
      const hint = response.status === 401
        ? ' Rejoin the Microsoft account to refresh its Minecraft Services token.'
        : response.status === 400
          ? ' Check that the URL is a public 64x64 PNG skin and that the selected arm model is correct.'
          : ''
      throw new Error(`Minecraft Services rejected the skin (${response.status})${detail ? `: ${detail}` : ''}${hint}`)
    }
    recordChat('system', 'Online skin', `Changed Microsoft account skin using ${mode}: ${value}`)
    updateHud()
    return { ok: true, message: 'Microsoft account skin changed. Rejoin if other players still see the previous skin.' }
  } catch (err) {
    recordChat('system', 'Online skin', err.message)
    return { ok: false, message: err.message }
  }
}

async function applyConfiguredSkin(options = {}) {
  if (minecraftAuth === 'microsoft') return applyMicrosoftSkin()
  return applyOfflineSkin(options)
}

function applyOfflineSkin({ clearWhenOff = false } = {}) {
  if (!minecraftConnected) return { ok: false, message: 'The Minecraft bot is not connected.' }
  if (minecraftAuth !== 'offline') return { ok: false, message: 'Offline skins require the active connection to use offline authentication.' }
  const mode = botSettings.offlineSkinMode
  const value = botSettings.offlineSkinValue
  if (mode === 'off') {
    if (!clearWhenOff) return { ok: true, message: 'Offline skin changer is disabled.' }
    const sent = bot.sendServerCommand?.('/skin clear') === true
    if (sent) recordChat('system', 'Offline skin', 'Requested the server to clear the offline skin.')
    return { ok: sent, message: sent ? 'Offline skin clear command sent.' : 'Could not send the offline skin clear command.' }
  }
  if (!value) return { ok: false, message: 'Enter a Minecraft player name or public PNG URL.' }
  if (mode === 'url') {
    if (!/^https?:\/\/\S+$/i.test(value)) {
      recordChat('system', 'Offline skin', 'Offline skin URL must be a public HTTP(S) URL.')
      return { ok: false, message: 'Offline skin URL must be a public HTTP(S) URL.' }
    }
    const sent = bot.sendServerCommand?.(`/skin url ${value}`) === true
    if (!sent) return { ok: false, message: 'Could not send the offline skin URL command.' }
  } else {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(value)) {
      return { ok: false, message: 'Minecraft skin player names may only contain letters, numbers and underscores, up to 16 characters.' }
    }
    const sent = bot.sendServerCommand?.(`/skin set ${value}`) === true
    if (!sent) return { ok: false, message: 'Could not send the offline player skin command.' }
  }
  recordChat('system', 'Offline skin', `Applied ${mode} skin: ${value}`)
  updateHud()
  return { ok: true, message: `Offline ${mode} skin command sent.` }
}

function isCommandWhitelisted(username) {
  if (String(username).toLowerCase() === 'hud') return true
  if (botSettings.ownerPlayer && botSettings.ownerPlayer.toLowerCase() === String(username).toLowerCase()) return true
  return botSettings.whitelistedPlayers.some(name => name.toLowerCase() === String(username).toLowerCase())
}

function normalizeCommandMessage(message) {
  return String(message || '')
}

function showHelp(topic = '') {
  if (!topic) {
    bot.chat(`Help categories: ${Object.keys(HELP_GROUPS).map(name => `ai help ${name}`).join(' | ')}`)
    return
  }
  const entries = HELP_GROUPS[topic]
  if (!entries) {
    bot.chat(`Unknown help category. Use: ${Object.keys(HELP_GROUPS).map(name => `ai help ${name}`).join(' | ')}`)
    return
  }
  bot.chat(`${topic}: ${entries.join(' | ')}`)
}

function rejoinServer() {
  if (state.rejoinRequested) return bot.chat('A rejoin is already scheduled.')
  state.rejoinRequested = true
  bot.chat('Rejoining the server...')
  setTimeout(() => restartWorker(), 1000)
}

async function restartWorker(code = 75) {
  await flushJsonWrites()
  process.exit(code)
}

function shortError(err) {
  const stack = String(err?.stack || err?.message || err)
  return stack.split('\n').slice(0, 4).join('\n')
}

async function markManualCommand(message) {
  const nonResuming = [
    'ai stop',
    'ai inv',
    'ai status',
    'ai info',
    'ai recipes',
    'ai memories',
    'ai pvp',
    'ai viewer on',
    'ai viewer off',
    'ai rejoin',
    'ai auto off',
    'ai hitman stop'
  ]
  const startsNewAction = !message.startsWith('ai help') && !message.startsWith('ai guard ally ') && !nonResuming.includes(message)
  if (startsNewAction) {
    taskController.begin(message, 'command')
    state.hardStopped = false
    state.stopVersion++
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.pvp.stop() } catch {}
    try { bot.clearControlStates() } catch {}
    const deadline = Date.now() + 30000
    while (state.busy && Date.now() < deadline) await sleep(50)
    if (state.busy) {
      taskController.cancelIfActive(taskController.active, 'previous action did not close')
      bot.chat('The previous action is still closing. Try the command again in a moment.')
      return false
    }
  }
  state.manualPriorityUntil = Date.now() + 8000
  if (commandNeedsImmediateAck(message)) bot.chat(`Alr, Gimme a sec.`)
  return true
}

function commandNeedsImmediateAck(message) {
  if (message.startsWith('ai help')) return false
  if ([
    'ai inv',
    'ai status',
    'ai info',
    'ai rejoin',
    'ai pvp',
    'ai auto on',
    'ai auto off',
    'ai auto general'
  ].includes(message)) return false
  return true
}

function showInventory() {
  const items = bot.inventory.items()
  if (items.length === 0) return bot.chat('My inventory is empty.')

  bot.chat(items.map(i => `${i.count}x ${i.name}`).join(', '))
}

function showStatus() {
  bot.chat(`HP: ${bot.health} | food: ${bot.food} | XP: ${bot.experience.level} | player pvp: ${playerPvpEnabled ? 'ON' : 'OFF'} | autonomy: ${autonomy.enabled ? 'ON' : 'OFF'}${autonomy.focus ? ` | focus: ${autonomy.focus}` : ''}`)
}

function recordInfo(message, category = 'activity') {
  const text = String(message || '').trim()
  if (!text) return
  const now = Date.now()
  const existingIndex = state.infoLog.findIndex(entry => entry.message === text && now - entry.time < 300000)
  if (existingIndex >= 0) {
    const existing = state.infoLog.splice(existingIndex, 1)[0]
    existing.count = (existing.count || 1) + 1
    existing.time = now
    existing.at = appTimestamp(now)
    existing.category = category
    state.infoLog.unshift(existing)
    return
  }
  state.infoLog.unshift({ message: text, category, count: 1, time: now, at: appTimestamp(now) })
  state.infoLog = state.infoLog.slice(0, 20)
}

function showInfo() {
  const task = state.currentTask
  const taskText = task
    ? `${task.action}: ${task.detail}${task.target ? ` | target: ${task.target}` : ''}`
    : `mode: ${state.mode}`
  bot.chat(`Info | ${taskText}`)
  if (!state.infoLog.length) return bot.chat('Info | No recent background activity.')
  for (const entry of state.infoLog.slice(0, 5)) {
    const repeat = entry.count > 1 ? ` x${entry.count}` : ''
    bot.chat(`Info | ${entry.category}: ${entry.message}${repeat}`)
  }
}

function followPlayer(username) {
  const player = bot.players[username]?.entity
  if (!player) return bot.chat('I cannot see you.')

  bot.pathfinder.setGoal(new goals.GoalFollow(player, 1), true)
  state.mode = 'follow'
  state.owner = username
  bot.chat('I follow you.')
}

function stopEverything() {
  taskController.cancel('ai stop')
  state.hardStopped = true
  state.manualControlOnly = true
  state.stopVersion++
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.pvp.stop() } catch {}
  try { bot.clearControlStates() } catch {}
  state.gatherTask = null
  state.progressionGatherTask = null
  state.miningTask = null
  state.farmTask = null
  state.hitmanTask = null
  state.guardTask = null
  state.guardAllies = []
  state.beatMinecraft = null
  state.smeltingTask = null
  state.activeRoute = null
  state.pathGoal = null
  state.pathGoalDynamic = false
  state.currentPath = []
  state.pathStatus = 'stopped'
  state.pendingNavigationRecovery = false
  state.unstucking = false
  state.navigationRecoveryAttempts = 0
  state.navigationRecoveryAnchor = null
  state.navigationRecoveryStartedAt = 0
  state.navigationBlockedUntil = 0
  state.combatTraining = false
  state.currentCombat = null
  state.resumeMode = null
  state.owner = null
  cancelDeathRecovery('ai stop')
  autonomy.enabled = false
  autonomy.focus = null
  state.mode = 'idle'
  updatePlanner('paused', 'waiting for command', 'ai stop')
  bot.chat('Stopped.')
}

function goToCommand(message) {
  const parts = message.split(' ')
  const x = Number(parts[3])
  const y = Number(parts[4])
  const z = Number(parts[5])

  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
    return bot.chat('Use: ai go to 100 64 100')
  }

  bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z))
  state.mode = 'travel'
  bot.chat(`I am going to ${x} ${y} ${z}`)
}

async function bridgeCommand(message) {
  const parts = message.trim().split(/\s+/)
  const mode = ['speed', 'up'].includes(parts[2]) ? parts[2] : 'safe'
  const lengthValue = mode === 'safe' ? parts[2] : parts[3]
  const maxSteps = Math.max(1, Number(knowledge.movement.rules?.maxBridgeSteps) || 64)
  const length = Math.min(maxSteps, Math.max(1, Math.floor(Number(lengthValue) || 8)))
  const result = await bridgeForward(length, mode)
  if (result.completed) bot.chat(`Bridge complete: ${result.steps} steps (${mode}).`)
  else bot.chat(`Bridge stopped after ${result.steps} steps: ${result.reason}.`)
}

function expectedPathError(err) {
  return /path was stopped|goal was changed|took to long to decide path|digging aborted|no path/i.test(err?.message || '')
}

async function safeGoto(goal, label = 'route', allowAutomaticBridge = true) {
  if (!minecraftConnected || !bot.entity || state.hardStopped) return false
  if (await emergencyDrowningEscape()) return false
  const stopVersion = state.stopVersion
  const taskToken = taskController.active
  state.activeRoute = label
  setCurrentTask('moving', label)
  try {
    await bot.pathfinder.goto(goal)
    return stopVersion === state.stopVersion && !state.hardStopped && (!taskToken || taskController.isActive(taskToken))
  } catch (err) {
    if (!expectedPathError(err)) throw err
    if (allowAutomaticBridge && await attemptAutomaticBridge(goal, label)) {
      try {
        await bot.pathfinder.goto(goal)
        return stopVersion === state.stopVersion && !state.hardStopped && (!taskToken || taskController.isActive(taskToken))
      } catch (retryError) {
        if (!expectedPathError(retryError)) throw retryError
      }
    }
    return false
  } finally {
    state.activeRoute = null
  }
}

function findUsefulBlock(matching, maxDistance = 64) {
  const positions = bot.findBlocks({ matching, maxDistance, count: 64 })
  const blocks = positions.map(position => bot.blockAt(position)).filter(Boolean)
    .filter(block => !peerClaimsPosition(block.position, 3))
  return blocks.sort((left, right) => {
    const leftDistance = left.position.distanceTo(bot.entity.position)
    const rightDistance = right.position.distanceTo(bot.entity.position)
    const leftNearby = leftDistance <= 5 ? 0 : 1
    const rightNearby = rightDistance <= 5 ? 0 : 1
    return leftNearby - rightNearby || leftDistance - rightDistance
  })[0] || null
}

function findBestResourceBlock(matching, maxDistance = 64, itemName = null) {
  if (!bot.entity) return null
  const ids = Array.isArray(matching) ? matching : [matching]
  const positions = bot.findBlocks({
    matching: ids,
    maxDistance,
    count: knowledge.mining.rules?.searchBlockCount || 256
  })
  const blocks = positions.map(position => bot.blockAt(position)).filter(Boolean)
    .filter(block => !peerClaimsPosition(block.position, 3))
  for (const block of blocks) rememberOreSight(block, itemName)
  if (blocks.length) saveKnowledge({ mining: knowledge.mining })
  return blocks.sort((left, right) => {
    const leftDistance = left.position.distanceTo(bot.entity.position)
    const rightDistance = right.position.distanceTo(bot.entity.position)
    const leftVisible = bot.canSeeBlock(left) ? 0 : 1
    const rightVisible = bot.canSeeBlock(right) ? 0 : 1
    const leftClose = leftDistance <= 5 ? 0 : 1
    const rightClose = rightDistance <= 5 ? 0 : 1
    const leftLearned = learnedScore('mining', 'blocks', left.name)
    const rightLearned = learnedScore('mining', 'blocks', right.name)
    const leftSafety = miningSafetyScore(left)
    const rightSafety = miningSafetyScore(right)
    return leftVisible - rightVisible || leftClose - rightClose || rightSafety - leftSafety || rightLearned - leftLearned || leftDistance - rightDistance
  })[0] || null
}

async function mineVisibleBlock(block, label = 'mining', itemName = null) {
  if (!minecraftConnected || !block || !bot.entity) return false
  if (!reserveCoordinationPosition(block.position, 'mining', 20000)) return false
  const actionVersion = state.stopVersion
  const hazards = miningHazards(block)
  if (hazards.length) {
    if (await makeMiningTargetSafe(block)) return mineVisibleBlock(block, label, itemName)
    rememberWorldLocation('dangerZones', block.position, { block: block.name, hazards, source: 'safe_mining' })
    recordLearning('mining', 'safety', block.name, 1, `skipped: ${hazards.join(', ')}`)
    setCurrentTask('mining', `skipping unsafe ${block.name}`, { target: hazards.join(', '), position: blockPositionText(block) })
    return false
  }
  bumpKnowledgeStat('mining', 'blocksSeen', block.name)
  setCurrentTask('mining', label, {
    target: block.name,
    position: blockPositionText(block)
  })
  if (block.position.distanceTo(bot.entity.position) > 4.5 || !bot.canSeeBlock(block)) {
    setCurrentTask('moving', `to ${block.name}`, { position: blockPositionText(block) })
    if (!await safeGoto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3), label)) return false
  }
  if (actionVersion !== state.stopVersion || state.hardStopped) return false
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
  const visibleBlock = bot.blockAt(block.position)
  if (!visibleBlock || visibleBlock.name !== block.name || visibleBlock.boundingBox === 'empty' ||
    block.position.distanceTo(bot.entity.position) > 5 || !bot.canSeeBlock(visibleBlock)) {
    return false
  }
  try {
    await bot.tool.equipForBlock(visibleBlock, { requireHarvest: true })
    await preferDurableEquippedTool()
    if (shouldPreserveHeldTool()) {
      const durability = durabilityInfo(bot.heldItem)
      planToolRepair(bot.heldItem)
      recordLearning('mining', 'tools', bot.heldItem.name, 1, 'preserved for repair before breaking')
      return false
    }
    const currentBlock = bot.blockAt(block.position)
    if (!currentBlock || currentBlock.name !== block.name || currentBlock.boundingBox === 'empty') return false
    rememberBlockTool(currentBlock, bot.heldItem)
    await bot.dig(currentBlock, 'raycast', 'raycast')
    bumpKnowledgeStat('mining', 'blocksMined', currentBlock.name)
    recordLearning('mining', 'blocks', currentBlock.name, 3, `mined during ${label}`)
    rememberOreMined(currentBlock, itemName)
    return true
  } catch (err) {
    bumpKnowledgeStat('mining', 'failedMines', block.name)
    if (itemName) {
      const heat = knowledge.mining.oreHeatmap?.[`${itemName}:${chunkKey(block.position)}`]
      if (heat) heat.failures++
    }
    recordLearning('mining', 'blocks', block.name, -2, err?.message || `failed during ${label}`)
    if (!expectedPathError(err)) console.log(`${label} failed:`, err.message)
    return false
  }
}

async function digNearbyVisibleBlock(block, label = 'clearing block') {
  if (!block || !bot.entity || block.boundingBox === 'empty') return false
  if (state.activeDig) return false
  if (block.position.distanceTo(bot.entity.position) > 5) return false
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
  const visibleBlock = bot.blockAt(block.position)
  if (!visibleBlock || visibleBlock.name !== block.name || visibleBlock.boundingBox === 'empty' || !bot.canSeeBlock(visibleBlock)) {
    return false
  }
  try {
    const forcedTool = recoveryToolForBlock(visibleBlock)
    if (blockNeedsPickaxe(visibleBlock) && !forcedTool) {
      setCurrentTask('waiting', `cannot clear ${visibleBlock.name} without a pickaxe`, { position: blockPositionText(visibleBlock) })
      return false
    }
    if (forcedTool) await bot.equip(forcedTool, 'hand')
    await bot.tool.equipForBlock(visibleBlock, { requireHarvest: true })
    if (blockNeedsPickaxe(visibleBlock) && toolParts(bot.heldItem?.name)?.family !== 'pickaxe') return false
    const currentBlock = bot.blockAt(block.position)
    if (!currentBlock || currentBlock.name !== block.name || currentBlock.boundingBox === 'empty' || !bot.canSeeBlock(currentBlock)) return false
    rememberBlockTool(currentBlock, bot.heldItem)
    try { bot.pathfinder.setGoal(null) } catch {}
    const digKey = blockPositionText(currentBlock)
    state.activeDig = { key: digKey, startedAt: Date.now(), label }
    let timeoutHandle = null
    const digPromise = bot.dig(currentBlock, 'raycast', 'raycast')
    try {
      await Promise.race([
        digPromise,
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('dig_timeout')), 12000)
        })
      ])
      return true
    } catch (digErr) {
      if (digErr?.message === 'dig_timeout') {
        const target = bot.targetDigBlock
        if (target?.position?.equals?.(block.position)) {
          try { bot.stopDigging() } catch {}
        }
        await Promise.race([digPromise.catch(() => null), sleep(500)])
      } else if (!expectedPathError(digErr)) {
        throw digErr
      }
      return false
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (state.activeDig?.key === digKey) state.activeDig = null
      await sleep(80)
    }
  } catch (err) {
    if (!expectedPathError(err)) logActionError(`Could not ${label}`, err)
    return false
  }
}

function canHitEntity(entity) {
  if (!entity || !bot.entity || entity.position.distanceTo(bot.entity.position) > (knowledge.combat.rules?.meleeRange || 4.2)) return false
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const target = entity.position.offset(0, Math.min(entity.height || 1, 1), 0)
  const delta = target.minus(eye)
  const obstruction = bot.world.raycast(eye, delta.normalize(), delta.norm())
  return !obstruction
}

async function approachCombatTarget(entity) {
  if (!entity || !bot.entity) return false
  if (canHitEntity(entity)) return true
  return safeGoto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 3), `combat:${entity.name}`)
}

async function findWood() {

  const logs = [
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
    'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'
  ]

  const ids = logs.map(n => mcData.blocksByName[n]?.id).filter(Boolean)

  const block = findUsefulBlock(ids, 64)

  if (!block) {
    recordInfo('No tree found nearby. Exploring further.', 'crafting')
    exploreNearby()
    return false
  }

  if (!await mineVisibleBlock(block, 'finding wood')) return false
  addSkill('woodcutting')
  return true
}

async function pickupNearbyItems() {
  // Info: Het chatcommando gebruikt dezelfde gevalideerde batchcollector als automatisch gedrag.
  const result = await itemPickupSystem.collectBatch()
  bot.chat(result.success ? `I picked up ${result.collected} nearby drop${result.collected === 1 ? '' : 's'}.` : 'I don\'t see any reachable items or my inventory is full.')
  return result.success
}

function shouldCancelRecoveryForCommand(message) {
  if (!state.recovering) return false
  return !['ai status', 'ai info', 'ai inv', 'ai recipes', 'ai help'].includes(message)
}

function cancelDeathRecovery(reason) {
  if (!state.deathRecovery) return
  state.recovering = false
  state.deathRecovery = null
  state.deathPosition = null
}

function bumpNestedStat(root, key, amount = 1) {
  root[key] = (root[key] || 0) + amount
}

function inventorySnapshot() {
  return bot.inventory.items().map(item => ({ name: item.name, count: item.count }))
}

function snapshotItemCounts(items = []) {
  const counts = new Map()
  for (const item of items) counts.set(item.name, (counts.get(item.name) || 0) + Number(item.count || 0))
  return counts
}

function retainedInventoryRatio(before = [], after = inventorySnapshot()) {
  const beforeCounts = snapshotItemCounts(before)
  const afterCounts = snapshotItemCounts(after)
  const total = [...beforeCounts.values()].reduce((sum, count) => sum + count, 0)
  if (!total) return 1
  let retained = 0
  for (const [name, count] of beforeCounts) retained += Math.min(count, afterCounts.get(name) || 0)
  return retained / total
}

function skipDeathRecoveryForKeepInventory(recovery) {
  if (!recovery || state.deathRecovery !== recovery) return false
  state.recovering = false
  state.deathRecovery = null
  state.deathPosition = null
  state.mode = 'idle'
  recordInfo('KeepInventory is on. Death recovery skipped.', 'recovery')
  return true
}

function checkKeepInventoryAfterRespawn(recovery, final = false) {
  if (!recovery || state.deathRecovery !== recovery) return false
  const before = recovery.droppedInventory || []
  if (!before.length) return skipDeathRecoveryForKeepInventory(recovery)
  const ratio = retainedInventoryRatio(before)
  recovery.keepInventoryRetainedRatio = ratio
  recovery.keepInventoryCheckedAt = Date.now()
  if (ratio >= 0.7) return skipDeathRecoveryForKeepInventory(recovery)
  if (final) {
    recovery.keepInventoryCheckPending = false
    recovery.keepInventoryCheckUntil = 0
    const pos = recovery.position
    recordInfo(`Retrieving dropped items from ${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}.`, 'recovery')
  }
  return false
}

function droppedItemsNear(position, radius = 12) {
  return Object.values(bot.entities || {})
    .filter(entity => entity.name === 'item' && entity.position.distanceTo(position) <= radius)
    .sort((left, right) => left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position))
}

function inferDeathCause(position) {
  if (state.lastDamage && Date.now() - state.lastDamage.at < 10000) return state.lastDamage.cause
  const feet = bot.blockAt(position.floored())
  const below = bot.blockAt(position.floored().offset(0, -1, 0))
  if (feet?.name === 'lava' || below?.name === 'lava') return 'lava'
  if (feet?.name === 'water') return 'water of verdrinking'
  if (position.y < 0) return 'void'
  return 'unknown, possibly fall or environmental damage'
}

function deathCategory(cause) {
  if (cause.startsWith('mob:')) return cause.slice(4)
  if (cause.startsWith('player:')) return 'player'
  if (cause.includes('lava')) return 'lava'
  if (cause.includes('water') || cause.includes('drowning')) return 'drowning'
  if (cause.includes('void')) return 'void'
  if (cause.includes('fall')) return 'fall'
  return 'unknown'
}

function mapPoint(position, type, label = null) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return null
  return {
    x: Math.round(position.x),
    y: Number.isFinite(position.y) ? Math.round(position.y) : null,
    z: Math.round(position.z),
    type,
    label
  }
}

function visibleMapPoints() {
  if (!bot.entity || !mcData) return []
  const points = []
  const groups = [
    { type: 'tree', names: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'], maxDistance: 28, count: 18 },
    { type: 'ore', names: ['coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'diamond_ore', 'deepslate_diamond_ore', 'gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore'], maxDistance: 32, count: 24 },
    { type: 'danger', names: ['lava', 'fire', 'magma_block', 'cactus', 'powder_snow'], maxDistance: 28, count: 18 },
    { type: 'storage', names: ['chest', 'barrel', 'trapped_chest'], maxDistance: 32, count: 12 }
  ]
  for (const group of groups) {
    for (const position of nearbyBlocks(group.names, group.maxDistance, group.count)) {
      const block = bot.blockAt(position)
      const point = mapPoint(position, group.type, block?.name)
      if (point) points.push(point)
    }
  }
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity?.position || entity === bot.entity || entity.position.distanceTo(bot.entity.position) > 32) continue
    if (entity.name === 'item') {
      const point = mapPoint(entity.position, 'item', droppedItemName(entity) || 'item')
      if (point) points.push(point)
      continue
    }
    if (isHostileMob(entity)) {
      const point = mapPoint(entity.position, 'hostile', entity.name)
      if (point) points.push(point)
    }
  }
  return points.slice(0, 90)
}

function memoryMapPoints() {
  const points = []
  const add = (entry, type, label) => {
    const point = mapPoint(entry, type, label)
    if (point) points.push(point)
  }
  if (worldMemory.home) add(worldMemory.home, 'home', 'home')
  for (const entry of (worldMemory.storage || []).slice(-8)) add(entry, 'storage', entry.block || 'storage')
  for (const entry of (worldMemory.dangerZones || []).slice(-10)) add(entry, 'danger', entry.block || 'danger')
  for (const entry of (worldMemory.caves || []).slice(-8)) add(entry, 'cave', 'cave')
  for (const entry of (worldMemory.mines || []).slice(-8)) add(entry, 'mine', 'mine')
  for (const entry of (worldMemory.deathLocations || []).slice(-8)) add(entry, 'death', entry.cause || 'death')
  return points
}

function goalPointFromState() {
  const taskPosition = state.currentTask?.position
  if (typeof taskPosition === 'string') {
    const [x, y, z] = taskPosition.split(/\s+/).map(Number)
    if ([x, y, z].every(Number.isFinite)) return { x, y, z, type: 'goal', label: state.currentTask?.detail || 'goal' }
  }
  if (state.deathRecovery?.position) return mapPoint(state.deathRecovery.position, 'death', state.deathRecovery.cause)
  return null
}

function minimapSnapshot() {
  const botPoint = mapPoint(bot.entity?.position, 'bot', bot.username)
  const goal = goalPointFromState()
  return {
    center: botPoint,
    points: [...visibleMapPoints(), ...memoryMapPoints(), goal].filter(Boolean),
    path: (state.currentPath || []).slice(-80),
    pathStatus: state.pathStatus,
    activeRoute: state.activeRoute,
    updatedAt: appTimestamp()
  }
}


async function ensureRecoveryTool(allowGather = true) {
  if (bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))) return true
  const hasLocalWood = bot.inventory.items().some(item => item.name.endsWith('_log')) || plankCount() >= 3
  if (!allowGather && !hasLocalWood) return false
  recordInfo('A pickaxe is needed to clear the recovery path.', 'recovery')
  try {
    if (await craftSmart('wooden_pickaxe')) return true
    if (!allowGather) return false
    await findWood()
    return Boolean(await craftSmart('wooden_pickaxe'))
  } catch {
    return false
  }
}

async function collectDeathLoot() {
  const recovery = state.deathRecovery
  if (!recovery || !bot.entity) return false
  const loot = droppedItemsNear(recovery.position, 16)
  if (loot.length === 0) return false

  recovery.lastLootSeenAt = Date.now()
  for (const item of loot) {
    try {
      await safeGoto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1), 'death loot ophalen')
      await sleep(350)
    } catch {
      recovery.pathFailures++
      await ensureRecoveryTool()
      await clearImmediateObstacles()
      await clearToward(recovery.position)
    }
  }
  return true
}

async function processDeathRecovery() {
  const recovery = state.deathRecovery
  if (!recovery || !bot.entity) return
  state.mode = 'recovering'
  if (recovery.keepInventoryCheckPending) {
    if (Date.now() < recovery.keepInventoryCheckUntil) {
      checkKeepInventoryAfterRespawn(recovery)
      return
    }
    if (checkKeepInventoryAfterRespawn(recovery, true)) return
  }

  if (Date.now() > recovery.deadline) {
    state.recovering = false
    state.deathRecovery = null
    state.deathPosition = null
    state.mode = 'idle'
    return
  }

  recovery.attempts++
  try {
    if (!await safeGoto(new goals.GoalNear(recovery.position.x, recovery.position.y, recovery.position.z, 3), 'death recovery')) throw new Error('No path to death recovery')
    recovery.reachedAt ||= Date.now()
  } catch {
    recovery.pathFailures++
    await ensureRecoveryTool()
    await clearImmediateObstacles()
    await clearToward(recovery.position)
    return
  }

  if (await collectDeathLoot()) return
  if (!recovery.reachedAt || Date.now() - recovery.reachedAt < 5000) return
  if (Date.now() - recovery.lastLootSeenAt < 5000) return
  state.recovering = false
  state.deathRecovery = null
  state.deathPosition = null
  state.mode = 'idle'
}

function snapshotSummary(items) {
  if (!items?.length) return 'an empty inventory'
  const summary = items.slice(0, 8).map(item => `${item.count}x ${item.name}`).join(', ')
  return items.length > 8 ? `${summary}, ...` : summary
}

async function clearToward(target) {
  if (!bot.entity) return false
  const base = bot.entity.position.floored()
  const delta = target.minus(base)
  const step = new Vec3(Math.sign(delta.x), Math.sign(delta.y), Math.sign(delta.z))
  const horizontal = new Vec3(step.x, 0, step.z)
  const candidates = [
    base.plus(horizontal),
    base.plus(horizontal).offset(0, 1, 0),
    base.plus(step),
    base.plus(step).offset(0, 1, 0)
  ]
  let cleared = false
  for (const pos of candidates) {
    const block = bot.blockAt(pos)
    if (!block || block.boundingBox === 'empty') continue
    if (isFootingBlock(block)) continue
    if (!canClearForUnstuck(block)) continue
    if (await digNearbyVisibleBlock(block, 'clearing recovery path')) cleared = true
  }
  return cleared
}

function togglePlayerPvp() {
  playerPvpEnabled = !playerPvpEnabled

  if (!playerPvpEnabled) {
    bot.pvp.stop()
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
  }

  bot.chat(`Player PvP is now: ${playerPvpEnabled ? 'ON' : 'OFF'}`)
}

function findPlayerByName(name) {
  const wanted = String(name || '').toLowerCase()
  return Object.entries(bot.players || {})
    .find(([username]) => username.toLowerCase() === wanted)?.[1] || null
}

function validPlayerName(name) {
  return /^[A-Za-z0-9_]{1,16}$/.test(String(name || ''))
}

function guardProtectedNames() {
  return [state.guardTask?.playerName, state.guardTask?.actualName, ...(state.guardAllies || [])]
    .filter(Boolean)
    .map(name => String(name).toLowerCase())
}

function isGuardProtectedPlayer(entityOrName) {
  const name = typeof entityOrName === 'string' ? entityOrName : entityOrName?.username
  return Boolean(name && guardProtectedNames().includes(String(name).toLowerCase()))
}

function addGuardAlly(playerName) {
  if (!validPlayerName(playerName)) return bot.chat('Use: ai guard ally <playername>')
  if (playerName.toLowerCase() === String(bot.username || '').toLowerCase()) return bot.chat('I already protect myself.')
  if (state.guardTask?.playerName?.toLowerCase() === playerName.toLowerCase()) return bot.chat(`${playerName} is already the primary guarded player.`)
  state.guardAllies ||= []
  if (state.guardAllies.some(name => name.toLowerCase() === playerName.toLowerCase())) return bot.chat(`${playerName} is already a guard ally.`)
  if (state.guardAllies.length >= 5) return bot.chat('The guard ally list is full. Maximum: 5 players.')
  state.guardAllies.push(findPlayerByName(playerName)?.username || playerName)
  bot.chat(`Guard ally added: ${playerName}. Allies: ${state.guardAllies.length}/5.`)
  return true
}

function startGuard(playerName) {
  if (!validPlayerName(playerName)) return bot.chat('Use: ai guard <playername>')
  if (playerName.toLowerCase() === String(bot.username || '').toLowerCase()) return bot.chat('I cannot guard myself.')
  if (state.hitmanTask) {
    state.hitmanTask = null
    state.currentCombat = null
    try { bot.pvp.stop() } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
  }
  state.guardAllies = (state.guardAllies || []).filter(name => name.toLowerCase() !== playerName.toLowerCase())
  state.manualControlOnly = true
  state.mode = 'guard'
  state.guardTask = {
    playerName,
    actualName: findPlayerByName(playerName)?.username || playerName,
    startedAt: Date.now(),
    threatEntityId: null,
    threatName: null,
    threatUntil: 0,
    nextMissingMessageAt: 0
  }
  updatePlanner(`guard ${playerName}`, 'stay nearby and intercept threats', 'ai guard')
  setCurrentTask('guard', `protecting ${playerName}`, { target: playerName })
  bot.chat(`Guarding ${playerName}. I will also protect ${state.guardAllies.length} allies.`)
}

function nearestGuardThreat(protectedEntity) {
  if (!protectedEntity?.position) return null
  const activeThreat = state.guardTask?.threatEntityId ? bot.entities[state.guardTask.threatEntityId] : null
  if (activeThreat?.position && activeThreat.isValid !== false && activeThreat.position.distanceTo(protectedEntity.position) < 24) return activeThreat
  return bot.nearestEntity(entity => {
    if (!entity?.position || entity === bot.entity || entity.position.distanceTo(protectedEntity.position) > 12) return false
    if (isHostileMob(entity)) return true
    return entity.type === 'player' &&
      !isGuardProtectedPlayer(entity) &&
      entity.username?.toLowerCase() !== String(bot.username || '').toLowerCase() &&
      state.guardTask?.threatName?.toLowerCase() === entity.username?.toLowerCase() &&
      Date.now() < (state.guardTask?.threatUntil || 0)
  })
}

async function runGuardStep() {
  const task = state.guardTask
  if (!task || state.hardStopped) return false
  const taskToken = taskController.active
  const protectedPlayers = [task.playerName, ...(state.guardAllies || [])]
    .map(findPlayerByName)
    .filter(player => player?.entity?.position)
  const primary = findPlayerByName(task.playerName)
  if (primary?.entity) task.actualName = primary.username || task.actualName
  const threatened = protectedPlayers
    .map(player => ({ player, threat: nearestGuardThreat(player.entity) }))
    .find(entry => entry.threat)
  if (threatened) {
    const threat = threatened.threat
    setCurrentTask('guard', `defending ${threatened.player.username || task.actualName}`, {
      target: threat.username || threat.name,
      position: `${threat.position.x.toFixed(1)} ${threat.position.y.toFixed(1)} ${threat.position.z.toFixed(1)}`
    })
    if (isHostileMob(threat)) {
      await defendAgainst(threat)
      if (state.mode.startsWith('defense:')) state.resumeMode = 'guard'
      return true
    }
    await equipBestArmor()
    if (taskWasCancelled(taskToken)) return false
    await equipCombatWeapon(threat)
    await equipShieldIfAvailable()
    return timedPlayerMeleeAttack(threat, { taskToken, preferCrit: true })
  }
  if (!primary?.entity?.position) {
    setCurrentTask('guard', `waiting for ${task.actualName}`, { target: task.actualName })
    if (Date.now() >= (task.nextMissingMessageAt || 0)) {
      task.nextMissingMessageAt = Date.now() + 30000
      bot.chat(`I cannot see ${task.actualName}. I am waiting for them to return.`)
    }
    return false
  }
  task.nextMissingMessageAt = 0
  setCurrentTask('guard', `protecting ${task.actualName}`, { target: task.actualName })
  if (primary.entity.position.distanceTo(bot.entity.position) > 4) {
    if (Date.now() < state.navigationBlockedUntil) {
      setCurrentTask('waiting', 'guard movement paused after navigation failures', { target: task.actualName })
      return false
    }
    bot.pathfinder.setGoal(new goals.GoalFollow(primary.entity, 3), true)
    return true
  }
  return false
}

function startHitman(playerName) {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(playerName)) {
    return bot.chat('Use: ai hitman <playername>')
  }
  if (playerName.toLowerCase() === String(bot.username || '').toLowerCase()) {
    return bot.chat('I cannot target myself.')
  }
  const resumeMode = state.mode === 'hitman' ? state.hitmanTask?.resumeMode || 'idle' : state.mode
  const resumeManualControlOnly = state.hitmanTask?.resumeManualControlOnly ?? state.manualControlOnly
  const resumeAutonomyEnabled = state.hitmanTask?.resumeAutonomyEnabled ?? autonomy.enabled
  const resumeAutonomyFocus = state.hitmanTask?.resumeAutonomyFocus ?? autonomy.focus
  cancelDeathRecovery('hitman command')
  state.guardTask = null
  state.guardAllies = []
  state.gatherTask = null
  state.progressionGatherTask = null
  state.miningTask = null
  state.farmTask = null
  state.beatMinecraft = null
  state.smeltingTask = null
  state.navigationBlockedUntil = 0
  state.activeRoute = null
  state.pathGoal = null
  state.pathGoalDynamic = false
  try { bot.pvp.stop() } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
  state.manualControlOnly = true
  state.mode = 'hitman'
  if (eliteMode && movements) {
    movements.allowParkour = true
    movements.allowSprinting = true
    movements.allow1by1towers = true
    movements.canDig = true
  }
  state.hitmanTask = {
    playerName,
    actualName: findPlayerByName(playerName)?.username || playerName,
    startedAt: Date.now(),
    lastSeenAt: 0,
    lastKnownPosition: null,
    nextMissingMessageAt: 0,
    attacks: 0,
    lastSeenDimension: currentDimension(),
    lastPortalAttemptAt: 0,
    pursuitFailures: 0,
    combatState: 'engage',
    lastCombatStateAt: Date.now(),
    terminator: eliteMode,
    resumeMode,
    resumeManualControlOnly,
    resumeAutonomyEnabled,
    resumeAutonomyFocus
  }
  updatePlanner(`eliminate ${playerName}`, eliteMode ? 'relentless Terminator pursuit' : 'locate and attack target player', 'ai hitman')
  setCurrentTask('hitman', `${eliteMode ? 'Terminator pursuit' : 'hunting'} ${playerName}`, { target: playerName })
  bot.chat(`${eliteMode ? 'Terminator hitman mode' : 'Hitman task'} started for ${playerName}. I will stop after one kill or ai hitman stop.`)
}

function stopHitman(reason = 'stopped') {
  const task = state.hitmanTask
  if (!task) {
    bot.chat('No hitman task is active.')
    return false
  }
  try { bot.pvp.stop() } catch {}
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
  state.hitmanTask = null
  state.currentCombat = null
  state.retaliationTask = null
  state.activeRoute = null
  state.pathGoal = null
  state.pathGoalDynamic = false
  state.mode = task.resumeMode && task.resumeMode !== 'hitman' ? task.resumeMode : 'idle'
  state.manualControlOnly = task.resumeManualControlOnly
  autonomy.enabled = task.resumeAutonomyEnabled
  autonomy.focus = task.resumeAutonomyFocus
  taskController.cancel(`hitman ${reason}`)
  state.stopVersion++
  updatePlanner('hitman stopped', state.mode === 'idle' ? 'waiting for command' : `resuming ${state.mode}`, reason)
  setCurrentTask('done', `hitman task ${reason}`, { target: task.actualName || task.playerName })
  bot.chat(reason === 'target killed'
    ? `Hitman task complete: ${task.actualName || task.playerName} was killed.`
    : 'Hitman task stopped.')
  return true
}

async function runHitmanStep() {
  const task = state.hitmanTask
  if (!task || state.hardStopped) return false
  const taskToken = taskController.active
  const player = findPlayerByName(task.playerName)
  const target = player?.entity
  if (!target?.position) {
    bot.pvp.stop()
    if (eliteMode && await eliteHitmanFollowPortal(task, taskToken)) return true
    if (task.lastKnownPosition && !state.pathGoal && new Vec3(task.lastKnownPosition.x, task.lastKnownPosition.y, task.lastKnownPosition.z).distanceTo(bot.entity.position) > 4) {
      const position = task.lastKnownPosition
      setCurrentTask('hitman', `searching last known position of ${task.actualName}`, {
        target: task.actualName,
        position: `${position.x} ${position.y} ${position.z}`
      })
      bot.pathfinder.setGoal(new goals.GoalNear(position.x, position.y, position.z, 3))
      return true
    }
    setCurrentTask('hitman', `${eliteMode ? 'relentlessly searching for' : 'waiting for'} ${task.actualName}`, { target: task.actualName })
    if (Date.now() >= (task.nextMissingMessageAt || 0)) {
      task.nextMissingMessageAt = Date.now() + 30000
      bot.chat(`I cannot see ${task.actualName}. I am ${eliteMode ? 'continuing the search' : 'waiting and searching from the last known position'}.`)
    }
    if (eliteMode && !state.pathGoal) {
      state.navigationBlockedUntil = 0
      const search = task.lastKnownPosition
        ? new Vec3(task.lastKnownPosition.x, task.lastKnownPosition.y, task.lastKnownPosition.z)
        : bot.entity.position.offset((Math.random() * 32) - 16, 0, (Math.random() * 32) - 16)
      bot.pathfinder.setGoal(new goals.GoalNear(search.x, search.y, search.z, 3))
      return true
    }
    return false
  }

  task.actualName = target.username || task.actualName || task.playerName
  task.lastSeenAt = Date.now()
  task.lastKnownPosition = positionData(target.position)
  task.lastSeenDimension = currentDimension()
  task.pursuitFailures = 0
  task.nextMissingMessageAt = 0
  setCurrentTask('hitman', `attacking ${task.actualName}`, {
    target: task.actualName,
    position: `${target.position.x.toFixed(1)} ${target.position.y.toFixed(1)} ${target.position.z.toFixed(1)}`
  })
  state.currentCombat = {
    mob: task.actualName,
    strategy: eliteMode ? 'Terminator pursuit: build, dig, bridge, clutch, attack' : 'persistent player pursuit',
    weapon: bestWeaponName(),
    armor: equippedArmorNames(),
    startedAt: state.currentCombat?.mob === task.actualName ? state.currentCombat.startedAt : Date.now()
  }
  await equipBestArmor()
  if (taskWasCancelled(taskToken)) return false
  if (eliteMode && await eliteHitmanCombatRecovery(target, taskToken)) return true
  if (!eliteMode && await retreatAndHeal(target, taskToken)) return true
  if (taskWasCancelled(taskToken)) return false
  await equipCombatWeapon(target)
  await equipShieldIfAvailable()
  if (eliteMode && await combatBrain.tick(target)) {
    task.attacks++
    task.combatState = state.eliteCombat?.phase || 'combatBrain'
    task.lastCombatStateAt = Date.now()
    return true
  }
  if (hasRangedCombat() && target.position.distanceTo(bot.entity.position) > 8) {
    if (await fireRangedWeapon(target)) {
      task.attacks++
      return true
    }
  }
  if (taskWasCancelled(taskToken)) return false
  if (eliteMode && await runEliteHitmanPursuit(target, task, taskToken)) return true
  if (taskWasCancelled(taskToken)) return false
  if (Date.now() < state.navigationBlockedUntil && target.position.distanceTo(bot.entity.position) > 5) {
    if (eliteMode) {
      state.navigationBlockedUntil = 0
      task.pursuitFailures++
      await eliteHitmanBreakFree(target, taskToken)
      return true
    }
    setCurrentTask('waiting', 'hitman pursuit paused after navigation failures', { target: task.actualName })
    return false
  }
  try {
    bot.pvp.stop()
    if (await timedPlayerMeleeAttack(target, { taskToken, preferCrit: true })) {
      task.attacks++
      return true
    }
  } catch (err) {
    logActionError(`Could not attack ${task.actualName}`, err)
    return false
  }
  return false
}

const hostileMobs = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
  'witch', 'slime', 'magma_cube', 'drowned',
  'husk', 'stray', 'phantom', 'blaze', 'ghast',
  'pillager', 'vindicator', 'evoker', 'ravager',
  'guardian', 'elder_guardian', 'piglin_brute', 'warden',
  'wither_skeleton', 'hoglin', 'zoglin', 'shulker',
  'endermite', 'wither', 'ender_dragon'
]

function isHostileMob(entity) {
  return entity && hostileMobs.includes(entity.name)
}

const ELITE_MOB_KNOWLEDGE = {
  blaze: { priority: 100, useful: 'blaze rods unlock brewing and Eyes of Ender', strategy: 'ranged or shielded rush' },
  wither_skeleton: { priority: 98, useful: 'wither skeleton skulls and coal', strategy: 'shield, keep spacing and use a strong sword' },
  shulker: { priority: 94, useful: 'shulker shells create portable storage', strategy: 'shield projectiles and attack while open' },
  ender_dragon: { priority: 92, useful: 'completes the game', strategy: 'destroy crystals, use bow, then attack the head' },
  hoglin: { priority: 82, useful: 'food and leather', strategy: 'keep spacing and use warped fungi terrain when possible' },
  piglin_brute: { priority: 88, useful: 'dangerous bastion threat', strategy: 'ranged attack or shielded axe combat' },
  ghast: { priority: 76, useful: 'ghast tears for regeneration', strategy: 'use ranged attacks and cover' },
  magma_cube: { priority: 72, useful: 'magma cream for fire resistance', strategy: 'keep distance and clear smaller cubes' },
  endermite: { priority: 65, useful: 'hostile End threat', strategy: 'quick melee attack' },
  wither: { priority: 55, useful: 'nether star', strategy: 'fight only with elite gear and healing' },
  warden: { priority: -100, useful: 'no worthwhile drop', strategy: 'avoid completely' },
  piglin: { priority: -40, useful: 'bartering ally while wearing gold', strategy: 'do not attack unless it attacks first' },
  zombified_piglin: { priority: -100, useful: 'group-neutral mob with dangerous retaliation', strategy: 'never provoke the group' },
  strider: { priority: -100, useful: 'safe lava transport', strategy: 'do not attack' },
  enderman: { priority: -30, useful: 'ender pearls, but dangerous when provoked', strategy: 'avoid eye contact; fight only when prepared and pearls are required' }
}

function eliteMobPriority(entity) {
  if (!isHostileMob(entity)) return -Infinity
  const profile = ELITE_MOB_KNOWLEDGE[entity.name]
  let priority = profile?.priority ?? 60
  if (entity.name === 'wither_skeleton' && !hasItem('wither_skeleton_skull', 3)) priority += 30
  if (entity.name === 'blaze' && !hasItem('blaze_rod', 8)) priority += 25
  if (entity.name === 'shulker' && !hasItem('shulker_shell', 2)) priority += 20
  return priority
}

function shouldEngageEliteMob(entity) {
  if (!entity || !isHostileMob(entity)) return false
  if (entity.name === 'warden') return false
  if (entity.name === 'wither' && (bot.health < 20 || equippedArmorNames().filter(name => /diamond|netherite/.test(name)).length < 4)) return false
  if (entity.name === 'ender_dragon' && state.mode !== 'beat_minecraft') return false
  if (entity.name === 'ghast' && !hasRangedCombat()) return false
  if (bot.health < 10) return false
  return true
}

function nearbyEnderman(range = 18) {
  if (!bot.entity) return null
  return Object.values(bot.entities || {})
    .filter(entity => entity?.name === 'enderman' && entity.position?.distanceTo(bot.entity.position) < range)
    .sort((left, right) => left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position))[0] || null
}

async function avoidEndermanGaze() {
  if (!eliteMode || !bot.entity || Date.now() - state.lastEndermanGazeAvoidAt < 500) return false
  const enderman = nearbyEnderman()
  if (!enderman) return false
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const head = enderman.position.offset(0, 2.7, 0)
  const delta = head.minus(eye)
  const length = Math.max(0.001, Math.hypot(delta.x, delta.y, delta.z))
  const toward = { x: delta.x / length, y: delta.y / length, z: delta.z / length }
  const yaw = Number(bot.entity.yaw) || 0
  const pitch = Number(bot.entity.pitch) || 0
  const look = {
    x: -Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * Math.cos(pitch)
  }
  const eyeContactRisk = look.x * toward.x + look.y * toward.y + look.z * toward.z
  const threshold = state.busy || state.hitmanTask || state.guardTask ? 0.985 : 0.96
  if (eyeContactRisk < threshold) return false
  state.lastEndermanGazeAvoidAt = Date.now()
  try {
    await bot.look(bot.entity.yaw + Math.PI * 0.75, -0.75, true)
    return true
  } catch {
    return false
  }
}

function bestEliteHostileTarget(range) {
  return Object.values(bot.entities || {})
    .filter(entity => entity?.position && entity.position.distanceTo(bot.entity.position) < range)
    .filter(entity => eliteMode ? shouldEngageEliteMob(entity) : isHostileMob(entity))
    .sort((left, right) => eliteMode
      ? eliteMobPriority(right) - eliteMobPriority(left) || left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position)
      : left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position))[0] || null
}

async function equipBestWeapon() {
  const priority = [
    'netherite_sword', 'diamond_sword', 'iron_sword',
    'stone_sword', 'wooden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe',
    'stone_axe', 'wooden_axe'
  ]

  const item = priority.map(name => bot.inventory.items().find(i => i.name === name)).find(Boolean)
  if (!item) return false
  try {
    await bot.equip(item, 'hand')
    return true
  } catch {
    return false
  }
}

function playerUsesShield(entity) {
  return Boolean(entity?.equipment?.some(item => item?.name === 'shield'))
}

function bestCombatWeapon(target = null) {
  const items = bot.inventory.items()
  const preferredType = playerUsesShield(target) ? '_axe' : '_sword'
  return items
    .filter(item => item.name.endsWith(preferredType))
    .sort((left, right) => weaponScore(right.name) - weaponScore(left.name))[0] ||
    items.filter(item => /_(sword|axe)$/.test(item.name))
      .sort((left, right) => weaponScore(right.name) - weaponScore(left.name))[0] ||
    null
}

async function equipCombatWeapon(target = null) {
  const item = bestCombatWeapon(target)
  if (!item) return false
  try {
    await bot.equip(item, 'hand')
    return true
  } catch {
    return false
  }
}

async function equipShieldIfAvailable() {
  const shield = bot.inventory.items().find(item => item.name === 'shield')
  if (!shield) return false
  try {
    await bot.equip(shield, 'off-hand')
    return true
  } catch {
    return false
  }
}

function hasRangedCombat() {
  return bot.inventory.items().some(item => item.name === 'bow' || item.name === 'crossbow') &&
    bot.inventory.items().some(item => ['arrow', 'spectral_arrow', 'tipped_arrow'].includes(item.name))
}

function taskWasCancelled(token) {
  return Boolean(state.hardStopped || (token && !taskController.isActive(token)))
}

function bestRangedWeapon() {
  return bot.inventory.items().find(item => item.name === 'crossbow') ||
    bot.inventory.items().find(item => item.name === 'bow') ||
    null
}

async function fireRangedWeapon(entity) {
  if (!entity?.position || !hasRangedCombat() || Date.now() - state.lastRangedAttackAt < 1500) return false
  const weapon = bestRangedWeapon()
  if (!weapon) return false
  try {
    state.lastRangedAttackAt = Date.now()
    bot.pvp.stop()
    bot.clearControlStates()
    await bot.equip(weapon, 'hand')
    await bot.lookAt(predictedRangedTarget(entity, weapon), true)
    if (weapon.name === 'crossbow') {
      bot.activateItem()
      await sleep(1300)
      bot.deactivateItem()
      await bot.lookAt(predictedRangedTarget(entity, weapon), true)
      await bot.waitForTicks(3)
      bot.activateItem()
      bot.deactivateItem()
    } else {
      bot.activateItem()
      await sleep(1100)
      await bot.lookAt(predictedRangedTarget(entity, weapon), true)
      bot.deactivateItem()
    }
    recordLearning('combat', 'weapons', weapon.name, 2, `fired at ${entity.name || 'target'}`)
    recordLearning('combat', 'tactics', `${entity.name || 'target'}:ranged`, 2, 'ranged attack fired')
    return true
  } catch (err) {
    try { bot.deactivateItem() } catch {}
    recordLearning('combat', 'weapons', weapon.name, -1, err.message || 'ranged attack failed')
    return false
  }
}

function predictedRangedTarget(entity, weapon) {
  const target = entity.position.offset(0, Math.min(entity.height || 1.5, 1.5), 0)
  if (!entity.velocity || !bot.entity) return target
  const distance = entity.position.distanceTo(bot.entity.position)
  const flightSeconds = Math.min(1.2, distance / (weapon?.name === 'crossbow' ? 32 : 25))
  return target.offset(
    entity.velocity.x * flightSeconds * 20,
    entity.velocity.y * flightSeconds * 20 + Math.min(2, distance * distance / 900),
    entity.velocity.z * flightSeconds * 20
  )
}

function weaponScore(name) {
  const material = { netherite: 60, diamond: 50, iron: 40, stone: 25, golden: 18, wood: 10, wooden: 10 }
  const type = { sword: 10, axe: 8, bow: 6, crossbow: 6, trident: 12 }
  const materialScore = Object.entries(material).find(([key]) => name.includes(key))?.[1] || 0
  const typeScore = Object.entries(type).find(([key]) => name.includes(key))?.[1] || 0
  return materialScore + typeScore + (eliteMode ? 0 : learnedScore('combat', 'weapons', name))
}

function bestWeaponName() {
  return bot.inventory.items()
    .filter(item => /(sword|axe|bow|crossbow|trident)/.test(item.name))
    .sort((left, right) => weaponScore(right.name) - weaponScore(left.name))[0]?.name || null
}

function equippedArmorNames() {
  try {
    return ['head', 'torso', 'legs', 'feet']
      .map(slot => bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name)
      .filter(Boolean)
  } catch {
    return []
  }
}

function armorScore(name) {
  const material = { netherite: 60, diamond: 50, iron: 40, chainmail: 30, golden: 22, leather: 12 }
  const piece = { chestplate: 10, leggings: 8, helmet: 6, boots: 5 }
  const materialScore = Object.entries(material).find(([key]) => name.includes(key))?.[1] || 0
  const pieceScore = Object.entries(piece).find(([key]) => name.includes(key))?.[1] || 0
  return materialScore + pieceScore + (eliteMode ? 0 : learnedScore('combat', 'armor', name))
}

async function eatFoodIfNeeded(options = {}) {
  const force = Boolean(options.force)
  if (!force && (bot.food >= 20 || (bot.food > 14 && bot.health > 12))) return false

  // Info: Bij direct levensgevaar is rotten flesh of rauwe kip beter dan blijven verhongeren; giftig voedsel blijft uitgesloten.
  const allowEmergencyFood = options.allowEmergencyFood !== false && (bot.food <= 4 || bot.health <= 6)
  const food = bot.inventory.items()
    .filter(item => item?.name && (isFood(item.name) || (allowEmergencyFood && isEmergencyFood(item.name))))
    .sort((left, right) => Number(isFood(right.name))-Number(isFood(left.name)) || foodScore(right.name)-foodScore(left.name))[0]

  if (!food?.name) return false

  try {
    if (!await equipAndConfirmHeldItem(food)) return false
    if (!bot.heldItem?.name || (!isFood(bot.heldItem.name) && !(allowEmergencyFood && isEmergencyFood(bot.heldItem.name)))) return false
    await bot.consume()
    bot.chat('I am eating for a moment to recover.')
    return true
  } catch (err) {
    if (!/food is full|consuming cancelled/i.test(err?.message || '')) logActionError('Could not eat food', err)
    return false
  }
}

async function retreatAndHeal(threat, taskToken = taskController.active) {
  const retreatHealth = eliteMode ? 12 : 8
  if (bot.health >= retreatHealth || state.combatRetreating || !bot.entity) return false
  state.combatRetreating = true
  setCurrentTask('combat', 'retreating to heal', { target: threat?.username || threat?.name || null })
  try {
    try { bot.pvp.stop() } catch {}
    await timedShieldBlock(500)
    if (threat?.position) {
      const away = bot.entity.position.minus(threat.position)
      const length = Math.max(0.1, Math.hypot(away.x, away.z))
      const target = bot.entity.position.offset((away.x / length) * 7, 0, (away.z / length) * 7)
      await safeGoto(new goals.GoalNear(target.x, target.y, target.z, 2), 'combat retreat')
    } else {
      bot.setControlState('back', true)
      await sleep(800)
      bot.clearControlStates()
    }
    if (taskWasCancelled(taskToken)) return false
    await eatFoodIfNeeded()
    return true
  } finally {
    bot.clearControlStates()
    state.combatRetreating = false
  }
}

async function timedShieldBlock(durationMs = 350) {
  if (!hasItem('shield') || Date.now() - state.lastShieldBlockAt < 900) return false
  if (!await equipShieldIfAvailable()) return false
  state.lastShieldBlockAt = Date.now()
  try {
    bot.activateItem(true)
    await sleep(durationMs)
    return true
  } finally {
    try { bot.deactivateItem() } catch {}
  }
}

function playerMeleeCooldownMs() {
  return Math.max(550, (getCooldown(bot.heldItem?.name) + 1) * 50)
}

async function waitForCritWindow(timeoutMs = 650) {
  if (!bot.entity?.onGround || bot.entity.isInWater || bot.entity.isInLava || bot.entity.isInWeb) return false
  bot.setControlState('sprint', false)
  bot.setControlState('jump', true)
  await sleep(80)
  bot.setControlState('jump', false)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!bot.entity) return false
    if (!bot.entity.onGround && Number(bot.entity.velocity?.y || 0) < -0.04) return true
    await sleep(25)
  }
  return false
}

async function timedPlayerMeleeAttack(target, options = {}) {
  if (!target?.position || !bot.entity || target.type !== 'player') return false
  const taskToken = options.taskToken || taskController.active
  const wait = playerMeleeCooldownMs() - (Date.now() - state.lastPlayerMeleeAt)
  if (wait > 250) {
    const startedAt = Date.now()
    await timedShieldBlock(Math.min(400, wait - 100))
    const remaining = wait - (Date.now() - startedAt)
    if (remaining > 0) await sleep(remaining)
  } else if (wait > 0) {
    await sleep(wait)
  }
  if (taskWasCancelled(taskToken) || target.isValid === false) return false
  if (!canHitEntity(target)) {
    if (!await approachCombatTarget(target)) return false
    if (taskWasCancelled(taskToken) || !canHitEntity(target)) return false
  }
  await bot.lookAt(target.position.offset(0, Math.min(target.height || 1.6, 1.6), 0), true)
  let critical = false
  const critIsSafe = !eliteMode || (bot.health >= 12 && bot.food >= 10 && !playerUsesShield(target))
  if (options.preferCrit !== false && critIsSafe && target.position.distanceTo(bot.entity.position) <= 3.6) {
    critical = await waitForCritWindow()
    if (taskWasCancelled(taskToken)) return false
    await bot.lookAt(target.position.offset(0, Math.min(target.height || 1.6, 1.6), 0), true)
  }
  if (!canHitEntity(target)) return false
  bot.attack(target)
  state.lastPlayerMeleeAt = Date.now()
  recordLearning('combat', 'tactics', critical ? 'player:critical_hit' : 'player:timed_hit', critical ? 2 : 1, critical ? 'timed falling critical attack' : 'fully charged player attack')
  return true
}

function playerThreatScore(entity) {
  if (!entity?.position || entity.username === bot.username) return -Infinity
  const distance = entity.position.distanceTo(bot.entity.position)
  const health = Number(entity.health ?? 20)
  let score = 100 - distance * 3 + (20 - health) * 2
  if (playerUsesShield(entity)) score += 18
  if (state.hitmanTask && entity.username?.toLowerCase() === state.hitmanTask.playerName?.toLowerCase()) score += 1000
  if (state.lastDamage?.cause?.includes(entity.username || '')) score += 120
  return score
}

function bestElitePlayerTarget(range = 32) {
  if (!bot.entity) return null
  return Object.values(bot.entities || {})
    .filter(entity => entity?.type === 'player' && entity.username !== bot.username && entity.position?.distanceTo(bot.entity.position) <= range)
    .sort((left, right) => playerThreatScore(right) - playerThreatScore(left))[0] || null
}

function eliteCombatSetPhase(phase, target, extra = {}) {
  state.eliteCombat.phase = phase
  state.eliteCombat.target = target?.username || target?.name || null
  state.eliteCombat.lastDecisionAt = Date.now()
  setCurrentTask('elite_pvp', phase, {
    target: state.eliteCombat.target,
    ...extra
  })
}

async function equipEliteOffhand(target = null) {
  const lowHealth = bot.health <= 10
  const totem = bot.inventory.items().find(item => item.name === 'totem_of_undying')
  if (lowHealth && totem && Date.now() - state.eliteCombat.lastTotemAt > 1000) {
    try {
      await bot.equip(totem, 'off-hand')
      state.eliteCombat.lastTotemAt = Date.now()
      recordLearning('combat', 'tactics', 'totem_logic', 2, 'equipped totem at low health')
      return true
    } catch {}
  }
  return equipShieldIfAvailable(target)
}

async function useEliteGapple(taskToken = taskController.active) {
  if (bot.health > 13 || Date.now() - state.eliteCombat.lastGappleAt < 9000) return false
  const gapple = bot.inventory.items().find(item => ['enchanted_golden_apple', 'golden_apple'].includes(item.name))
  if (!gapple) return false
  try {
    eliteCombatSetPhase('healing with golden apple', null)
    try { bot.pvp.stop() } catch {}
    bot.clearControlStates()
    await equipAndConfirmHeldItem(gapple)
    await bot.consume()
    state.eliteCombat.lastGappleAt = Date.now()
    recordLearning('combat', 'tactics', 'gapple_logic', 3, 'used golden apple before re-engage')
    return !taskWasCancelled(taskToken)
  } catch (err) {
    if (!/food is full|consuming cancelled/i.test(err?.message || '')) logActionError('Elite gapple failed', err)
    return false
  }
}

function eliteRetreatPoint(threat, distance = 10) {
  if (!bot.entity || !threat?.position) return null
  const away = bot.entity.position.minus(threat.position)
  const length = Math.max(0.1, Math.hypot(away.x, away.z))
  return bot.entity.position.offset((away.x / length) * distance, 0, (away.z / length) * distance)
}

async function useElitePearl(target, mode = 'retreat') {
  if (Date.now() - state.eliteCombat.lastPearlAt < 12000 || !hasItem('ender_pearl')) return false
  const pearl = bot.inventory.items().find(item => item.name === 'ender_pearl')
  if (!pearl || !bot.entity) return false
  const aim = mode === 'engage' && target?.position
    ? target.position.offset(0, 1.2, 0)
    : eliteRetreatPoint(target, 18)?.offset(0, 1.2, 0)
  if (!aim) return false
  try {
    eliteCombatSetPhase(`${mode} pearl`, target)
    try { bot.pvp.stop() } catch {}
    await equipAndConfirmHeldItem(pearl)
    await bot.lookAt(aim, true)
    bot.activateItem()
    state.eliteCombat.lastPearlAt = Date.now()
    recordLearning('combat', 'tactics', `pearl:${mode}`, 3, 'used ender pearl for PvP repositioning')
    return true
  } catch (err) {
    if (!expectedPathError(err)) logActionError('Elite pearl failed', err)
    return false
  }
}

async function useEliteWater(target) {
  if (currentDimension().includes('nether') || Date.now() - state.eliteCombat.lastWaterAt < 5000) return false
  const water = bot.inventory.items().find(item => item.name === 'water_bucket')
  if (!water || !bot.entity) return false
  const feet = bot.entity.position.floored()
  const inLava = ['lava', 'fire'].includes(bot.blockAt(feet)?.name) || ['lava', 'fire'].includes(bot.blockAt(feet.offset(0, -1, 0))?.name)
  const needsSlowField = target?.position && target.position.distanceTo(bot.entity.position) < 3 && bot.health <= 12
  if (!inLava && !needsSlowField) return false
  try {
    eliteCombatSetPhase(inLava ? 'water clutch versus lava' : 'water spacing field', target)
    await equipAndConfirmHeldItem(water)
    const reference = bot.blockAt(feet.offset(0, -1, 0))
    if (reference?.boundingBox === 'block') {
      await bot.lookAt(reference.position.offset(0.5, 1, 0.5), true)
      bot.activateItem()
      state.eliteCombat.lastWaterAt = Date.now()
      recordLearning('combat', 'tactics', 'water_bucket', 2, inLava ? 'escaped lava/fire' : 'created spacing field')
      return true
    }
  } catch (err) {
    if (!expectedPathError(err)) logActionError('Elite water bucket failed', err)
  }
  return false
}

async function useEliteLava(target) {
  if (!target?.position || currentDimension().includes('nether') || Date.now() - state.eliteCombat.lastLavaAt < 10000) return false
  if (target.position.distanceTo(bot.entity.position) > 4 || bot.health < 12) return false
  const lava = bot.inventory.items().find(item => item.name === 'lava_bucket')
  if (!lava) return false
  const targetFeet = target.position.floored()
  const below = bot.blockAt(targetFeet.offset(0, -1, 0))
  if (!below || below.boundingBox !== 'block') return false
  try {
    eliteCombatSetPhase('lava bucket pressure', target)
    try { bot.pvp.stop() } catch {}
    await equipAndConfirmHeldItem(lava)
    await bot.lookAt(below.position.offset(0.5, 1, 0.5), true)
    bot.activateItem()
    state.eliteCombat.lastLavaAt = Date.now()
    recordLearning('combat', 'tactics', 'lava_bucket', 3, 'placed lava to force target movement')
    return true
  } catch (err) {
    if (!expectedPathError(err)) logActionError('Elite lava bucket failed', err)
    return false
  }
}

function applyEliteStrafePattern(target) {
  if (!target?.position || !bot.entity) return
  const now = Date.now()
  if (now - state.eliteCombat.lastStrafeAt > 650) {
    state.eliteCombat.strafeSide = state.eliteCombat.strafeSide === 'left' ? 'right' : 'left'
    state.eliteCombat.lastStrafeAt = now
  }
  const distance = target.position.distanceTo(bot.entity.position)
  bot.setControlState('sprint', true)
  bot.setControlState('left', state.eliteCombat.strafeSide === 'left')
  bot.setControlState('right', state.eliteCombat.strafeSide === 'right')
  bot.setControlState('forward', distance > 2.9)
  bot.setControlState('back', distance < 2.15)
  if (now < state.eliteCombat.comboUntil) bot.setControlState('jump', distance <= 3.4 && bot.entity.onGround && bot.health >= 12)
}

async function eliteShieldBreak(target, taskToken = taskController.active) {
  if (!playerUsesShield(target)) return false
  const axe = bot.inventory.items()
    .filter(item => item.name.endsWith('_axe'))
    .sort((left, right) => weaponScore(right.name) - weaponScore(left.name))[0]
  if (!axe) return false
  eliteCombatSetPhase('shield break with axe', target)
  await equipAndConfirmHeldItem(axe)
  applyEliteStrafePattern(target)
  if (taskWasCancelled(taskToken)) return false
  if (!canHitEntity(target) && !await approachCombatTarget(target)) return false
  await bot.lookAt(target.position.offset(0, 1.35, 0), true)
  if (!canHitEntity(target)) return false
  bot.attack(target)
  state.lastPlayerMeleeAt = Date.now()
  state.eliteCombat.comboUntil = Date.now() + 1800
  recordLearning('combat', 'tactics', 'shield_break_axe', 3, 'used axe into shield user')
  return true
}

async function eliteRetreatAndReengage(target, taskToken = taskController.active) {
  if (!target?.position || state.combatRetreating) return false
  const mustRetreat = bot.health <= 8 || bot.food <= 6
  if (!mustRetreat && Date.now() < state.eliteCombat.reengageAt) return false
  if (!mustRetreat) return false
  state.combatRetreating = true
  try {
    eliteCombatSetPhase('retreat and reset', target)
    try { bot.pvp.stop() } catch {}
    await timedShieldBlock(500)
    if (await useEliteGapple(taskToken)) {
      state.eliteCombat.reengageAt = Date.now() + 1200
      return true
    }
    if (bot.health <= 6 && await useElitePearl(target, 'retreat')) {
      state.eliteCombat.reengageAt = Date.now() + 2500
      return true
    }
    const retreat = eliteRetreatPoint(target, 9)
    if (retreat) await safeGoto(new goals.GoalNear(retreat.x, retreat.y, retreat.z, 2), 'elite pvp retreat')
    if (!taskWasCancelled(taskToken)) await eatFoodIfNeeded({ force: true })
    state.eliteCombat.reengageAt = Date.now() + 1000
    return true
  } finally {
    bot.clearControlStates()
    state.combatRetreating = false
  }
}

async function runElitePlayerCombatStateMachine(target, context = {}) {
  if (!eliteMode || !target?.position || !bot.entity || target.type !== 'player') return false
  const taskToken = context.taskToken || taskController.active
  if (taskWasCancelled(taskToken)) return false
  const distance = target.position.distanceTo(bot.entity.position)
  await equipBestArmor()
  await equipEliteOffhand(target)

  if (await useEliteWater(target)) return true
  if (await eliteRetreatAndReengage(target, taskToken)) return true
  if (Date.now() < state.eliteCombat.reengageAt) return true

  if (distance > 22 && bot.health <= 10 && await useElitePearl(target, 'retreat')) return true
  if (distance > 14 && distance < 32 && hasRangedCombat()) {
    eliteCombatSetPhase('bow prediction pressure', target, { distance: distance.toFixed(1) })
    if (await fireRangedWeapon(target)) return true
  }
  if (distance > 8 && distance < 18 && bot.health >= 14 && !hasRangedCombat() && await useElitePearl(target, 'engage')) return true
  if (distance <= 4 && await useEliteLava(target)) return true
  if (await eliteShieldBreak(target, taskToken)) return true

  if (distance > 4.1) {
    eliteCombatSetPhase('closing combo distance', target, { distance: distance.toFixed(1) })
    return context.pursue ? context.pursue() : safeGoto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), 'elite pvp engage')
  }

  eliteCombatSetPhase('strafe combo spacing', target, { distance: distance.toFixed(1) })
  await equipCombatWeapon(target)
  applyEliteStrafePattern(target)
  if (await timedPlayerMeleeAttack(target, { taskToken, preferCrit: bot.health >= 12 && bot.food >= 10 })) {
    state.eliteCombat.comboUntil = Date.now() + 1600
    return true
  }
  return false
}

async function retaliateAgainstPlayer(target, hits = 3) {
  if (!target?.position || state.hitmanTask) return false
  const token = taskController.begin(`retaliate:${target.username || 'player'}`, 'pvp-defense')
  const retaliation = { target: target.username || 'player', hitsRemaining: hits, startedAt: Date.now() }
  state.retaliationTask = retaliation
  try {
    await equipCombatWeapon(target)
    await equipShieldIfAvailable()
    for (let hit = 0; hit < hits; hit++) {
      if (taskWasCancelled(token) || state.retaliationTask !== retaliation || target.isValid === false || !target.position) break
      retaliation.hitsRemaining = hits - hit
      if (eliteMode && await combatBrain.tick(target)) continue
      if (!await timedPlayerMeleeAttack(target, { taskToken: token, preferCrit: true })) break
    }
    return true
  } finally {
    if (taskController.isActive(token)) taskController.cancel('retaliation complete')
    if (state.retaliationTask === retaliation) state.retaliationTask = null
    bot.clearControlStates()
  }
}

function rememberGuardAttacker(protectedEntity) {
  if (!state.guardTask || protectedEntity?.type !== 'player' || !isGuardProtectedPlayer(protectedEntity)) return
  const attacker = bot.nearestEntity(entity => {
    if (!entity?.position || entity === bot.entity || entity === protectedEntity) return false
    if (entity.position.distanceTo(protectedEntity.position) > 6) return false
    if (isHostileMob(entity)) return true
    return entity.type === 'player' &&
      !isGuardProtectedPlayer(entity) &&
      entity.username?.toLowerCase() !== String(bot.username || '').toLowerCase()
  })
  if (!attacker) return
  state.guardTask.threatEntityId = attacker.id
  state.guardTask.threatName = attacker.username || attacker.name
  state.guardTask.threatUntil = Date.now() + 20000
  setCurrentTask('guard', `intercepting attacker of ${protectedEntity.username}`, { target: state.guardTask.threatName })
}

bot.on('entityHurt', async entity => {
  rememberGuardAttacker(entity)
  if (entity !== bot.entity) return

  await eatFoodIfNeeded()
  await equipBestArmor()
  equipBestWeapon()

  const closeEnderman = eliteMode ? nearbyEnderman(5) : null
  const attacker = bot.nearestEntity(e => isHostileMob(e) && e.position.distanceTo(bot.entity.position) < 8) ||
    closeEnderman ||
    (eliteMode ? bestElitePlayerTarget(10) : bot.nearestEntity(e => e && e !== bot.entity && e.type === 'player' && e.position.distanceTo(bot.entity.position) < 8))

  state.lastDamage = {
    at: Date.now(),
    cause: attacker ? `${attacker.type === 'player' ? 'player' : 'mob'}:${attacker.username || attacker.name}` : 'environment damage'
  }
  if (attacker) {
    recordLearning('combat', 'mobs', attacker.username || attacker.name || 'unknown', -1, 'damaged bot')
    for (const armor of equippedArmorNames()) recordLearning('combat', 'armor', armor, -1, 'damage taken while equipped')
  }
  if (!attacker) return

  if (eliteMode && attacker.name === 'enderman') {
    setCurrentTask('combat', 'escaping an aggravated enderman without eye contact', { target: 'enderman' })
    await avoidEndermanGaze()
    await retreatFromEliteThreat(attacker, taskController.active)
    return
  }

  if (isHostileMob(attacker)) {
    await defendAgainst(attacker)
    return
  }

  if (attacker.type === 'player') {
    if (playerPvpEnabled) {
      if (!state.retaliationTask) bot.chat('Player PvP is enabled.')
      if (!state.retaliationTask) {
        if (eliteMode) {
          await retaliateAgainstPlayer(attacker, 3)
        } else if (!await retreatAndHeal(attacker)) await retaliateAgainstPlayer(attacker, 3)
      }
    }
  }
})

async function equipBestArmor() {
  try {
    await bot.armorManager.equipAll()
  } catch {
    return
  }
}

function editDistance(left, right) {
  left = String(left || '')
  right = String(right || '')
  const row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= right.length; j++) {
      const previous = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1))
      diagonal = previous
    }
  }
  return row[right.length]
}

function normalizeCraftRequest(itemName) {
  const aliases = { sheers: 'shears' }
  const normalized = aliases[itemName] || itemName
  if (normalized === 'boat' || mcData?.itemsByName?.[normalized]) return { item: normalized, corrected: normalized !== itemName }
  const suggestion = Object.keys(mcData?.itemsByName || {})
    .map(name => ({ name, distance: editDistance(normalized, name) }))
    .sort((left, right) => left.distance - right.distance)[0]
  return { item: null, suggestion: suggestion?.distance <= 3 ? suggestion.name : null }
}

function craftRetryRemaining(itemName) {
  return Math.max(0, Number(state.craftRetryAfter[itemName] || 0) - Date.now())
}

function craftingRetryCoolingDown() {
  return Object.values(state.craftRetryAfter).some(retryAt => Number(retryAt) > Date.now())
}

async function craftSmart(itemName, allowDuplicateTool = false) {
  const normalizedName = String(itemName || '').trim().toLowerCase()
  if (!normalizedName) return false
  if (state.craftInProgress) {
    setCurrentTask('waiting', `waiting for ${state.craftInProgress} crafting attempt`)
    return false
  }
  const retryRemaining = craftRetryRemaining(normalizedName)
  if (retryRemaining > 0) {
    setCurrentTask('waiting', `craft ${normalizedName} retry cooldown`, {
      target: `${Math.ceil(retryRemaining / 1000)} seconds`
    })
    return false
  }

  state.craftInProgress = normalizedName
  try {
    let crafted = false
    try {
      crafted = await craftSmartAttempt(normalizedName, allowDuplicateTool)
    } catch (err) {
      logActionError(`Could not craft ${normalizedName}`, err)
    }
    if (crafted) {
      delete state.craftRetryAfter[normalizedName]
      delete state.craftFailureCounts[normalizedName]
      return true
    }
    const failures = (state.craftFailureCounts[normalizedName] || 0) + 1
    state.craftFailureCounts[normalizedName] = failures
    state.craftRetryAfter[normalizedName] = Date.now() + Math.min(180000, 30000 * failures)
    setCurrentTask('waiting', `craft ${normalizedName} unavailable`, {
      target: `retry in ${Math.ceil(craftRetryRemaining(normalizedName) / 1000)} seconds`
    })
    return false
  } finally {
    state.craftInProgress = null
  }
}

async function craftSmartAttempt(itemName, allowDuplicateTool = false) {
  if (!minecraftConnected || !mcData) return false
  const taskToken = taskController.active
  const request = normalizeCraftRequest(String(itemName || '').trim().toLowerCase())
  if (!request.item) {
    bot.chat(request.suggestion ? `Unknown item. Did you mean ${request.suggestion}?` : `I don't know an item named ${itemName}.`)
    return false
  }
  itemName = request.item
  if (request.corrected) bot.chat(`Using corrected item name: ${itemName}.`)
  if (!allowDuplicateTool && ownedToolSatisfies(itemName)) {
    const wanted = toolParts(itemName)
    const owned = wanted ? bestOwnedTool(wanted.family) : bot.inventory.items().find(item => item.name === itemName)
    bot.chat(`I already have ${owned?.name || itemName}.`)
    return true
  }
  recordInfo(`Trying to craft ${itemName}.`, 'crafting')

  if (itemName === 'boat') {
    if (!await ensurePlanks(5)) return false
    if (taskWasCancelled(taskToken)) return false
    const planks = bot.inventory.items().find(item => item.name.endsWith('_planks'))
    if (!planks) return false
    return craftWithTable(planks.name.replace('_planks', '_boat'))
  }

  if (itemName === 'wooden_pickaxe') {
    if (!await ensureSticks()) return false
    if (taskWasCancelled(taskToken)) return false
    if (!await ensureCraftingTable()) return false
    if (taskWasCancelled(taskToken)) return false
    if (!await ensurePlanks(3)) return false
    if (!await craftWithTable('wooden_pickaxe')) return false
    return true
  }

  if (itemName === 'stone_pickaxe') {
    if (!hasItem('wooden_pickaxe') && !hasItem('stone_pickaxe') && !await craftSmartAttempt('wooden_pickaxe')) return false
    if (taskWasCancelled(taskToken)) return false
    await ensureCobblestone(3)
    if (taskWasCancelled(taskToken)) return false
    if (!await ensureSticks()) return false
    if (!await craftWithTable('stone_pickaxe')) return false
    return true
  }

  if (itemName === 'crafting_table') {
    if (!await ensurePlanks(4)) return false
    return craftItem('crafting_table')
  }

  if (itemName === 'stick') {
    await ensureSticks()
    return true
  }

  if (itemName === 'shield') {
    if (!hasItem('iron_ingot')) return false
    if (!await ensureCraftingTable()) return false
    if (taskWasCancelled(taskToken)) return false
    if (!await ensurePlanks(6)) return false
    if (taskWasCancelled(taskToken)) return false
    return craftWithTable('shield')
  }

  await searchNearbyChests()
  if (eliteMode) return eliteCraftUsingCorrectStation(itemName, allowDuplicateTool)
  return craftItem(itemName)
}

async function eliteCraftUsingCorrectStation(itemName, allowDuplicateTool = false, depth = 0, seen = new Set()) {
  if (!minecraftConnected || !mcData || depth > 5 || seen.has(itemName)) return false
  seen.add(itemName)
  const before = itemCount(itemName)
  const item = mcData.itemsByName[itemName]
  if (!item) return false
  if (bot.recipesFor(item.id, null, 1, null)[0] && await craftItem(itemName)) {
    return itemCount(itemName) > before || hasItem(itemName)
  }
  const table = await ensureCraftingTable()
  if (table && bot.recipesFor(item.id, null, 1, table)[0] && await craftWithTable(itemName, allowDuplicateTool)) {
    return itemCount(itemName) > before || hasItem(itemName)
  }

  const recipes = recipeBook?.recipes || []
  const recipe = recipes.find(entry => entry.output === itemName && entry.station === 'crafting_table') ||
    recipes.find(entry => entry.output === itemName && entry.station === 'inventory')
  if (!recipe) return false
  setCurrentTask('crafting', `preparing ingredients for ${itemName}`, { target: recipe.ingredients.join(', ') })
  for (const ingredient of recipe.ingredients) {
    if (hasItem(ingredient)) continue
    if (ingredient.endsWith('_planks')) {
      if (!await ensurePlanks(4)) return false
      continue
    }
    if (ingredient === 'stick') {
      if (!await ensureSticks()) return false
      continue
    }
    const subRecipe = recipes.some(entry => entry.output === ingredient && ['inventory', 'crafting_table'].includes(entry.station))
    if (!subRecipe || !await eliteCraftUsingCorrectStation(ingredient, false, depth + 1, seen)) {
      recordInfo(`Missing ${ingredient} for ${itemName}.`, 'crafting')
      return false
    }
  }
  return recipe.station === 'crafting_table'
    ? craftWithTable(itemName, allowDuplicateTool)
    : craftItem(itemName)
}

async function ensureWood() {
  const hasLog = bot.inventory.items().some(i => i.name.includes('_log'))

  if (hasLog) return true

  recordInfo('Wood is needed. Looking for a tree.', 'crafting')
  if (await withdrawWantedItem('oak_log', 1)) return true
  return findWood()
}

async function craftItem(itemName) {
  if (!minecraftConnected || !mcData) return false
  const taskToken = taskController.active
  const item = mcData.itemsByName[itemName]

  if (!item) {
    bot.chat(`I don't know how to make ${itemName}.`)
    bumpKnowledgeStat('crafting', 'failedCrafts', itemName)
    recordLearning('crafting', 'items', itemName, -2, 'unknown item')
    return false
  }

  const recipe = bot.recipesFor(item.id, null, 1, null)[0]

  if (!recipe) {
    bot.chat(`I cannot craft ${itemName} right now.`)
    bumpKnowledgeStat('crafting', 'failedCrafts', itemName)
    recordLearning('crafting', 'items', itemName, -1, 'missing recipe or ingredients')
    return false
  }

  if (!minecraftConnected) return false
  await bot.craft(recipe, 1, null)
  if (taskWasCancelled(taskToken)) return false
  addSkill('crafting')
  bumpKnowledgeStat('crafting', 'crafted', itemName)
  recordLearning('crafting', 'items', itemName, 2, 'crafted without table')
  discoverRecipe(itemName)
  recordInfo(`Crafted ${itemName}.`, 'crafting')
  return true
}

async function ensureCraftingTable() {
  if (!minecraftConnected || !bot.entity) return null
  let failed = state.failedUtilities.crafting_table
  if (failed?.until <= Date.now()) {
    delete state.failedUtilities.crafting_table
    failed = null
  }
  let tableBlock = await findRememberedUtility('crafting_table')
  if (tableBlock?.position.distanceTo(bot.entity.position) > 4 &&
    !await safeGoto(new goals.GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 2), 'reaching crafting table')) {
    tableBlock = null
  }
  tableBlock ||= bot.findBlocks({
    matching: mcData.blocksByName.crafting_table.id,
    maxDistance: 8,
    count: 8
  }).map(position => bot.blockAt(position)).filter(Boolean)
    .find(block => !failed || block.position.distanceTo(new Vec3(failed.x, failed.y, failed.z)) > 2) || null

  if (tableBlock) {
    rememberUtility('crafting_table', tableBlock)
    return tableBlock
  }

  const hasTable = bot.inventory.items().find(i => i.name === 'crafting_table')

  if (!hasTable) {
    if (!await ensurePlanks(4)) return null
    await craftItem('crafting_table')
  }

  const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table')
  if (!tableItem) {
    bot.chat('I could not make a crafting table.')
    return null
  }

  const target = await findOrClearPlacementSpot()

  if (!target) {
    bot.chat('I could not find a free spot for a crafting table.')
    return null
  }

  try {
    if (!minecraftConnected) return null
    if (!await equipAndConfirmHeldItem(tableItem)) return null
    if (!minecraftConnected) return null
    await bot.placeBlock(bot.blockAt(target.offset(0, -1, 0)), new Vec3(0, 1, 0))
    if (!await waitForPlacedBlock(target, 1800)) throw new Error('server did not confirm crafting table placement')
  } catch (err) {
    if (minecraftConnected) console.log('Crafting table placement failed:', err.message)
    bot.chat('Placing the crafting table did not work. I will try again later')
    return null
  }

  const placementDeadline = Date.now() + 1500
  do {
    tableBlock = bot.blockAt(target)
    if (tableBlock?.name === 'crafting_table') break
    await sleep(50)
  } while (Date.now() < placementDeadline)

  if (tableBlock?.name === 'crafting_table') {
    rememberUtility('crafting_table', tableBlock)
    return tableBlock
  }
  return null
}

async function craftWithTable(itemName, allowDuplicateTool = false) {
  if (!minecraftConnected || !mcData) return false
  const taskToken = taskController.active
  if (!allowDuplicateTool && ownedToolSatisfies(itemName)) return true
  const tableBlock = await ensureCraftingTable()
  if (taskWasCancelled(taskToken)) return false
  if (!tableBlock) return false
  if (tableBlock.position.distanceTo(bot.entity.position) > 4 &&
    !await safeGoto(new goals.GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 2), 'reaching crafting table')) return false

  const item = mcData.itemsByName[itemName]
  if (!item) {
    bumpKnowledgeStat('crafting', 'failedCrafts', itemName)
    recordLearning('crafting', 'items', itemName, -2, 'unknown item')
    return false
  }

  const recipe = bot.recipesFor(item.id, null, 1, tableBlock)[0]

  if (!recipe) {
    bot.chat(`I am missing items for ${itemName}.`)
    bumpKnowledgeStat('crafting', 'failedCrafts', itemName)
    recordLearning('crafting', 'items', itemName, -1, 'missing table recipe or ingredients')
    return false
  }

  if (!minecraftConnected) return false
  const before = itemCount(itemName)
  try {
    await bot.craft(recipe, 1, tableBlock)
  } catch (err) {
    if (/windowOpen did not fire|timeout/i.test(err?.message || '')) {
      state.failedUtilities.crafting_table = {
        x: tableBlock.position.x,
        y: tableBlock.position.y,
        z: tableBlock.position.z,
        until: Date.now() + 120000
      }
      recordLearning('crafting', 'utilities', 'crafting_table', -2, 'table did not open; avoiding temporarily')
      return false
    }
    throw err
  }
  if (taskWasCancelled(taskToken)) return false
  if (itemCount(itemName) <= before && !hasItem(itemName)) {
    recordLearning('crafting', 'utilities', 'crafting_table', -1, 'craft returned without verified output')
    return false
  }
  addSkill('crafting')
  bumpKnowledgeStat('crafting', 'crafted', itemName)
  recordLearning('crafting', 'items', itemName, 2, 'crafted with table')
  discoverRecipe(itemName)
  recordInfo(`Crafted ${itemName}.`, 'crafting')
  return true
}

async function searchNearbyChests() {
  const chestIds = [
    mcData.blocksByName.chest?.id,
    mcData.blocksByName.trapped_chest?.id,
    mcData.blocksByName.barrel?.id
  ].filter(Boolean)

  const chest = bot.findBlock({
    matching: chestIds,
    maxDistance: 16
  })

  if (!chest) {
    bot.chat('No chest or barrel found nearby.')
    return
  }

  bot.chat('I am looking for items in a chest/barrel...')

  if (!await safeGoto(new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 'searching chest')) return

  const container = await bot.openContainer(chest)

  for (const item of container.containerItems()) {
    try {
      await container.withdraw(item.type, null, item.count)
    } catch (err) {
      logActionError(`Could not withdraw ${item.name} from chest`, err)
    }
  }

  container.close()
  bot.chat('I have taken items from the chest.')
}

function isWaterBlock(block) {
  return Boolean(block && WATER_BLOCK_NAMES.includes(block.name))
}

function findBoatItem() {
  return bot.inventory.items().find(item => BOAT_ITEMS.includes(item.name))
}

async function useBoatOnWater() {
  if (bot.vehicle?.name?.includes('boat')) {
    const target = goalPosition(state.pathGoal)
    if (target) await bot.lookAt(target.offset(0, 0.5, 0), true)
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    setCurrentTask('moving', 'boating efficiently toward route goal')
    return true
  }
  const water = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
  const boat = findBoatItem()
  if (!boat || !isWaterBlock(water)) return false
  try {
    await bot.equip(boat, 'hand')
    bot.activateItem()
    await sleep(500)
    const entity = bot.nearestEntity(entity => entity.name?.includes('boat') && entity.position.distanceTo(bot.entity.position) < 3)
    if (entity) await bot.mount(entity)
    return Boolean(entity)
  } catch {
    return false
  }
}

async function craftAvailablePlanks() {
  const log = bot.inventory.items().find(item => item.name.endsWith('_log'))
  if (!log) return false
  return craftItem(log.name.replace('_log', '_planks'))
}

function plankCount() {
  return bot.inventory.items()
    .filter(item => item.name.endsWith('_planks'))
    .reduce((total, item) => total + item.count, 0)
}

async function ensurePlanks(count) {
  while (plankCount() < count) {
    const hasLog = bot.inventory.items().some(item => item.name.endsWith('_log'))
    if (!hasLog) await ensureWood()
    if (!bot.inventory.items().some(item => item.name.endsWith('_log'))) {
      recordInfo(`Could not find enough wood for ${count} planks.`, 'crafting')
      return false
    }
    if (!await craftAvailablePlanks()) return false
  }
  return true
}

async function ensureSticks() {
  if (hasItem('stick', 2)) return true
  if (!await ensurePlanks(2)) return false
  return craftItem('stick')
}

function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(memoryFile, 'utf8'))
  } catch {
    return { skills: {} }
  }
}

function worldMemoryId() {
  return safeName(`${minecraftHost}_${minecraftPort}_${botSettings.worldId}`)
}

function worldMemoryFile() {
  return path.join(worldsDir, `${worldMemoryId()}.json`)
}

function defaultWorldMemory() {
  return {
    id: worldMemoryId(),
    host: minecraftHost,
    port: minecraftPort,
    updatedAt: null,
    home: null,
    villages: [],
    mines: [],
    strongholds: [],
    storage: [],
    workstations: [],
    beds: [],
    portals: [],
    ores: [],
    foodSources: [],
    dangerZones: [],
    deathLocations: [],
    caves: [],
    bases: [],
    farms: [],
    utilities: {},
    oreChunks: {}
  }
}

function mergeWorldMemory(loaded) {
  const base = defaultWorldMemory()
  const next = { ...base, ...(loaded || {}) }
  for (const key of ['villages', 'mines', 'strongholds', 'storage', 'workstations', 'beds', 'portals', 'ores', 'foodSources', 'dangerZones', 'deathLocations', 'caves', 'bases', 'farms']) {
    next[key] = Array.isArray(next[key]) ? next[key] : []
  }
  next.oreChunks ||= {}
  next.utilities ||= {}
  return next
}

function loadWorldMemory() {
  try {
    return mergeWorldMemory(JSON.parse(fs.readFileSync(worldMemoryFile(), 'utf8')))
  } catch {
    return defaultWorldMemory()
  }
}

function saveWorldMemory() {
  fs.mkdirSync(worldsDir, { recursive: true })
  worldMemory.updatedAt = appTimestamp()
  writeJsonFileSafe(worldMemoryFile(), worldMemory)
}

function defaultKnowledgeBase() {
  return {
    movement: {
      version: 1,
      updatedAt: null,
      rules: {
        unstuckTimeoutMs: 12000,
        actionTimeoutMs: 30000,
        actionRestartMs: 60000,
        routeRecalcMs: 18000,
        protectFooting: true,
        preferJumpBeforeDig: true,
        avoidVoid: true,
        preferExistingBridges: true,
        allowSpeedBridge: true,
        allowUpwardBridge: true,
        bridgePlaceCost: 1,
        bridgePlaceDelayMs: 180,
        bridgeSpeedDelayMs: 70,
        bridgeVerifyTimeoutMs: 1400,
        maxBridgeSteps: 64,
        automaticBridgeSteps: 6,
        voidScanDepth: 16
      },
      clearableBlocks: ['bamboo', 'sand', 'red_sand', 'gravel', 'dirt', 'grass_block', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves'],
      unstuckClearableBlocks: ['bamboo', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves'],
      avoidFloorBlocks: ['sand', 'red_sand', 'gravel', 'bamboo', 'cactus', 'water', 'lava', 'chest', 'trapped_chest', 'barrel'],
      buildingBlocks: ['cobblestone', 'stone', 'dirt', 'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks'],
      stats: {
        stuckEvents: 0,
        unstuckAttempts: 0,
        holesEscaped: 0,
        bridgesBuilt: 0,
        bridgeBlocksPlaced: 0,
        existingBridgeSteps: 0,
        upwardBridgeSteps: 0,
        speedBridgeSteps: 0,
        bridgeFailures: 0,
        voidStops: 0
      }
    },
    mining: {
      version: 1,
      updatedAt: null,
      rules: { visibleBlockPriority: true, maxSearchDistance: 64, searchBlockCount: 256 },
      toolUsage: {},
      resources: {
        cobblestone: { blocks: ['stone'], strategy: 'mine visible stone first' },
        oak_log: { blocks: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'], strategy: 'find nearest visible tree' },
        raw_iron: { blocks: ['iron_ore', 'deepslate_iron_ore'], strategy: 'mine visible ore first, then search caves' },
        raw_gold: { blocks: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'], strategy: 'mine visible ore first' },
        diamond: { blocks: ['diamond_ore', 'deepslate_diamond_ore'], strategy: 'mine visible ore first, then explore low caves' },
        emerald: { blocks: ['emerald_ore', 'deepslate_emerald_ore'], strategy: 'mine visible mountain ore' },
        coal: { blocks: ['coal_ore', 'deepslate_coal_ore'], strategy: 'mine visible coal' },
        redstone: { blocks: ['redstone_ore', 'deepslate_redstone_ore'], strategy: 'mine visible redstone' },
        lapis_lazuli: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], strategy: 'mine visible lapis' },
        ancient_debris: { blocks: ['ancient_debris'], strategy: 'search nether low y' }
      },
      stats: { blocksSeen: {}, blocksMined: {}, failedMines: {} }
    },
    combat: {
      version: 1,
      updatedAt: null,
      rules: { hostileRange: 12, meleeRange: 4.2, pvpEnabledByDefault: false },
      strategies: { creeper: 'back away before attacking', skeleton: 'strafe while approaching', default: 'equip best weapon and attack when line of sight is clear' },
      stats: { encounters: {}, blockedHits: 0, finishedFights: 0 }
    },
    items: {
      version: 1,
      updatedAt: null,
      categories: {
        alwaysKeep: ['ender_pearl', 'blaze_rod', 'water_bucket', 'lava_bucket', 'bucket', 'flint_and_steel', 'torch', 'totem_of_undying', 'elytra', 'saddle', 'name_tag', 'enchanted_book', 'experience_bottle'],
        food: ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'baked_potato', 'bread', 'apple', 'carrot', 'golden_carrot'],
        valuables: ['diamond', 'emerald', 'ancient_debris', 'netherite_scrap', 'netherite_ingot', 'gold_ingot', 'iron_ingot', 'copper_ingot', 'lapis_lazuli', 'redstone', 'coal', 'quartz', 'amethyst_shard'],
        resources: ['ore', 'log', 'planks', 'stick', 'string', 'leather', 'feather', 'flint', 'bone', 'gunpowder', 'slime_ball', 'obsidian'],
        tools: ['pickaxe', 'axe', 'shovel', 'hoe', 'shears', 'fishing_rod'],
        weapons: ['sword', 'bow', 'crossbow', 'trident', 'shield', 'arrow'],
        armor: ['helmet', 'chestplate', 'leggings', 'boots'],
        stations: ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'enchanting_table', 'grindstone', 'stonecutter', 'brewing_stand']
      },
      stats: { kept: {}, pickedUp: {} }
    },
    crafting: {
      version: 1,
      updatedAt: null,
      survivalCrafts: [
        { item: 'shield', reason: 'reduces damage from skeletons and melee mobs', priority: 100 },
        { item: 'iron_sword', reason: 'defeats hostile mobs faster', priority: 90 },
        { item: 'iron_pickaxe', reason: 'opens resource gathering and recovery routes', priority: 85 },
        { item: 'boat', reason: 'safe and fast water travel', priority: 60 },
        { item: 'bucket', reason: 'carry water for falls, lava and climbing', priority: 55 }
      ],
      endgamePlans: [
        { item: 'enchanting_table', action: 'find obsidian, diamonds and books for an enchanting_table', reason: 'unlock enchantments' },
        { item: 'lapis_lazuli', action: 'find lapis in caves and ore heatmaps', reason: 'enchantments need lapis' },
        { item: 'obsidian', count: 10, action: 'find lava and water for obsidian', reason: 'prepare Nether portal' },
        { item: 'flint_and_steel', action: 'collect iron and flint', reason: 'activate Nether portal' },
        { item: null, action: 'explore the Nether for fortress signs', reason: 'find blaze rods' },
        { item: 'blaze_rod', action: 'find blaze rods in a known fortress', reason: 'brewing and End route' },
        { item: 'ancient_debris', action: 'find ancient debris at a good Nether height', reason: 'netherite upgrades' },
        { item: 'netherite_sword', action: 'collect templates, scraps and gold for netherite upgrades', reason: 'finish netherite gear' }
      ],
      foodRules: {
        cooked_beef: { score: 10, safe: true }, cooked_porkchop: { score: 10, safe: true }, golden_carrot: { score: 9, safe: true },
        cooked_mutton: { score: 8, safe: true }, cooked_chicken: { score: 7, safe: true }, cooked_salmon: { score: 7, safe: true },
        cooked_rabbit: { score: 7, safe: true }, cooked_cod: { score: 6, safe: true }, bread: { score: 6, safe: true }, baked_potato: { score: 5, safe: true },
        apple: { score: 4, safe: true }, carrot: { score: 3, safe: true }, beef: { score: 3, safe: true }, porkchop: { score: 3, safe: true },
        mutton: { score: 2, safe: true }, rabbit: { score: 2, safe: true }, cod: { score: 2, safe: true }, salmon: { score: 2, safe: true },
        potato: { score: 1, safe: true }, chicken: { score: 1, safe: false }, rotten_flesh: { score: 0, safe: false }, poisonous_potato: { score: 0, safe: false }
      },
      discoveredRecipes: {},
      stats: { crafted: {}, failedCrafts: {} }
    }
  }
}

function mergeKnowledge(defaults, loaded) {
  if (Array.isArray(defaults)) return Array.isArray(loaded) ? loaded : defaults
  if (!defaults || typeof defaults !== 'object') return loaded ?? defaults
  const merged = { ...defaults, ...(loaded && typeof loaded === 'object' ? loaded : {}) }
  for (const key of Object.keys(defaults)) merged[key] = mergeKnowledge(defaults[key], merged[key])
  return merged
}

function loadKnowledgeFile(name, defaults) {
  const file = path.join(knowledgeDir, `${name}.json`)
  try {
    return mergeKnowledge(defaults, JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (err) {
    if (err?.code && err.code !== 'ENOENT') console.log(`Knowledge load warning (${name}):`, err.message)
    return defaults
  }
}

function writeJsonFileSafe(file, value) {
  maybeBackupRuntimeData()
  return writeJsonSafe(file, value)
}

function maybeBackupRuntimeData(force = false) {
  if (!force && Date.now() - lastRuntimeBackupAt < 10 * 60 * 1000) return false
  lastRuntimeBackupAt = Date.now()
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return copyRuntimeData(runtimeRoot, botSettingsFile, path.join(backupsRoot, stamp))
  } catch (err) {
    console.log('Runtime backup warning:', err.message)
    return false
  }
}

function latestRuntimeBackup() {
  if (!fs.existsSync(backupsRoot)) return null
  return fs.readdirSync(backupsRoot)
    .filter(name => fs.statSync(path.join(backupsRoot, name)).isDirectory())
    .sort()
    .pop() || null
}

function resetCurrentWorldMemory() {
  maybeBackupRuntimeData(true)
  try {
    if (fs.existsSync(worldMemoryFile())) fs.unlinkSync(worldMemoryFile())
  } catch (err) {
    throw new Error(`Could not reset world memory: ${err.message}`)
  }
  for (const key of Object.keys(worldMemory)) delete worldMemory[key]
  Object.assign(worldMemory, defaultWorldMemory())
  saveMemory()
  saveWorldMemory()
}

function loadKnowledge() {
  const defaults = defaultKnowledgeBase()
  fs.mkdirSync(knowledgeDir, { recursive: true })
  const loaded = {}
  for (const [name, value] of Object.entries(defaults)) loaded[name] = loadKnowledgeFile(name, value)
  saveKnowledge(loaded)
  return loaded
}

function saveKnowledge(target = knowledge) {
  fs.mkdirSync(knowledgeDir, { recursive: true })
  for (const [name, value] of Object.entries(target)) {
    compactKnowledgeDomain(name, value)
    value.updatedAt = appTimestamp()
    writeJsonFileSafe(path.join(knowledgeDir, `${name}.json`), value)
  }
}

function eliteSwimTowardRoute() {
  if (!eliteMode || !bot.entity || bot.vehicle) return false
  const feet = bot.blockAt(bot.entity.position.floored())
  const head = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))
  if (!isWaterBlock(feet) && !isWaterBlock(head)) return false
  bot.setControlState('sprint', true)
  bot.setControlState('forward', true)
  bot.setControlState('jump', true)
  setCurrentTask('moving', 'swimming efficiently toward route goal')
  return true
}

function trimObjectEntries(store, limit, score) {
  if (!store || typeof store !== 'object') return
  const entries = Object.entries(store)
  if (entries.length <= limit) return
  entries.sort((left, right) => score(right[1]) - score(left[1]))
  for (const [key] of entries.slice(limit)) delete store[key]
}

function compactKnowledgeDomain(name, value) {
  if (name !== 'mining' || !value) return
  for (const entry of Object.values(value.toolUsage || {})) {
    if (entry?.preferredTool !== 'hand' && entry?.preferredTool !== 'shears' &&
      !/^(wooden|golden|stone|iron|diamond|netherite)_(pickaxe|axe|shovel|hoe|sword)$/.test(entry?.preferredTool || '')) {
      entry.preferredTool = 'hand'
    }
  }
  trimObjectEntries(value.oreMemory, 1200, entry => {
    const seen = Date.parse(entry?.seenAt || 0) || 0
    return (entry?.mined ? -1e13 : 0) + seen
  })
  trimObjectEntries(value.oreHeatmap, 800, entry => {
    const seen = Date.parse(entry?.lastSeenAt || 0) || 0
    return seen + (((entry?.sightings || 0) - (entry?.failures || 0)) * 60000)
  })
}

function bumpKnowledgeStat(domain, group, key, amount = 1) {
  const store = knowledge[domain]
  if (!store) return
  store.stats ||= {}
  if (key) {
    store.stats[group] ||= {}
    store.stats[group][key] = (store.stats[group][key] || 0) + amount
  } else {
    store.stats[group] = (store.stats[group] || 0) + amount
  }
  saveKnowledge({ [domain]: store })
}

function recordLearning(domain, category, subject, delta, note = '') {
  const store = knowledge[domain]
  if (!store || !subject) return
  store.learning ||= {}
  store.learning[category] ||= {}
  const entry = store.learning[category][subject] ||= {
    score: 0,
    attempts: 0,
    successes: 0,
    failures: 0,
    notes: []
  }
  // Elite mode records outcomes for diagnostics, but fixed expert rules remain authoritative.
  entry.score = Math.max(-50, Math.min(100, (entry.score || 0) + (eliteMode ? Math.sign(delta) : delta)))
  entry.attempts = (entry.attempts || 0) + 1
  if (delta > 0) entry.successes = (entry.successes || 0) + 1
  if (delta < 0) entry.failures = (entry.failures || 0) + 1
  if (note) {
    entry.notes ||= []
    entry.notes.unshift({ at: appTimestamp(), note })
    entry.notes = entry.notes.slice(0, 8)
  }
  entry.updatedAt = appTimestamp()
  saveKnowledge({ [domain]: store })
}

function learnedScore(domain, category, subject) {
  return knowledge[domain]?.learning?.[category]?.[subject]?.score || 0
}

function knowledgeSummary() {
  const topEntries = (domain, category, limit = 6) => Object.entries(knowledge[domain]?.learning?.[category] || {})
    .sort(([, left], [, right]) => (right.score || 0) - (left.score || 0))
    .slice(0, limit)
    .map(([name, info]) => ({ name, ...info }))

  return {
    mining: {
      learnedBlocks: topEntries('mining', 'blocks'),
      toolUsage: Object.entries(knowledge.mining.toolUsage || {})
        .sort(([, left], [, right]) => (right.uses || 0) - (left.uses || 0))
        .slice(0, 10)
        .map(([block, info]) => ({ block, ...info })),
      hotChunks: Object.values(knowledge.mining.oreHeatmap || {})
        .sort((left, right) => ((right.sightings || 0) - (right.failures || 0)) - ((left.sightings || 0) - (left.failures || 0)))
        .slice(0, 6),
      stats: knowledge.mining.stats || {}
    },
    crafting: {
      learnedItems: topEntries('crafting', 'items'),
      discoveredRecipes: knowledge.crafting.discoveredRecipes || {},
      stats: knowledge.crafting.stats || {}
    },
    combat: {
      learnedMobs: topEntries('combat', 'mobs'),
      learnedTactics: topEntries('combat', 'tactics'),
      learnedWeapons: topEntries('combat', 'weapons'),
      learnedArmor: topEntries('combat', 'armor'),
      stats: knowledge.combat.stats || {}
    },
    movement: {
      learnedRecovery: topEntries('movement', 'recovery'),
      stats: knowledge.movement.stats || {}
    }
  }
}

function loadRecipeBook() {
  try {
    return JSON.parse(fs.readFileSync(recipesFile, 'utf8'))
  } catch {
    return { version: null, updatedAt: null, recipes: [] }
  }
}

function saveRecipeBook() {
  writeJsonFileSafe(recipesFile, recipeBook)
}

function saveDiscoveredRecipes() {
  knowledge.crafting.discoveredRecipes = discoveredRecipes
  saveKnowledge({ crafting: knowledge.crafting })
}

function discoverRecipe(item) {
  if (!item || discoveredRecipes[item]) return
  discoveredRecipes[item] = {
    discoveredAt: appTimestamp()
  }
  saveDiscoveredRecipes()
}

function forgetDiscoveredRecipe(item) {
  if (!item || !discoveredRecipes[item]) return false
  delete discoveredRecipes[item]
  saveDiscoveredRecipes()
  return true
}


function saveMemory() {
  memory.skills = skills
  memory.utilities ||= {}
  memory.autonomy = autonomy
  memory.planner = state.planner
  writeJsonFileSafe(memoryFile, memory)
}



function positionData(position = bot.entity?.position) {
  if (!position) return null
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
}

function memoryPosition(position = bot.entity?.position) {
  if (!position) return null
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
    at: appTimestamp(),
    dimension: currentDimension()
  }
}

function locationDistance(left, right) {
  if (!left || !right) return Infinity
  if (left.dimension && right.dimension && left.dimension !== right.dimension) return Infinity
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
}

function currentDimension() {
  return String(bot.game?.dimension || bot.game?.dimensionName || 'unknown')
}

function rememberWorldLocation(type, position = bot.entity?.position, extra = {}, save = true) {
  const location = memoryPosition(position)
  if (!location || !worldMemory[type]) return false
  const existing = worldMemory[type].find(entry => locationDistance(entry, location) < 24)
  if (existing) {
    Object.assign(existing, extra, { lastSeenAt: location.at })
  } else {
    worldMemory[type].push({ ...location, ...extra })
  }
  if (save) saveWorldMemory()
  return true
}

function setHome() {
  const home = memoryPosition()
  if (!home) return bot.chat('I do not know my position yet.')
  worldMemory.home = home
  rememberWorldLocation('bases', bot.entity.position, { source: 'manual_home' })
  saveWorldMemory()
  bot.chat(`Home saved for this world at ${home.x} ${home.y} ${home.z}.`)
}

function rememberCurrentPlace(type, label) {
  if (!rememberWorldLocation(type)) return bot.chat('I do not know my position yet.')
  bot.chat(`${label} saved for this world.`)
}

async function goHome() {
  if (!worldMemory.home) return bot.chat('No home saved for this world yet. Use ai set home.')
  state.mode = 'travel'
  setCurrentTask('moving', 'returning home', { position: `${worldMemory.home.x} ${worldMemory.home.y} ${worldMemory.home.z}` })
  await safeGoto(new goals.GoalNear(worldMemory.home.x, worldMemory.home.y, worldMemory.home.z, 2), 'returning home')
}

function summarizeWorldMemory() {
  const parts = [
    `world ${worldMemory.id}`,
    `home ${worldMemory.home ? `${worldMemory.home.x} ${worldMemory.home.y} ${worldMemory.home.z}` : 'not set'}`,
    `villages ${worldMemory.villages.length}`,
    `mines ${worldMemory.mines.length}`,
    `caves ${worldMemory.caves.length}`,
    `storage ${worldMemory.storage.length}`,
    `danger ${worldMemory.dangerZones.length}`
  ]
  bot.chat(parts.join(' | '))
}

function distance2d(left, right) {
  return Math.hypot(left.x - right.x, left.z - right.z)
}



function chunkKey(position) {
  return `${Math.floor(position.x / 16)},${Math.floor(position.z / 16)}`
}

function blockIds(names) {
  return names.map(name => mcData.blocksByName[name]?.id).filter(id => id !== undefined)
}



saveMemory()



function addSkill(name, amount = 1) {
  skills[name] = (skills[name] || 0) + amount
  saveMemory()
}

















function hasItem(name, count = 1) {
  return bot.inventory.items().filter(i => i.name === name).reduce((total, i) => total + i.count, 0) >= count
}

function toolParts(name) {
  const match = String(name || '').match(/^(wooden|golden|stone|iron|diamond|netherite)_(pickaxe|axe|shovel|hoe|sword)$/)
  return match ? { material: match[1], family: match[2], tier: TOOL_MATERIAL_TIERS[match[1]] || 0 } : null
}

function bestOwnedTool(family) {
  return bot.inventory.items()
    .map(item => ({ item, parts: toolParts(item.name), durability: durabilityInfo(item) }))
    .filter(entry => entry.parts?.family === family)
    .sort((left, right) => {
      const leftUsable = !left.durability || left.durability.ratio > 0.08 ? 1 : 0
      const rightUsable = !right.durability || right.durability.ratio > 0.08 ? 1 : 0
      return rightUsable - leftUsable || right.parts.tier - left.parts.tier || (right.durability?.ratio || 0) - (left.durability?.ratio || 0)
    })[0]?.item || null
}

function ownedToolSatisfies(name) {
  const wanted = toolParts(name)
  if (!wanted) return false
  const owned = bestOwnedTool(wanted.family)
  return Boolean(owned && toolParts(owned.name).tier >= wanted.tier)
}

function rememberBlockTool(block, toolItem) {
  if (!block?.name) return
  knowledge.mining.toolUsage ||= {}
  const validTool = Boolean(toolParts(toolItem?.name) || toolItem?.name === 'shears')
  const toolName = validTool ? toolItem.name : 'hand'
  const entry = knowledge.mining.toolUsage[block.name] ||= { preferredTool: toolName, uses: 0, lastUsedAt: null }
  const current = toolParts(entry.preferredTool)
  const next = toolParts(toolName)
  if (!current || !next || next.family !== current.family || next.tier >= current.tier) entry.preferredTool = toolName
  entry.uses = (entry.uses || 0) + 1
  entry.lastUsedAt = appTimestamp()
}

function itemCount(name) {
  return bot.inventory.items().filter(i => itemMatches(name, i.name)).reduce((total, item) => total + item.count, 0)
}

function itemMatches(wanted, actual) {
  if (wanted === 'oak_log') return actual.endsWith('_log')
  return wanted === actual
}

function setCurrentTask(action, detail, extra = {}) {
  const now = Date.now()
  const key = `${action}:${detail}:${extra.target || ''}:${extra.position || ''}`
  state.currentTask = {
    action,
    detail,
    target: extra.target || null,
    position: extra.position || null,
    mode: state.mode,
    id: taskController.active?.id || null,
    source: taskController.active?.source || null,
    updatedAt: appTimestamp(now)
  }
  if (key === state.lastTaskKey && now - state.lastTaskAt < 2500) return
  state.lastTaskKey = key
  state.lastTaskAt = now
  state.taskLog.unshift(state.currentTask)
  state.taskLog = state.taskLog.slice(0, 30)
}

function coordinationFile() {
  return path.join(coordinationRoot, `${safeName(bot.username || minecraftUsername, 'bot')}.json`)
}

function coordinationPosition(value) {
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y)) || !Number.isFinite(Number(value.z))) return null
  return new Vec3(Number(value.x), Number(value.y), Number(value.z))
}

function reserveCoordinationPosition(position, action, ttlMs = 12000) {
  if (!position) return false
  if (peerClaimsPosition(position, 2.5)) return false
  state.coordinationReservation = {
    action,
    position: positionData(position),
    until: Date.now() + ttlMs
  }
  publishCoordinationPresence(true)
  return true
}

function visibleBotPeers() {
  return Object.values(bot.entities || {}).filter(entity =>
    entity?.type === 'player' &&
    entity !== bot.entity &&
    /^bot\d+$/i.test(entity.username || '') &&
    entity.position)
}

function coordinationScore(username, position) {
  const text = `${username}:${position.x},${position.y},${position.z}`
  let hash = 2166136261
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

function ownsNearbyCoordinationTarget(position, radius = 8) {
  if (!position) return true
  const candidates = [
    { username: bot.username, position: bot.entity?.position },
    ...visibleBotPeers()
  ].filter(peer => peer.position?.distanceTo(position) <= radius)
  if (candidates.length < 2) return true
  candidates.sort((left, right) => coordinationScore(left.username, position) - coordinationScore(right.username, position))
  return candidates[0].username === bot.username
}

function peerClaimsPosition(position, radius = 3) {
  if (!position) return false
  if (!ownsNearbyCoordinationTarget(position)) return true
  return state.peerBots.some(peer => {
    if (peer.dimension !== currentDimension()) return false
    const reserved = coordinationPosition(peer.reservation?.position)
    return reserved && Number(peer.reservation?.until || 0) > Date.now() && reserved.distanceTo(position) <= radius
  })
}

function nearbyPeerCount(radius = 6) {
  if (!bot.entity) return 0
  const sharedPeers = state.peerBots.filter(peer => peer.dimension === currentDimension() &&
    coordinationPosition(peer.position)?.distanceTo(bot.entity.position) <= radius).length
  return Math.max(sharedPeers, visibleBotPeers().filter(peer => peer.position.distanceTo(bot.entity.position) <= radius).length)
}

function refreshCoordinationPeers() {
  fs.mkdirSync(coordinationRoot, { recursive: true })
  const now = Date.now()
  const own = coordinationFile().toLowerCase()
  const peers = []
  for (const name of fs.readdirSync(coordinationRoot)) {
    const file = path.join(coordinationRoot, name)
    if (name.endsWith('.tmp')) {
      try { if (now - fs.statSync(file).mtimeMs > 30000) fs.unlinkSync(file) } catch {}
      continue
    }
    if (!name.endsWith('.json') || file.toLowerCase() === own) continue
    try {
      const peer = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (now - Number(peer.updatedAt || 0) > 15000) {
        try { fs.unlinkSync(file) } catch {}
        continue
      }
      peers.push(peer)
    } catch {}
  }
  state.peerBots = peers
}

function publishCoordinationPresence(force = false) {
  if (!bot.entity || (!force && Date.now() - state.lastCoordinationWriteAt < 1500)) return
  state.lastCoordinationWriteAt = Date.now()
  if (state.coordinationReservation?.until <= Date.now()) state.coordinationReservation = null
  const presence = {
    username: bot.username,
    dimension: currentDimension(),
    position: positionData(bot.entity.position),
    mode: state.mode,
    task: state.currentTask,
    reservation: state.coordinationReservation,
    updatedAt: Date.now()
  }
  fs.mkdirSync(coordinationRoot, { recursive: true })
  try { writeJsonSafe(coordinationFile(), presence) } catch {}
}

function spreadTargetFromPeers(distance = 28) {
  if (!bot.entity) return null
  const nearby = state.peerBots
    .filter(peer => peer.dimension === currentDimension())
    .map(peer => coordinationPosition(peer.position))
    .filter(position => position && position.distanceTo(bot.entity.position) < 12)
  for (const peer of visibleBotPeers()) {
    if (peer.position.distanceTo(bot.entity.position) < 12) nearby.push(peer.position)
  }
  if (!nearby.length) return null
  const away = nearby.reduce((vector, position) => vector.plus(bot.entity.position.minus(position)), new Vec3(0, 0, 0))
  if (away.x === 0 && away.z === 0) {
    const angle = (String(bot.username || '').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360) * Math.PI / 180
    away.x = Math.cos(angle)
    away.z = Math.sin(angle)
  }
  const length = Math.max(0.01, Math.hypot(away.x, away.z))
  return {
    x: Math.floor(bot.entity.position.x + (away.x / length) * distance),
    y: Math.floor(bot.entity.position.y),
    z: Math.floor(bot.entity.position.z + (away.z / length) * distance)
  }
}

function blockPositionText(block) {
  if (!block?.position) return null
  return `${block.position.x} ${block.position.y} ${block.position.z}`
}

function rememberOreSight(block, itemName = null) {
  if (!block?.position || !bot.entity) return
  knowledge.mining.oreMemory ||= {}
  knowledge.mining.oreHeatmap ||= {}
  const key = `${block.name}:${block.position.x},${block.position.y},${block.position.z}`
  const now = Date.now()
  const existing = knowledge.mining.oreMemory[key]
  const lastSeen = existing?.seenAt ? new Date(existing.seenAt).getTime() : 0
  const freshSight = !Number.isFinite(lastSeen) || now - lastSeen > 30000
  knowledge.mining.oreMemory[key] = {
    block: block.name,
    item: itemName,
    position: positionData(block.position),
    chunk: chunkKey(block.position),
    seenAt: appTimestamp(now),
    mined: existing?.mined || false
  }
  const heatKey = `${itemName || block.name}:${chunkKey(block.position)}`
  const heat = knowledge.mining.oreHeatmap[heatKey] ||= {
    item: itemName || block.name,
    chunk: chunkKey(block.position),
    sightings: 0,
    mined: 0,
    failures: 0,
    lastSeenAt: null
  }
  if (freshSight) heat.sightings++
  heat.lastSeenAt = appTimestamp(now)
}

function rememberOreMined(block, itemName = null) {
  if (!block?.position) return
  knowledge.mining.oreMemory ||= {}
  knowledge.mining.oreHeatmap ||= {}
  const key = `${block.name}:${block.position.x},${block.position.y},${block.position.z}`
  if (knowledge.mining.oreMemory[key]) knowledge.mining.oreMemory[key].mined = true
  const heatKey = `${itemName || block.name}:${chunkKey(block.position)}`
  const heat = knowledge.mining.oreHeatmap[heatKey]
  if (heat) heat.mined++
  saveKnowledge({ mining: knowledge.mining })
}

function bestKnownResourceChunk(itemName) {
  const entries = Object.values(knowledge.mining.oreHeatmap || {})
    .filter(entry => entry.item === itemName && (entry.sightings || 0) > (entry.mined || 0))
    .sort((left, right) => ((right.sightings || 0) - (right.failures || 0)) - ((left.sightings || 0) - (left.failures || 0)))
  const best = entries[0]
  if (!best) return null
  const [cx, cz] = String(best.chunk).split(',').map(Number)
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) return null
  return { x: cx * 16 + 8, z: cz * 16 + 8 }
}

function isHazardNear(position = bot.entity?.position, radius = 2) {
  if (!position) return false
  const base = position.floored()
  for (let x = -radius; x <= radius; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -radius; z <= radius; z++) {
        const block = bot.blockAt(base.offset(x, y, z))
        if (['lava', 'fire', 'magma_block', 'cactus', 'powder_snow'].includes(block?.name)) return true
      }
    }
  }
  return false
}

function miningSafetyScore(block) {
  if (!block?.position) return 0
  let score = 0
  const below = bot.blockAt(block.position.offset(0, -1, 0))
  const feet = bot.entity?.position?.floored()
  if (below?.name === 'lava') score -= 40
  if (below?.boundingBox === 'empty') score -= 10
  if (feet && block.position.y < feet.y - 2) score -= 8
  if (isHazardNear(block.position, 1)) score -= 25
  return score
}

function miningHazards(block) {
  if (!block?.position) return ['unknown target']
  const hazards = []
  const dangerous = new Set(['lava', 'fire', 'magma_block', 'cactus', 'powder_snow'])
  for (const offset of [
    new Vec3(0, -1, 0), new Vec3(0, 1, 0),
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1)
  ]) {
    const nearby = bot.blockAt(block.position.plus(offset))
    if (dangerous.has(nearby?.name)) hazards.push(nearby.name)
  }
  const above = bot.blockAt(block.position.offset(0, 1, 0))
  if (['sand', 'red_sand', 'gravel', 'anvil'].some(name => above?.name?.includes(name))) hazards.push(`falling ${above.name}`)
  const belowBot = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
  if (belowBot?.position?.equals(block.position)) hazards.push('current footing')
  const feet = bot.entity.position.floored()
  const belowTarget = bot.blockAt(block.position.offset(0, -1, 0))
  const twoBelowTarget = bot.blockAt(block.position.offset(0, -2, 0))
  if (belowTarget?.boundingBox === 'empty' && twoBelowTarget?.boundingBox === 'empty') hazards.push('drop below target')
  const lightLevel = Math.max(Number(block.light || 0), Number(block.skyLight || 0))
  if (lightLevel <= 1 && !hasItem('torch')) hazards.push('insufficient light')
  return [...new Set(hazards)]
}

function safetyBuildingItem() {
  const names = bestOwnedTool('pickaxe')
    ? ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone']
    : ['dirt', 'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks']
  return names.map(name => bot.inventory.items().find(item => item.name === name)).find(Boolean) || null
}

function wouldSealLastSideExit(position) {
  if (!bot.entity || !position) return false
  const base = bot.entity.position.floored()
  const sides = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1)
  ]
  const affectedSide = sides.find(side => position.equals(base.plus(side)) || position.equals(base.plus(side).offset(0, 1, 0)))
  if (!affectedSide) return false
  const openSides = sides.filter(side => {
    const feet = bot.blockAt(base.plus(side))
    const head = bot.blockAt(base.plus(side).offset(0, 1, 0))
    return feet?.boundingBox === 'empty' && head?.boundingBox === 'empty'
  })
  return openSides.length <= 1 && openSides.some(side => side.equals(affectedSide))
}

async function placeSafetyBlockAt(position, item = safetyBuildingItem()) {
  if (!position || !item) return false
  if (bot.blockAt(position)?.boundingBox === 'block') return true
  if (blockFailureCoolingDown(state.safetyBlockFailures, position, 30000)) return false
  if (!reserveCoordinationPosition(position, 'safety_block', 12000)) return false
  const base = bot.entity?.position?.floored()
  if (base && (position.equals(base) || position.equals(base.offset(0, 1, 0)))) return false
  if (wouldSealLastSideExit(position)) return false
  let lastError = null
  let attempts = 0
  for (const face of [
    new Vec3(0, -1, 0), new Vec3(0, 1, 0),
    new Vec3(-1, 0, 0), new Vec3(1, 0, 0),
    new Vec3(0, 0, -1), new Vec3(0, 0, 1)
  ]) {
    const reference = bot.blockAt(position.minus(face))
    if (!reference || reference.boundingBox === 'empty' || ['lava', 'water'].includes(reference.name)) continue
    if (++attempts > 2) break
    try {
      if (!await equipAndConfirmHeldItem(item)) break
      await bot.placeBlock(reference, face)
      if (await waitForPlacedBlock(position, 900)) {
        delete state.safetyBlockFailures[blockFailureKey(position)]
        return true
      }
    } catch (err) {
      lastError = err
    }
  }
  rememberBlockFailure(state.safetyBlockFailures, position)
  if (lastError && !/blockUpdate:.*did not fire|block not in view/i.test(lastError?.message || '')) {
    logActionError(`Could not place safety block at ${position.x} ${position.y} ${position.z}`, lastError)
  }
  return false
}

async function eliteHitmanCombatRecovery(target, taskToken) {
  if (bot.health >= 7 || taskWasCancelled(taskToken)) return false
  const food = bot.inventory.items()
    .filter(item => isFood(item.name))
    .sort((left, right) => foodScore(right.name) - foodScore(left.name))[0]
  if (!food || bot.food >= 20) return false
  setCurrentTask('hitman', `briefly healing while maintaining pursuit of ${state.hitmanTask?.actualName || target?.username || 'target'}`, {
    target: state.hitmanTask?.actualName || target?.username || null
  })
  try {
    bot.pvp.stop()
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    await timedShieldBlock(450)
    if (taskWasCancelled(taskToken)) return false
    await bot.equip(food, 'hand')
    await bot.consume()
    return true
  } catch (err) {
    if (!/food is full|consuming cancelled/i.test(err?.message || '')) logActionError('Hitman combat recovery failed', err)
    return false
  }
}

async function runEliteHitmanPursuit(target, task, taskToken) {
  if (!target?.position || !bot.entity || canHitEntity(target)) return false
  const delta = target.position.minus(bot.entity.position)
  const horizontal = Math.hypot(delta.x, delta.z)
  const distance = target.position.distanceTo(bot.entity.position)

  if (delta.y > 2.2 && horizontal < 7) {
    setCurrentTask('hitman', `building up to ${task.actualName}`, { target: task.actualName })
    if (await buildUpOneBlock()) return true
    const direction = bridgeDirectionToward(target.position)
    const result = await bridgeForward(Math.min(3, Math.ceil(delta.y)), 'up', direction)
    if (state.hitmanTask) state.mode = 'hitman'
    if (result.steps > 0) return true
  }

  if (delta.y < -2.2 && horizontal < 6) {
    setCurrentTask('hitman', `digging down toward ${task.actualName}`, { target: task.actualName })
    const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
    if (below?.boundingBox === 'block' && !['bedrock', 'lava'].includes(below.name) && await digNearbyVisibleBlock(below, 'digging down during hitman pursuit')) return true
  }

  const direction = bridgeDirectionToward(target.position)
  const feet = bot.entity.position.floored()
  const nextFeet = feet.plus(direction)
  if (horizontal > 2 && hasBridgeClearance(nextFeet) && !canUseAsPlacementFloor(bot.blockAt(nextFeet.offset(0, -1, 0)))) {
    setCurrentTask('hitman', `speed bridging toward ${task.actualName}`, { target: task.actualName })
    const result = await bridgeForward(Math.min(6, Math.max(1, Math.floor(horizontal))), 'speed', direction)
    if (state.hitmanTask) state.mode = 'hitman'
    if (result.steps > 0) return true
  }

  const obstruction = hitmanWallBlockToward(target.position)
  if (obstruction) {
    setCurrentTask('hitman', `digging through ${obstruction.name} toward ${task.actualName}`, { target: task.actualName })
    if (await digNearbyVisibleBlock(obstruction, 'digging through wall during hitman pursuit')) return true
  }

  if (distance > 4 && distance < 18 && Math.abs(delta.y) < 2.2 && directHitmanLaneClear(direction)) {
    setCurrentTask('hitman', `sprint jumping toward ${task.actualName}`, { target: task.actualName })
    await bot.lookAt(target.position.offset(0, 1, 0), true)
    bot.setControlState('sprint', true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    await sleep(450)
    bot.clearControlStates()
    return !taskWasCancelled(taskToken)
  }
  if (distance > 3.2) {
    setCurrentTask('hitman', `relentlessly following ${task.actualName}`, {
      target: task.actualName,
      position: `${target.position.x.toFixed(1)} ${target.position.y.toFixed(1)} ${target.position.z.toFixed(1)}`
    })
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
    return true
  }
  return false
}

function hitmanWallBlockToward(targetPosition) {
  if (!bot.entity || !targetPosition) return null
  const eye = bot.entity.position.offset(0, 1.45, 0)
  const delta = targetPosition.offset(0, 1, 0).minus(eye)
  const block = bot.world.raycast(eye, delta.normalize(), Math.min(4.5, delta.norm()))
  if (!block || block.boundingBox === 'empty' || ['bedrock', 'barrier', 'end_portal_frame'].includes(block.name)) return null
  return block
}

function directHitmanLaneClear(direction) {
  if (!bot.entity) return false
  const base = bot.entity.position.floored().plus(direction)
  return bot.blockAt(base)?.boundingBox === 'empty' &&
    bot.blockAt(base.offset(0, 1, 0))?.boundingBox === 'empty' &&
    canUseAsPlacementFloor(bot.blockAt(base.offset(0, -1, 0)))
}

async function eliteHitmanBreakFree(target, taskToken) {
  if (taskWasCancelled(taskToken)) return false
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  if (await clearImmediateObstacles()) return true
  if (target?.position?.y > bot.entity.position.y + 1 && await buildUpOneBlock()) return true
  if (await climbOutIfInHole()) return true
  return runEliteHitmanPursuit(target, state.hitmanTask, taskToken)
}

async function eliteHitmanFollowPortal(task, taskToken) {
  if (!bot.entity || Date.now() - Number(task.lastSeenAt || 0) > 15000) return false
  if (Date.now() - Number(task.lastPortalAttemptAt || 0) < 8000) return false
  const portalPosition = nearbyBlocks(['nether_portal', 'end_portal'], 24, 8)
    .sort((left, right) => left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position))[0]
  if (!portalPosition) return false
  task.lastPortalAttemptAt = Date.now()
  setCurrentTask('hitman', `following ${task.actualName} through a portal`, { target: task.actualName })
  const reached = await safeGoto(new goals.GoalBlock(portalPosition.x, portalPosition.y, portalPosition.z), 'hitman portal pursuit', false)
  if (taskWasCancelled(taskToken)) return false
  if (reached) {
    bot.setControlState('forward', true)
    await sleep(1200)
    bot.clearControlStates()
  }
  return reached
}

async function eliteHitmanClutch() {
  if (!eliteMode || state.hitmanClutching || state.hardStopped || !bot.entity) return false
  if (Date.now() - state.lastEliteClutchAt < 1200) return false
  const falling = !bot.entity.onGround && Number(bot.entity.velocity?.y || 0) < -0.45
  const feet = bot.entity.position.floored()
  const inLava = bot.blockAt(feet)?.name === 'lava' || bot.blockAt(feet.offset(0, -1, 0))?.name === 'lava'
  if (!falling && !inLava) return false
  state.hitmanClutching = true
  state.lastEliteClutchAt = Date.now()
  try {
    const waterBucket = bot.inventory.items().find(item => item.name === 'water_bucket')
    if (falling && !inLava && waterBucket && !currentDimension().includes('nether')) {
      const landing = [feet.offset(0, -2, 0), feet.offset(0, -3, 0), feet.offset(0, -4, 0), feet.offset(0, -5, 0)]
        .map(position => bot.blockAt(position))
        .find(block => block?.boundingBox === 'block')
      if (landing) {
        await bot.equip(waterBucket, 'hand')
        await bot.lookAt(landing.position.offset(0.5, 1, 0.5), true)
        bot.activateItem()
        setCurrentTask('survival', 'water clutch attempt')
        return true
      }
    }
    const targets = [feet.offset(0, -1, 0), feet.offset(0, -2, 0), feet.offset(0, -3, 0)]
    for (const target of targets) {
      if (await placeBridgeBlock(target)) {
        setCurrentTask('survival', inLava ? 'lava escape block clutch' : 'fall-saving block clutch')
        return true
      }
    }
    if (!inLava && findBoatItem()) {
      const landing = targets.map(position => bot.blockAt(position)).find(block => block?.boundingBox === 'block')
      if (landing) {
        await bot.equip(findBoatItem(), 'hand')
        await bot.lookAt(landing.position.offset(0.5, 1, 0.5), true)
        bot.activateItem()
        setCurrentTask('survival', 'boat clutch attempt')
        return true
      }
    }
  } catch (err) {
    if (!expectedPathError(err)) logActionError('Elite hitman clutch failed', err)
  } finally {
    state.hitmanClutching = false
  }
  return false
}

async function makeMiningTargetSafe(block) {
  const taskToken = taskController.active
  const hazards = miningHazards(block)
  if (!hazards.length) return true
  setCurrentTask('mining_safety', `making ${block.name} safe`, { target: hazards.join(', '), position: blockPositionText(block) })
  for (const offset of [
    new Vec3(0, -1, 0), new Vec3(0, 1, 0),
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1)
  ]) {
    if (taskToken && !taskController.isActive(taskToken)) return false
    const nearby = bot.blockAt(block.position.plus(offset))
    if (nearby?.name === 'lava') await placeSafetyBlockAt(nearby.position)
  }
  let above = bot.blockAt(block.position.offset(0, 1, 0))
  if (['sand', 'red_sand', 'gravel'].includes(above?.name)) {
    const column = []
    while (above && ['sand', 'red_sand', 'gravel'].includes(above.name) && column.length < 16) {
      column.push(above)
      above = bot.blockAt(above.position.offset(0, 1, 0))
    }
    for (const falling of column.reverse()) {
      if (taskWasCancelled(taskToken) || falling.position.distanceTo(bot.entity.position) > 5 || !bot.canSeeBlock(falling)) return false
      try {
        await bot.dig(falling, 'raycast', 'raycast')
      } catch (err) {
        console.log(`Mining safety could not clear ${falling.name}:`, err.message)
        return false
      }
    }
  }
  const belowTarget = bot.blockAt(block.position.offset(0, -1, 0))
  if (belowTarget?.boundingBox === 'empty') await placeSafetyBlockAt(belowTarget.position)
  if (hazards.includes('insufficient light')) {
    if (!hasItem('torch') && hasItem('coal') && hasItem('stick')) await craftItem('torch')
    if (taskWasCancelled(taskToken)) return false
    const torch = bot.inventory.items().find(item => item.name === 'torch')
    const empty = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
      .map(offset => bot.blockAt(block.position.plus(offset)))
      .find(candidate => candidate?.boundingBox === 'empty')
    if (torch && empty) await placeSafetyBlockAt(empty.position, torch)
  }
  return miningHazards(block).length === 0
}

function durabilityInfo(item) {
  const max = mcData?.itemsByName?.[item?.name]?.maxDurability
  if (!item || !max) return null
  const used = Number(item.durabilityUsed || 0)
  return { max, used, remaining: Math.max(0, max - used), ratio: Math.max(0, (max - used) / max) }
}

async function preferDurableEquippedTool() {
  const held = bot.heldItem
  const heldDurability = durabilityInfo(held)
  if (!heldDurability || heldDurability.ratio > 0.08) return
  const family = held.name.replace(/^(wooden|golden|stone|iron|diamond|netherite)_/, '')
  const alternative = bot.inventory.items()
    .filter(item => item.name.endsWith(`_${family}`) && item.slot !== held.slot)
    .map(item => ({ item, durability: durabilityInfo(item) }))
    .filter(entry => !entry.durability || entry.durability.ratio > 0.2)
    .sort((left, right) => (right.durability?.ratio ?? 1) - (left.durability?.ratio ?? 1))[0]?.item
  if (alternative) await bot.equip(alternative, 'hand')
}

function shouldPreserveHeldTool() {
  const held = bot.heldItem
  const durability = durabilityInfo(held)
  return Boolean(durability && durability.ratio <= 0.08 && /^(diamond|netherite)_/.test(held.name))
}

function itemHasMending(item) {
  const enchants = item?.enchants || item?.nbt?.value?.Enchantments?.value?.value || []
  return JSON.stringify(enchants).toLowerCase().includes('mending')
}

function planToolRepair(item) {
  const durability = durabilityInfo(item)
  if (!item || !durability) return
  const parts = toolParts(item.name)
  state.repairTask = {
    item: item.name,
    durability: `${durability.remaining}/${durability.max}`,
    method: itemHasMending(item) ? 'gain XP while holding tool' : hasItem('anvil') || worldMemory.utilities?.anvil ? 'repair at anvil' : parts ? `prepare reserve ${parts.family}` : 'preserve item',
    updatedAt: appTimestamp()
  }
  setCurrentTask('repair', `preserving ${item.name}`, { target: state.repairTask.method })
}

async function serviceToolRepair() {
  if (!state.repairTask) return false
  const item = bot.inventory.items().find(entry => entry.name === state.repairTask.item)
  const durability = durabilityInfo(item)
  if (!item || !durability || durability.ratio > 0.2) {
    state.repairTask = null
    return false
  }
  const parts = toolParts(item.name)
  const reserve = parts && bot.inventory.items().find(entry => entry.slot !== item.slot && toolParts(entry.name)?.family === parts.family && (durabilityInfo(entry)?.ratio ?? 1) > 0.2)
  if (reserve) {
    const taskToken = taskController.active
    const anvilBlock = await findRememberedUtility('anvil')
    if (taskWasCancelled(taskToken)) return false
    if (anvilBlock && bot.experience.level > 0 && reserve.name === item.name) {
      try {
        const anvil = await bot.openAnvil(anvilBlock)
        if (taskWasCancelled(taskToken)) {
          anvil.close()
          return false
        }
        await anvil.combine(item, reserve)
        state.repairTask = null
        recordLearning('mining', 'tools', item.name, 3, 'repaired at anvil')
        return true
      } catch (err) {
        logActionError(`Could not repair ${item.name} at anvil`, err)
      }
    }
    await bot.equip(reserve, 'hand')
    state.repairTask.method = `using reserve ${reserve.name}`
    return true
  }
  if (itemHasMending(item)) {
    const taskToken = taskController.active
    const orb = bot.nearestEntity(entity => entity.name === 'experience_orb')
    if (!orb || orb.position.distanceTo(bot.entity.position) > 24) return false
    await bot.equip(item, 'hand')
    if (taskWasCancelled(taskToken)) return false
    setCurrentTask('repair', `repairing ${item.name} with Mending XP`, { position: `${orb.position.x.toFixed(1)} ${orb.position.y.toFixed(1)} ${orb.position.z.toFixed(1)}` })
    await safeGoto(new goals.GoalNear(orb.position.x, orb.position.y, orb.position.z, 1), `mending:${item.name}`)
    return true
  }
  if (parts && parts.material !== 'netherite') {
    state.repairTask.method = `crafting reserve ${item.name}`
    return craftWithTable(item.name, true)
  }
  return false
}

function normalizeItemName(name) {
  const aliases = {
    hout: 'oak_log',
    wood: 'oak_log',
    planken: 'oak_planks',
    planks: 'oak_planks',
    steen: 'cobblestone',
    stone: 'cobblestone',
    ijzer: 'raw_iron',
    iron: 'raw_iron',
    iron_ore: 'raw_iron',
    deepslate_iron_ore: 'raw_iron',
    gold_ore: 'raw_gold',
    deepslate_gold_ore: 'raw_gold',
    diamond_ore: 'diamond',
    deepslate_diamond_ore: 'diamond',
    coal_ore: 'coal',
    deepslate_coal_ore: 'coal',
    diamant: 'diamond',
    diamanten: 'diamond',
    diamonds: 'diamond'
  }
  return aliases[name] || name
}

function startGatherTask(message) {
  const match = message.match(/^ai gather ([a-z0-9_]+) (\d+)$/)
  if (!match) return bot.chat('Use: ai gather <item> <amount>, for example ai gather diamond 3')

  const item = normalizeItemName(match[1])
  const amount = Math.max(1, Math.min(2304, Number(match[2])))
  if (!mcData.itemsByName[item] && !mcData.blocksByName[item] && item !== 'cobblestone') {
    return bot.chat(`I don't know how to make ${item}.`)
  }

  state.gatherTask = { item, amount, announcedMissing: false, nextSearchAt: 0, startedAt: Date.now(), method: 'searching' }
  state.mode = 'gather'
  setCurrentTask('searching', `searching for ${amount}x ${item}`, { target: item })
  bot.chat(`I am going to do everything to find ${amount}x ${item}. I have ${itemCount(item)} now.`)
}

async function withdrawWantedItem(itemName, amount) {
  const taskToken = taskController.active
  for (const block of findNearbyContainers(24, itemName)) {
    if (taskWasCancelled(taskToken)) return false
    if (itemCount(itemName) >= amount) return true
    try {
      if (!await safeGoto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), 'opening storage')) continue
      if (taskWasCancelled(taskToken)) return false
      const container = await bot.openContainer(block)
      for (const item of container.containerItems().filter(item => itemMatches(itemName, item.name))) {
        if (taskWasCancelled(taskToken)) {
          container.close()
          return false
        }
        const wanted = amount - itemCount(itemName)
        if (wanted <= 0) break
        try {
          await container.withdraw(item.type, null, Math.min(item.count, wanted))
        } catch (err) {
          logActionError(`Could not withdraw ${item.name}`, err)
        }
      }
      rememberContainerContents(block, container)
      container.close()
    } catch (err) {
      logActionError(`Could not inspect storage for ${itemName}`, err)
    }
  }
  return itemCount(itemName) >= amount
}

async function gatherItemStep(task) {
  const taskToken = taskController.active
  setCurrentTask('searching', `searching for ${task.item}`, { target: task.item })
  if (itemCount(task.item) >= task.amount) {
    setCurrentTask('done', `collected enough ${task.item}`, { target: task.item })
    bot.chat(`Done: I have ${itemCount(task.item)}x ${task.item}.`)
    if (task.returnMode) {
      if (task.returnMode === 'progression') state.progressionGatherTask = null
      state.mode = task.returnMode
    } else {
      state.gatherTask = null
      state.mode = 'idle'
    }
    return true
  }

  if (await withdrawWantedItem(task.item, task.amount)) return false
  if (taskWasCancelled(taskToken)) return false

  const dropped = bot.nearestEntity(e => e.name === 'item' && e.metadata?.[8]?.itemId === mcData.itemsByName[task.item]?.id)
  if (dropped) {
    setCurrentTask('pickup', `picking up dropped ${task.item}`, {
      target: task.item,
      position: `${dropped.position.x.toFixed(1)} ${dropped.position.y.toFixed(1)} ${dropped.position.z.toFixed(1)}`
    })
    await safeGoto(new goals.GoalNear(dropped.position.x, dropped.position.y, dropped.position.z, 1), 'picking up dropped item')
    if (taskWasCancelled(taskToken)) return false
    return false
  }

  const matching = resourceBlockIds(task.item)
  const block = matching && findBestResourceBlock(matching, knowledge.mining.rules?.maxSearchDistance || 64, task.item)
  if (block) {
    setCurrentTask('mining', `mining for ${task.item}`, {
      target: block.name,
      position: blockPositionText(block)
    })
    if (!await mineVisibleBlock(block, `searching:${task.item}`, task.item)) return false
    addSkill(task.item.includes('log') ? 'woodcutting' : 'mining')
    return false
  }

  const recipeItem = mcData.itemsByName[task.item]
  const recipe = recipeItem && bot.recipesFor(recipeItem.id, null, 1, null)[0]
  if (recipe) {
    setCurrentTask('crafting', `crafting ${task.item}`, { target: task.item })
    await bot.craft(recipe, 1, null)
    if (taskWasCancelled(taskToken)) return false
    addSkill('crafting')
    bumpKnowledgeStat('crafting', 'crafted', task.item)
    return false
  }

  if (!task.announcedMissing) {
    bot.chat(`I don't see any ${task.item} within 64 blocks and can't find it in nearby storage. I will continue exploring.`)
    task.announcedMissing = true
  }
  if (!task.nextSearchAt || Date.now() >= task.nextSearchAt) {
    const known = bestKnownResourceChunk(task.item)
    const pos = bot.entity.position
    const x = known ? known.x : Math.floor(pos.x + (Math.random() * 48) - 24)
    const z = known ? known.z : Math.floor(pos.z + (Math.random() * 48) - 24)
    if (known) task.method = 'ore_heatmap'
    setCurrentTask('exploring', `searching for ${task.item}`, {
      target: task.item,
      position: `${x} ${known?.y || Math.floor(pos.y)} ${z}`
    })
    bot.pathfinder.setGoal(new goals.GoalNear(x, known?.y || Math.floor(pos.y), z, 3))
    task.nextSearchAt = Date.now() + 10000
  }
  return false
}

async function gatherForProgression(item, amount) {
  if (!state.progressionGatherTask || state.progressionGatherTask.item !== item || state.progressionGatherTask.amount !== amount) {
    state.progressionGatherTask = { item, amount, announcedMissing: false, nextSearchAt: 0, startedAt: Date.now(), method: 'searching', returnMode: 'progression' }
  }
  updatePlanner('getting stronger', `collect ${amount}x ${item}`, 'prerequisite for the next progression step')
  return gatherItemStep(state.progressionGatherTask)
}





function resourceBlockIds(itemName) {
  const names = knowledge.mining.resources?.[itemName]?.blocks || [itemName]
  const ids = names.map(name => mcData.blocksByName[name]?.id).filter(Boolean)
  return ids.length > 0 ? ids : null
}

function activeResourceTask() {
  if (state.gatherTask && itemCount(state.gatherTask.item) < state.gatherTask.amount) return state.gatherTask
  if (state.progressionGatherTask && itemCount(state.progressionGatherTask.item) < state.progressionGatherTask.amount) return state.progressionGatherTask
  if (state.miningTask?.item && state.miningTask.item !== 'mixed_ores') {
    const amount = state.miningTask.amount || 1
    if (itemCount(state.miningTask.item) < amount) return { item: state.miningTask.item, amount }
  }
  return null
}

function droppedItemName(entity) {
  const itemId = entity?.metadata?.[8]?.itemId
  return itemId === undefined ? null : mcData.items[itemId]?.name || null
}

function shouldPickupUsefulDrop(entity) {
  const name = droppedItemName(entity)
  if (!name) return false
  const item = { name, count: entity.metadata?.[8]?.itemCount || 1 }
  return activeTaskNeeds(item) || keepItem(item)
}

async function pickupNearbyUsefulDrop() {
  // Info: De naam blijft voor backward compatibility; de collector neemt nu ook gewone drops mee.
  if (!bot.entity || state.unstucking || state.recovering) return false
  const result = await itemPickupSystem.collectBatch()
  return result.success
}

// Info: Een team-gatherskill wacht op de echte inventoryhoeveelheid en blijft annuleerbaar door survival.
async function gatherTeamItems(context, fallbackItem) {
  const item = normalizeItemName(context.target?.item || fallbackItem)
  const amount = Math.max(1, Number(context.target?.amount || 1))
  if (itemCount(item) >= amount) return skillResult.success({ item,amount })
  startGatherTask(`ai gather ${item} ${amount}`)
  const startedAt=Date.now()
  while (!context.signal?.aborted && itemCount(item)<amount && Date.now()-startedAt<170000) await sleep(750)
  if (state.gatherTask?.item===item) { state.gatherTask=null;if(state.mode==='gather')state.mode='idle' }
  if (context.signal?.aborted) return skillResult.failure(ErrorCodes.CANCELLED,true,{item,actual:itemCount(item)})
  return itemCount(item)>=amount?skillResult.success({item,amount}):skillResult.failure(ErrorCodes.TARGET_MISSING,true,{item,expected:amount,actual:itemCount(item)})
}

async function mineNearbyNeededResource() {
  const task = activeResourceTask()
  if (!task || state.unstucking || state.recovering) return false
  const matching = resourceBlockIds(task.item)
  if (!matching) return false
  const block = findBestResourceBlock(matching, 12, task.item)
  if (!block || !bot.canSeeBlock(block)) return false
  if (block.position.distanceTo(bot.entity.position) > 5) return false
  setCurrentTask('mining', `mining nearby ${task.item}`, {
    target: block.name,
    position: blockPositionText(block)
  })
  if (await mineVisibleBlock(block, `nearby:${task.item}`, task.item)) {
    addSkill('mining')
    return true
  }
  return false
}



function nearbyBlocks(names, maxDistance = 48, count = 64) {
  const matching = blockIds(names)
  if (!matching.length || !bot.entity) return []
  return bot.findBlocks({ matching, maxDistance, count })
}





function startExploration(reason = 'idle') {
  if (!bot.entity) return
  state.mode = 'explore'
  state.planner = { goal: 'explore world', nextAction: 'scan new chunks', reason }
  setCurrentTask('exploring', 'scanning new chunks', { target: reason })
  chooseExplorationRoute()
  saveMemory()
  recordInfo('Exploring the world and remembering resources, dangers, and visible structures.', 'movement')
}

function nextExplorationTarget() {
  const pos = bot.entity.position
  const spread = spreadTargetFromPeers()
  if (spread) return spread
  return {
    x: Math.floor(pos.x + (Math.random() * 96) - 48),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z + (Math.random() * 96) - 48)
  }
}

function chooseExplorationRoute() {
  if (!bot.entity) return
  const target = nextExplorationTarget()
  state.exploreNextAt = Date.now() + 14000
  bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 4))
  saveMemory()
}

function runExplorationStep() {
  if (!state.exploreNextAt || Date.now() >= state.exploreNextAt) chooseExplorationRoute()
}

async function goNearestMemory(type, label) {
  const entries = worldMemory[type] || []
  if (!entries.length) return bot.chat(`I do not remember a ${label} in this world yet.`)
  const target = entries
    .slice()
    .sort((left, right) => locationDistance(left, bot.entity.position) - locationDistance(right, bot.entity.position))[0]
  state.mode = 'travel'
  setCurrentTask('moving', `returning to ${label}`, { position: `${target.x} ${target.y} ${target.z}` })
  await safeGoto(new goals.GoalNear(target.x, target.y, target.z, 3), `returning to ${label}`)
}

function startFarmMode() {
  const alreadyFarming = state.mode === 'farm'
  state.mode = 'farm'
  state.farmTask ||= {
    nextHarvestAt: 0,
    nextReplantAt: 0,
    nextBreedAt: 0,
    nextSearchAt: 0,
    searches: 0,
    startedAt: Date.now(),
    lastYieldAt: Date.now(),
    harvested: 0,
    bred: 0
  }
  state.planner = { goal: 'food supply', nextAction: 'harvest and replant crops', reason: 'farm command', updatedAt: appTimestamp() }
  setCurrentTask('farming', 'maintaining food supply')
  if (!alreadyFarming) bot.chat('Farm mode enabled. I will harvest mature crops, replant, and breed animals when possible.')
}

function cropSeedName(cropName) {
  return {
    wheat: 'wheat_seeds',
    carrots: 'carrot',
    potatoes: 'potato',
    beetroots: 'beetroot_seeds'
  }[cropName]
}

function isMatureCrop(block) {
  if (!block || !['wheat', 'carrots', 'potatoes', 'beetroots'].includes(block.name)) return false
  const age = Number(block.getProperties?.().age ?? block.metadata)
  const matureAge = block.name === 'beetroots' ? 3 : 7
  return Number.isFinite(age) && age >= matureAge
}

async function harvestNearbyCrops() {
  if (!bot.entity) return false
  const taskToken = taskController.active
  const blocks = nearbyBlocks(['wheat', 'carrots', 'potatoes', 'beetroots'], 32, 96)
    .map(position => bot.blockAt(position))
    .filter(isMatureCrop)
    .sort((left, right) => left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position))
  if (!blocks.length) {
    setCurrentTask('farming', 'searching for mature crops')
    return false
  }
  const block = blocks[0]
  rememberWorldLocation('farms', block.position, { crop: block.name, source: 'crop_seen' })
  setCurrentTask('farming', `harvesting ${block.name}`, { position: blockPositionText(block), target: block.name })
  if (block.position.distanceTo(bot.entity.position) > 4.5 && !await safeGoto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), `harvesting ${block.name}`)) return false
  try {
    await bot.dig(block)
    if (taskWasCancelled(taskToken)) return false
    await pickupNearbyItems()
    if (taskWasCancelled(taskToken)) return false
    await replantAt(block.position, cropSeedName(block.name))
    if (state.farmTask) {
      state.farmTask.harvested = (state.farmTask.harvested || 0) + 1
      state.farmTask.lastYieldAt = Date.now()
    }
    return true
  } catch (err) {
    if (!expectedPathError(err)) console.log('Harvest failed:', err.message)
    return false
  }
}

async function replantAt(position, seedName) {
  if (!seedName || !hasItem(seedName)) return false
  const current = bot.blockAt(position)
  const below = bot.blockAt(position.offset(0, -1, 0))
  if (current?.boundingBox !== 'empty' || below?.name !== 'farmland') return false
  try {
    const seed = bot.inventory.items().find(item => item.name === seedName)
    await bot.equip(seed, 'hand')
    await bot.placeBlock(below, new Vec3(0, 1, 0))
    return true
  } catch {
    return false
  }
}

async function replantNearbyFarmland(announce = true) {
  const taskToken = taskController.active
  const crops = ['wheat', 'carrots', 'potatoes', 'beetroots']
  let planted = false
  for (const position of nearbyBlocks(['farmland'], 24, 80)) {
    if (taskWasCancelled(taskToken)) return false
    const above = position.offset(0, 1, 0)
    if (bot.blockAt(above)?.boundingBox !== 'empty') continue
    const seed = crops.map(cropSeedName).find(name => hasItem(name))
    if (seed && await replantAt(above, seed)) planted = true
  }
  if (announce) bot.chat(planted ? 'Replanted nearby farmland.' : 'I found no empty farmland I can replant.')
  return planted
}

async function breedNearbyAnimals(announce = true) {
  const taskToken = taskController.active
  const rules = [
    { mobs: ['cow', 'sheep'], food: 'wheat' },
    { mobs: ['pig'], food: 'carrot' },
    { mobs: ['chicken'], food: 'wheat_seeds' }
  ]
  for (const rule of rules) {
    if (!hasItem(rule.food, 2)) continue
    const animals = Object.values(bot.entities)
      .filter(entity => rule.mobs.includes(entity.name) && entity.position.distanceTo(bot.entity.position) < 16)
      .sort((left, right) => left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position))
      .slice(0, 2)
    if (animals.length < 2) continue
    const food = bot.inventory.items().find(item => item.name === rule.food)
    const foodBefore = itemCount(rule.food)
    const entityIdsBefore = new Set(Object.keys(bot.entities || {}))
    try {
      await bot.equip(food, 'hand')
      for (const animal of animals) {
        if (taskWasCancelled(taskToken)) return false
        if (animal.position.distanceTo(bot.entity.position) > 4 && !await safeGoto(new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 3), `breeding ${animal.name}`)) continue
        bot.activateEntity(animal)
        rememberWorldLocation('farms', animal.position, { animal: animal.name, source: 'animal_bred' })
        await sleep(400)
      }
      await sleep(1400)
      const newAnimal = Object.entries(bot.entities || {}).some(([id, entity]) =>
        !entityIdsBefore.has(id) && rule.mobs.includes(entity?.name) &&
        entity.position?.distanceTo(bot.entity.position) < 20)
      const confirmed = itemCount(rule.food) <= foodBefore - 2 || newAnimal
      if (confirmed) {
        if (announce) bot.chat(`Bred nearby ${animals[0].name}s.`)
        if (state.farmTask) {
          state.farmTask.bred = (state.farmTask.bred || 0) + 1
          state.farmTask.lastYieldAt = Date.now()
        }
        return true
      }
      if (announce) bot.chat(`The ${animals[0].name}s did not breed yet.`)
    } catch (err) {
      logActionError('Could not breed nearby animals', err)
    }
  }
  if (announce) bot.chat('I do not see breedable animals with the right food nearby.')
  return false
}

function chooseFarmSearchRoute() {
  if (!bot.entity) return false
  const current = memoryPosition()
  const remembered = (worldMemory.farms || [])
    .filter(entry => locationDistance(entry, current) >= 8 && locationDistance(entry, current) < 96)
    .filter(entry => `${entry.dimension}:${entry.x}:${entry.y}:${entry.z}` !== state.farmTask?.lastTargetKey)
    .sort((left, right) => locationDistance(left, current) - locationDistance(right, current))[0]
  const target = remembered || nextExplorationTarget()
  state.exploreNextAt = Date.now() + 14000
  state.farmTask ||= {}
  state.farmTask.nextSearchAt = state.exploreNextAt
  state.farmTask.searches = (state.farmTask.searches || 0) + 1
  state.farmTask.lastTargetKey = remembered ? `${remembered.dimension}:${remembered.x}:${remembered.y}:${remembered.z}` : null
  setCurrentTask('farming', remembered ? 'checking remembered farm' : 'searching for crops and animals', {
    position: `${Math.floor(target.x)} ${Math.floor(target.y)} ${Math.floor(target.z)}`
  })
  bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 4))
  return true
}

async function runFarmStep() {
  if (!bot.entity || state.mode !== 'farm') return false
  const now = Date.now()
  const task = state.farmTask ||= {
    nextHarvestAt: 0,
    nextReplantAt: 0,
    nextBreedAt: 0,
    nextSearchAt: 0,
    searches: 0
  }
  if (eliteMode) return runEliteFarmerStep(task)

  if (now >= (task.nextHarvestAt || 0)) {
    task.nextHarvestAt = now + 5000
    if (await harvestNearbyCrops()) {
      task.nextReplantAt = now + 1000
      return true
    }
  }
  if (now >= (task.nextReplantAt || 0)) {
    task.nextReplantAt = now + 15000
    if (await replantNearbyFarmland(false)) return true
  }
  if (now >= (task.nextBreedAt || 0)) {
    task.nextBreedAt = now + 30000
    if (await breedNearbyAnimals(false)) return true
  }
  if (!state.pathGoal && now >= (task.nextSearchAt || 0)) return chooseFarmSearchRoute()
  setCurrentTask('farming', 'searching for crops and animals')
  return false
}

function startCaveMode() {
  state.mode = 'cave'
  state.miningTask = { item: 'mixed_ores', style: 'cave', startedAt: Date.now() }
  setCurrentTask('exploring', 'searching for caves')
  bot.chat('Cave mode enabled. I will look for caves and remember entrances.')
}

function startTargetedMining(item, amount = 1) {
  state.mode = 'smart_mining'
  state.miningTask = { item, amount, style: 'targeted', startedAt: Date.now(), nextSearchAt: 0 }
  setCurrentTask('mining', `searching for ${item}`, { target: item })
  bot.chat(`Smart mining enabled for ${item}.`)
}

function eliteMiningStockTargets() {
  const ironStock = itemCount('raw_iron') + itemCount('iron_ingot')
  const goldStock = itemCount('raw_gold') + itemCount('gold_ingot')
  const strongIronTool = ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].some(name => hasItem(name))
  const strongArmor = equippedArmorNames().filter(name => /iron|diamond|netherite/.test(name)).length
  const basicsReady = strongIronTool && hasItem('shield') && strongArmor >= 4 && ironStock >= 16 && itemCount('coal') >= 16
  return [
    { item: 'raw_iron', amount: 32, current: ironStock, score: basicsReady ? 105 : 180 },
    { item: 'coal', amount: 32, score: itemCount('coal') < 8 ? 170 : basicsReady ? 100 : 150 },
    { item: 'cobblestone', amount: 128, score: itemCount('cobblestone') < 32 ? 145 : 70 },
    { item: 'diamond', amount: 24, score: basicsReady ? 165 : 80 },
    { item: 'lapis_lazuli', amount: 32, score: 85 },
    { item: 'raw_gold', amount: 24, current: goldStock, score: 75 },
    { item: 'redstone', amount: 64, score: 55 }
  ].filter(target => Number(target.current ?? itemCount(target.item)) < target.amount)
    .sort((left, right) => right.score - left.score)
}

async function runEliteMinerStep() {
  if (!bestOwnedTool('pickaxe') || (!hasItem('iron_pickaxe') && !hasItem('diamond_pickaxe') && !hasItem('netherite_pickaxe'))) {
    state.mode = 'progression'
    await workOnProgression()
    return true
  }
  if (await mineNearbyEliteUpgradeResource()) return true
  const target = eliteMiningStockTargets()[0]
  if (!target) {
    setCurrentTask('mining', 'resource stock targets complete')
    state.mode = 'idle'
    return true
  }
  const sameTarget = state.miningTask?.item === target.item
  state.mode = 'smart_mining'
  state.miningTask = {
    item: target.item,
    amount: target.amount,
    style: 'targeted',
    y: target.item === 'diamond' ? -54 : 16,
    startedAt: sameTarget ? state.miningTask.startedAt : Date.now(),
    nextSearchAt: sameTarget ? state.miningTask.nextSearchAt || 0 : 0,
    tunnelSteps: sameTarget ? state.miningTask.tunnelSteps || 0 : 0
  }
  setCurrentTask('mining', `producing ${target.item}`, { target: `${itemCount(target.item)}/${target.amount}` })
  await runSmartMiningStep()
  return true
}

async function runSmartMiningStep() {
  const task = state.miningTask
  if (!task) return
  const item = task.item === 'mixed_ores' ? null : task.item
  if (item && itemCount(item) >= (task.amount || 1)) {
    bot.chat(`I have enough ${item}.`)
    state.mode = 'idle'
    state.miningTask = null
    return
  }
  if (state.mode === 'cave') {
    await scanWorldFeatures()
    runExplorationStep()
    return
  }
  if (item) await gatherItemStep(task)
}

let worldFeatureScanAt = 0
let worldFeatureScanPromise = null

async function scanWorldFeatures({ force = false } = {}) {
  if (!bot.entity) return
  if (worldFeatureScanPromise) return worldFeatureScanPromise
  const now = Date.now()
  if (!force && now - worldFeatureScanAt < Math.min(worldScanIntervalMs, 10000)) return
  worldFeatureScanAt = now
  worldFeatureScanPromise = performWorldFeatureScan()
  try { return await worldFeatureScanPromise }
  finally { worldFeatureScanPromise = null }
}

async function performWorldFeatureScan() {
  if (!bot.entity) return
  const scannerResult = await worldScanner.tick()
  let changed = Boolean(scannerResult?.changed) || validateWorldMemoryNearby()
  const storageBlocks = nearbyBlocks(['chest', 'barrel', 'trapped_chest'], 24, 10)
  for (const position of storageBlocks) changed = rememberWorldLocation('storage', position, { block: bot.blockAt(position)?.name, source: 'auto_scan' }, false) || changed
  if (storageBlocks.length >= 2 && nearbyBlocks(['crafting_table', 'furnace', 'bed'], 12, 4).length) {
    changed = rememberWorldLocation('bases', bot.entity.position, { source: 'storage_cluster' }, false) || changed
  }

  const villageSignals = nearbyBlocks([
    'bell', 'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed', 'lime_bed', 'pink_bed',
    'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed',
    'composter', 'lectern', 'smithing_table', 'blast_furnace', 'cartography_table', 'stonecutter', 'loom'
  ], 32, 10)
  if (villageSignals.length >= 2) changed = rememberWorldLocation('villages', villageSignals[0], { source: 'village_blocks' }, false) || changed

  const mineSignals = nearbyBlocks(['rail', 'cobweb', 'oak_planks', 'oak_fence'], 24, 10)
    .filter(position => Number.isFinite(position?.y) && position.y < 50)
  if (mineSignals.length >= 2) changed = rememberWorldLocation('mines', mineSignals[0], { source: 'mine_blocks' }, false) || changed

  const strongholdSignals = nearbyBlocks(['end_portal_frame', 'end_portal'], 24, 4)
  if (strongholdSignals.length) changed = rememberWorldLocation('strongholds', strongholdSignals[0], { source: 'portal_blocks' }, false) || changed

  const farmBlocks = nearbyBlocks(['farmland', 'wheat', 'carrots', 'potatoes', 'beetroots'], 24, 16)
  for (const position of farmBlocks.slice(0, 5)) changed = rememberWorldLocation('farms', position, { block: bot.blockAt(position)?.name, source: 'auto_scan' }, false) || changed

  const dangerBlocks = nearbyBlocks(['lava', 'fire', 'magma_block', 'cactus', 'powder_snow'], 20, 8)
  for (const position of dangerBlocks) changed = rememberWorldLocation('dangerZones', position, { block: bot.blockAt(position)?.name, source: 'auto_scan' }, false) || changed
  if (eliteMode) scanVisibleEliteUpgradeResources(32)

  const caveAir = bot.findBlocks({
    matching: block => block?.boundingBox === 'empty' && Number.isFinite(block.position?.y) && block.position.y < bot.entity.position.y - 4,
    maxDistance: 18,
    count: 5
  })
  for (const position of caveAir.slice(0, 3)) changed = rememberWorldLocation('caves', position, { source: 'auto_air_scan' }, false) || changed
  if (changed) saveWorldMemory()
}

function startBeatMinecraft() {
  state.mode = 'beat_minecraft'
  state.beatMinecraft = { phase: 1, startedAt: Date.now() }
  bot.chat('Beat Minecraft mode enabled. I will progress toward killing the Ender Dragon.')
}

async function runBeatMinecraftStep() {
  const plan = nextBeatMinecraftStep()
  updatePlanner('beat minecraft', plan.action, plan.reason)
  if (plan.mode === 'progression') {
    state.mode = 'progression'
    await workOnProgression()
    state.mode = 'beat_minecraft'
    return
  }
  if (plan.gather) {
    await gatherForProgression(plan.gather.item, plan.gather.amount)
    return
  }
  if (plan.craft) {
    await craftSmart(plan.craft)
    return
  }
  if (plan.portal) {
    await buildOrUseNetherPortal()
    return
  }
  if (plan.explore) startExploration(plan.explore)
}

function nextBeatMinecraftStep() {
  if (!hasItem('stone_pickaxe') && !hasItem('iron_pickaxe') && !hasItem('diamond_pickaxe')) return { action: 'get stone tools', reason: 'phase 1 survival tools', mode: 'progression' }
  if (!hasItem('shield') || !hasItem('iron_pickaxe')) return { action: 'get iron tools and shield', reason: 'phase 2 iron safety', mode: 'progression' }
  if (!['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].every(item => hasItem(item))) return { action: 'craft iron armor', reason: 'phase 2 defense', mode: 'progression' }
  if (!hasItem('diamond_pickaxe')) return { action: 'mine diamonds for pickaxe', reason: 'phase 3 diamond progression', mode: 'progression' }
  if (!hasItem('obsidian', 10)) return { action: 'collect obsidian', reason: 'phase 5 nether portal', gather: { item: 'obsidian', amount: 10 } }
  if (!hasItem('flint_and_steel')) return { action: 'craft flint and steel', reason: 'phase 5 nether portal', craft: 'flint_and_steel' }
  if (!currentDimension().includes('nether') && (nearbyBlocks(['nether_portal'], 32, 4).length || worldMemory.portals?.length)) {
    return { action: 'enter Nether portal', reason: 'phase 5 use prepared Nether route', portal: true }
  }
  if (!currentDimension().includes('nether')) return { action: 'build and light Nether portal', reason: 'phase 5 enter the Nether', portal: true }
  if (!hasItem('blaze_rod', 6)) return { action: 'find nether fortress and blazes', reason: 'phase 6 blaze rods', explore: 'nether fortress search' }
  if (!hasItem('ender_pearl', 12)) return { action: 'collect ender pearls', reason: 'phase 7 eyes of ender', gather: { item: 'ender_pearl', amount: 12 } }
  if (!worldMemory.strongholds.length) return { action: 'find stronghold', reason: 'phase 8 portal room', explore: 'stronghold search' }
  return { action: 'prepare for End fight', reason: 'phase 9 checklist', explore: 'end preparation' }
}

async function enterNearestNetherPortal() {
  const nearby = nearbyBlocks(['nether_portal'], 32, 8)
    .sort((left, right) => left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position))[0]
  const remembered = (worldMemory.portals || [])
    .filter(entry => entry.block === 'nether_portal' && (!entry.dimension || entry.dimension === currentDimension()))
    .sort((left, right) => locationDistance(left, bot.entity.position) - locationDistance(right, bot.entity.position))[0]
  const target = nearby || (remembered ? new Vec3(remembered.x, remembered.y, remembered.z) : null)
  if (!target) return false
  setCurrentTask('nether', 'entering Nether portal', { position: `${target.x} ${target.y} ${target.z}` })
  const reached = await safeGoto(new goals.GoalBlock(target.x, target.y, target.z), 'entering Nether portal', false)
  if (!reached) return false
  await sleep(4500)
  return currentDimension().includes('nether') || Boolean(bot.blockAt(bot.entity.position.floored())?.name === 'nether_portal')
}

async function buildOrUseNetherPortal() {
  if (await enterNearestNetherPortal()) return true
  if (!hasItem('obsidian', 10) || !hasItem('flint_and_steel')) return false
  const base = bot.entity.position.floored().offset(3, 0, 0)
  const frame = [
    [1, 0], [2, 0],
    [0, 1], [3, 1],
    [0, 2], [3, 2],
    [0, 3], [3, 3],
    [1, 4], [2, 4]
  ].map(([x, y]) => base.offset(x, y, 0))
  setCurrentTask('nether', 'building Nether portal frame')
  for (const position of frame) {
    if (!await placeSpecificBlockAt('obsidian', position)) return false
  }
  const lighter = bot.inventory.items().find(item => item.name === 'flint_and_steel')
  if (!lighter) return false
  try {
    await equipAndConfirmHeldItem(lighter)
    const fireBase = bot.blockAt(base.offset(1, 0, 0)) || bot.blockAt(frame[0])
    await bot.activateBlock(fireBase)
    await sleep(1500)
  } catch (err) {
    logActionError('Could not light Nether portal', err)
    return false
  }
  await scanWorldFeatures()
  return enterNearestNetherPortal()
}

async function placeSpecificBlockAt(itemName, target) {
  const existing = bot.blockAt(target)
  if (existing?.name === itemName) return true
  if (existing && existing.boundingBox !== 'empty') return false
  const item = bot.inventory.items().find(item => item.name === itemName)
  if (!item) return false
  if (target.distanceTo(bot.entity.position) > 4.5 &&
    !await safeGoto(new goals.GoalNear(target.x, target.y, target.z, 3), `placing ${itemName}`, false)) return false
  const faces = [
    new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)
  ]
  const face = faces.find(candidate => bot.blockAt(target.minus(candidate))?.boundingBox === 'block')
  if (!face) return false
  try {
    await equipAndConfirmHeldItem(item)
    await bot.placeBlock(bot.blockAt(target.minus(face)), face)
    return waitForPlacedBlock(target, 1400)
  } catch (err) {
    if (!expectedPathError(err)) logActionError(`Could not place ${itemName}`, err)
    return false
  }
}

function exploreNearby() {
  const pos = bot.entity.position
  const x = Math.floor(pos.x + (Math.random() * 48) - 24)
  const z = Math.floor(pos.z + (Math.random() * 48) - 24)
  bot.pathfinder.setGoal(new goals.GoalNear(x, Math.floor(pos.y), z, 3))
}

function canClearBlock(block) {
  if (!block || block.boundingBox === 'empty') return false
  return knowledge.movement.clearableBlocks.includes(block.name)
}

function canClearForUnstuck(block) {
  if (!block || block.boundingBox === 'empty') return false
  return knowledge.movement.unstuckClearableBlocks.includes(block.name)
}

function eliteUpgradeResourceNeeds() {
  const needs = []
  const add = (item, blocks, priority, wanted) => needs.push({ item, blocks, priority, wanted })
  const strongPickaxe = hasItem('diamond_pickaxe') || hasItem('netherite_pickaxe')
  const strongSword = hasItem('diamond_sword') || hasItem('netherite_sword')
  const strongArmor = equippedArmorNames().filter(name => /diamond|netherite/.test(name)).length
  const ironArmor = equippedArmorNames().filter(name => /iron|diamond|netherite/.test(name)).length
  const basicsReady = (hasItem('iron_pickaxe') || strongPickaxe) && hasItem('shield') && ironArmor >= 4 &&
    itemCount('coal') >= 16 && itemCount('iron_ingot') + itemCount('raw_iron') >= 16
  const logCount = bot.inventory.items().filter(item => item.name.endsWith('_log') || item.name.endsWith('_stem')).reduce((sum, item) => sum + item.count, 0)

  if (logCount < 8) add('logs', Object.keys(mcData.blocksByName).filter(name => name.endsWith('_log') || name.endsWith('_stem')), 75, 8)
  if (itemCount('coal') < 16) add('coal', ['coal_ore', 'deepslate_coal_ore'], 70, 16)
  if (!hasItem('iron_pickaxe') || !hasItem('shield') || equippedArmorNames().length < 4 || itemCount('iron_ingot') < 12) {
    add('raw_iron', ['iron_ore', 'deepslate_iron_ore'], 95, 32)
  }
  if (!strongPickaxe || !strongSword || strongArmor < 4 || itemCount('diamond') < 8) {
    add('diamond', ['diamond_ore', 'deepslate_diamond_ore'], basicsReady ? 130 : 65, 32)
  }
  if (strongPickaxe && itemCount('ancient_debris') < 8) add('ancient_debris', ['ancient_debris'], 140, 8)
  if (itemCount('lapis_lazuli') < 32) add('lapis_lazuli', ['lapis_ore', 'deepslate_lapis_ore'], 80, 32)
  if (itemCount('gold_ingot') < 16) add('raw_gold', ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'], 72, 16)
  if (itemCount('redstone') < 32) add('redstone', ['redstone_ore', 'deepslate_redstone_ore'], 45, 32)
  return needs
}

function scanVisibleEliteUpgradeResources(maxDistance = 24, force = false) {
  if (!eliteMode || !bot.entity || !mcData) return []
  const now = Date.now()
  if (!force && now - state.lastEliteResourceScanAt < 6000) {
    return (state.eliteResourceScanCache || [])
      .map(entry => ({ ...entry, block: bot.blockAt(entry.position) }))
      .filter(entry => entry.block?.boundingBox === 'block')
  }
  state.lastEliteResourceScanAt = now
  const found = []
  const needs = eliteUpgradeResourceNeeds().sort((left, right) => right.priority - left.priority).slice(0, 5)
  for (const need of needs) {
    const matching = blockIds(need.blocks)
    if (!matching.length) continue
    for (const position of bot.findBlocks({ matching, maxDistance, count: 24 })) {
      const block = bot.blockAt(position)
      if (!block || !bot.canSeeBlock(block)) continue
      rememberOreSight(block, need.item)
      state.eliteResourceKnowledgeDirty = true
      found.push({ block, need })
    }
  }
  if (state.eliteResourceKnowledgeDirty && now - state.lastEliteResourceSaveAt >= 30000) {
    state.eliteResourceKnowledgeDirty = false
    state.lastEliteResourceSaveAt = now
    saveKnowledge({ mining: knowledge.mining })
  }
  const sorted = found.sort((left, right) =>
    right.need.priority - left.need.priority ||
    left.block.position.distanceTo(bot.entity.position) - right.block.position.distanceTo(bot.entity.position))
  state.eliteResourceScanCache = sorted.map(entry => ({ position: entry.block.position.clone(), need: entry.need }))
  return sorted
}

async function mineNearbyEliteUpgradeResource() {
  if (!eliteMode || state.unstucking || state.recovering || state.hitmanTask || state.guardTask || state.manualControlOnly) return false
  const candidates = scanVisibleEliteUpgradeResources(20)
    .filter(entry => entry.block.position.distanceTo(bot.entity.position) <= 12)
    .filter(entry => !peerClaimsPosition(entry.block.position, 3))
  const target = candidates[0]
  if (!target) return false
  setCurrentTask('mining', `collecting visible ${target.need.item} for elite progression`, {
    target: target.block.name,
    position: blockPositionText(target.block)
  })
  if (await mineVisibleBlock(target.block, `elite-upgrade:${target.need.item}`, target.need.item)) {
    addSkill(target.need.item === 'logs' ? 'woodcutting' : 'mining')
    return true
  }
  return false
}

function eliteFarmFoodCount() {
  return bot.inventory.items()
    .filter(item => isFood(item.name) && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'].includes(item.name))
    .reduce((sum, item) => sum + item.count, 0)
}

async function harvestEliteFarmResources() {
  const block = nearbyBlocks(['sugar_cane', 'melon', 'pumpkin', 'cocoa'], 32, 96)
    .map(position => bot.blockAt(position))
    .filter(Boolean)
    .filter(entry => entry.name !== 'sugar_cane' || bot.blockAt(entry.position.offset(0, -1, 0))?.name === 'sugar_cane')
    .sort((left, right) => left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position))[0]
  if (!block) return false
  setCurrentTask('farming', `harvesting useful ${block.name}`, { target: block.name, position: blockPositionText(block) })
  if (block.position.distanceTo(bot.entity.position) > 4.5 &&
    !await safeGoto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), `harvesting ${block.name}`)) return false
  if (!await digNearbyVisibleBlock(block, `harvesting ${block.name}`)) return false
  await pickupNearbyUsefulDrop()
  state.farmTask.harvested = (state.farmTask.harvested || 0) + 1
  state.farmTask.lastYieldAt = Date.now()
  return true
}

async function runEliteFarmerStep(task) {
  const now = Date.now()
  const foodCount = eliteFarmFoodCount()
  setCurrentTask('farming', 'producing food and renewable resources', {
    target: `food ${foodCount}/32 | harvests ${task.harvested || 0} | breeds ${task.bred || 0}`
  })
  if (autonomy.focus !== 'farm' && foodCount >= 32) {
    setCurrentTask('done', 'stable food reserve produced', { target: `${foodCount} food` })
    state.farmTask = null
    state.mode = 'idle'
    return true
  }
  if (now >= Number(task.nextHarvestAt || 0)) {
    task.nextHarvestAt = now + 5000
    if (await harvestNearbyCrops()) return true
    if (await harvestEliteFarmResources()) return true
  }
  if (now >= Number(task.nextReplantAt || 0)) {
    task.nextReplantAt = now + 12000
    if (await replantNearbyFarmland(false)) return true
  }
  if (now >= Number(task.nextBreedAt || 0)) {
    task.nextBreedAt = now + 30000
    if (await breedNearbyAnimals(false)) return true
  }
  if (foodCount < 32 && now >= Number(task.nextCookAt || 0)) {
    task.nextCookAt = now + 10000
    if (await autoCookFoodIfUseful()) return true
  }
  if (foodCount < 24 && now >= Number(task.nextFoodSearchAt || 0) &&
    await eliteAcquireFood({ preserveBreedingPairs: true, emergencyOnly: bot.food >= 6 })) {
    task.nextFoodSearchAt = now + 15000
    state.mode = 'farm'
    return true
  }
  if (now - Number(task.lastYieldAt || task.startedAt || now) > 90000) {
    task.lastYieldAt = now
    task.lastTargetKey = null
    task.nextSearchAt = 0
    setCurrentTask('farming', 'changing area after no farm yield')
  }
  if (!state.pathGoal && now >= (task.nextSearchAt || 0)) return chooseFarmSearchRoute()
  return false
}

function blockFailureKey(position) {
  return position ? `${position.x},${position.y},${position.z}` : ''
}

function blockFailureCoolingDown(store, position, cooldownMs) {
  const key = blockFailureKey(position)
  if (!key) return false
  const failedAt = Number(store[key] || 0)
  if (!failedAt) return false
  if (Date.now() - failedAt >= cooldownMs) {
    delete store[key]
    return false
  }
  return true
}

function rememberBlockFailure(store, position) {
  const key = blockFailureKey(position)
  if (key) store[key] = Date.now()
  const entries = Object.entries(store)
  if (entries.length > 64) {
    entries.sort((left, right) => left[1] - right[1]).slice(0, entries.length - 64).forEach(([oldKey]) => delete store[oldKey])
  }
}

async function equipAndConfirmHeldItem(item, timeoutMs = 1000) {
  if (!item) return false
  try {
    await bot.equip(item, 'hand')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (bot.heldItem?.type === item.type) return true
      await sleep(40)
    }
  } catch (err) {
    if (!expectedPathError(err)) logActionError(`Could not equip ${item.name || 'placement item'}`, err)
  }
  return false
}

async function waitForPlacedBlock(position, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (canUseAsPlacementFloor(bot.blockAt(position))) return true
    await sleep(40)
  }
  return false
}

function blockNeedsPickaxe(block) {
  if (!block?.name) return false
  return block.material === 'rock' || String(block.material || '').includes('pickaxe') ||
    /(?:stone|cobble|deepslate|ore|brick|obsidian|netherrack|basalt|blackstone|andesite|diorite|granite|terracotta|concrete)/.test(block.name)
}

function recoveryToolForBlock(block) {
  if (blockNeedsPickaxe(block)) return bestOwnedTool('pickaxe')
  if (block?.material === 'wood' || /(?:log|wood|planks)/.test(block?.name || '')) return bestOwnedTool('axe')
  if (['dirt', 'grass_block', 'sand', 'red_sand', 'gravel', 'clay', 'snow'].includes(block?.name)) return bestOwnedTool('shovel')
  return null
}

function canClearHardEscapeBlock(block) {
  return Boolean(block?.boundingBox === 'block' && blockNeedsPickaxe(block) && bestOwnedTool('pickaxe'))
}

function hardEscapeBlockNearby() {
  if (!bot.entity) return null
  const base = bot.entity.position.floored()
  return [
    base.offset(0, 1, 0),
    base.offset(1, 0, 0), base.offset(-1, 0, 0),
    base.offset(0, 0, 1), base.offset(0, 0, -1),
    base.offset(1, 1, 0), base.offset(-1, 1, 0),
    base.offset(0, 1, 1), base.offset(0, 1, -1)
  ].map(position => bot.blockAt(position)).find(blockNeedsPickaxe) || null
}

function isFootingBlock(block) {
  if (!block?.position || !bot.entity) return false
  const base = bot.entity.position.floored()
  return block.position.y <= base.y && Math.abs(block.position.x - base.x) <= 1 && Math.abs(block.position.z - base.z) <= 1
}

function canUseAsPlacementFloor(block) {
  return block?.boundingBox === 'block' && !knowledge.movement.avoidFloorBlocks.includes(block.name)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function clearBlockSafely(block) {
  if (!canClearBlock(block)) return false
  if (isFootingBlock(block)) return false
  if (!await digNearbyVisibleBlock(block, 'clearing space')) return false
  if (['sand', 'red_sand', 'gravel'].includes(block.name)) await sleep(750)
  return true
}

async function clearPlacementBlock(block) {
  if (!block || block.boundingBox === 'empty') return true
  const allowed = canClearBlock(block) || [
    'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'netherrack'
  ].includes(block.name)
  if (!allowed) return false
  if (!await digNearbyVisibleBlock(block, 'clearing placement block')) return false
  if (['sand', 'red_sand', 'gravel'].includes(block.name)) await sleep(750)
  return true
}

async function findOrClearPlacementSpot() {
  const base = bot.entity.position.floored()
  const offsets = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    new Vec3(1, 0, 1), new Vec3(-1, 0, -1),
    new Vec3(1, 0, -1), new Vec3(-1, 0, 1),
    new Vec3(2, 0, 0), new Vec3(-2, 0, 0),
    new Vec3(0, 0, 2), new Vec3(0, 0, -2)
  ]

  for (const offset of offsets) {
    const target = base.plus(offset)
    if (!await ensurePlacementFloor(target)) continue
    if (await clearPlacementColumn(target)) return target
  }
  return null
}

async function ensurePlacementFloor(target) {
  const belowPos = target.offset(0, -1, 0)
  let below = bot.blockAt(belowPos)
  if (canUseAsPlacementFloor(below)) return true

  if (below?.boundingBox === 'block') return false
  below = bot.blockAt(belowPos)
  if (canUseAsPlacementFloor(below)) return true
  if (below?.boundingBox !== 'empty') return false

  const floorItem = bot.inventory.items().find(item => knowledge.movement.buildingBlocks.includes(item.name))
  if (!floorItem) return false

  const supportFaces = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    new Vec3(0, -1, 0)
  ]
  const face = supportFaces.find(candidate => canUseAsPlacementFloor(bot.blockAt(belowPos.minus(candidate))))
  if (!face) return false
  try {
    await bot.equip(floorItem, 'hand')
    await bot.placeBlock(bot.blockAt(belowPos.minus(face)), face)
    return canUseAsPlacementFloor(bot.blockAt(belowPos))
  } catch {
    return false
  }
}

async function clearPlacementColumn(target) {
  for (const pos of [target, target.offset(0, 1, 0)]) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const block = bot.blockAt(pos)
      if (block?.boundingBox === 'empty') break
      if (!await clearPlacementBlock(block)) return false
    }
    if (bot.blockAt(pos)?.boundingBox !== 'empty') return false
  }
  return true
}

async function clearImmediateObstacles() {
  const base = bot.entity.position.floored()
  const candidates = [
    base.offset(0, 1, 0),
    base.offset(1, 0, 0), base.offset(-1, 0, 0),
    base.offset(0, 0, 1), base.offset(0, 0, -1),
    base.offset(1, 1, 0), base.offset(-1, 1, 0),
    base.offset(0, 1, 1), base.offset(0, 1, -1)
  ]
  let cleared = false
  let attempts = 0
  for (const pos of candidates.sort((left, right) => left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position))) {
    const block = bot.blockAt(pos)
    if (!canClearForUnstuck(block) && !canClearHardEscapeBlock(block)) continue
    if (blockFailureCoolingDown(state.recoveryBlockFailures, block.position, 30000)) continue
    attempts++
    if (await digNearbyVisibleBlock(block, 'clearing unstuck space')) cleared = true
    else rememberBlockFailure(state.recoveryBlockFailures, block.position)
    if (attempts >= 2) break
  }
  return cleared
}

function pathGoalY() {
  const value = state.pathGoal?.y ?? state.pathGoal?.goalPos?.y ?? state.pathGoal?.pos?.y
  return Number.isFinite(Number(value)) ? Number(value) : null
}

async function buildUpOneBlock() {
  if (!bot.entity?.onGround) return false
  const taskToken = taskController.active
  const base = bot.entity.position.floored()
  const below = bot.blockAt(base.offset(0, -1, 0))
  const head = bot.blockAt(base.offset(0, 1, 0))
  const twoHigh = bot.blockAt(base.offset(0, 2, 0))
  if (!canUseAsPlacementFloor(below)) return false
  if (head?.boundingBox !== 'empty' && !await clearPlacementBlock(head)) return false
  if (twoHigh?.boundingBox !== 'empty' && !await clearPlacementBlock(twoHigh)) return false
  const item = safetyBuildingItem()
  if (!item) return false

  setCurrentTask('building', 'pillaring upward', { position: `${base.x} ${base.y} ${base.z}` })
  try {
    if (!await equipAndConfirmHeldItem(item)) return false
    await bot.lookAt(below.position.offset(0.5, 1, 0.5), true)
    bot.setControlState('jump', true)
    const jumpDeadline = Date.now() + 700
    while (Date.now() < jumpDeadline && bot.entity.position.y < base.y + 0.35) {
      if (taskWasCancelled(taskToken)) return false
      await sleep(25)
    }
    bot.setControlState('jump', false)
    if (bot.entity.position.y < base.y + 0.3) return false
    await bot.placeBlock(below, new Vec3(0, 1, 0))
    if (!await waitForPlacedBlock(base, 1000)) {
      rememberBlockFailure(state.safetyBlockFailures, base)
      return false
    }
    const landingDeadline = Date.now() + 1200
    while (Date.now() < landingDeadline && !bot.entity.onGround) await sleep(25)
    const placed = bot.blockAt(base)
    if (placed?.boundingBox === 'block') {
      bumpKnowledgeStat('movement', 'pillarsBuilt')
      recordLearning('movement', 'recovery', 'pillar_up', 2, 'built upward instead of repeatedly jumping')
      return true
    }
  } catch (err) {
    if (!expectedPathError(err)) logActionError('Could not pillar upward', err)
  } finally {
    bot.setControlState('jump', false)
  }
  return false
}

async function climbOutIfInHole() {
  if (!bot.entity) return false
  const base = bot.entity.position.floored()
  const below = bot.blockAt(base.offset(0, -1, 0))
  const head = bot.blockAt(base.offset(0, 1, 0))
  if (head?.boundingBox === 'block' && canClearForUnstuck(head) && !blockFailureCoolingDown(state.recoveryBlockFailures, head.position, 30000)) {
    if (!await digNearbyVisibleBlock(head, 'clearing headroom')) rememberBlockFailure(state.recoveryBlockFailures, head.position)
  }
  const targetY = pathGoalY()
  if (targetY !== null && targetY > base.y + 1 && await buildUpOneBlock()) return true
  if (below?.boundingBox === 'empty') {
    bumpKnowledgeStat('movement', 'holesEscaped')
    const blockItem = bot.inventory.items().find(item => knowledge.movement.buildingBlocks.includes(item.name))
    const support = [
      { offset: new Vec3(1, -1, 0), face: new Vec3(-1, 0, 0) },
      { offset: new Vec3(-1, -1, 0), face: new Vec3(1, 0, 0) },
      { offset: new Vec3(0, -1, 1), face: new Vec3(0, 0, -1) },
      { offset: new Vec3(0, -1, -1), face: new Vec3(0, 0, 1) },
      { offset: new Vec3(0, -2, 0), face: new Vec3(0, 1, 0) }
    ].find(candidate => bot.blockAt(base.plus(candidate.offset))?.boundingBox === 'block')
    if (blockItem && support) {
      try {
        await bot.equip(blockItem, 'hand')
        await bot.placeBlock(bot.blockAt(base.plus(support.offset)), support.face)
        return true
      } catch (err) {
        rememberBlockFailure(state.recoveryBlockFailures, base)
        if (!/blockUpdate:.*did not fire|block not in view/i.test(err?.message || '')) logActionError('Could not place an escape block', err)
      }
    }
  }
  bot.setControlState('jump', true)
  bot.setControlState('forward', true)
  await sleep(500)
  bot.clearControlStates()
  return true
}

function actionTimeoutMs() {
  return Math.max(20000, Number(knowledge.movement.rules?.actionTimeoutMs) || 30000)
}

function actionRestartMs() {
  return Math.max(actionTimeoutMs() + 15000, Number(knowledge.movement.rules?.actionRestartMs) || 60000)
}

function recoverHungAction(source) {
  if (!state.busy || !state.busySince) return false
  const now = Date.now()
  if (now - state.busySince <= actionTimeoutMs()) return false

  if (state.actionRecoveryPendingAt) {
    if (now - state.actionRecoveryPendingAt > actionRestartMs() && !reconnectTimer) {
      recordInfo('The current action did not close. Reconnecting to recover safely.', 'recovery')
      scheduleReconnect('hung action')
    }
    return true
  }

  state.actionRecoveryPendingAt = now
  state.actionRecoveryBusySince = state.busySince
  state.lastActionRecoveryAt = now
  state.lastWatchdogWakeAt = now
  taskController.cancel(`${source} action timeout`)
  state.stopVersion++
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.pvp.stop() } catch {}
  try { bot.clearControlStates() } catch {}
  bumpKnowledgeStat('movement', 'actionRecoveryRequests')
  recordLearning('movement', 'recovery', state.mode || 'busy', -2, `${source} requested action cancellation`)
  recordInfo('An action stopped responding. It was cancelled while waiting for it to close.', 'recovery')
  return true
}

function registerNavigationRecovery(position) {
  const now = Date.now()
  const sameArea = state.navigationRecoveryAnchor &&
    position.distanceTo(state.navigationRecoveryAnchor) < 8 &&
    now - state.navigationRecoveryStartedAt < 180000
  if (!sameArea) {
    state.navigationRecoveryAnchor = position.clone()
    state.navigationRecoveryStartedAt = now
    state.navigationRecoveryAttempts = 0
  }
  state.navigationRecoveryAttempts++
  return state.navigationRecoveryAttempts
}

function pauseFailedNavigation(position) {
  const pauseMs = 90000
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
  state.pathGoal = null
  state.pathGoalDynamic = false
  state.activeRoute = null
  state.currentPath = []
  state.pathStatus = 'blocked'
  state.pendingNavigationRecovery = false
  state.navigationBlockedUntil = Date.now() + pauseMs
  state.stuckChecks = 0
  state.unstuckFailures = 0
  taskController.cancel('navigation repeatedly stuck')
  state.stopVersion++
  if (state.mode === 'travel') state.mode = 'idle'
  rememberWorldLocation('dangerZones', position, {
    source: 'repeated_navigation_failure',
    reason: 'repeatedly stuck',
    blockedUntil: appTimestamp(state.navigationBlockedUntil)
  })
  setCurrentTask('waiting', 'navigation paused after repeated failures', {
    position: `${position.x.toFixed(1)} ${position.y.toFixed(1)} ${position.z.toFixed(1)}`
  })
  recordInfo('Could not escape this area safely. Route stopped temporarily.', 'recovery')
}

async function recoverIfStuck() {
  if (state.hardStopped) return
  if (!minecraftConnected || !bot.entity || state.recovering || state.unstucking) return
  if (Date.now() < state.navigationBlockedUntil) return
  const position = bot.entity.position
  if (!state.pathGoal) {
    recoverHungAction('stuck recovery')
    return
  }

  if (state.mode === 'explore' && Date.now() - state.routeStartedAt > (knowledge.movement.rules?.routeRecalcMs || 18000)) {
    state.unstuckFailures = 0
    chooseExplorationRoute()
    return
  }
  if (typeof state.pathGoal.isEnd === 'function' && state.pathGoal.isEnd(position.floored())) {
    state.stuckChecks = 0
    state.unstuckFailures = 0
    return
  }

  if (!state.stuckPosition || position.distanceTo(state.stuckPosition) > 0.8) {
    if (state.pendingNavigationRecovery) {
      state.pendingNavigationRecovery = false
    }
    state.stuckPosition = position.clone()
    state.stuckChecks = 0
    state.unstuckFailures = 0
    return
  }

  state.stuckChecks++
  if (state.stuckChecks < 3 || Date.now() - state.lastUnstuckAt < 10000) return
  state.lastUnstuckAt = Date.now()
  state.stuckChecks = 0
  state.unstuckFailures++
  const recoveryAttempts = registerNavigationRecovery(position)

  state.unstucking = true
  try {
    bumpKnowledgeStat('movement', 'stuckEvents')
    bumpKnowledgeStat('movement', 'unstuckAttempts')
    recordLearning('movement', 'recovery', state.mode || 'unknown', -1, 'stuck detected')
    if (Date.now() - state.lastNavigationRecoveryChatAt > 60000) {
      state.lastNavigationRecoveryChatAt = Date.now()
      recordInfo('Stuck. Climbing out and recalculating the route.', 'recovery')
    }
    if (hardEscapeBlockNearby() && !bestOwnedTool('pickaxe')) await ensureRecoveryTool(false)
    if (eliteMode && await eliteTraversalRecovery()) return
    await clearImmediateObstacles()
    await climbOutIfInHole()

    if (recoveryAttempts >= 4 && eliteMode) {
      state.navigationRecoveryAttempts = 0
      state.navigationBlockedUntil = 0
      if (state.hitmanTask) {
        const target = findPlayerByName(state.hitmanTask.playerName)?.entity
        await eliteHitmanBreakFree(target, taskController.active)
      } else {
        await eliteTraversalRecovery()
        const goal = state.pathGoal
        const dynamic = state.pathGoalDynamic
        if (goal) {
          bot.pathfinder.setGoal(null)
          bot.pathfinder.setGoal(goal, dynamic)
        }
      }
      return
    }
    if (recoveryAttempts >= 4) {
      pauseFailedNavigation(position)
      return
    }

    if (state.unstuckFailures >= 2) {
      bot.pathfinder.setGoal(null)
      state.pathGoal = null
      taskController.cancel('unstuck route reset')
      state.stopVersion++
      state.pendingNavigationRecovery = false
      state.unstuckFailures = 0
      if (state.mode === 'explore') chooseExplorationRoute()
      else if (!['follow', 'guard', 'hitman'].includes(state.mode)) exploreNearby()
      return
    }

    const goal = state.pathGoal
    const dynamic = state.pathGoalDynamic
    if (goal) {
      bot.pathfinder.setGoal(null)
      bot.pathfinder.setGoal(goal, dynamic)
    }
    state.pendingNavigationRecovery = true
  } finally {
    state.unstucking = false
  }
}

async function wakeIfStalled() {
  if (state.hardStopped) return
  if (!minecraftConnected || !bot.entity || state.recovering || state.unstucking) return
  const now = Date.now()
  const activeModes = ['follow', 'gather', 'progression', 'explore', 'travel', 'farm', 'hitman', 'guard', 'smart_mining', 'cave', 'beat_minecraft']
  const activeMode = activeModes.includes(state.mode)
  const lastMovement = state.lastMovementAt || state.routeStartedAt || state.busySince || state.lastPriorityAt || now
  const noRecentMovement = now - lastMovement > 12000
  const noRecentWake = now - state.lastWatchdogWakeAt > 9000

  if (recoverHungAction('watchdog')) return
  if (now < state.navigationBlockedUntil) return
  if (state.mode === 'progression' && craftingRetryCoolingDown()) return

  if (state.pathGoal && noRecentMovement && noRecentWake) {
    state.lastWatchdogWakeAt = now
    bumpKnowledgeStat('movement', 'watchdogPathResets')
    recordLearning('movement', 'recovery', state.mode || 'path', -1, 'path restarted by watchdog')
    const goal = state.pathGoal
    const dynamic = state.pathGoalDynamic
    bot.pathfinder.setGoal(null)
    await climbOutIfInHole()
    bot.pathfinder.setGoal(goal, dynamic)
    recordInfo('Watchdog restarted the route.', 'recovery')
    return
  }

  if (!state.busy && !state.pathGoal && activeMode && noRecentMovement && noRecentWake) {
    state.lastWatchdogWakeAt = now
    if (state.mode === 'hitman' && state.hitmanTask) {
      await runHitmanStep()
      return
    }
    if (state.mode === 'guard' && state.guardTask) {
      await runGuardStep()
      return
    }
    bumpKnowledgeStat('movement', 'watchdogWakes')
    recordLearning('movement', 'recovery', state.mode, 1, 'watchdog resumed task')
    bot.clearControlStates()
    state.activeRoute = null
    state.stuckChecks = 0
    state.unstuckFailures = 0
    recordInfo('Watchdog resumed a quiet task.', 'recovery')

    if (state.mode === 'explore') {
      chooseExplorationRoute()
      return
    }
    if (state.mode === 'follow' && state.owner) {
      const player = bot.players[state.owner]?.entity
      if (player) bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true)
      return
    }
    if (state.mode === 'gather' && state.gatherTask) {
      state.gatherTask.nextSearchAt = 0
      await gatherItemStep(state.gatherTask)
      return
    }
    if (state.mode === 'progression') {
      await workOnProgression()
      return
    }
    if (state.mode === 'farm') {
      state.farmTask ||= {}
      state.farmTask.nextSearchAt = 0
      await runFarmStep()
      return
    }
    if (['smart_mining', 'cave'].includes(state.mode)) {
      await runSmartMiningStep()
      return
    }
    if (state.mode === 'beat_minecraft') {
      await runBeatMinecraftStep()
      return
    }
    if (state.mode === 'travel') {
      state.mode = 'idle'
    }
  }

  if (!state.busy && !state.pathGoal && state.mode === 'idle' && autonomy.enabled && noRecentMovement && noRecentWake) {
    state.lastWatchdogWakeAt = now
    bumpKnowledgeStat('movement', 'watchdogAutonomyRestarts')
    recordInfo('Watchdog restarted autonomy.', 'recovery')
    await runAutonomousPlanner()
  }
}

async function placeUtilityBlock(itemName) {
  if (!minecraftConnected || !bot.entity) return null
  const existing = await findRememberedUtility(itemName)
  if (existing) return existing
  const item = bot.inventory.items().find(item => item.name === itemName)
  if (!item) return null

  const target = await findOrClearPlacementSpot()
  if (!target) return null
  try {
    if (!minecraftConnected) return null
    await bot.equip(item, 'hand')
    if (!minecraftConnected) return null
    await bot.placeBlock(bot.blockAt(target.offset(0, -1, 0)), new Vec3(0, 1, 0))
    const block = bot.blockAt(target)
    rememberUtility(itemName, block)
    return block
  } catch {
    return null
  }
}

function rememberUtility(name, block, extra = {}) {
  if (!block?.position) return
  worldMemory.utilities ||= {}
  const utility = {
    ...(worldMemory.utilities[name] || {}),
    x: block.position.x,
    y: block.position.y,
    z: block.position.z,
    dimension: currentDimension(),
    validationMisses: 0,
    lastSeenAt: appTimestamp(),
    ...extra
  }
  worldMemory.utilities[name] = utility
  saveWorldMemory()
}

function utilityBlockAt(name, position) {
  if (!position || !mcData.blocksByName[name]) return null
  const block = bot.blockAt(new Vec3(position.x, position.y, position.z))
  return block?.type === mcData.blocksByName[name].id ? block : null
}

async function findRememberedUtility(name) {
  worldMemory.utilities ||= {}
  let position = worldMemory.utilities[name]
  if (position?.dimension && position.dimension !== currentDimension()) position = null
  if (position) {
    const target = new Vec3(position.x, position.y, position.z)
    if (target.distanceTo(bot.entity.position) > 4) {
      try {
        await safeGoto(new goals.GoalNear(target.x, target.y, target.z, 2), `utility:${name}`)
      } catch (err) {
        console.log(`Could not reach remembered ${name}:`, err.message)
      }
    }
    const remembered = utilityBlockAt(name, position)
    if (remembered) {
      rememberUtility(name, remembered)
      return remembered
    }
    if (target.distanceTo(bot.entity.position) <= 16) {
      position.validationMisses = (position.validationMisses || 0) + 1
      position.stale = true
      if (position.validationMisses >= 3) {
        delete worldMemory.utilities[name]
      }
      saveWorldMemory()
    }
  }

  let failed = state.failedUtilities[name]
  if (failed && failed.until <= Date.now()) {
    delete state.failedUtilities[name]
    failed = null
  }
  const nearby = bot.findBlocks({ matching: mcData.blocksByName[name]?.id, maxDistance: 64, count: 16 })
    .map(position => bot.blockAt(position))
    .filter(Boolean)
    .filter(block => !failed || block.position.distanceTo(new Vec3(failed.x, failed.y, failed.z)) > 2)[0] || null
  if (nearby) rememberUtility(name, nearby)
  return nearby
}

async function hasAvailableFurnace() {
  return Boolean(await findRememberedUtility('furnace'))
}

async function serviceRememberedFurnace() {
  const remembered = worldMemory.utilities?.furnace
  const hasWork = Boolean(remembered?.input || remembered?.output)
  if (!hasWork || state.smeltingTask || Date.now() - state.lastFurnaceCheckAt < 30000) return false
  if (locationDistance(remembered, bot.entity?.position) > 64 && !['idle', 'progression'].includes(state.mode)) return false
  state.lastFurnaceCheckAt = Date.now()
  const furnaceBlock = await findRememberedUtility('furnace')
  if (!furnaceBlock) return false
  try {
    const furnace = await bot.openFurnace(furnaceBlock)
    if (furnace.outputItem()) await furnace.takeOutput()
    if (furnace.fuelItem()?.name === 'stick') await furnace.takeFuel()
    updateFurnaceDebug(furnace, furnaceBlock, 'service check')
    rememberUtility('furnace', furnaceBlock, {
      occupied: Boolean(furnace.inputItem() || furnace.outputItem()),
      input: furnace.inputItem()?.name || null,
      output: furnace.outputItem()?.name || null,
      fuel: furnace.fuelItem()?.name || null,
      lastCheckedAt: appTimestamp()
    })
    furnace.close()
    return true
  } catch {
    return false
  }
}

function fuelSmeltCapacity(name) {
  if (FUEL_SMELT_CAPACITY[name]) return FUEL_SMELT_CAPACITY[name]
  if (/_planks$|_log$|_wood$|_stem$|_hyphae$/.test(name)) return 1.5
  if (/^wooden_(pickaxe|axe|shovel|hoe|sword)$/.test(name)) return 1
  return 0
}

function chooseFurnaceFuel(existingFuelName = null) {
  return bot.inventory.items()
    .filter(item => fuelSmeltCapacity(item.name) > 0)
    .sort((left, right) => fuelSmeltCapacity(right.name) - fuelSmeltCapacity(left.name))[0] || null
}

function furnaceFuelCapacity(furnace) {
  const activeFuel = Math.max(0, Number(furnace.fuelSeconds) || 0) / 10
  const queuedFuel = furnace.fuelItem()
  return activeFuel + (queuedFuel ? queuedFuel.count * fuelSmeltCapacity(queuedFuel.name) : 0)
}

function inventoryFuelCapacity() {
  return bot.inventory.items().reduce((total, item) => total + item.count * fuelSmeltCapacity(item.name), 0)
}

async function ensureFuelSupply(requiredSmelts = 1) {
  if (inventoryFuelCapacity() >= requiredSmelts) return true
  const coalBlock = findBestResourceBlock(blockIds(['coal_ore', 'deepslate_coal_ore']), 48, 'coal')
  if (coalBlock) {
    setCurrentTask('fuel', 'mining coal for furnace', { target: coalBlock.name, position: blockPositionText(coalBlock) })
    await mineVisibleBlock(coalBlock, 'collecting furnace fuel', 'coal')
    return inventoryFuelCapacity() >= requiredSmelts
  }
  if (!await ensureWood()) return false
  await craftAvailablePlanks()
  return inventoryFuelCapacity() >= requiredSmelts
}

async function ensureFurnaceFuel(furnace, requiredSmelts) {
  let currentCapacity = furnaceFuelCapacity(furnace)
  if (currentCapacity >= requiredSmelts) return { enough: true, capacity: currentCapacity, required: requiredSmelts }

  const existingFuelName = furnace.fuelItem()?.name || null
  const fuel = chooseFurnaceFuel(existingFuelName)
  if (!fuel) return { enough: false, capacity: currentCapacity, required: requiredSmelts }
  if (existingFuelName && existingFuelName !== fuel.name && furnace.fuelItem()) {
    try {
      await furnace.takeFuel()
      await sleep(150)
      currentCapacity = furnaceFuelCapacity(furnace)
    } catch (err) {
      return { enough: false, capacity: currentCapacity, required: requiredSmelts, error: `could not replace ${existingFuelName}: ${err.message}` }
    }
  }

  const perItem = fuelSmeltCapacity(fuel.name)
  const neededCount = Math.ceil((requiredSmelts - currentCapacity) / perItem)
  const putCount = Math.min(fuel.count, neededCount)
  if (putCount > 0) await furnace.putFuel(fuel.type, fuel.metadata, putCount)
  await sleep(150)
  const capacity = currentCapacity + putCount * perItem
  return { enough: capacity >= requiredSmelts, capacity, required: requiredSmelts, fuel: fuel.name }
}

function furnaceSlotData(item) {
  return item ? { name: item.name, count: item.count, slot: item.slot ?? null } : null
}

function updateFurnaceDebug(furnace, block, status, extra = {}) {
  state.furnaceDebug = {
    status,
    position: block?.position ? positionData(block.position) : null,
    inputSlot: furnaceSlotData(furnace?.inputItem?.()),
    fuelSlot: furnaceSlotData(furnace?.fuelItem?.()),
    outputSlot: furnaceSlotData(furnace?.outputItem?.()),
    fuelSeconds: Number(furnace?.fuelSeconds || 0),
    progress: Number(furnace?.progress || 0),
    updatedAt: appTimestamp(),
    ...extra
  }
}

async function putFurnaceInputReliable(furnace, inputName, count) {
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (furnace.inputItem()?.name === inputName) {
      return { placed: true, attempts: attempt - 1, count: furnace.inputItem().count }
    }
    const input = bot.inventory.items().find(item => item.name === inputName)
    if (!input) return { placed: false, attempts: attempt - 1, error: 'input missing from inventory' }
    try {
      await furnace.putInput(input.type, input.metadata ?? null, Math.min(input.count, count))
      await sleep(700)
      if (furnace.inputItem()?.name === inputName) {
        return { placed: true, attempts: attempt, count: furnace.inputItem().count }
      }
      lastError = new Error('server did not confirm furnace input')
    } catch (err) {
      lastError = err
      await sleep(500)
    }
  }
  return { placed: false, attempts: 3, error: lastError?.message || 'input transfer failed' }
}

async function smeltStep(inputName, outputName, amount) {
  if (hasItem(outputName, amount)) {
    state.smeltingTask = null
    return true
  }
  const taskToken = taskController.active
  if (state.smeltingTask?.nextCheckAt && Date.now() < state.smeltingTask.nextCheckAt) return false
  let furnaceBlock = await findRememberedUtility('furnace')
  if (!furnaceBlock) furnaceBlock = await placeUtilityBlock('furnace')
  if (!furnaceBlock) return false

  try {
    if (furnaceBlock.position.distanceTo(bot.entity.position) > 4) {
      if (!await safeGoto(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 'reaching furnace')) return false
    }
    const furnace = await bot.openFurnace(furnaceBlock)
    if (taskToken && !taskController.isActive(taskToken)) {
      furnace.close()
      return false
    }
    if (furnace.outputItem()) await furnace.takeOutput()
    let existingInput = furnace.inputItem()
    if (existingInput && existingInput.name !== inputName) {
      try {
        await furnace.takeInput()
        await sleep(200)
      } catch (err) {
        state.failedUtilities.furnace = {
          x: furnaceBlock.position.x,
          y: furnaceBlock.position.y,
          z: furnaceBlock.position.z,
          until: Date.now() + 10 * 60 * 1000
        }
        updateFurnaceDebug(furnace, furnaceBlock, 'blocked by different input', {
          blockedByInput: existingInput.name,
          lastTransferError: err.message,
          temporarilyBlocked: state.failedUtilities.furnace
        })
        furnace.close()
        delete worldMemory.utilities.furnace
        saveWorldMemory()
        state.smeltingTask = null
        return false
      }
      existingInput = null
    }
    let input = bot.inventory.items().find(item => item.name === inputName)
    const remaining = Math.max(0, amount - itemCount(outputName))
    const plannedInput = existingInput?.count || Math.min(input?.count || 0, remaining)
    if (plannedInput <= 0) {
      updateFurnaceDebug(furnace, furnaceBlock, 'waiting for input item')
      furnace.close()
      state.smeltingTask = null
      return false
    }
    let inputPlaced = Boolean(furnace.inputItem())
    let inputResult = { placed: inputPlaced, attempts: 0, count: furnace.inputItem()?.count || 0 }
    if (!inputPlaced) {
      inputResult = await putFurnaceInputReliable(furnace, inputName, plannedInput)
      if (taskWasCancelled(taskToken)) {
        furnace.close()
        return false
      }
      inputPlaced = inputResult.placed
    }
    const fuelStatus = inputPlaced
      ? await ensureFurnaceFuel(furnace, furnace.inputItem()?.count || plannedInput)
      : { enough: false, capacity: furnaceFuelCapacity(furnace), required: plannedInput }
    if (taskWasCancelled(taskToken)) {
      furnace.close()
      return false
    }
    const hasFuel = fuelStatus.enough
    rememberUtility('furnace', furnaceBlock, {
      occupied: Boolean(furnace.inputItem() || furnace.outputItem()),
      input: furnace.inputItem()?.name || null,
      output: furnace.outputItem()?.name || null,
      fuel: furnace.fuelItem()?.name || null,
      lastUsedAt: appTimestamp()
    })
    state.smeltingTask = {
      input: inputName,
      output: outputName,
      amount,
      furnace: worldMemory.utilities.furnace,
      waiting: inputPlaced && hasFuel,
      needsFuel: plannedInput > 0 && !hasFuel,
      needsInput: !inputPlaced,
      inputAttempts: inputResult.attempts,
      inputError: inputPlaced ? null : inputResult.error,
      fuelCapacity: Math.floor(fuelStatus.capacity * 10) / 10,
      fuelRequired: plannedInput,
      nextCheckAt: inputPlaced && hasFuel ? Date.now() + Math.max(12000, Math.min(60000, plannedInput * 10000)) : Date.now() + 15000
    }
    updateFurnaceDebug(furnace, furnaceBlock, inputPlaced && hasFuel ? 'smelting' : 'transfer incomplete', {
      inputAttempts: inputResult.attempts,
      lastTransferError: inputPlaced ? null : inputResult.error,
      temporarilyBlocked: state.failedUtilities.furnace || null
    })
    if (!inputPlaced) {
      const failures = (worldMemory.utilities?.furnace?.inputFailures || 0) + 1
      rememberUtility('furnace', furnaceBlock, { inputFailures: failures, lastInputError: inputResult.error })
      if (failures >= 3 && !furnace.inputItem() && !furnace.outputItem()) {
        state.failedUtilities.furnace = {
          x: furnaceBlock.position.x,
          y: furnaceBlock.position.y,
          z: furnaceBlock.position.z,
          until: Date.now() + 10 * 60 * 1000
        }
        delete worldMemory.utilities.furnace
        saveWorldMemory()
        state.smeltingTask.fallback = 'unresponsive furnace forgotten; searching for another'
      }
    } else if (worldMemory.utilities?.furnace?.inputFailures) {
      rememberUtility('furnace', furnaceBlock, { inputFailures: 0, lastInputError: null })
    }
    furnace.close()
  } catch (err) {
    console.log(`Smelting failed (${inputName} -> ${outputName}):`, err.message)
    state.smeltingTask = {
      input: inputName,
      output: outputName,
      amount,
      furnace: worldMemory.utilities?.furnace || null,
      waiting: false,
      needsInput: true,
      error: err.message,
      nextCheckAt: Date.now() + 30000
    }
    state.furnaceDebug = { status: 'error', lastTransferError: err.message, updatedAt: appTimestamp() }
  }
  if (hasItem(outputName, amount)) state.smeltingTask = null
  return hasItem(outputName, amount)
}

async function ensureSmelted(inputName, outputName, amount) {
  if (hasItem(outputName, amount)) return true
  if (state.smeltingTask?.input === inputName && state.smeltingTask?.output === outputName) {
    await smeltStep(inputName, outputName, amount)
    if (hasItem(outputName, amount)) return true
    if (state.smeltingTask?.needsFuel) {
      await ensureFuelSupply(state.smeltingTask.fuelRequired || amount)
      return false
    }
    if (state.smeltingTask?.waiting) return false
  }
  const missing = amount - itemCount(outputName)
  if (itemCount(inputName) < missing) {
    if (state.mode === 'progression') await gatherForProgression(inputName, missing)
    else await gatherItemStep({ item: inputName, amount: missing, announcedMissing: false, nextSearchAt: 0 })
    return false
  }
  return smeltStep(inputName, outputName, amount)
}

function findNearbyContainers(maxDistance = 16, wantedItem = null) {
  if (!mcData || !bot.entity) return []
  const ids = [
    mcData.blocksByName.chest?.id,
    mcData.blocksByName.trapped_chest?.id,
    mcData.blocksByName.barrel?.id
  ].filter(Boolean)
  if (ids.length === 0) return []
  return bot.findBlocks({ matching: ids, maxDistance, count: 32 })
    .map(pos => bot.blockAt(pos))
    .filter(Boolean)
    .sort((left, right) => storageMemoryScore(right, wantedItem) - storageMemoryScore(left, wantedItem) ||
      left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position))
}

function storageMemoryScore(block, wantedItem = null) {
  const remembered = (worldMemory.storage || []).find(entry => locationDistance(entry, block.position) < 2)
  if (!remembered) return 0
  if (wantedItem) {
    return Object.entries(remembered.contents || {})
      .filter(([name]) => itemMatches(wantedItem, name))
      .reduce((total, [, count]) => total + Number(count || 0), 0) * 1000
  }
  return Object.values(remembered.contents || {}).reduce((total, count) => total + Number(count || 0), 0)
}

function rememberContainerContents(block, container, categoryOverride = null) {
  if (!block?.position || !container?.containerItems) return
  const contents = {}
  for (const item of container.containerItems()) contents[item.name] = (contents[item.name] || 0) + item.count
  const categories = {}
  for (const [name, count] of Object.entries(contents)) categories[itemCategory(name)] = (categories[itemCategory(name)] || 0) + count
  const category = categoryOverride || Object.entries(categories).sort(([, left], [, right]) => right - left)[0]?.[0] || null
  rememberWorldLocation('storage', block.position, {
    block: block.name,
    contents,
    category,
    lastInspectedAt: appTimestamp(),
    source: 'container_opened'
  })
}

async function openStorageForCategory(category) {
  const remembered = (worldMemory.storage || [])
    .filter(entry => entry.category === category && locationDistance(entry, bot.entity?.position) <= 32)
    .sort((left, right) => locationDistance(left, bot.entity.position) - locationDistance(right, bot.entity.position))[0]
  if (remembered) {
    const block = bot.blockAt(new Vec3(remembered.x, remembered.y, remembered.z))
    if (block && await safeGoto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), `storage:${category}`)) {
      const container = await bot.openContainer(block)
      container._rememberedBlock = block
      return container
    }
  }
  const assigned = new Set((worldMemory.storage || [])
    .filter(entry => entry.category && entry.category !== category)
    .map(entry => `${entry.dimension || currentDimension()}:${entry.x}:${entry.y}:${entry.z}`))
  for (const block of findNearbyContainers(16)) {
    const key = `${currentDimension()}:${block.position.x}:${block.position.y}:${block.position.z}`
    if (assigned.has(key)) continue
    try {
      if (!await safeGoto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), `storage:${category}`)) continue
      const container = await bot.openContainer(block)
      const known = (worldMemory.storage || []).find(entry => locationDistance(entry, memoryPosition(block.position)) < 2)
      if (container.containerItems().length > 0 && known?.category && known.category !== category) {
        container.close()
        continue
      }
      container._rememberedBlock = block
      container._storageCategory = category
      rememberContainerContents(block, container, category)
      return container
    } catch (err) {
      console.log(`Could not open ${category} storage:`, err.message)
    }
  }
  if (!hasItem('chest')) {
    try {
      await craftSmart('chest')
    } catch (err) {
      logActionError(`Could not craft dedicated ${category} storage`, err)
    }
  }
  const chest = bot.inventory.items().find(item => item.name === 'chest')
  const target = chest && await findOrClearPlacementSpot()
  if (!chest || !target) return null
  try {
    await bot.equip(chest, 'hand')
    await bot.placeBlock(bot.blockAt(target.offset(0, -1, 0)), new Vec3(0, 1, 0))
    const block = bot.blockAt(target)
    const container = await bot.openContainer(block)
    container._rememberedBlock = block
    container._storageCategory = category
    rememberContainerContents(block, container, category)
    return container
  } catch (err) {
    logActionError(`Could not create dedicated ${category} storage`, err)
    return null
  }
}

async function openNearestContainer(index = 0) {
  const containers = findNearbyContainers(16)
  const block = containers[index] || containers[0]
  if (!block) return null
  if (!await safeGoto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), 'reaching container')) return null
  const container = await bot.openContainer(block)
  rememberContainerContents(block, container)
  container._rememberedBlock = block
  return container
}

async function openOrCreateStorageContainer() {
  let container = await openNearestContainer()
  if (container) return container

  if (!hasItem('chest')) {
    try {
      await craftSmart('chest')
    } catch (err) {
      logActionError('Could not craft storage chest', err)
    }
  }
  if (!hasItem('chest')) return null

  const placed = await placeUtilityBlock('chest')
  if (!placed) return null
  const createdContainer = await bot.openContainer(placed)
  createdContainer._rememberedBlock = placed
  rememberContainerContents(placed, createdContainer)
  return createdContainer
}

function isFood(name) {
  return Boolean(FOOD_RULES[name]?.safe)
}

function isEmergencyFood(name) {
  return ['rotten_flesh', 'chicken'].includes(name)
}

function isFoodItem(name) {
  return Boolean(FOOD_RULES[name] || COOKABLE_FOOD[name] || Object.values(COOKABLE_FOOD).includes(name))
}

function foodScore(name) {
  return FOOD_RULES[name]?.score || 0
}

async function autoCookFoodIfUseful() {
  if (state.smeltingTask?.kind === 'food') {
    if (state.smeltingTask.nextCheckAt && Date.now() < state.smeltingTask.nextCheckAt) return false
    if (Date.now() - state.lastAutoCookAt < 5000) return false
    state.lastAutoCookAt = Date.now()
    const task = { ...state.smeltingTask }
    await smeltStep(task.input, task.output, task.amount)
    if (state.smeltingTask?.needsFuel) {
      await ensureFuelSupply(state.smeltingTask.fuelRequired || task.amount)
    }
    if (state.smeltingTask) state.smeltingTask.kind = 'food'
    return true
  }
  if (Date.now() - state.lastAutoCookAt < 15000 || state.smeltingTask) return false
  const raw = bot.inventory.items()
    .filter(item => COOKABLE_FOOD[item.name])
    .sort((left, right) => right.count - left.count)[0]
  if (!raw) return false

  const cookedName = COOKABLE_FOOD[raw.name]
  const hasCookedFood = bot.inventory.items().some(item => isFood(item.name) && foodScore(item.name) >= 5)
  if (hasCookedFood && bot.food > 14 && raw.count < 3) return false
  state.lastAutoCookAt = Date.now()

  if (!hasItem('coal') && !bot.inventory.items().some(item => item.name.endsWith('_planks'))) {
    if (!await ensureWood()) return false
    await craftAvailablePlanks()
  }
  if (!hasItem('furnace') && !await hasAvailableFurnace()) {
    if (!hasItem('cobblestone', 8)) return false
    await craftWithTable('furnace')
  }

  setCurrentTask('cooking', `cooking ${raw.name}`, { target: cookedName })
  await smeltStep(raw.name, cookedName, raw.count)
  if (state.smeltingTask?.needsFuel) {
    await ensureFuelSupply(state.smeltingTask.fuelRequired || raw.count)
  }
  if (state.smeltingTask) state.smeltingTask.kind = 'food'
  return true
}

function hasMemoryEvidenceNear(entry, names, radius = 6) {
  if (!mcData || !bot.entity) return null
  const ids = blockIds(names)
  if (!ids.length) return false
  const positions = bot.findBlocks({
    matching: ids,
    maxDistance: Math.min(48, Math.ceil(locationDistance(entry, bot.entity.position) + radius)),
    count: 128
  })
  return positions.some(position => locationDistance(position, entry) <= radius)
}

function validateWorldMemoryNearby() {
  if (!mcData || !bot.entity) return false
  const rememberedBefore = ['storage', 'farms', 'strongholds', 'villages', 'mines', 'bases', 'caves']
    .reduce((total, type) => total + (worldMemory[type]?.length || 0), 0)
  const validators = {
    storage: entry => hasMemoryEvidenceNear(entry, ['chest', 'barrel', 'trapped_chest'], 3),
    dangerZones: entry => hasMemoryEvidenceNear(entry, ['lava', 'fire', 'magma_block', 'cactus', 'powder_snow'], 4),
    farms: entry => hasMemoryEvidenceNear(entry, ['farmland', 'wheat', 'carrots', 'potatoes', 'beetroots'], 8),
    strongholds: entry => hasMemoryEvidenceNear(entry, ['end_portal_frame', 'end_portal'], 10),
    villages: entry => hasMemoryEvidenceNear(entry, ['bell', 'composter', 'lectern', 'smithing_table', 'blast_furnace', 'cartography_table', 'stonecutter', 'loom'], 16),
    mines: entry => hasMemoryEvidenceNear(entry, ['rail', 'cobweb', 'oak_planks', 'oak_fence'], 12),
    bases: entry => hasMemoryEvidenceNear(entry, ['chest', 'barrel', 'crafting_table', 'furnace', 'bed'], 12),
    caves: entry => {
      const block = bot.blockAt(new Vec3(entry.x, entry.y, entry.z))
      return block ? block.boundingBox === 'empty' : null
    }
  }
  let changed = false
  for (const [type, validate] of Object.entries(validators)) {
    worldMemory[type] = (worldMemory[type] || []).filter(entry => {
      if (locationDistance(entry, bot.entity.position) > 32) return true
      const result = validate(entry)
      if (result === null) return true
      entry.lastValidatedAt = appTimestamp()
      if (result) {
        if (entry.validationMisses || entry.stale) changed = true
        entry.validationMisses = 0
        entry.stale = false
        return true
      }
      entry.validationMisses = (entry.validationMisses || 0) + 1
      entry.stale = true
      changed = true
      return entry.validationMisses < 3
    })
  }

  const deathCutoff = Date.now() - 30 * 60 * 1000
  const previousDeaths = worldMemory.deathLocations.length
  worldMemory.deathLocations = worldMemory.deathLocations.filter(entry => {
    const timestamp = Date.parse(entry.at || entry.lastSeenAt || 0)
    return !Number.isFinite(timestamp) || timestamp >= deathCutoff
  })
  if (worldMemory.deathLocations.length !== previousDeaths) changed = true
  const rememberedAfter = ['storage', 'farms', 'strongholds', 'villages', 'mines', 'bases', 'caves']
    .reduce((total, type) => total + (worldMemory[type]?.length || 0), 0)
  if (rememberedBefore >= 3 && rememberedBefore - rememberedAfter >= 3 && Date.now() - state.lastWorldResetWarningAt > 10 * 60 * 1000) {
    state.lastWorldResetWarningAt = Date.now()
    bot.chat(`World memory warning: several known locations disappeared. Check whether World ID "${botSettings.worldId}" still matches this world.`)
    recordChat('system', 'World memory', `Possible world reset detected for ${worldMemoryId()}`)
  }
  if (changed) saveWorldMemory()
  return changed
}


function itemNameFromId(id) {
  return mcData?.items[id]?.name || mcData?.blocks[id]?.name || `id_${id}`
}

function normalizeRecipeItem(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return itemNameFromId(value)
  if (typeof value === 'object') return itemNameFromId(value.id ?? value.type)
  return String(value)
}

function uniqueRecipeNames(values) {
  return [...new Set(values.map(normalizeRecipeItem).filter(Boolean))].sort()
}

function recipeNeedsCraftingTable(recipe) {
  if (recipe.inShape?.length) {
    const width = Math.max(...recipe.inShape.map(row => row.length))
    return recipe.inShape.length > 2 || width > 2
  }
  return (recipe.ingredients?.length || 0) > 4
}

function describeCraftingRecipe(output, recipe) {
  const ingredients = recipe.inShape?.length
    ? uniqueRecipeNames(recipe.inShape.flat())
    : uniqueRecipeNames(recipe.ingredients || [])
  return {
    output,
    count: recipe.result?.count || 1,
    station: recipeNeedsCraftingTable(recipe) ? 'crafting_table' : 'inventory',
    ingredients
  }
}

function cookingRecipe(input, output, stations) {
  return {
    output,
    count: 1,
    station: stations.join(', '),
    ingredients: [input]
  }
}

function knownCookingRecipes() {
  const recipes = [
    cookingRecipe('raw_iron', 'iron_ingot', ['furnace', 'blast_furnace']),
    cookingRecipe('iron_ore', 'iron_ingot', ['furnace', 'blast_furnace']),
    cookingRecipe('deepslate_iron_ore', 'iron_ingot', ['furnace', 'blast_furnace']),
    cookingRecipe('raw_gold', 'gold_ingot', ['furnace', 'blast_furnace']),
    cookingRecipe('gold_ore', 'gold_ingot', ['furnace', 'blast_furnace']),
    cookingRecipe('deepslate_gold_ore', 'gold_ingot', ['furnace', 'blast_furnace']),
    cookingRecipe('nether_gold_ore', 'gold_ingot', ['furnace', 'blast_furnace']),
    cookingRecipe('raw_copper', 'copper_ingot', ['furnace', 'blast_furnace']),
    cookingRecipe('copper_ore', 'copper_ingot', ['furnace', 'blast_furnace']),
    cookingRecipe('deepslate_copper_ore', 'copper_ingot', ['furnace', 'blast_furnace']),
    cookingRecipe('sand', 'glass', ['furnace']),
    cookingRecipe('red_sand', 'glass', ['furnace']),
    cookingRecipe('cobblestone', 'stone', ['furnace']),
    cookingRecipe('stone', 'smooth_stone', ['furnace']),
    cookingRecipe('clay_ball', 'brick', ['furnace']),
    cookingRecipe('clay', 'terracotta', ['furnace']),
    cookingRecipe('netherrack', 'nether_brick', ['furnace']),
    cookingRecipe('wet_sponge', 'sponge', ['furnace']),
    cookingRecipe('cactus', 'green_dye', ['furnace']),
    cookingRecipe('sea_pickle', 'lime_dye', ['furnace']),
    cookingRecipe('chorus_fruit', 'popped_chorus_fruit', ['furnace']),
    cookingRecipe('kelp', 'dried_kelp', ['furnace']),
    cookingRecipe('beef', 'cooked_beef', ['furnace', 'smoker']),
    cookingRecipe('porkchop', 'cooked_porkchop', ['furnace', 'smoker']),
    cookingRecipe('chicken', 'cooked_chicken', ['furnace', 'smoker']),
    cookingRecipe('mutton', 'cooked_mutton', ['furnace', 'smoker']),
    cookingRecipe('rabbit', 'cooked_rabbit', ['furnace', 'smoker']),
    cookingRecipe('cod', 'cooked_cod', ['furnace', 'smoker']),
    cookingRecipe('salmon', 'cooked_salmon', ['furnace', 'smoker']),
    cookingRecipe('potato', 'baked_potato', ['furnace', 'smoker'])
  ]

  const logNames = Object.keys(mcData?.itemsByName || {}).filter(name => name.endsWith('_log') || name.endsWith('_stem'))
  for (const name of logNames) recipes.push(cookingRecipe(name, 'charcoal', ['furnace']))
  return recipes.filter(recipe => mcData.itemsByName[recipe.output] && recipe.ingredients.every(name => mcData.itemsByName[name] || mcData.blocksByName[name]))
}

function buildRecipeBook() {
  if (!mcData) return recipeBook
  const recipesByKey = new Map()

  for (const [id, recipes] of Object.entries(mcData.recipes || {})) {
    const output = itemNameFromId(Number(id))
    if (!mcData.itemsByName[output]) continue
    for (const recipe of recipes) {
      const entry = describeCraftingRecipe(output, recipe)
      const key = `${entry.station}:${entry.output}:${entry.ingredients.join('+')}`
      recipesByKey.set(key, entry)
    }
  }

  for (const recipe of knownCookingRecipes()) {
    const key = `${recipe.station}:${recipe.output}:${recipe.ingredients.join('+')}`
    recipesByKey.set(key, recipe)
  }

  return {
    version: bot.version,
    updatedAt: appTimestamp(),
    recipes: [...recipesByKey.values()].sort((left, right) => left.output.localeCompare(right.output))
  }
}

function refreshRecipeBook() {
  recipeBook = buildRecipeBook()
  saveRecipeBook()
  return recipeBook
}

function knownRecipeNames() {
  return recipeBook.recipes.map(recipe => recipe.output)
}

function showRecipeSummary() {
  const book = refreshRecipeBook()
  bot.chat(`I have ${book.recipes.length} recipes saved in ai-recipes.json.`)
}

function itemCategory(name) {
  const categories = knowledge.items?.categories || {}
  const matchesKnownCategory = category => (categories[category] || []).some(token => name === token || name.includes(token))
  if (isFoodItem(name)) return 'Food'
  if (matchesKnownCategory('tools') || /_(pickaxe|axe|shovel|hoe)$/.test(name) || ['shears', 'fishing_rod', 'flint_and_steel'].includes(name)) return 'Tools'
  if (matchesKnownCategory('weapons') || /_(sword|bow|crossbow|trident)$/.test(name) || ['shield', 'arrow'].includes(name)) return 'Weapons'
  if (matchesKnownCategory('armor') || /_(helmet|chestplate|leggings|boots)$/.test(name)) return 'Armor'
  if (matchesKnownCategory('stations') || ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'enchanting_table', 'grindstone', 'stonecutter', 'brewing_stand', 'chest', 'barrel'].includes(name)) return 'Stations'
  if (['rotten_flesh', 'bone', 'string', 'spider_eye', 'gunpowder', 'slime_ball', 'ender_pearl', 'blaze_rod', 'ghast_tear', 'phantom_membrane', 'leather', 'feather', 'rabbit_hide', 'rabbit_foot'].includes(name)) return 'Mob Drops'
  if (fuelSmeltCapacity(name) > 0) return 'Fuel'
  if (/(coal|raw_iron|raw_gold|raw_copper|iron_ingot|gold_ingot|copper_ingot|diamond|emerald|lapis|redstone|quartz|ore|ancient_debris|netherite)/.test(name)) return 'Ores & Valuables'
  if (/(seeds|wheat|carrot|potato|beetroot|sapling|bone_meal)/.test(name)) return 'Farming'
  if (/(log|planks|stone|cobblestone|deepslate|dirt|sand|gravel|brick|glass|wool|concrete|terracotta)/.test(name)) return 'Blocks'
  if (/(stick|flint|paper|book|string|leather|feather|bucket|bottle)/.test(name)) return 'Materials'
  if (/(boat|minecart|saddle|elytra)/.test(name)) return 'Transport'
  return 'Other'
}

function keepItem(item) {
  if (!item?.name) return false
  if (isFoodItem(item.name)) return true
  if (/(diamond|netherite|elytra|totem_of_undying|enchanted_book)/.test(item.name)) return true
  if (durabilityInfo(item) && durabilityInfo(item).ratio <= 0.15) return true
  const categories = knowledge.items?.categories || {}
  return Object.values(categories).some(entries => (entries || []).some(entry => {
    const token = String(entry || '').trim()
    if (!token) return false
    return item.name === token || item.name.includes(token)
  }))
}

function inventorySlotsUsed() {
  return bot.inventory.items().length
}

function inventoryFreeSlots() {
  if (typeof bot.inventory.emptySlotCount === 'function') return bot.inventory.emptySlotCount()
  return Math.max(0, 36 - inventorySlotsUsed())
}

function activeTaskNeeds(item) {
  return Boolean(
    (state.gatherTask && itemMatches(state.gatherTask.item, item.name)) ||
    (state.progressionGatherTask && itemMatches(state.progressionGatherTask.item, item.name)) ||
    (state.miningTask?.item && state.miningTask.item !== 'mixed_ores' && itemMatches(state.miningTask.item, item.name))
  )
}

function autoStorageCount(item, aggressive) {
  if (activeTaskNeeds(item) || keepItem(item)) return 0
  if (['rotten_flesh', 'poisonous_potato', 'spider_eye'].includes(item.name)) return item.count
  if (item.name === 'dirt') return Math.max(0, item.count - 32)
  if (['cobblestone', 'stone', 'cobbled_deepslate', 'sand', 'gravel'].includes(item.name)) {
    return Math.max(0, item.count - 64)
  }
  return aggressive ? item.count : 0
}

async function tossUnneededInventory(aggressive = false) {
  let tossed = 0
  for (const item of [...bot.inventory.items()]) {
    const count = autoStorageCount(item, aggressive)
    if (count <= 0) continue
    try {
      await bot.toss(item.type, null, count)
      state.pickupIgnoreUntilByName[item.name] = Date.now() + 10000
      tossed += count
    } catch (err) {
      logActionError(`Could not drop ${item.name}`, err)
    }
    if (inventorySlotsUsed() <= 30 || inventoryFreeSlots() >= 4) break
  }
  return tossed
}

async function autoStoreIfNeeded() {
  if (inventorySlotsUsed() < 34 && inventoryFreeSlots() > 2) return false
  if (Date.now() - state.lastAutoStorageAt < 15000) return false
  state.lastAutoStorageAt = Date.now()
  let container = await openOrCreateStorageContainer()
  if (!container) {
    const tossed = await tossUnneededInventory(false) || await tossUnneededInventory(true)
    if (tossed > 0) {
      bot.chat(`Inventory almost full: dropped ${tossed} low-value items because no storage was available.`)
      return true
    }
    bot.chat('My inventory is full and I cannot find, craft, or place storage. I need a chest/barrel nearby.')
    setCurrentTask('inventory', 'blocked by full inventory')
    return true
  }

  let stored = 0
  for (const aggressive of [false, true]) {
    for (const item of [...bot.inventory.items()]) {
      const count = autoStorageCount(item, aggressive)
      if (count <= 0) continue
      try {
        await container.deposit(item.type, null, count)
        stored += count
      } catch (err) {
        logActionError(`Could not store ${item.name}`, err)
      }
      if (inventorySlotsUsed() <= 30) break
    }
    if (inventorySlotsUsed() <= 30) break
  }
  rememberContainerContents(container._rememberedBlock, container)
  container.close()
  if (stored > 0) bot.chat(`Inventory almost full: ${stored} unnecessary items stored.`)
  if (stored > 0) return true

  const tossed = await tossUnneededInventory(false)
  if (tossed > 0) {
    bot.chat(`Inventory almost full: dropped ${tossed} low-value items after storage had nothing useful to take.`)
    return true
  }
  setCurrentTask('inventory', 'inventory full with protected items')
  return false
}

async function depositInventory(onlyJunk) {
  const container = await openNearestContainer()
  if (!container) return bot.chat('No chest or barrel found nearby.')

  for (const item of bot.inventory.items()) {
    const excessCobble = item.name === 'cobblestone' && item.count > 64
    const junk = ['dirt', 'rotten_flesh'].includes(item.name) || excessCobble
    if ((onlyJunk && !junk) || (!onlyJunk && keepItem(item))) continue
    const count = excessCobble ? item.count - 64 : item.count
    try {
      await container.deposit(item.type, null, count)
    } catch (err) {
      logActionError(`Could not deposit ${item.name}`, err)
    }
  }
  rememberContainerContents(container._rememberedBlock, container)
  container.close()
  bot.chat(onlyJunk ? 'Junk cleaned up.' : 'Inventory saved.')
}

async function dumpJunk() {
  const hasContainer = findNearbyContainers(16).length > 0
  if (hasContainer) return depositInventory(true)

  const tossed = await tossUnneededInventory(false)
  bot.chat(tossed > 0 ? `Junk thrown away: ${tossed} items.` : 'No safe junk to throw away.')
}

async function sortStorage() {
  const groups = Object.groupBy(
    [...bot.inventory.items()].filter(item => !keepItem(item)),
    item => itemCategory(item.name)
  )
  for (const [category, items] of Object.entries(groups)) {
    const container = await openStorageForCategory(category)
    if (!container) continue
    for (const item of items) {
      try {
        await container.deposit(item.type, null, item.count)
      } catch (err) {
        console.log(`Could not sort ${item.name} into ${category}:`, err.message)
      }
    }
    rememberContainerContents(container._rememberedBlock, container, category)
    container.close()
  }
  bot.chat('Storage sorted into separate category containers where space was available.')
}

async function ensureCobblestone(count) {
  while (!hasItem('cobblestone', count)) {
    const block = findUsefulBlock(mcData.blocksByName.stone.id, 48)
    if (!block) return bot.chat('I cannot find any stone.')
    if (!await mineVisibleBlock(block, 'collecting cobblestone')) return false
    addSkill('mining')
  }
}

async function defendAgainst(entity) {
  if (!entity || !isHostileMob(entity)) return
  const taskToken = taskController.active
  bumpKnowledgeStat('combat', 'encounters', entity.name || 'unknown')
  recordLearning('combat', 'mobs', entity.name || 'unknown', 1, 'encountered hostile')
  if (state.combatTraining) setCurrentTask('training', `combat practice against ${entity.name}`, { target: entity.name })
  equipBestWeapon()
  equipShieldIfAvailable()
  if (!state.mode.startsWith('defense:')) state.resumeMode = state.mode
  state.mode = `defense:${entity.name}`
  const strategy = eliteMode
    ? ELITE_MOB_KNOWLEDGE[entity.name]?.strategy || knowledge.combat.strategies?.[entity.name] || knowledge.combat.strategies?.default || null
    : knowledge.combat.strategies?.[entity.name] || knowledge.combat.strategies?.default || null
  state.currentCombat = {
    mob: entity.name,
    strategy,
    weapon: bestWeaponName(),
    armor: equippedArmorNames(),
    startedAt: Date.now()
  }
  if (eliteMode && await combatBrain.tick(entity)) return true
  const distance = entity.position.distanceTo(bot.entity.position)
  if (eliteMode && entity.name === 'warden') {
    setCurrentTask('combat', 'avoiding warden and preserving life', { target: entity.name })
    return retreatFromEliteThreat(entity, taskToken)
  }
  if (eliteMode && bot.health < 12) return retreatAndHeal(entity, taskToken)
  if (bot.health < 8 || entity.name === 'creeper') {
    bot.setControlState('back', true)
    bot.setControlState(Math.random() > 0.5 ? 'left' : 'right', true)
  }
  if (hasRangedCombat() && distance > (eliteMode ? 5 : 7) && distance < 32 && entity.name !== 'enderman') {
    if (await fireRangedWeapon(entity)) return true
    if (taskWasCancelled(taskToken)) return false
  }
  if (entity.name === 'creeper' || /retreat|kite|back away/i.test(strategy || '')) bot.setControlState('back', true)
  if (entity.name === 'skeleton' || /strafe|zigzag/i.test(strategy || '')) {
    bot.setControlState(strategy === 'zigzag_left' ? 'left' : strategy === 'zigzag_right' ? 'right' : Math.random() > 0.5 ? 'left' : 'right', true)
  }
  if (/rush/i.test(strategy || '')) bot.setControlState('forward', true)
  if (!await approachCombatTarget(entity)) return finishFailedDefense()
  if (taskWasCancelled(taskToken)) return finishFailedDefense()
  await bot.lookAt(entity.position.offset(0, 1, 0), true)
  if (!canHitEntity(entity)) {
    return finishFailedDefense()
  }
  bot.pvp.attack(entity)
  return true
}

function finishFailedDefense() {
  if (state.mode.startsWith('defense:')) {
    const mob = state.mode.slice('defense:'.length)
    bumpNestedStat(knowledge.combat.stats, 'failedFights')
    recordLearning('combat', 'mobs', mob, -2, 'failed to reach or hit target')
    if (state.currentCombat?.strategy) recordLearning('combat', 'tactics', `${mob}:${state.currentCombat.strategy}`, -2, 'failed defense')
    if (state.currentCombat?.weapon) recordLearning('combat', 'weapons', state.currentCombat.weapon, -1, 'failed defense')
  }
  bot.pvp.stop()
  bot.clearControlStates()
  state.mode = state.resumeMode || 'idle'
  state.resumeMode = null
  state.currentCombat = null
  return false
}

function startCombatLearning() {
  autonomy.enabled = true
  state.manualControlOnly = false
  autonomy.focus = 'combat'
  state.combatTraining = true
  state.mode = 'combat_training'
  saveMemory()
  updatePlanner('training combat', 'find safe hostile combat practice', 'ai combat learn')
  bot.chat('Combat learning enabled. I will train against hostile mobs, track success rate and learn from deaths.')
}

function combatMetrics() {
  const stats = knowledge.combat.stats ||= {}
  const wins = Number(stats.finishedFights || 0)
  const losses = Number(stats.failedFights || 0) + Number(stats.deaths || 0)
  const total = wins + losses
  return {
    wins,
    losses,
    successRate: total ? Math.round((wins / total) * 100) : 0,
    deathsByCause: stats.deathsByCause || {},
    current: state.currentCombat,
    training: state.combatTraining || autonomy.focus === 'combat'
  }
}

async function runPriorities() {
  if (!minecraftConnected || !bot.entity || state.busy || state.hardStopped) return
  if (!taskController.active && autonomy.enabled) taskController.begin(`autonomy:${state.mode}`, 'autonomy')
  const taskToken = taskController.active
  const priorityVersion = state.stopVersion
  const cancelled = () => priorityVersion !== state.stopVersion || state.hardStopped || (taskToken && !taskController.isActive(taskToken))
  state.busy = true
  state.busySince = Date.now()
  state.lastPriorityAt = state.busySince
  try {
    state.lastInventorySnapshot = inventorySnapshot()
    // Info: Een schematic houdt exclusief controle over normale beweging; food en saturation onderbreken de bouw niet.
    const reliableTaskActive = Boolean(reliableTaskManager.active)
    const schematicTaskActive = reliableTaskManager.active?.goal === 'build_schematic'
    if (!schematicTaskActive && !state.hitmanTask && (bot.food <= 6 || bot.health <= 8)) {
      if (await eatFoodIfNeeded({ force: true })) return
      updatePlanner('food emergency', 'find or produce food before continuing other tasks', 'critical food or health')
      startFarmMode()
      // Info: Alleen de modus instellen deed niets; voer in dezelfde noodcyclus ook werkelijk een voedselzoek- of farmstap uit.
      await runFarmStep()
      return
    }
    if (state.recovering) {
      await processDeathRecovery()
      return
    }
    if (state.hitmanTask) {
      await runHitmanStep()
      return
    }
    if (eliteMode && await eliteEmergencySurvival({ ignoreFood:schematicTaskActive })) return
    if (!schematicTaskActive) await eatFoodIfNeeded()
    if (cancelled()) return
    if (state.guardTask) {
      await runGuardStep()
      return
    }

    if (eliteMode && playerPvpEnabled) {
      const playerTarget = combatBrain.bestTarget(18) || bestElitePlayerTarget(18)
      if (playerTarget && await combatBrain.tick(playerTarget)) return
    }

    const hostile = bestEliteHostileTarget(knowledge.combat.rules?.hostileRange || 12)
    if (hostile) {
      await defendAgainst(hostile)
      return
    }

    // Info: Terwijl een betrouwbare taak loopt, mogen loot-, farm- en planner-routines geen tweede padfinderdoel starten.
    if (reliableTaskActive) return

    // Info: Na directe gevaren wordt loot opgepakt vóór de bot een nieuwe route of productietaak start.
    if (await pickupNearbyUsefulDrop()) return
    if (cancelled()) return
    if (Date.now() < state.navigationBlockedUntil) {
      setCurrentTask('waiting', 'navigation cooling down after repeated failures')
      return
    }

    const manualPriorityActive = Date.now() < state.manualPriorityUntil
    if (!state.manualControlOnly) {
      if (Date.now() - state.lastWorldScanAt > worldScanIntervalMs) {
        state.lastWorldScanAt = Date.now()
        await scanWorldFeatures({ force: true })
        if (cancelled()) return
      }
      if (await mineNearbyEliteUpgradeResource()) return
      if (cancelled()) return
      if (await serviceToolRepair()) return
      if (cancelled()) return
      if (await mineNearbyNeededResource()) return
      if (cancelled()) return
      await equipBestArmor()
      if (cancelled()) return
      if (await serviceRememberedFurnace()) return
      if (cancelled()) return
      if (await autoCookFoodIfUseful()) return
      if (cancelled()) return
      if (await autoStoreIfNeeded()) return
      if (cancelled()) return
    }
    if ((eliteMode && state.pathGoal) || ['travel', 'follow'].includes(state.mode)) {
      if (await useBoatOnWater()) return
      if (eliteMode) eliteSwimTowardRoute()
    }
    if (state.mode === 'follow' && state.owner) {
      const player = bot.players[state.owner]?.entity
      if (player) bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true)
    }
    if (state.mode === 'gather' && state.gatherTask) await gatherItemStep(state.gatherTask)
    if (cancelled()) return
    if (state.mode === 'progression') await workOnProgression()
    if (cancelled()) return
    if (state.mode === 'explore') runExplorationStep()
    if (state.mode === 'farm') {
      await runFarmStep()
    }
    if (cancelled()) return
    if (['smart_mining', 'cave'].includes(state.mode)) await runSmartMiningStep()
    if (cancelled()) return
    if (state.mode === 'beat_minecraft') await runBeatMinecraftStep()
    if (cancelled()) return
    if (state.mode === 'idle' && autonomy.enabled && !manualPriorityActive) await runAutonomousPlanner()
  } finally {
    if (state.busySince === state.lastPriorityAt) {
      state.busy = false
      state.busySince = 0
      state.actionRecoveryPendingAt = 0
      state.actionRecoveryBusySince = 0
    }
  }
}

function logActionError(action, err) {
  const message = err?.message || String(err)
  console.log(`${action}:`, message)
  recordChat('system', 'Runtime', `${action}: ${message}`)
}

// Info: Deze high-level skill bouwt alleen de door de Hub toegewezen schematicblokken en valideert ieder doelblok in Minecraft.
async function buildSchematicAssignment(context = {}) {
  const origin=context.target?.origin,blocks=Array.isArray(context.target?.blocks)?context.target.blocks:[]
  if(!origin||!blocks.length)return skillResult.failure(ErrorCodes.TARGET_MISSING,false)
  // Info: Omdat de lus achterstevoren verwijdert, zet deze sortering de laagste steunblokken als eerste aan de beurt.
  const pending=blocks.map(block=>({...block,target:new Vec3(Number(origin.x)+block.x,Number(origin.y)+block.y,Number(origin.z)+block.z)})).sort((a,b)=>b.target.y-a.target.y)
  const targetKeys=new Set(pending.map(entry=>`${entry.target.x},${entry.target.y},${entry.target.z}`)),temporarySupports=[],problems=[]
  const rememberProblem=(entry,reason,error=null)=>{if(problems.length<20)problems.push({position:positionData(entry.target),block:entry.name,reason,error:error?shortError(error):null})}
  const faces=[new Vec3(0,1,0),new Vec3(0,-1,0),new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)]
  const referenceFor=target=>faces.map(direction=>({direction,block:bot.blockAt(target.minus(direction))})).find(value=>value.block&&value.block.boundingBox==='block')
  const buildTemporarySupport=async entry=>{
    const below=entry.target.offset(0,-1,0)
    if(targetKeys.has(`${below.x},${below.y},${below.z}`))return false
    const supportItem=bot.inventory.items().find(item=>['dirt','cobblestone','netherrack','stone','deepslate','oak_planks','spruce_planks','birch_planks'].includes(item.name))
    if(!supportItem)return false
    let base=null
    for(let depth=1;depth<=8;depth++){const candidate=bot.blockAt(entry.target.offset(0,-depth,0));if(candidate?.boundingBox==='block'){base=candidate;break}}
    if(!base)return false
    for(let y=base.position.y+1;y<entry.target.y;y++){
      const position=new Vec3(entry.target.x,y,entry.target.z),current=bot.blockAt(position)
      if(current?.boundingBox==='block')continue
      try{await bot.equip(supportItem,'hand');const reference=bot.blockAt(position.offset(0,-1,0));if(!reference||reference.boundingBox!=='block')return false;await bot.placeBlock(reference,new Vec3(0,1,0));if(bot.blockAt(position)?.boundingBox!=='block')return false;temporarySupports.push({position,name:supportItem.name})}catch(error){rememberProblem(entry,'SUPPORT_PLACE_FAILED',error);return false}
    }
    return Boolean(referenceFor(entry.target))
  }
  let placed=0
  for(let pass=0;pass<3&&pending.length;pass++){
    let progress=0
    for(let index=pending.length-1;index>=0;index--){
      if(context.signal?.aborted)return skillResult.failure(ErrorCodes.CANCELLED,false,{placed,remaining:pending.length})
      if(bot.health<botSettings.safety.minimumHealth)return skillResult.failure(ErrorCodes.UNSAFE_ENVIRONMENT,true,{placed,remaining:pending.length})
      const entry=pending[index],current=bot.blockAt(entry.target)
      if(current?.name===entry.name){pending.splice(index,1);continue}
      let item=bot.inventory.items().find(value=>value.name===entry.name)
      // Info: In creative krijgt de bot het benodigde goedgekeurde palette-item; survival gebruikt alleen werkelijk verzamelde materialen.
      if(!item&&bot.game?.gameMode==='creative'&&bot.creative?.setInventorySlot){
        const itemType=bot.registry?.itemsByName?.[entry.name]
        if(itemType){try{const Item=require('prismarine-item')(bot.version);await bot.creative.setInventorySlot(36,new Item(itemType.id,64));item=bot.inventory.items().find(value=>value.name===entry.name)}catch{}}
      }
      if(!item){rememberProblem(entry,'MISSING_MATERIAL');continue}
      if(entry.target.distanceTo(bot.entity.position)>4.5&&!await safeGoto(new goals.GoalNear(entry.target.x,entry.target.y,entry.target.z,3),`schematic:${entry.name}`,false)){rememberProblem(entry,'PATH_FAILED');continue}
      const occupied=bot.blockAt(entry.target)
      if(occupied&&occupied.name!=='air'&&occupied.boundingBox!=='empty'){
        if(typeof bot.canDigBlock==='function'&&!bot.canDigBlock(occupied)){rememberProblem(entry,'TARGET_BLOCKED');continue}
        try{await bot.dig(occupied,true)}catch(error){rememberProblem(entry,'TARGET_CLEAR_FAILED',error);continue}
        if(bot.blockAt(entry.target)?.boundingBox==='block'){rememberProblem(entry,'TARGET_STILL_BLOCKED');continue}
      }
      let reference=referenceFor(entry.target)
      if(!reference&&await buildTemporarySupport(entry))reference=referenceFor(entry.target)
      if(!reference){rememberProblem(entry,'NO_SUPPORT_FACE');continue}
      try{await bot.equip(item,'hand');await bot.placeBlock(reference.block,reference.direction);if(bot.blockAt(entry.target)?.name===entry.name){pending.splice(index,1);placed++;progress++}else rememberProblem(entry,'BLOCK_NOT_CONFIRMED')}catch(error){rememberProblem(entry,'PLACE_FAILED',error)}
    }
    if(!progress)break
  }
  if(!pending.length){
    for(const support of temporarySupports.reverse()){
      if(targetKeys.has(`${support.position.x},${support.position.y},${support.position.z}`))continue
      const block=bot.blockAt(support.position)
      if(block?.name===support.name){try{if(block.position.distanceTo(bot.entity.position)>4.5)await safeGoto(new goals.GoalNear(block.position.x,block.position.y,block.position.z,3),'remove schematic support',false);await bot.dig(block,true)}catch(error){problems.push({position:positionData(support.position),reason:'SUPPORT_CLEANUP_FAILED',error:shortError(error)})}}
    }
    const invalid=blocks.filter(block=>bot.blockAt(new Vec3(Number(origin.x)+block.x,Number(origin.y)+block.y,Number(origin.z)+block.z))?.name!==block.name)
    if(!invalid.length)return skillResult.success({placed,schematicId:context.target.schematicId})
    return skillResult.failure(ErrorCodes.VALIDATION_FAILED,true,{placed,remaining:invalid.length,problems:[...problems,{reason:'FINAL_WORLD_VALIDATION_FAILED',count:invalid.length}]})
  }
  const missing=[...new Set(pending.filter(entry=>!bot.inventory.items().some(item=>item.name===entry.name)).map(entry=>entry.name))]
  return skillResult.failure(missing.length?ErrorCodes.INSUFFICIENT_ITEMS:ErrorCodes.VALIDATION_FAILED,true,{placed,remaining:pending.length,missingMaterials:missing,problems})
}

// Info: Teamlogistiek gebruikt een expliciete wereldgebonden kist en valideert de echte containerinhoud.
async function depositTeamItems(target, destination) {
  const amount = Math.max(1, Number(target.amount || 1))
  const beforeInventory = itemCount(target.item)
  if (beforeInventory < amount) return skillResult.failure(ErrorCodes.INSUFFICIENT_ITEMS, true, { expected:amount,actual:beforeInventory })
  const position = new Vec3(Number(destination.x), Number(destination.y), Number(destination.z))
  if (!await safeGoto(new goals.GoalNear(position.x, position.y, position.z, 2), 'team logistics chest')) return skillResult.failure(ErrorCodes.PATH_FAILED, true)
  const block = bot.blockAt(position)
  if (!block || !['chest','barrel','trapped_chest'].includes(block.name)) return skillResult.failure(ErrorCodes.TARGET_MISSING, true, { position:positionData(position) })
  let container
  try {
    container = await bot.openContainer(block)
    const beforeContainer = container.containerItems().filter(item => item.name === target.item).reduce((sum,item)=>sum+item.count,0)
    const inventoryItem = bot.inventory.items().find(item => item.name === target.item)
    await container.deposit(inventoryItem.type, inventoryItem.metadata ?? null, amount)
    const contents = Object.fromEntries(container.containerItems().map(item => [item.name, container.containerItems().filter(entry=>entry.name===item.name).reduce((sum,entry)=>sum+entry.count,0)]))
    const afterContainer = Number(contents[target.item] || 0)
    const afterInventory = itemCount(target.item)
    if (afterContainer < beforeContainer + amount || afterInventory > beforeInventory - amount) return skillResult.failure(ErrorCodes.VALIDATION_FAILED, true, { beforeContainer,afterContainer,beforeInventory,afterInventory })
    rememberContainerContents(block, container)
    return skillResult.success({ container:{ id:`${identity.worldId}:${block.name}:${position.x}:${position.y}:${position.z}`,worldId:identity.worldId,position:positionData(position),type:block.name,contents } }, { itemsGained:{} })
  } catch (error) {
    return skillResult.failure(ErrorCodes.VALIDATION_FAILED, true, { error:error.message })
  } finally { try { container?.close() } catch {} }
}

function plannerTaskControllerBlocked() {
  const active = taskController.active
  if (!active) return false
  return active.source !== 'autonomy'
}

async function runPlannerBrainTick() {
  if (!minecraftConnected || !bot.entity) return false
  if (!autonomy.enabled || state.busy || state.hardStopped || state.manualControlOnly) return false
  if (plannerTaskControllerBlocked()) return false
  if (state.hitmanTask || state.guardTask || state.recovering || state.combatRetreating) return false
  if (state.mode && !['idle', 'progression'].includes(state.mode)) return false

  const situation = perceptionBrain.perceive()
  const plan = plannerBrain.choose(situation)
  if (!plan?.action) return false

  const plannerLogKey = `${plan.goal}/${plan.action}/${plan.reason}`
  if (plannerLogKey !== lastPlannerLogKey || Date.now() - lastPlannerLogAt >= 60000) {
    console.log(`[Planner] ${plannerLogKey} | score=${Math.round(plan.score ?? plan.priority ?? 0)} reward=${Math.round(plan.reward ?? 0)} risk=${Math.round(plan.risk ?? 0)} time=${Math.round(plan.timeCost ?? 0)}`)
    lastPlannerLogKey = plannerLogKey
    lastPlannerLogAt = Date.now()
  }
  const skillPlans = {
    heal_or_retreat: ['ensureSafety'], eat: ['eat'], get_food: ['findFood', 'eat'],
    get_wood: ['collectWood'], craft_crafting_table: ['craftPlanks', 'craftCraftingTable'],
    craft_pickaxe: ['craftPlanks', 'craftCraftingTable', 'craftTool'],
    get_stone_tools: ['craftTool', 'collectStone', 'craftTool'],
    get_iron: ['ensureSafety', 'findFood', 'eat', 'craftTool', 'collectStone', 'craftFurnace', 'mineResource', 'smeltItem']
  }
  const verticalPlan = skillPlans[plan.action]
  if (!verticalPlan) return actionExecutor.execute(plan, situation)
  if (reliableTaskManager.active || reliableTaskManager.queue.length) return false
  reliableTaskManager.enqueue({ name: plan.action, goal: plan.action === 'get_iron' ? 'obtain_iron_ingot' : plan.goal, source: 'planner', priority: plan.priority, context: situation, plan: verticalPlan })
  return true
}

function nearestThreatFromSituation(situation = {}) {
  const hostile = (situation.nearbyHostiles || [])[0]
  if (hostile?.id && bot.entities[hostile.id]) return bot.entities[hostile.id]
  if (!situation.playerPvpEnabled) return null
  const player = (situation.nearbyPlayers || [])[0]
  if (player?.id && bot.entities[player.id]) return bot.entities[player.id]
  return null
}

function startProgression() {
  autonomy.enabled = true
  state.manualControlOnly = false
  saveMemory()
  state.mode = 'progression'
  bot.chat('I am working independently towards enchanted netherite armor and tools. I will continue collecting resources and getting stronger.')
}

function setAutonomy(enabled) {
  autonomy.enabled = enabled
  state.manualControlOnly = !enabled
  if (!enabled) {
    taskController.cancel('ai auto off')
    state.stopVersion++
    autonomy.focus = null
    const autonomousModes = ['progression', 'explore', 'farm', 'smart_mining', 'cave', 'beat_minecraft', 'combat_training']
    if (autonomousModes.includes(state.mode)) {
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.pvp.stop() } catch {}
      try { bot.clearControlStates() } catch {}
      state.gatherTask = null
      state.progressionGatherTask = null
      state.miningTask = null
      state.beatMinecraft = null
      state.activeRoute = null
      state.pathGoal = null
      state.currentPath = []
      state.mode = 'idle'
    }
    state.resumeMode = null
    updatePlanner('paused', 'waiting for command', 'autonomy disabled')
  }
  saveMemory()
  bot.chat(`Autonomous AI is now: ${enabled ? 'ON' : 'OFF'}${enabled && autonomy.focus ? ` | focus: ${autonomy.focus}` : ''}`)
}

function normalizeAutonomyFocus(focus) {
  const aliases = {
    mining: 'mine',
    mines: 'mine',
    diamond: 'mine',
    diamonds: 'mine',
    iron: 'mine',
    farming: 'farm',
    food: 'farm',
    fight: 'combat',
    fighting: 'combat',
    pvp: 'combat',
    move: 'movement',
    explore: 'movement',
    exploration: 'movement',
    craft: 'crafting',
    recipes: 'crafting',
    base: 'world',
    memory: 'world',
    memories: 'world',
    beat: 'progression',
    stronger: 'progression',
    gear: 'progression',
    none: null,
    clear: null,
    general: null,
    normal: null,
    off: null
  }
  const cleaned = String(focus || '').toLowerCase().trim()
  if (Object.prototype.hasOwnProperty.call(aliases, cleaned)) return aliases[cleaned]
  if (['mine', 'farm', 'combat', 'movement', 'crafting', 'world', 'progression'].includes(cleaned)) return cleaned
  return undefined
}

function setAutonomyFocus(focus) {
  const normalized = normalizeAutonomyFocus(focus)
  if (normalized === undefined) {
    return bot.chat('Use: ai auto mine/farm/combat/movement/crafting/world/progression/general')
  }
  autonomy.enabled = true
  state.manualControlOnly = false
  autonomy.focus = normalized
  saveMemory()
  if (!normalized) {
    updatePlanner('autonomy', 'general survival decisions', 'focus cleared')
    return bot.chat('Autonomy focus cleared. I will train generally.')
  }
  updatePlanner(eliteMode ? `productive ${normalized}` : `training ${normalized}`, eliteMode ? `perform useful ${normalized} work` : `practice ${normalized}`, 'autonomy focus command')
  bot.chat(`${eliteMode ? 'Productive autonomy role' : 'Autonomy training focus'}: ${normalized}.`)
}

function updatePlanner(goal, nextAction, reason) {
  const previous = state.planner || {}
  const samePlan = previous.goal === goal && previous.nextAction === nextAction && previous.reason === reason
  const now = Date.now()
  state.planner = {
    goal,
    nextAction,
    reason,
    updatedAt: samePlan && previous.updatedAt ? previous.updatedAt : appTimestamp()
  }
  setCurrentTask('planning', nextAction, { target: goal })
  if (samePlan && now - Number(state.lastPlannerSaveAt || 0) < 15000) return
  state.lastPlannerSaveAt = now
  saveMemory()
}

async function runAutonomousPlanner() {
  if (eliteMode) {
    if (autonomy.focus === 'mine') {
      await runEliteMinerStep()
      return
    }
    if (autonomy.focus === 'farm') {
      if (state.mode !== 'farm') startFarmMode()
      await runFarmStep()
      return
    }
    if (autonomy.focus === 'progression') {
      await runEliteProgressionPlanner()
      return
    }
    if (!autonomy.focus) {
      await runEliteGeneralPlanner()
      return
    }
    await runElitePlanner()
    return
  }
  if (bot.food < 10) {
    updatePlanner('food supply', 'farm, harvest or breed animals', 'food is low')
    startFarmMode()
    return
  }
  if (autonomy.focus) {
    await runFocusedAutonomy(autonomy.focus)
    return
  }
  if (!hasItem('diamond_pickaxe') || !hasItem('diamond_sword')) {
    updatePlanner('getting stronger', 'resume progression', 'diamond gear is missing')
    state.mode = 'progression'
    await workOnProgression()
    return
  }
  const suggestion = survivalCraftSuggestion()
  if (suggestion && ['boat', 'bucket'].includes(suggestion.item)) {
    updatePlanner('survival', `craft ${suggestion.item}`, suggestion.reason)
    await craftSmart(suggestion.item)
    if (!hasItem(suggestion.item)) startExploration(`searching resources for ${suggestion.item}`)
    return
  }
  const endgame = nextEndgamePlan()
  updatePlanner('max gear', endgame.action, endgame.reason)
  startExploration('autonomous planner')
}

async function runFocusedAutonomy(focus) {
  updatePlanner(`training ${focus}`, `practice ${focus}`, 'autonomy focus')
  if (focus === 'mine') {
    if (!hasItem('iron_pickaxe') && !hasItem('diamond_pickaxe')) {
      state.mode = 'progression'
      await workOnProgression()
      return
    }
    const target = hasItem('iron_pickaxe') || hasItem('diamond_pickaxe') ? 'diamond' : 'raw_iron'
    if (!state.miningTask || state.mode !== 'smart_mining') startTargetedMining(target, target === 'diamond' ? 8 : 24)
    await runSmartMiningStep()
    return
  }
  if (focus === 'farm') {
    startFarmMode()
    await runFarmStep()
    return
  }
  if (focus === 'combat') {
    state.mode = 'combat_training'
    await equipBestArmor()
    equipBestWeapon()
    const hostile = bot.nearestEntity(entity => isHostileMob(entity) && entity.position.distanceTo(bot.entity.position) < 24)
    if (hostile) {
      await defendAgainst(hostile)
      return
    }
    setCurrentTask('training', 'searching for safe combat practice', { target: 'combat' })
    startExploration('combat training')
    return
  }
  if (focus === 'movement') {
    startExploration('movement training')
    recordLearning('movement', 'recovery', 'exploration_route', 1, 'movement training route started')
    return
  }
  if (focus === 'crafting') {
    const suggestion = survivalCraftSuggestion()
    if (suggestion) {
      updatePlanner('training crafting', `craft ${suggestion.item}`, suggestion.reason)
      await craftSmart(suggestion.item)
      return
    }
    state.mode = 'progression'
    await workOnProgression()
    return
  }
  if (focus === 'world') {
    await scanWorldFeatures()
    startExploration('world memory training')
    return
  }
  if (focus === 'progression') {
    state.mode = 'progression'
    await workOnProgression()
  }
}

function nextEndgamePlan() {
  const plans = knowledge.crafting.endgamePlans || []
  return plans.find(plan => !plan.item || !hasItem(plan.item, plan.count || 1)) || { action: 'find XP, books and rare utility items', reason: 'optimize max gear' }
}

async function workOnProgression() {
  if (!bot.inventory.items().some(item => isFood(item.name))) {
    const food = bot.nearestEntity(entity => ['cow', 'pig', 'chicken', 'sheep'].includes(entity.name))
    if (food) {
      state.mode = 'progression'
      equipBestWeapon()
      bot.pvp.attack(food)
      return
    }
  }
  if (!hasItem('wooden_pickaxe') && !hasItem('stone_pickaxe') && !hasItem('iron_pickaxe') && !hasItem('diamond_pickaxe')) {
    await craftSmart('wooden_pickaxe')
    return
  }
  if (!hasItem('stone_pickaxe') && !hasItem('iron_pickaxe') && !hasItem('diamond_pickaxe')) {
    await craftSmart('stone_pickaxe')
    return
  }
  if (!hasItem('furnace') && !await hasAvailableFurnace()) {
    await ensureCobblestone(8)
    await craftWithTable('furnace')
    return
  }
  if (!hasItem('iron_pickaxe') && !hasItem('diamond_pickaxe')) {
    if (!hasItem('raw_iron', 3) && !hasItem('iron_ingot', 3)) {
      await gatherForProgression('raw_iron', 3)
      return
    }
    if (!hasItem('iron_ingot', 3)) {
      if (!hasItem('coal') && !bot.inventory.items().some(item => item.name.endsWith('_planks'))) {
        await ensureWood()
        await craftAvailablePlanks()
      }
      await smeltStep('raw_iron', 'iron_ingot', 3)
      return
    }
    await ensureSticks()
    await craftWithTable('iron_pickaxe')
    return
  }
  if (!hasItem('iron_sword')) {
    if (!await ensureSmelted('raw_iron', 'iron_ingot', 2)) return
    await ensureSticks()
    await craftWithTable('iron_sword')
    return
  }
  if (bot.inventory.items().some(item => /_armor|_helmet|_chestplate|_leggings|_boots/.test(item.name)) && equippedArmorNames().length < 4) {
    await equipBestArmor()
    return
  }
  const ironArmor = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
  if (!ironArmor.every(name => hasItem(name))) {
    if (!await ensureSmelted('raw_iron', 'iron_ingot', 24)) return
    for (const item of ironArmor) {
      if (!hasItem(item)) await craftWithTable(item)
    }
    await equipBestArmor()
    return
  }
  if (equippedArmorNames().length < 4) {
    await equipBestArmor()
    return
  }
  if (!hasItem('shield')) {
    if (!await ensureSmelted('raw_iron', 'iron_ingot', 1)) return
    if (!await ensurePlanks(6)) return
    await craftWithTable('shield')
    return
  }
  if (!hasItem('diamond_pickaxe')) {
    if (!hasItem('diamond', 3)) {
      await gatherForProgression('diamond', 3)
      return
    }
    await ensureSticks()
    await craftWithTable('diamond_pickaxe')
    return
  }
  if (!hasItem('diamond_sword')) {
    if (!hasItem('diamond', 2)) {
      await gatherForProgression('diamond', 2)
      return
    }
    await ensureSticks()
    await craftWithTable('diamond_sword')
    return
  }
  const diamondArmor = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']
  if (!diamondArmor.every(name => hasItem(name))) {
    if (!hasItem('diamond', 24)) {
      await gatherForProgression('diamond', 24)
      return
    }
    for (const item of diamondArmor) {
      if (!hasItem(item)) await craftWithTable(item)
    }
    return
  }
  state.mode = 'idle'
  const endgame = nextEndgamePlan()
  updatePlanner('max gear', endgame.action, endgame.reason)
  bot.chat('Diamond gear ready. I will continue autonomous exploration for enchanting and endgame-resources.')
}

function survivalCraftSuggestion() {
  return [...SURVIVAL_CRAFTS]
    .sort((left, right) => survivalCraftPriority(right) - survivalCraftPriority(left))
    .find(rule => !hasItem(rule.item))
}

function survivalCraftPriority(rule) {
  let priority = rule.priority
  return priority
}

function findBuildMaterial() {
  return bot.inventory.items().find(i => knowledge.movement.buildingBlocks.includes(i.name))
}

function buildMaterialCount() {
  return bot.inventory.items()
    .filter(i => knowledge.movement.buildingBlocks.includes(i.name))
    .reduce((total, item) => total + item.count, 0)
}

async function ensureBuildingBlocks(count) {
  while (buildMaterialCount() < count) {
    const before = bot.inventory.items().find(i => i.name.endsWith('_log'))?.name
    if (!before) await findWood()
    const log = bot.inventory.items().find(i => i.name.endsWith('_log'))
    if (!log) return false
    await craftItem(log.name.replace('_log', '_planks'))
  }
  return true
}

async function runEliteGeneralPlanner() {
  if (eliteFarmFoodCount() < 24) {
    updatePlanner('general survival', 'produce a stable food reserve', 'food reserve below 24')
    if (state.mode !== 'farm') startFarmMode()
    await runFarmStep()
    return
  }
  const loadout = eliteLoadoutGap()
  if (loadout) {
    await runElitePlanner()
    return
  }
  if (eliteMiningStockTargets().length) {
    updatePlanner('general survival', 'produce missing mining stock', 'resource reserve below target')
    await runEliteMinerStep()
    return
  }
  await runEliteProgressionPlanner()
}

async function runEliteProgressionPlanner() {
  if (eliteFarmFoodCount() < 16) {
    updatePlanner('progression', 'secure food before dangerous progression', 'food reserve below 16')
    if (state.mode !== 'farm') startFarmMode()
    await runFarmStep()
    return
  }
  const diamondArmor = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']
  if (!hasItem('diamond_pickaxe') || !hasItem('diamond_sword') || !diamondArmor.every(name => hasItem(name))) {
    updatePlanner('progression', 'finish reliable diamond equipment', 'diamond equipment incomplete')
    state.mode = 'progression'
    await workOnProgression()
    return
  }
  updatePlanner('progression', 'advance toward the Ender Dragon', 'diamond equipment complete')
  state.mode = 'beat_minecraft'
  await runBeatMinecraftStep()
}

async function emergencyDrowningEscape(force = false) {
  if (!bot.entity || state.hardStopped) return false
  const now = Date.now()
  const base = bot.entity.position.floored()
  const feet = bot.blockAt(base)
  const head = bot.blockAt(base.offset(0, 1, 0))
  const above = bot.blockAt(base.offset(0, 2, 0))
  const inWater = isWaterBlock(feet) || isWaterBlock(head)
  const oxygen = Number(bot.oxygenLevel ?? 20)
  if (!force && (!inWater || oxygen > 16)) return false

  state.drowningEscapeUntil = Math.max(state.drowningEscapeUntil || 0, now + 2500)
  if (now - (state.lastDrowningEscapeAt || 0) > 600) {
    state.lastDrowningEscapeAt = now
    recordLearning('movement', 'survival', 'drowning_escape', 1, `surfacing with oxygen ${oxygen}`)
  }

  setCurrentTask('survival', `surfacing before drowning (${oxygen}/20 oxygen)`)
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  bot.setControlState('jump', true)
  bot.setControlState('forward', true)
  bot.setControlState('sprint', false)

  const surface = [above, head, feet].find(block => block?.boundingBox === 'empty' || block?.name === 'air')
  if (surface) {
    try { await bot.lookAt(surface.position.offset(0.5, 0.5, 0.5), true) } catch {}
  }

  await sleep(900)
  if (!bot.entity) return true
  const newBase = bot.entity.position.floored()
  const newFeet = bot.blockAt(newBase)
  const newHead = bot.blockAt(newBase.offset(0, 1, 0))
  if (!isWaterBlock(newFeet) && !isWaterBlock(newHead)) {
    bot.clearControlStates()
  }
  return true
}

async function eliteEmergencySurvival(options = {}) {
  if (!bot.entity) return false
  const feet = bot.blockAt(bot.entity.position.floored())
  const head = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))
  if ((isWaterBlock(feet) || isWaterBlock(head)) && Number(bot.oxygenLevel ?? 20) <= 16) return emergencyDrowningEscape(true)
  if (!options.ignoreFood && bot.health < 10 && bot.food < 8) {
    setCurrentTask('survival', 'finding food while avoiding combat')
    if (await eatFoodIfNeeded()) return true
    await eliteAcquireFood()
    return true
  }
  return false
}

async function eliteTraversalRecovery() {
  const target = goalPosition(state.pathGoal)
  if (!target || !bot.entity) return false
  const delta = target.minus(bot.entity.position)
  if (delta.y > 1.5 && await buildUpOneBlock()) return true
  if (delta.y < -1.5) {
    const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
    if (below?.boundingBox === 'block' && !['bedrock', 'lava'].includes(below.name) &&
      await digNearbyVisibleBlock(below, 'digging downward toward route goal')) return true
  }
  const obstruction = hitmanWallBlockToward(target)
  if (obstruction && await digNearbyVisibleBlock(obstruction, 'digging through route obstruction')) return true
  return attemptAutomaticBridge(state.pathGoal, state.activeRoute || state.mode || 'elite route')
}

function eliteFoodCount() {
  return bot.inventory.items()
    .filter(item => isFood(item.name) && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'].includes(item.name))
    .reduce((total, item) => total + item.count, 0)
}

function eliteLoadoutGap() {
  if (eliteFoodCount() < 16) return { goal: 'reliable food supply', action: 'hunt, collect and cook at least 16 safe food', food: true }
  if (!hasItem('shield')) return { goal: 'combat loadout', action: 'craft a shield', craft: 'shield' }
  if (!hasItem('water_bucket')) return { goal: 'survival utility', action: 'craft a water bucket', craft: 'bucket' }
  if (buildMaterialCount() < 64) return { goal: 'mobility supplies', action: 'collect a full stack of building blocks', blocks: 64 }
  if (!hasRangedCombat()) {
    if (!hasItem('bow') && !hasItem('crossbow')) return { goal: 'ranged combat', action: 'craft a bow', craft: 'bow' }
    return { goal: 'ranged combat', action: 'collect arrows', gather: { item: 'arrow', amount: 32 } }
  }
  if (!hasItem('iron_pickaxe') && !hasItem('diamond_pickaxe') && !hasItem('netherite_pickaxe')) {
    return { goal: 'expert tool set', action: 'obtain an iron pickaxe', mode: 'progression' }
  }
  if (!['iron_sword', 'diamond_sword', 'netherite_sword'].some(name => hasItem(name))) {
    return { goal: 'expert combat set', action: 'obtain a strong sword', mode: 'progression' }
  }
  const armor = equippedArmorNames()
  if (armor.length < 4 || !armor.some(name => /(?:iron|diamond|netherite)_chestplate/.test(name))) {
    return { goal: 'expert armor set', action: 'obtain and equip full strong armor', mode: 'progression' }
  }
  return null
}

async function runElitePlanner() {
  autonomy.focus = null
  state.combatTraining = false
  await equipBestArmor()
  await equipCombatWeapon()

  const gap = eliteLoadoutGap()
  if (gap) {
    updatePlanner(gap.goal, gap.action, 'elite player loadout requirement')
    if (gap.food) {
      await eliteAcquireFood()
      return
    }
    if (gap.mode === 'progression') {
      state.mode = 'progression'
      await workOnProgression()
      return
    }
    if (gap.blocks) {
      await ensureBuildingBlocks(gap.blocks)
      return
    }
    if (gap.gather) {
      await gatherForProgression(gap.gather.item, gap.gather.amount)
      return
    }
    if (gap.craft) {
      await craftSmart(gap.craft)
      return
    }
  }

  updatePlanner('complete Minecraft expertly', 'continue Ender Dragon progression with a complete combat loadout', 'elite player profile')
  state.mode = 'beat_minecraft'
  await runBeatMinecraftStep()
}

async function eliteAcquireFood(options = {}) {
  const preserveBreedingPairs = options.preserveBreedingPairs !== false
  const emergencyOnly = Boolean(options.emergencyOnly)
  if (await autoCookFoodIfUseful()) return true
  const animals = Object.values(bot.entities || {})
    .filter(entity => ['cow', 'pig', 'chicken', 'sheep', 'rabbit'].includes(entity?.name))
    .filter(entity => entity.position?.distanceTo(bot.entity.position) < 32)
  const counts = animals.reduce((result, entity) => {
    result[entity.name] = (result[entity.name] || 0) + 1
    return result
  }, {})
  const animal = animals
    .filter(entity => !preserveBreedingPairs || (counts[entity.name] || 0) > 2 || bot.food < 6)
    .sort((left, right) => left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position))[0]
  if (animal) {
    setCurrentTask('food', `hunting ${animal.name} for a reliable food supply`, { target: animal.name })
    await equipCombatWeapon()
    bot.pvp.attack(animal)
    return true
  }
  setCurrentTask('food', emergencyOnly ? 'searching for renewable food without hunting breeding pairs' : 'searching for safe food sources')
  startExploration('elite food search')
  return true
}

async function retreatFromEliteThreat(entity, taskToken = taskController.active) {
  if (!entity?.position || !bot.entity) return false
  try { bot.pvp.stop() } catch {}
  const away = bot.entity.position.minus(entity.position)
  const length = Math.max(0.1, Math.hypot(away.x, away.z))
  const target = bot.entity.position.offset((away.x / length) * 18, 0, (away.z / length) * 18)
  await safeGoto(new goals.GoalNear(target.x, target.y, target.z, 3), 'elite threat retreat')
  if (!taskWasCancelled(taskToken)) await eatFoodIfNeeded()
  return true
}

async function runCoordinationStep() {
  if (!minecraftConnected || !bot.entity) return
  refreshCoordinationPeers()
  publishCoordinationPresence()

  // Info: Teampeers uit de Hub hebben voorrang op de oudere file-based nabijheidsdetectie.
  if (await avoidTeamBlocking()) return

  compactMiningKnowledgeIfNeeded()

  if (autonomy.enabled && state.mode === 'idle' && !state.hardStopped) {
    state.idleAutonomySince ||= Date.now()
    if (Date.now() - state.idleAutonomySince > 10000) {
      if (state.busy && Date.now() - Number(state.busySince || 0) > 10000) {
        taskController.cancel('idle autonomy recovery')
        state.stopVersion++
        state.busy = false
        state.busySince = 0
        try { bot.pathfinder.setGoal(null) } catch {}
        try { bot.clearControlStates() } catch {}
      }
      if (state.busy) return
      state.idleAutonomySince = 0
      startExploration('idle autonomy recovery')
      return
    }
  } else {
    state.idleAutonomySince = 0
  }

  if (nearbyPeerCount(5) < 3 || state.busy || state.hardStopped || state.hitmanTask || state.guardTask || state.combatRetreating) return
  if (Date.now() < state.coordinationSpreadUntil) return
  state.coordinationSpreadUntil = Date.now() + 45000
  const target = spreadTargetFromPeers(32)
  if (!target) return
  state.mode = 'explore'
  state.exploreNextAt = Date.now() + 20000
  setCurrentTask('moving', 'spreading away from nearby bots', { position: `${target.x} ${target.y} ${target.z}` })
  bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 4))
}

async function avoidTeamBlocking() {
  if (!bot.entity || Date.now() < state.teamYieldUntil) return false
  const peers = (state.teamPeers || []).filter(peer => peer.position?.dimension === currentDimension() && coordinationPosition(peer.position)?.distanceTo(bot.entity.position) <= 2.5)
  if (!peers.length) { state.teamConflictSince = 0; return false }
  state.teamConflictSince ||= Date.now()
  if (Date.now() - state.teamConflictSince < 5000) return false
  const own = { botId:teamClient.botId,priority:Number(teamClient.activeTeamTask?.priority||0),destination:teamClient.activeTeamTask?.destination,position:positionData(bot.entity.position),hasObjectReservation:teamClient.activeReservation }
  const contenders = rankBotsForPassage([own,...peers.map(peer=>({botId:peer.botId,priority:Number(peer.teamTaskPriority||0),destination:peer.teamDestination,position:peer.position,hasObjectReservation:peer.hasObjectReservation}))])
  if (contenders[0].botId === own.botId) return false
  state.teamYieldUntil = Date.now() + 3000
  state.teamConflictSince = 0
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const winner = peers.find(peer=>peer.botId===contenders[0].botId)
  const awayFrom = coordinationPosition(winner?.position) || bot.entity.position.offset(1,0,0)
  const delta = bot.entity.position.minus(awayFrom); const length=Math.max(.1,Math.hypot(delta.x,delta.z))
  const target=bot.entity.position.offset((delta.x/length)*3,0,(delta.z/length)*3)
  setCurrentTask('team_yield',`yielding to ${contenders[0].botId}`,{position:`${target.x.toFixed(1)} ${target.y.toFixed(1)} ${target.z.toFixed(1)}`})
  try { await safeGoto(new goals.GoalNear(target.x,target.y,target.z,1),'team path conflict yield') } catch {}
  return true
}

function compactMiningKnowledgeIfNeeded() {
  const memoryCount = Object.keys(knowledge.mining.oreMemory || {}).length
  const heatCount = Object.keys(knowledge.mining.oreHeatmap || {}).length
  const heapMb = Math.round((process.memoryUsage?.().heapUsed || 0) / 1024 / 1024)
  if (memoryCount <= 900 && heatCount <= 600 && heapMb < 320) return
  compactKnowledgeDomain('mining', knowledge.mining)
  if (heapMb >= 320) {
    for (const domain of ['movement', 'combat', 'crafting']) {
      if (knowledge[domain]) compactKnowledgeDomain(domain, knowledge[domain])
    }
    state.currentPath = []
    state.peerBots = []
  }
  saveKnowledge({ mining: knowledge.mining })
}

function bridgeDirection() {
  const yaw = Number(bot.entity?.yaw) || 0
  return new Vec3(-Math.round(Math.sin(yaw)), 0, Math.round(Math.cos(yaw)))
}

function goalPosition(goal) {
  const value = goal?.goalPos || goal?.pos || goal
  const x = Number(value?.x)
  const y = Number(value?.y)
  const z = Number(value?.z)
  return [x, y, z].every(Number.isFinite) ? new Vec3(x, y, z) : null
}

function bridgeDirectionToward(target) {
  if (!bot.entity || !target) return bridgeDirection()
  const dx = target.x - bot.entity.position.x
  const dz = target.z - bot.entity.position.z
  return Math.abs(dx) >= Math.abs(dz)
    ? new Vec3(Math.sign(dx) || 1, 0, 0)
    : new Vec3(0, 0, Math.sign(dz) || 1)
}

function hasBridgeClearance(feetPosition) {
  return bot.blockAt(feetPosition)?.boundingBox === 'empty' &&
    bot.blockAt(feetPosition.offset(0, 1, 0))?.boundingBox === 'empty'
}

function deepDropBelow(position, depth = Number(knowledge.movement.rules?.voidScanDepth) || 16) {
  for (let offset = 1; offset <= depth; offset++) {
    const block = bot.blockAt(position.offset(0, -offset, 0))
    if (canUseAsPlacementFloor(block)) return false
    if (block?.boundingBox === 'block' || ['water', 'lava'].includes(block?.name)) return true
  }
  return true
}

function incrementMovementStat(name, amount = 1) {
  knowledge.movement.stats ||= {}
  knowledge.movement.stats[name] = (knowledge.movement.stats[name] || 0) + amount
}

async function attemptAutomaticBridge(goal, label = 'route') {
  if (!bot.entity?.onGround || state.hardStopped || state.autoBridging) return false
  if (knowledge.movement.rules?.avoidVoid === false || buildMaterialCount() < 1) return false
  if (Date.now() < state.automaticBridgeBlockedUntil) return false
  if (Date.now() - (state.lastAutomaticBridgeAt || 0) < 3000) return false

  const target = goalPosition(goal)
  if (!target || target.distanceTo(bot.entity.position) < 2) return false
  const direction = bridgeDirectionToward(target)
  const base = bot.entity.position.floored()
  const nextFeet = base.plus(direction)
  if (!hasBridgeClearance(nextFeet) || canUseAsPlacementFloor(bot.blockAt(nextFeet.offset(0, -1, 0)))) return false
  const distance = Math.abs(target.x - base.x) + Math.abs(target.z - base.z)
  const limit = Math.max(1, Math.min(8, Number(knowledge.movement.rules?.automaticBridgeSteps) || 6))
  const steps = Math.min(limit, Math.max(1, Math.floor(distance)))
  const mode = target.y > base.y + 1 && knowledge.movement.rules?.allowUpwardBridge !== false
    ? 'up'
    : eliteMode && knowledge.movement.rules?.allowSpeedBridge !== false
      ? 'speed'
      : 'safe'
  state.autoBridging = true
  state.lastAutomaticBridgeAt = Date.now()
  setCurrentTask('building', `automatic ${mode} bridge`, { route: label, steps })
  try {
    const result = await bridgeForward(steps, mode, direction)
    if (result.steps > 0) {
      recordLearning('movement', 'bridging', 'automatic', result.completed ? 2 : 1, `bridged toward ${label}`)
      return true
    }
    state.automaticBridgeBlockedUntil = Date.now() + 30000
  } finally {
    state.autoBridging = false
  }
  return false
}

async function placeBridgeBlock(target) {
  if (canUseAsPlacementFloor(bot.blockAt(target))) return true
  if (blockFailureCoolingDown(state.bridgeBlockFailures, target, 30000)) return false
  const item = findBuildMaterial()
  if (!item) return false
  const faces = [
    new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)
  ]
  const usableFaces = faces.filter(candidate => canUseAsPlacementFloor(bot.blockAt(target.minus(candidate)))).slice(0, 2)
  if (!usableFaces.length) {
    rememberBlockFailure(state.bridgeBlockFailures, target)
    return false
  }
  for (const face of usableFaces) {
    try {
      if (!await equipAndConfirmHeldItem(item)) break
      const referenceBlock = bot.blockAt(target.minus(face))
      if (!referenceBlock?.position || !canUseAsPlacementFloor(referenceBlock)) {
        rememberBlockFailure(state.bridgeBlockFailures, target)
        continue
      }
      await bot.placeBlock(referenceBlock, face)
      if (await waitForPlacedBlock(target, Math.max(500, Number(knowledge.movement.rules?.bridgeVerifyTimeoutMs) || 1200))) {
        delete state.bridgeBlockFailures[blockFailureKey(target)]
        incrementMovementStat('bridgeBlocksPlaced')
        return true
      }
    } catch (err) {
      if (!expectedPathError(err) && !/blockUpdate:.*did not fire|block not in view/i.test(err?.message || '')) logActionError('Could not place bridge block', err)
    }
  }
  rememberBlockFailure(state.bridgeBlockFailures, target)
  return false
}

async function bridgeForward(length, mode = 'safe', requestedDirection = null) {
  if (!bot.entity || state.hardStopped) return { completed: false, steps: 0, reason: 'bot is stopped' }
  if (mode === 'speed' && knowledge.movement.rules?.allowSpeedBridge === false) {
    return { completed: false, steps: 0, reason: 'speed bridging is disabled' }
  }
  if (mode === 'up' && knowledge.movement.rules?.allowUpwardBridge === false) {
    return { completed: false, steps: 0, reason: 'upward bridging is disabled' }
  }

  const stopVersion = state.stopVersion
  const direction = requestedDirection || bridgeDirection()
  const requiredBlocks = mode === 'up' ? length * 2 : length
  if (buildMaterialCount() < requiredBlocks && !await ensureBuildingBlocks(requiredBlocks)) {
    return { completed: false, steps: 0, reason: 'not enough building blocks' }
  }

  state.mode = 'bridging'
  setCurrentTask('building', `${mode} bridge`, { length })
  bot.clearControlStates()
  let steps = 0
  let placedAny = false
  try {
    while (steps < length && stopVersion === state.stopVersion && !state.hardStopped) {
      const base = bot.entity.position.floored()
      const nextFeet = base.plus(direction).offset(0, mode === 'up' ? 1 : 0, 0)
      const floor = nextFeet.offset(0, -1, 0)

      if (!hasBridgeClearance(nextFeet)) return { completed: false, steps, reason: 'the route is blocked' }
      const existingFloor = canUseAsPlacementFloor(bot.blockAt(floor))
      if (!existingFloor) {
        bot.setControlState('sneak', true)
        if (mode === 'up') {
          const lowerSupport = base.plus(direction).offset(0, -1, 0)
          if (!await placeBridgeBlock(lowerSupport)) {
            incrementMovementStat('bridgeFailures')
            return { completed: false, steps, reason: 'could not place the upward bridge support' }
          }
        }
        if (!await placeBridgeBlock(floor)) {
          incrementMovementStat('bridgeFailures')
          recordLearning('movement', 'bridging', mode, -1, 'bridge block could not be placed safely')
          return { completed: false, steps, reason: 'could not safely place the next block' }
        }
        placedAny = true
      } else {
        incrementMovementStat('existingBridgeSteps')
      }

      if (!canUseAsPlacementFloor(bot.blockAt(floor)) || deepDropBelow(nextFeet, 2)) {
        incrementMovementStat('voidStops')
        return { completed: false, steps, reason: 'unsafe drop detected' }
      }

      bot.setControlState('sneak', false)
      const reached = await safeGoto(new goals.GoalBlock(nextFeet.x, nextFeet.y, nextFeet.z), `${mode} bridge step`, false)
      if (!reached) {
        incrementMovementStat('bridgeFailures')
        return { completed: false, steps, reason: 'could not step onto the bridge' }
      }
      steps++
      if (mode === 'up') incrementMovementStat('upwardBridgeSteps')
      if (mode === 'speed') incrementMovementStat('speedBridgeSteps')
      const delay = mode === 'speed'
        ? Number(knowledge.movement.rules?.bridgeSpeedDelayMs) || 70
        : Number(knowledge.movement.rules?.bridgePlaceDelayMs) || 180
      await sleep(Math.max(25, delay))
    }
  } finally {
    bot.setControlState('sneak', false)
    if (state.mode === 'bridging') state.mode = 'idle'
    saveKnowledge({ movement: knowledge.movement })
  }

  if (steps === length) {
    if (placedAny) incrementMovementStat('bridgesBuilt')
    recordLearning('movement', 'bridging', mode, 2, 'bridge completed with verified footing')
    return { completed: true, steps, reason: 'complete' }
  }
  return { completed: false, steps, reason: 'stopped' }
}

async function placeAt(target) {
  const current = bot.blockAt(target)
  if (current && current.boundingBox === 'block') return true
  const faces = [
    new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)
  ]
  const face = faces.find(candidate => bot.blockAt(target.minus(candidate))?.boundingBox === 'block')
  const item = findBuildMaterial()
  if (!face || !item) return false
  try {
    await bot.equip(item, 'hand')
    await bot.placeBlock(bot.blockAt(target.minus(face)), face)
    addSkill('building')
    return true
  } catch {
    return false
  }
}

async function placeLine(length, height = 1) {
  const base = bot.entity.position.floored()
  for (let y = 0; y < height; y++) {
    for (let x = 1; x <= length; x++) {
      if (!await placeAt(base.offset(x, y, 0))) return false
    }
  }
  return true
}

bot.on('death', () => {
  const deathSnapshot = inventorySnapshot()
  if (deathSnapshot.length) state.lastInventorySnapshot = deathSnapshot
  const position = bot.entity?.position || state.lastPosition
  if (!position) return
  const cause = inferDeathCause(position)
  const category = deathCategory(cause)
  knowledge.combat.stats ||= {}
  knowledge.combat.stats.deaths = (knowledge.combat.stats.deaths || 0) + 1
  knowledge.combat.stats.deathsByCause ||= {}
  bumpNestedStat(knowledge.combat.stats.deathsByCause, category)
  recordLearning('combat', 'deaths', category, -3, `death by ${cause}`)
  if (eliteMode && combatBrain?.learnLostFight) combatBrain.learnLostFight(category)
  rememberWorldLocation('deathLocations', position, { cause, category, source: 'death' })
  state.deathPosition = position.clone()
  state.recovering = true
  state.deathRecovery = {
    position: position.clone(),
    cause,
    droppedInventory: state.lastInventorySnapshot,
    attempts: 0,
    pathFailures: 0,
    reachedAt: null,
    lastLootSeenAt: 0,
    keepInventoryCheckPending: true,
    keepInventoryCheckUntil: 0,
    keepInventoryCheckedAt: 0,
    keepInventoryRetainedRatio: 0,
    deadline: Date.now() + 280000
  }
  state.mode = 'recovering'
})

bot.on('entityDead', entity => {
  const task = state.hitmanTask
  if (!task || entity?.type !== 'player') return
  const name = String(entity.username || '').toLowerCase()
  if (!name || ![task.playerName, task.actualName].some(target => String(target || '').toLowerCase() === name)) return
  stopHitman('target killed')
})

bot.on('move', () => {
  if (!bot.entity?.position) return
  if (!state.lastMovementPosition || bot.entity.position.distanceTo(state.lastMovementPosition) > 0.2) {
    state.lastMovementAt = Date.now()
    state.lastMovementPosition = bot.entity.position.clone()
  }
  state.lastPosition = bot.entity.position.clone()
  if (bot.entity.onGround) {
    if (state.airborneSince && state.lastGroundY !== null) {
      const fall = state.lastGroundY - bot.entity.position.y
      if (fall > 3) {
      } else if (fall >= -1 && Date.now() - state.airborneSince > 250 && state.airborneStartPosition?.distanceTo(bot.entity.position) > 1.2) {
      }
    }
    state.lastGroundY = bot.entity.position.y
    state.airborneSince = null
    state.airborneStartPosition = null
  } else {
    if (!state.airborneSince) {
      state.airborneSince = Date.now()
      state.airborneStartPosition = bot.entity.position.clone()
    }
  }
})

bot.on('blockUpdate', (oldBlock, newBlock) => {
  const position = newBlock?.position || oldBlock?.position
  if (!position || !bot.entity || position.distanceTo(bot.entity.position) > 32) return
  if (oldBlock?.name !== newBlock?.name) state.lastWorldScanAt = 0
})

bot.on('goal_updated', (goal, dynamic) => {
  state.pathGoal = goal
  state.pathGoalDynamic = dynamic
  state.pathStatus = 'routing'
  state.pathUpdatedAt = appTimestamp()
  state.routeStartedAt = Date.now()
  state.stuckPosition = bot.entity?.position?.clone() || null
  state.stuckChecks = 0
})

bot.on('path_update', result => {
  const path = Array.isArray(result?.path) ? result.path : []
  state.currentPath = path
    .map(position => mapPoint(position, 'route'))
    .filter(Boolean)
    .slice(0, 120)
  state.pathStatus = result?.status === 'noPath' ? 'blocked' : 'routing'
  state.pathUpdatedAt = appTimestamp()
  if (result?.status === 'noPath' && state.pathGoal && !state.autoBridging) {
    const interruptedGoal = state.pathGoal
    const dynamic = state.pathGoalDynamic
    const label = state.activeRoute || state.mode || 'route'
    setTimeout(async () => {
      if (state.hardStopped || state.autoBridging || state.pathGoal !== interruptedGoal) return
      try {
        if (await attemptAutomaticBridge(interruptedGoal, label)) bot.pathfinder.setGoal(interruptedGoal, dynamic)
      } catch (err) {
        if (!expectedPathError(err)) logActionError('Automatic bridge failed', err)
      }
    }, 100)
  }
})

bot.on('physicsTick', () => {
  if (!eliteMode || state.hitmanClutching) return
  avoidEndermanGaze().catch(() => {})
  eliteHitmanClutch().catch(err => {
    if (!expectedPathError(err)) logActionError('Elite survival clutch failed', err)
  })
})

bot.on('goal_reached', () => {
  state.pathGoal = null
  state.pathGoalDynamic = false
  state.activeRoute = null
  state.currentPath = []
  state.pathStatus = 'reached'
  state.pathUpdatedAt = appTimestamp()
  state.stuckChecks = 0
  state.unstuckFailures = 0
  state.navigationRecoveryAttempts = 0
  state.navigationRecoveryAnchor = null
  state.navigationRecoveryStartedAt = 0
  state.navigationBlockedUntil = 0
})

bot.on('path_stop', () => {
  if (state.unstucking) return
  state.pathGoal = null
  state.pathGoalDynamic = false
  state.activeRoute = null
  state.currentPath = []
  state.pathStatus = 'stopped'
  state.pathUpdatedAt = appTimestamp()
})

bot.on('spawn', async () => {
  if (!state.recovering || !state.deathRecovery) return
  const recovery = state.deathRecovery
  recovery.keepInventoryCheckPending = true
  recovery.keepInventoryCheckUntil = Date.now() + 5000
  recordInfo('Waiting for the respawn inventory before deciding whether death recovery is needed.', 'recovery')
  for (const delay of [500, 1500, 3000, 5000]) {
    setTimeout(() => checkKeepInventoryAfterRespawn(recovery, delay === 5000), delay)
  }
})

bot.on('stoppedAttacking', () => {
  bot.clearControlStates()
  addSkill('combat')
  if (state.mode.startsWith('defense:')) {
    const mob = state.mode.slice('defense:'.length)
    bumpKnowledgeStat('combat', 'finishedFights')
    recordLearning('combat', 'mobs', mob, 3, 'combat finished')
    if (state.currentCombat?.strategy) recordLearning('combat', 'tactics', `${mob}:${state.currentCombat.strategy}`, 3, 'combat finished')
    if (state.currentCombat?.weapon) recordLearning('combat', 'weapons', state.currentCombat.weapon, 2, 'combat finished')
    for (const armor of state.currentCombat?.armor || []) recordLearning('combat', 'armor', armor, 1, 'survived combat while equipped')
  }
  if (state.mode.startsWith('defense:')) state.mode = state.resumeMode || 'idle'
  state.resumeMode = null
  state.currentCombat = null
})

bot.on('physicsTick', () => {
  if (bot.entity && Number(bot.oxygenLevel ?? 20) <= 16 && Date.now() - (state.lastDrowningEscapeAt || 0) > 500) {
    const base = bot.entity.position.floored()
    if (isWaterBlock(bot.blockAt(base)) || isWaterBlock(bot.blockAt(base.offset(0, 1, 0)))) {
      emergencyDrowningEscape(true).catch(() => {})
      return
    }
  }

  if (bot.entity?.onGround && knowledge.movement.rules?.avoidVoid !== false && !state.autoBridging) {
    const ahead = bot.entity.position.floored().plus(bridgeDirection())
    if (hasBridgeClearance(ahead) && deepDropBelow(ahead)) {
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)
      bot.setControlState('sneak', true)
      state.voidGuardActive = true
      if (Date.now() - (state.lastVoidStopAt || 0) > 2000) {
        state.lastVoidStopAt = Date.now()
        incrementMovementStat('voidStops')
      }
    } else if (state.voidGuardActive) {
      bot.setControlState('sneak', false)
      state.voidGuardActive = false
    }
  }
  const target = bot.pvp.target
  if (!target || !bot.entity) return
  if (target.position.distanceTo(bot.entity.position) <= 4.2 && !canHitEntity(target)) {
    if (Date.now() - state.lastCombatBlockedAt > 1000) {
      state.lastCombatBlockedAt = Date.now()
    }
    bot.pvp.stop()
  }
})

function updateHud() {
  const now = Date.now()
  const elapsedMs = Math.max(1, now - previousCpuSampleAt)
  const cpuDelta = process.cpuUsage(previousCpuUsage)
  previousCpuUsage = process.cpuUsage()
  previousCpuSampleAt = now
  const cpuPercent = ((cpuDelta.user + cpuDelta.system) / 1000 / elapsedMs) * 100
  const runtimeHealth = {
    cpuPercent: Number(cpuPercent.toFixed(1)),
    rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
    eventLoopLagP95Ms: Number((eventLoopDelay.percentile(95) / 1e6).toFixed(1)),
    eventLoopLagMaxMs: Number((eventLoopDelay.max / 1e6).toFixed(1)),
    uptimeSeconds: Math.floor(process.uptime())
  }
  eventLoopDelay.reset()
  io.emit('update', {
    runtimeHealth,
    botUsername: bot.username || null,
    connected: minecraftConnected,
    health: bot.health,
    food: bot.food,
    xp: bot.experience?.level ?? 0,
    pvp: playerPvpEnabled,
    position: bot.entity?.position
      ? {
          x: bot.entity.position.x.toFixed(1),
          y: bot.entity.position.y.toFixed(1),
          z: bot.entity.position.z.toFixed(1)
        }
      : null,
    inventory: bot.inventory.items().map(hudItem),
    equipment: {
      helmet: hudItem(bot.inventory.slots[5]),
      chestplate: hudItem(bot.inventory.slots[6]),
      leggings: hudItem(bot.inventory.slots[7]),
      boots: hudItem(bot.inventory.slots[8]),
      offhand: hudItem(bot.inventory.slots[45])
    },
    foodItems: bot.inventory.items()
      .filter(item => isFoodItem(item.name))
      .map(item => ({
        name: item.name,
        count: item.count,
        cooked: Object.values(COOKABLE_FOOD).includes(item.name),
        cookable: Boolean(COOKABLE_FOOD[item.name])
      })),
    mode: state.mode,
    smeltingTask: state.smeltingTask,
    furnaceDebug: state.furnaceDebug,
    repairTask: state.repairTask,
    activeRoute: state.activeRoute,
    pathStatus: {
      status: state.pathStatus,
      updatedAt: state.pathUpdatedAt,
      points: state.currentPath?.length || 0
    },
    viewer: {
      enabled: viewerEnabled && viewerStarted,
      requested: viewerEnabled,
      url: null,
      port: viewerPort,
      firstPerson: true
    },
    currentTask: state.currentTask,
    reliableTask: reliableTaskManager.status(),
    currentStep: reliableTaskManager.status().currentStep,
    activeSkill: reliableTaskManager.status().activeSkill,
    attempt: reliableTaskManager.status().attempt,
    maxAttempts: reliableTaskManager.status().maxAttempts,
    lastError: reliableTaskManager.status().lastError,
    learningEnabled: botSettings.learning.enabled,
    knownSkills: skillRegistry.list().length,
    experienceCount: learnedStore.data.experiences.length,
    currentPlan: reliableTaskManager.status().currentPlan,
    safetyState: bot.health < botSettings.safety.minimumHealth ? 'unsafe' : 'safe',
    curriculum: { enabled: curriculum.enabled, unlocked: curriculum.unlocked(), next: curriculum.next() },
    team: { enabled: teamClient.enabled, botId:teamClient.botId,instanceId:teamClient.instanceId,worldId:teamClient.worldId,activeTask:teamClient.activeTeamTask },
    taskLog: state.taskLog,
    miningTask: state.miningTask,
    hitmanTask: state.hitmanTask,
    guardTask: state.guardTask,
    guardAllies: state.guardAllies,
    retaliationTask: state.retaliationTask,
    beatMinecraft: state.beatMinecraft,
    watchdog: {
      busy: state.busy,
      busySince: state.busySince,
      actionRecoveryPendingAt: state.actionRecoveryPendingAt,
      actionRecoveryBusySince: state.actionRecoveryBusySince,
      lastMovementAt: state.lastMovementAt,
      lastPriorityAt: state.lastPriorityAt,
      lastWakeAt: state.lastWatchdogWakeAt
    },
    utilities: worldMemory.utilities || {},
    deathRecovery: state.deathRecovery
      ? {
          cause: state.deathRecovery.cause,
          attempts: state.deathRecovery.attempts,
          pathFailures: state.deathRecovery.pathFailures,
          keepInventoryCheckPending: state.deathRecovery.keepInventoryCheckPending,
          keepInventoryRetainedRatio: state.deathRecovery.keepInventoryRetainedRatio,
          droppedInventory: state.deathRecovery.droppedInventory
        }
      : null,
    gatherTask: state.gatherTask || state.progressionGatherTask,
    autonomy,
    planner: state.planner,
    worldMemory,
    combatMetrics: combatMetrics(),
    knowledge: knowledgeSummary(),
    itemsKnowledge: knowledge.items,
    knownRecipes: knownRecipeNames(),
    recipeBook,
    discoveredRecipes,
    chatHistory,
    botSettings: {
      host: minecraftHost,
      port: minecraftPort,
      username: minecraftUsername,
      auth: minecraftAuth,
      version: minecraftVersion,
      worldId: botSettings.worldId,
      dataProfile: botSettings.dataProfile,
      ownerPlayer: botSettings.ownerPlayer,
      offlineSkinMode: botSettings.offlineSkinMode,
      offlineSkinValue: botSettings.offlineSkinValue,
      offlineSkinVariant: botSettings.offlineSkinVariant,
      whitelistedPlayers: botSettings.whitelistedPlayers,
      supportedVersions: SUPPORTED_MINECRAFT_VERSIONS,
      environmentOverrides: {
        host: Boolean(process.env.MC_HOST),
        port: Boolean(process.env.MC_PORT),
        username: Boolean(process.env.MC_USERNAME),
        auth: Boolean(process.env.MC_AUTH)
      }
    },
    commands
  })
}

addRuntimeInterval(updateHud, hudIntervalMs)

io.on('connection', socket => {
  teamClient.attach(socket)
  updateHud()

  socket.on('command', cmd => {
    if (!minecraftConnected) return
    const text = String(cmd || '').trim()
    if (!text) return
    if (normalizeCommandMessage(text.toLowerCase()).startsWith('ai ')) {
      bot.emit('chat', 'HUD', text)
      return
    }
    const prefix = 'HUD: '
    const maxMessageLength = Math.max(1, 256 - prefix.length)
    const message = text.slice(0, maxMessageLength)
    if (bot.sendServerCommand(`${prefix}${message}`)) {
      recordChat('hud', `${bot.username || 'AI'} HUD`, message)
      updateHud()
    }
  })

  socket.on('inventory:drop', request => {
    if (!minecraftConnected) return
    const slot = Number(request?.slot)
    const amount = Math.max(1, Math.floor(Number(request?.amount) || 1))
    const item = bot.inventory.items().find(item => item.slot === slot)
    if (!item) return
    // Info: Een handmatige HUD-drop wordt niet meteen door de automatische collector teruggepakt.
    state.pickupIgnoreUntilByName[item.name] = Date.now() + 10000
    bot.toss(item.type, item.metadata, Math.min(item.count, amount))
      .then(updateHud)
      .catch(err => console.log('Inventory drop failed:', err.message))
  })

  socket.on('recipe:forget', item => {
    if (forgetDiscoveredRecipe(String(item || ''))) updateHud()
  })

  socket.on('bot-settings:save', async request => {
    const settings = normalizeBotSettings(request)
    const restart = request?.restart === true
    if (!settings.host || !settings.username) {
      socket.emit('bot-settings:result', { ok: false, message: 'Host and username are required.' })
      return
    }
    saveBotSettings(settings)
    botSettings.whitelistedPlayers = settings.whitelistedPlayers
    botSettings.ownerPlayer = settings.ownerPlayer
    botSettings.offlineSkinMode = settings.offlineSkinMode
    botSettings.offlineSkinValue = settings.offlineSkinValue
    botSettings.offlineSkinVariant = settings.offlineSkinVariant
    botSettings.eliteMode = settings.eliteMode
    const skinResult = !restart && settings.auth === minecraftAuth
      ? await applyConfiguredSkin({ clearWhenOff: true })
      : null
    const skinMessage = skinResult
      ? ` ${skinResult.message}`
      : (!restart && settings.auth !== minecraftAuth
          ? ' Restart the AI before applying settings that change authentication.'
          : '')
    socket.emit('bot-settings:result', {
      ok: skinResult ? skinResult.ok : true,
      message: restart ? 'Settings saved. Restarting the AI...' : `Settings saved.${skinMessage || ' Connection changes will be used on the next rejoin or restart.'}`,
      settings
    })
    if (restart) setTimeout(() => restartWorker(), 750)
  })

  socket.on('runtime-backup:create', async () => {
    try {
      await flushJsonWrites()
      maybeBackupRuntimeData(true)
      socket.emit('runtime-data:result', { ok: true, message: 'Backup created.' })
    } catch (err) {
      socket.emit('runtime-data:result', { ok: false, message: err.message })
    }
  })

  socket.on('runtime-backup:restore-latest', async () => {
    try {
      const latest = latestRuntimeBackup()
      if (!latest) return socket.emit('runtime-data:result', { ok: false, message: 'No backup found.' })
      await flushJsonWrites()
      maybeBackupRuntimeData(true)
      restoreRuntimeData(path.join(backupsRoot, latest), runtimeRoot, botSettingsFile)
      socket.emit('runtime-data:result', { ok: true, message: `Restored backup ${latest}. Restarting AI...` })
      setTimeout(() => restartWorker(), 750)
    } catch (err) {
      socket.emit('runtime-data:result', { ok: false, message: err.message })
    }
  })

  socket.on('world-memory:reset', () => {
    try {
      resetCurrentWorldMemory()
      socket.emit('runtime-data:result', { ok: true, message: `Current world memory reset: ${worldMemoryId()}` })
      updateHud()
    } catch (err) {
      socket.emit('runtime-data:result', { ok: false, message: err.message })
    }
  })

  socket.on('items-knowledge:add', request => {
    const category = String(request?.category || '').trim()
    const item = String(request?.item || '').trim().toLowerCase()
    if (!category || !item) return
    knowledge.items ||= { categories: {}, stats: {} }
    knowledge.items.categories ||= {}
    knowledge.items.categories[category] ||= []
    if (!knowledge.items.categories[category].includes(item)) {
      knowledge.items.categories[category].push(item)
      knowledge.items.categories[category].sort()
      saveKnowledge({ items: knowledge.items })
      updateHud()
    }
  })

  socket.on('items-knowledge:remove', request => {
    const category = String(request?.category || '').trim()
    const item = String(request?.item || '').trim().toLowerCase()
    const entries = knowledge.items?.categories?.[category]
    if (!Array.isArray(entries)) return
    const next = entries.filter(entry => entry !== item)
    if (next.length !== entries.length) {
      knowledge.items.categories[category] = next
      saveKnowledge({ items: knowledge.items })
      updateHud()
    }
  })
})

bot.on('error', err => {
  if (['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(err.code) || /client timed out|keepalive/i.test(err.message || '')) {
    console.log(`Minecraft connection error: ${err.code || err.message}`)
    scheduleReconnect('connection error')
    return
  }
  console.log('ERROR:', err)
})
bot.on('end', () => {
  resetDisconnectedSession()
  console.log('Bot disconnected')
  scheduleReconnect('disconnect')
})
bot.on('kicked', reason => {
  resetDisconnectedSession()
  console.log('KICKED:', reason)
  scheduleReconnect('kick')
})

}


