const express = require('express')
const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { io } = require('socket.io-client')
const { mergeKnowledgeFoldersMany } = require('./src/knowledge-merge')
const { registerSupportRoutes } = require('./src/routes')
const { systemHealth: buildSystemHealth } = require('./src/health')
const { TeamStore } = require('./src/team/teamStore')
const { TeamCoordinator } = require('./src/team/teamCoordinator')
const { EventBuffer } = require('./src/dashboard/eventBuffer')
const { DashboardService } = require('./src/dashboard/dashboardService')
const { BoundedHistoryStore, summarizeReconnects } = require('./src/dashboard/historyStore')
const { SchematicStore, transformBlocks, MAX_BYTES } = require('./src/schematics/schematicStore')
process.env.TZ ||= 'Europe/Amsterdam'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const HUB_PORT = Number(process.env.HUB_PORT || 3100)
const HUB_HOST = process.env.HUB_HOST || '0.0.0.0'
const LOCAL_HOST = '127.0.0.1'
const portableRoot = path.dirname(__dirname)
const configRoot = path.join(portableRoot, 'Config')
const dataRoot = path.join(portableRoot, 'Data')
const settingsFile = path.join(configRoot, 'settings.json')
const portsFile = path.join(configRoot, 'ports.json')
const legacySettingsFile = path.join(__dirname, 'hub-settings.json')
const mergedRoot = path.join(dataRoot, 'knowledge', 'merged')
const logsRoot = path.join(portableRoot, 'Logs', 'hub')
const updateBackupsRoot = path.join(dataRoot, 'backups', 'update-backups')
const startupBackupsRoot = path.join(dataRoot, 'backups', 'startup')
const configBackupsRoot = path.join(dataRoot, 'backups', 'config')
const teamStateFile = path.join(dataRoot, 'team-state.json')
const schematicsRoot = path.join(dataRoot, 'schematics')
const schematicBuildHistoryFile = path.join(dataRoot, 'schematic-build-history.json')
const reconnectHistoryFile = path.join(dataRoot, 'reconnect-history.json')
const botsRoot = path.join(portableRoot, 'Bots')
const discordBridgeRoot = path.join(portableRoot, 'minecraft-discord-bot')
const discordBridgeFile = path.join(discordBridgeRoot, 'index.js')
const discordEnvFile = path.join(discordBridgeRoot, '.env')
const discordPidFile = path.join(discordBridgeRoot, 'discord-bridge.pid')
const discordOutLog = path.join(portableRoot, 'Logs', 'discord-bridge.out.log')
const discordErrLog = path.join(portableRoot, 'Logs', 'discord-bridge.err.log')
const dashboardUpdateStateFile = path.join(portableRoot, 'Logs', 'dashboard-update.json')
const dashboardUpdatePidFile = path.join(portableRoot, 'Logs', 'dashboard-update.pid')
const dashboardUpdateScript = path.join(portableRoot, 'scripts', 'dashboard-update.ps1')
const dashboardUpdateLauncher = path.join(portableRoot, 'scripts', 'launch-dashboard-update.ps1')
const schematicStore = new SchematicStore(schematicsRoot, require(path.join(portableRoot,'Bots','node_modules','prismarine-nbt')))
const schematicBuildHistory = new BoundedHistoryStore(schematicBuildHistoryFile, 5)
const reconnectHistory = new BoundedHistoryStore(reconnectHistoryFile, 1000)
// Info: Alleen de vijf nieuwste bouwopdrachten worden hersteld; onafgeronde opdrachten worden na een Hub-herstart eerlijk als mislukt gemarkeerd.
const recoveredSchematicBuilds = schematicBuildHistory.list().map(job => {
  if (['completed','failed','cancelled'].includes(job.status)) return job
  return { ...job, status:'failed',updatedAt:Date.now(),builders:(job.builders||[]).map(builder => ['completed','failed','cancelled'].includes(builder.status)?builder:{...builder,status:'failed',errorCode:'HUB_RESTARTED',updatedAt:Date.now()}) }
})
const schematicBuildJobs = new Map(recoveredSchematicBuilds.map(job => [job.id, job]))
if (recoveredSchematicBuilds.length) schematicBuildHistory.replace(recoveredSchematicBuilds)
const runningBots = new Map()
const telemetrySockets = new Map()
const botPortBase = 3110
const botPortStep = 2
const perBotBackupLimit = 5
const supportedMinecraftVersions = ['1.21.11', '1.21.9', '1.21.8', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.20', '1.19.4', '1.19.3', '1.19.2', '1.19', '1.18.2', '1.17.1', '1.16.5', '1.15.2', '1.14.4', '1.13.2', '1.12.2', '1.11.2', '1.10.2', '1.9.4', '1.8.8', '1.7']
const appVersion = String(readJson(path.join(portableRoot, 'Bots', 'package.json'), {}).version || '0.0.0')
const crashWindowMs = 10 * 60 * 1000
const crashWindowLimit = 5
const defaultTeamSettings = { enabled: true, heartbeatIntervalMs: 3000, botOfflineAfterMs: 12000, taskAcceptTimeoutMs: 10000, taskReservationMs: 30000, areaReservationMs: 60000, objectReservationMs: 30000, inventoryReservationMs: 60000, maxTaskRetries: 3, assignmentIntervalMs: 2000, conflictDistance: 2.5, conflictTimeoutMs: 5000, yieldCooldownMs: 3000, logisticsContainers: [] }
const defaultDashboardSettings = { enabled:true,realtimeEnabled:true,positionUpdateIntervalMs:1000,statusUpdateIntervalMs:3000,eventBufferSize:500,debugMode:false,allowControlActions:true }

function normalizeTeamSettings(value = {}) {
  const number = (name, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value[name] ?? defaultTeamSettings[name])))
  return { ...defaultTeamSettings, ...value, enabled: value.enabled !== false, heartbeatIntervalMs:number('heartbeatIntervalMs',1000,30000),botOfflineAfterMs:number('botOfflineAfterMs',3000,120000),taskAcceptTimeoutMs:number('taskAcceptTimeoutMs',1000,60000),taskReservationMs:number('taskReservationMs',5000,300000),areaReservationMs:number('areaReservationMs',5000,300000),objectReservationMs:number('objectReservationMs',5000,300000),inventoryReservationMs:number('inventoryReservationMs',5000,300000),maxTaskRetries:number('maxTaskRetries',0,10),assignmentIntervalMs:number('assignmentIntervalMs',500,30000),conflictDistance:number('conflictDistance',1,16),conflictTimeoutMs:number('conflictTimeoutMs',1000,60000),yieldCooldownMs:number('yieldCooldownMs',500,30000),logisticsContainers:Array.isArray(value.logisticsContainers)?value.logisticsContainers.filter(item=>item?.id&&item?.worldId&&item?.position):[] }
}
function normalizeDashboardSettings(value={}){const number=(name,min,max)=>Math.max(min,Math.min(max,Number(value[name]??defaultDashboardSettings[name]))),envBool=(name,fallback)=>process.env[name]===undefined?fallback:process.env[name]==='1';return{...defaultDashboardSettings,...value,enabled:envBool('DASHBOARD_ENABLED',value.enabled!==false),realtimeEnabled:envBool('DASHBOARD_REALTIME_ENABLED',value.realtimeEnabled!==false),positionUpdateIntervalMs:Number(process.env.DASHBOARD_POSITION_INTERVAL_MS)||number('positionUpdateIntervalMs',500,10000),statusUpdateIntervalMs:Number(process.env.DASHBOARD_STATUS_INTERVAL_MS)||number('statusUpdateIntervalMs',1000,30000),eventBufferSize:number('eventBufferSize',50,5000),debugMode:envBool('DASHBOARD_DEBUG',value.debugMode===true),allowControlActions:envBool('DASHBOARD_ALLOW_CONTROLS',value.allowControlActions!==false)}}

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

function persistSchematicBuilds() {
  const latest = [...schematicBuildJobs.values()].sort((left, right) => Number(right.createdAt) - Number(left.createdAt)).slice(0, 5)
  schematicBuildJobs.clear()
  for (const job of latest) schematicBuildJobs.set(job.id, job)
  schematicBuildHistory.replace(latest)
}

function recordReconnect(bot, details = {}) {
  const timestamp = Date.now()
  reconnectHistory.add({
    id: crypto.randomUUID(),
    timestamp,
    botId: bot.id,
    botName: bot.name,
    serverId: `${String(bot.host || 'unknown').toLowerCase()}:${Number(bot.port || 25565)}`,
    serverName: `${bot.host || 'unknown'}:${Number(bot.port || 25565)}`,
    attempt: Number(bot.reconnectAttempts || 0),
    delayMs: Number(details.delayMs || 0),
    reason: String(details.reason || 'worker-exit').slice(0, 80)
  })
}

function reconnectDashboardData() {
  const events = reconnectHistory.list().filter(event => Number.isFinite(Number(event.timestamp)))
  return { ...summarizeReconnects(events),events:events.slice(0, 100) }
}

function diagnosticLogCounts(bot) {
  const lines = tailLog(bot)
  const count = pattern => lines.filter(line => pattern.test(line)).length
  return {
    connectionReset: count(/ECONNRESET/i),
    connectionAborted: count(/ECONNABORTED/i),
    throttled: count(/Connection throttled/i),
    idleKicks: count(/disconnect\.idling/i),
    taskTimeouts: count(/task_timeout/i),
    nullPositionErrors: count(/null \(reading 'position'\)/i)
  }
}

async function diagnosticReport() {
  const health = await systemHealth()
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    application: { version:appVersion,node:process.version,platform:process.platform,architecture:process.arch,hubUptimeSeconds:Math.round(process.uptime()) },
    checks: {
      paths: (health.paths||[]).map(item => ({ name:item.name,ok:item.ok })),
      ports: health.ports||[],
      disk: health.disk ? { size:health.disk.size,free:health.disk.free } : null,
      dashboardEnabled: settings.dashboard.enabled,
      realtimeEnabled: settings.dashboard.realtimeEnabled,
      teamEnabled: settings.team.enabled
    },
    bots: await Promise.all(settings.bots.map(async bot => ({
      name:bot.name,
      username:bot.username,
      server:`${bot.host}:${bot.port}`,
      version:bot.version,
      status:await botStatus(bot),
      stats:{starts:Number(bot.stats?.starts||0),crashes:Number(bot.stats?.crashes||0),totalRuntimeMs:Number(bot.stats?.totalRuntimeMs||0),lastExit:bot.stats?.lastExit||null,recentCrashes:Array.isArray(bot.stats?.recentCrashes)?bot.stats.recentCrashes.slice(-10):[]},
      recentLogCounts:diagnosticLogCounts(bot)
    }))),
    reconnects: reconnectDashboardData(),
    schematicBuilds: [...schematicBuildJobs.values()].map(job => ({ id:job.id,name:job.schematicName,status:job.status,createdAt:job.createdAt,updatedAt:job.updatedAt,builders:(job.builders||[]).map(builder=>({name:builder.name,status:builder.status,errorCode:builder.errorCode||null,blocks:builder.blocks})) })),
    team: { goals:teamCoordinator.goals().length,tasks:teamCoordinator.tasks().length,reservations:teamStore.state.reservations.length },
    note: 'Secrets, authentication files, environment variables, full filesystem paths, knowledge and world data are intentionally excluded.'
  }
}

function readEnv(file) {
  if (!fs.existsSync(file)) return {}
  const env = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return env
}

// Info: Secrets worden atomisch in het reeds genegeerde .env-bestand geschreven en nooit teruggestuurd naar de browser.
function writeEnvValue(file, key, value) {
  if (!/^[A-Z0-9_]+$/.test(key)) throw new Error('Invalid environment key.')
  const clean = String(value ?? '')
  if (/[\r\n]/.test(clean)) throw new Error('Environment values may not contain newlines.')
  fs.mkdirSync(path.dirname(file), { recursive:true })
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  const line = `${key}=${clean}`
  const next = pattern.test(current) ? current.replace(pattern, line) : `${current.replace(/\s*$/, '')}${current.trim()?'\r\n':''}${line}\r\n`
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, next, 'utf8')
  fs.renameSync(temp, file)
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function localStamp(date = new Date(), separator = ' ') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  const time = `${parts.hour}${parts.minute}${parts.second}`
  const day = `${parts.day}${parts.month}${parts.year}`
  return `${time}${separator}${day}`
}

function localStampFile(date = new Date()) {
  return localStamp(date, '-')
}

function normalizePort(value, fallback) {
  const port = Math.floor(Number(value))
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback
}

function normalizeHostAndPort(hostValue, portValue) {
  const rawHost = String(hostValue || '').trim()
  const combined = rawHost.match(/^(.+):(\d{1,5})$/)
  return {
    host: combined ? combined[1] : rawHost,
    port: normalizePort(combined ? combined[2] : portValue, 25565)
  }
}

function normalizeMinecraftVersion(value, fallback = '1.21.4') {
  const version = String(value || '').trim()
  return supportedMinecraftVersions.includes(version) ? version : fallback
}

function normalizeServerProfile(profile) {
  const server = normalizeHostAndPort(profile?.host, profile?.port)
  const name = String(profile?.name || 'Server').trim().slice(0, 80) || 'Server'
  return {
    id: String(profile?.id || crypto.randomUUID()).trim().slice(0, 80) || crypto.randomUUID(),
    name,
    host: server.host || 'localhost',
    port: server.port,
    version: normalizeMinecraftVersion(profile?.version, '1.21.4')
  }
}

function validateBotFolder(folderValue) {
  const raw = String(folderValue || '').trim()
  const folder = path.resolve(path.isAbsolute(raw) ? raw : path.join(__dirname, raw))
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Bot folder does not exist.')
  if (!fs.existsSync(path.join(folder, 'bot.js'))) throw new Error('The selected folder does not contain bot.js.')
  return folder
}

function resolvedBotFolder(bot) {
  if (String(bot.folder).startsWith('@/')) return path.resolve(portableRoot, String(bot.folder).slice(2))
  return path.resolve(path.isAbsolute(bot.folder) ? bot.folder : path.join(__dirname, bot.folder))
}

function portablePath(folder) {
  const relative = path.relative(portableRoot, path.resolve(folder))
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? `@/${relative}` : path.resolve(folder)
}

function nextPorts(bots) {
  const used = new Set(bots.flatMap(bot => [bot.hudPort, bot.viewerPort].map(Number)))
  let hudPort = botPortBase
  while (used.has(hudPort) || used.has(hudPort + 1) || hudPort === HUB_PORT || hudPort + 1 === HUB_PORT) hudPort += botPortStep
  return { hudPort, viewerPort: hudPort + 1 }
}

function compactBotPorts(bots) {
  let hudPort = botPortBase
  for (const bot of bots) {
    if (hudPort === HUB_PORT || hudPort + 1 === HUB_PORT) hudPort += botPortStep
    bot.hudPort = hudPort
    bot.viewerPort = hudPort + 1
    hudPort += botPortStep
  }
  return bots
}

function writePortsConfig() {
  const bots = {}
  for (const bot of settings?.bots || []) {
    bots[bot.name] = {
      hud: normalizePort(bot.hudPort, botPortBase),
      viewer: normalizePort(bot.viewerPort, botPortBase + 1)
    }
  }
  fs.mkdirSync(path.dirname(portsFile), { recursive: true })
  fs.writeFileSync(portsFile, `${JSON.stringify({ hub: HUB_PORT, bots }, null, 2)}\n`, 'utf8')
}

function botFromFolder(folder, existingBots = []) {
  const botSettings = readJson(path.join(folder, 'bot-settings.json'), {})
  const ports = nextPorts(existingBots)
  const name = path.basename(folder)
  return {
    id: crypto.randomUUID(),
    name,
    username: minecraftUsername(name),
    ownerPlayer: normalizePlayerName(botSettings.ownerPlayer),
    whitelistedPlayers: normalizePlayerList(botSettings.whitelistedPlayers),
    folder: portablePath(folder),
    host: String(botSettings.host || 'localhost'),
    port: normalizePort(botSettings.port, 25565),
    version: normalizeMinecraftVersion(botSettings.version, '1.21.4'),
    hudPort: ports.hudPort,
    viewerPort: ports.viewerPort,
    group: 'Ungrouped',
    autoRestart: true,
    reconnectAttempts: 0,
    disabledUntil: null,
    stats: { starts: 0, crashes: 0, totalRuntimeMs: 0, lastExit: null, lastError: '' }
  }
}

function normalizePlayerName(value) {
  const name = String(value || '').trim()
  return /^[A-Za-z0-9_]{1,16}$/.test(name) ? name : ''
}

function normalizePlayerList(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/[\r\n,;]+/)
  return [...new Map(entries.map(normalizePlayerName).filter(Boolean).map(name => [name.toLowerCase(), name])).values()]
}

function minecraftUsername(value) {
  return String(value || 'MinecraftAI').trim().replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16) || 'MinecraftAI'
}

function findBotFolders(rootValue) {
  const root = path.resolve(String(rootValue || '').trim())
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('Folder does not exist.')
  const found = []
  const ignored = new Set(['node_modules', '.git', 'knowledge', 'worlds', 'backups', 'logs', 'merged-knowledge'])
  const visit = (folder, depth) => {
    if (found.length >= 100 || depth > 4) return
    try {
      if (fs.existsSync(path.join(folder, 'bot.js'))) {
        found.push(folder)
        return
      }
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith('.')) visit(path.join(folder, entry.name), depth + 1)
      }
    } catch {}
  }
  visit(root, 0)
  return found
}

function normalizeBot(bot) {
  const folder = String(bot.folder || '').startsWith('@/')
    ? path.resolve(portableRoot, String(bot.folder).slice(2))
    : path.resolve(path.isAbsolute(String(bot.folder || '')) ? String(bot.folder || '') : path.join(__dirname, String(bot.folder || '')))
  const server = normalizeHostAndPort(bot.host, bot.port)
  const folderSettings = readJson(path.join(folder, 'bot-settings.json'), {})
  return {
    id: String(bot.id || crypto.randomUUID()),
    name: String(bot.name || path.basename(folder || 'Minecraft AI')).trim().slice(0, 80) || 'Minecraft AI',
    // Info: De gekozen Hub-naam is ook de Minecraft-username; zo erven nieuwe of gekloonde bots nooit de bronnaam.
    username: minecraftUsername(bot.name || path.basename(folder || 'MinecraftAI')),
    ownerPlayer: normalizePlayerName(bot.ownerPlayer ?? folderSettings.ownerPlayer),
    whitelistedPlayers: normalizePlayerList(bot.whitelistedPlayers ?? folderSettings.whitelistedPlayers),
    auth: ['offline', 'microsoft'].includes(String(bot.auth || '').toLowerCase()) ? String(bot.auth).toLowerCase() : undefined,
    viewerEnabled: bot.viewerEnabled === true,
    folder: portablePath(folder),
    host: server.host || 'localhost',
    port: server.port,
    version: normalizeMinecraftVersion(bot.version, '1.21.4'),
    hudPort: normalizePort(bot.hudPort, botPortBase),
    viewerPort: normalizePort(bot.viewerPort, botPortBase + 1),
    group: String(bot.group || 'Ungrouped').trim().slice(0, 60) || 'Ungrouped',
    autoRestart: bot.autoRestart !== false,
    reconnectAttempts: Math.max(0, Math.min(20, Number(bot.reconnectAttempts || 0))),
    disabledUntil: bot.disabledUntil || null,
    stats: {
      starts: 0,
      crashes: 0,
      totalRuntimeMs: 0,
      lastExit: null,
      lastError: '',
      recentCrashes: [],
      ...(bot.stats || {})
    }
  }
}

function loadSettings() {
  const loaded = readJson(settingsFile, readJson(legacySettingsFile, {}))
  const bots = compactBotPorts(Array.isArray(loaded.bots) ? loaded.bots.map(normalizeBot) : [])
  return {
    bots,
    groups: Array.isArray(loaded.groups) ? loaded.groups : [],
    serverProfiles: Array.isArray(loaded.serverProfiles) ? loaded.serverProfiles.map(normalizeServerProfile) : [],
    schedules: Array.isArray(loaded.schedules) ? loaded.schedules : [],
    mergeHistory: Array.isArray(loaded.mergeHistory) ? loaded.mergeHistory : [],
    team: normalizeTeamSettings(loaded.team),
    dashboard: normalizeDashboardSettings(loaded.dashboard),
    viewerLayout: {
      columns: [1, 2, 3, 4].includes(Number(loaded.viewerLayout?.columns)) ? Number(loaded.viewerLayout.columns) : 2,
      order: Array.isArray(loaded.viewerLayout?.order) ? loaded.viewerLayout.order.map(String) : [],
      hidden: Array.isArray(loaded.viewerLayout?.hidden) ? loaded.viewerLayout.hidden.map(String) : []
    }
  }
}

let settings = loadSettings()
const teamStore = new TeamStore(teamStateFile)
const teamCoordinator = new TeamCoordinator(teamStore, settings.team)
const dashboardEvents = new EventBuffer(settings.dashboard.eventBufferSize)
const dashboardStreams = new Set()
const dashboardService = new DashboardService({ team:teamCoordinator,events:dashboardEvents,configBots:()=>settings.bots,resolveBotFolder:resolvedBotFolder,telemetry:id=>telemetrySockets.get(id),settings:()=>settings.dashboard })

function dashboardEvent(event){const value=dashboardEvents.add(event);if(!settings.dashboard.realtimeEnabled)return value;const line=`event: dashboard\ndata: ${JSON.stringify(value)}\n\n`;for(const response of dashboardStreams){try{response.write(line)}catch{dashboardStreams.delete(response)}}return value}
teamCoordinator.on('event',dashboardEvent)

function saveSettings() {
  cleanupViewerLayout()
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  const temp = `${settingsFile}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, settingsFile)
  writePortsConfig()
}
saveSettings()

function cleanupViewerLayout() {
  if (!settings?.viewerLayout) return
  const ids = new Set((settings.bots || []).map(bot => bot.id))
  settings.viewerLayout.order = (settings.viewerLayout.order || []).filter(id => ids.has(id))
  settings.viewerLayout.hidden = (settings.viewerLayout.hidden || []).filter(id => ids.has(id))
}

function pruneOldDirectories(root, keep = perBotBackupLimit) {
  if (!fs.existsSync(root)) return 0
  const folders = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const folder = path.join(root, entry.name)
      return { folder, mtimeMs: fs.statSync(folder).mtimeMs }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  let removed = 0
  for (const entry of folders.slice(Math.max(0, keep))) {
    fs.rmSync(entry.folder, { recursive: true, force: true })
    removed++
  }
  return removed
}

function cleanupBotBackups() {
  let removed = 0
  for (const bot of settings.bots || []) {
    const folder = resolvedBotFolder(bot)
    removed += pruneOldDirectories(path.join(folder, 'backups'), perBotBackupLimit)
    removed += pruneOldDirectories(path.join(folder, 'knowledge-backups'), perBotBackupLimit)
    removed += pruneOldDirectories(path.join(updateBackupsRoot, bot.id), perBotBackupLimit)
  }
  return removed
}

function cleanupStaleHubLogs() {
  if (!fs.existsSync(logsRoot)) return 0
  const ids = new Set((settings.bots || []).map(bot => bot.id))
  let removed = 0
  for (const entry of fs.readdirSync(logsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue
    const id = entry.name.replace(/\.log$/i, '')
    if (/^[0-9a-f-]{36}$/i.test(id) && !ids.has(id)) {
      fs.rmSync(path.join(logsRoot, entry.name), { force: true })
      removed++
    }
  }
  return removed
}

function runMaintenance() {
  return {
    botBackupsRemoved: cleanupBotBackups(),
    staleLogsRemoved: cleanupStaleHubLogs()
  }
}
setTimeout(() => {
  try {
    const result = runMaintenance()
    if (result.botBackupsRemoved || result.staleLogsRemoved) console.log('Maintenance cleanup:', result)
  } catch (err) {
    console.log('Maintenance cleanup skipped:', err.message)
  }
}, 1000)

function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function botPauseMs(bot) {
  const until = bot.disabledUntil ? Date.parse(bot.disabledUntil) : 0
  return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0
}

function recordBotCrash(bot, message) {
  const now = Date.now()
  bot.stats.recentCrashes = Array.isArray(bot.stats.recentCrashes) ? bot.stats.recentCrashes : []
  bot.stats.recentCrashes = bot.stats.recentCrashes
    .map(value => Date.parse(value))
    .filter(value => Number.isFinite(value) && now - value < crashWindowMs)
    .map(value => new Date(value).toISOString())
  bot.stats.recentCrashes.push(new Date(now).toISOString())
  bot.stats.crashes = (bot.stats.crashes || 0) + 1
  bot.stats.lastError = message
  if (bot.stats.recentCrashes.length >= crashWindowLimit) {
    bot.disabledUntil = new Date(now + crashWindowMs).toISOString()
    bot.stats.lastError = `Paused after ${crashWindowLimit} crashes in 10 minutes.`
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.killed) return resolve(true)
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function killPidTree(pid) {
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    let output = ''
    let error = ''
    killer.stdout.on('data', chunk => { output += chunk })
    killer.stderr.on('data', chunk => { error += chunk })
    killer.once('exit', code => {
      if (code === 0) resolve(output.trim())
      else reject(new Error(error.trim() || output.trim() || `taskkill exited with code ${code}`))
    })
  })
}

function portListening(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: LOCAL_HOST, port })
    const finish = result => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(1200)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function portOwnerPid(port) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise(resolve => {
    const netstat = spawn('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true })
    let output = ''
    netstat.stdout.on('data', chunk => { output += chunk })
    netstat.once('error', () => resolve(null))
    netstat.once('exit', () => {
      const suffix = `:${Number(port)}`
      for (const line of output.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 5 && parts[1]?.endsWith(suffix) && parts[3] === 'LISTENING') {
          const pid = Number(parts[4])
          return resolve(Number.isInteger(pid) && pid > 0 ? pid : null)
        }
      }
      resolve(null)
    })
  })
}

function botRootPid(pid) {
  if (process.platform !== 'win32' || !pid) return Promise.resolve(pid || null)
  const script = [
    `$currentId=${Number(pid)}`,
    '$rootId=$currentId',
    'while ($currentId -gt 0) {',
    '  $process=Get-CimInstance Win32_Process -Filter "ProcessId=$currentId" -ErrorAction SilentlyContinue',
    '  if (-not $process) { break }',
    '  if ($process.CommandLine -match "bot\\.js") { $rootId=$currentId }',
    '  $currentId=[int]$process.ParentProcessId',
    '}',
    'Write-Output $rootId'
  ].join('; ')
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.once('error', () => resolve(pid))
    child.once('exit', () => {
      const root = Number(output.trim().split(/\r?\n/).pop())
      resolve(Number.isInteger(root) && root > 0 ? root : pid)
    })
  })
}

async function botStatus(bot) {
  const runtime = runningBots.get(bot.id)
  if (runtime && !processAlive(runtime.pid)) runningBots.delete(bot.id)
  const managed = runningBots.get(bot.id)
  const telemetry = telemetrySockets.get(bot.id)
  const telemetryFresh = telemetry?.receivedAt && Date.now() - Date.parse(telemetry.receivedAt) < 20000
  const [hudOnline, viewerOnline] = await Promise.all([portListening(bot.hudPort), portListening(bot.viewerPort)])
  const effectiveHudOnline = Boolean(hudOnline || telemetryFresh || managed)
  return {
    running: Boolean(managed) || effectiveHudOnline,
    managed: Boolean(managed),
    pid: managed?.pid || null,
    startedAt: managed?.startedAt || null,
    pausedUntil: bot.disabledUntil || null,
    pausedMs: botPauseMs(bot),
    hudOnline: effectiveHudOnline,
    viewerOnline
  }
}

function ensureTelemetry(bot) {
  const current = telemetrySockets.get(bot.id)
  if (current?.port === bot.hudPort) return current
  if (current) current.socket.close()

  const entry = { port: bot.hudPort, data: null, receivedAt: null, socket: null, lastDashboardPushAt:0 }
  const socket = io(`http://127.0.0.1:${bot.hudPort}`, {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 3000,
    timeout: 1200
  })
  entry.socket = socket
  // Info: Teamverkeer gebruikt dezelfde Socket.IO-verbinding als bestaande HUD-telemetrie.
  socket.on('team:register', payload => {
    try { teamCoordinator.register({ ...payload, botId: bot.id }, socket);dashboardEvent({type:'bot.registered',botId:bot.id,message:`${bot.name} registered for teamwork`}) } catch (error) { socket.emit('team:error', { errorCode: error.message }) }
  })
  socket.on('team:heartbeat', payload => {
    try { teamCoordinator.heartbeat({ ...payload, botId: bot.id }) } catch (error) { socket.emit('team:error', { errorCode: error.message }) }
  })
  socket.on('team:unregister', payload => { try { teamCoordinator.unregister(bot.id,payload.instanceId) } catch {} })
  socket.on('team:task-accepted', payload => { try { const task=teamCoordinator.accept({ ...payload, botId:bot.id });dashboardEvent({type:'task.accepted',level:'info',botId:bot.id,taskId:task.id,goalId:task.teamGoalId,message:`${bot.name} accepted ${task.skill}`});socket.emit('team:task-start-approved',{taskId:task.id}) } catch(error){socket.emit('team:error',{errorCode:error.message})} })
  socket.on('team:task-rejected', payload => { try { teamCoordinator.reject({ ...payload, botId:bot.id }) } catch {} })
  socket.on('team:task-started', payload => { try { const task=teamCoordinator.start({ ...payload, botId:bot.id });dashboardEvent({type:'task.started',botId:bot.id,taskId:task.id,goalId:task.teamGoalId,message:`${bot.name} started ${task.skill}`}) } catch(error){socket.emit('team:error',{errorCode:error.message})} })
  socket.on('team:task-progress', payload => { try { teamCoordinator.progress({ ...payload, botId:bot.id }) } catch {} })
  socket.on('team:task-blocked', payload => { try { const task=teamCoordinator.block({ ...payload, botId:bot.id });dashboardEvent({type:'task.blocked',level:'warning',botId:bot.id,taskId:task.id,goalId:task.teamGoalId,errorCode:task.lastError,message:`${bot.name} was blocked: ${task.lastError}`}) } catch(error){socket.emit('team:error',{errorCode:error.message})} })
  socket.on('team:task-completed', payload => { try { const task=teamCoordinator.complete({ ...payload, botId:bot.id });dashboardEvent({type:'task.completed',level:'success',botId:bot.id,taskId:task.id,goalId:task.teamGoalId,message:`${bot.name} completed ${task.skill}`}) } catch(error){socket.emit('team:error',{errorCode:error.message})} })
  socket.on('team:task-failed', payload => { try { const task=teamCoordinator.fail({ ...payload, botId:bot.id });dashboardEvent({type:'task.failed',level:'error',botId:bot.id,taskId:task.id,goalId:task.teamGoalId,errorCode:task.lastError,message:`${bot.name} failed ${task.skill}: ${task.lastError}`}) } catch(error){socket.emit('team:error',{errorCode:error.message})} })
  socket.on('team:reservation-create', (payload, acknowledge) => { try { const value=teamCoordinator.reservations.create({ ...payload, ownerBotId:bot.id });teamStore.save();acknowledge?.({ok:true,reservation:value}) } catch(error){acknowledge?.({ok:false,errorCode:error.message})} })
  socket.on('team:reservation-renew', (payload, acknowledge) => { try { const value=teamCoordinator.reservations.renew(payload.id,bot.id,payload.instanceId,payload.ttlMs);teamStore.save();acknowledge?.({ok:true,reservation:value}) } catch(error){acknowledge?.({ok:false,errorCode:error.message})} })
  socket.on('team:reservation-release', payload => { teamCoordinator.reservations.release(payload.id,bot.id,payload.instanceId);teamStore.save() })
  socket.on('team:inventory-container', payload => { try { teamCoordinator.inventory.updateContainer(payload);teamStore.save() } catch {} })
  socket.on('team:control-result', payload => {
    const requestId=String(payload?.requestId||''),job=[...schematicBuildJobs.values()].find(value=>value.builders.some(builder=>builder.requestId===requestId)),builder=job?.builders.find(value=>value.requestId===requestId)
    if(!builder)return
    Object.assign(builder,{status:payload.ok?'queued':'failed',localTaskId:payload.taskId??null,errorCode:payload.errorCode||null,updatedAt:Date.now()})
    job.status=job.builders.every(value=>value.status==='failed')?'failed':'running';job.updatedAt=Date.now()
    persistSchematicBuilds()
    dashboardEvent({type:'schematic.accepted',level:payload.ok?'info':'error',botId:bot.id,errorCode:builder.errorCode,message:payload.ok?`${bot.name} queued schematic blocks`:`${bot.name} rejected schematic build: ${builder.errorCode||'unknown error'}`})
  })
  socket.on('team:control-completed', payload => {
    const requestId=String(payload?.requestId||''),job=[...schematicBuildJobs.values()].find(value=>value.builders.some(builder=>builder.requestId===requestId)),builder=job?.builders.find(value=>value.requestId===requestId)
    if(!builder)return
    Object.assign(builder,{status:payload.ok?'completed':'failed',errorCode:payload.errorCode||null,result:payload.result||null,updatedAt:Date.now()})
    job.status=job.builders.every(value=>value.status==='completed')?'completed':job.builders.some(value=>value.status==='failed')?'failed':'running';job.updatedAt=Date.now()
    persistSchematicBuilds()
    dashboardEvent({type:'schematic.completed',level:payload.ok?'success':'error',botId:bot.id,errorCode:builder.errorCode,message:payload.ok?`${bot.name} completed its schematic blocks`:`${bot.name} could not build: ${builder.errorCode||'unknown error'}`})
  })
  socket.on('disconnect', () => { const registered=teamCoordinator.registry.get(bot.id);if(registered)teamCoordinator.unregister(bot.id,registered.instanceId) })
  socket.on('update', data => {
    const inventorySummary = {}
    for (const item of Array.isArray(data?.inventory) ? data.inventory : []) if (item?.name) inventorySummary[item.name]=(inventorySummary[item.name]||0)+Number(item.count||0)
    entry.data = {
      connected: Boolean(data?.connected),
      health: data?.health ?? null,
      food: data?.food ?? null,
      mode: data?.mode ?? 'unknown',
      autonomy: Boolean(data?.autonomy?.enabled),
      pvp: Boolean(data?.pvp),
      xp: data?.xp ?? 0,
      position: data?.position ?? null,
      dimension: data?.team?.activeTask?.dimension || data?.worldMemory?.dimension || null,
      inventorySummary,
      equipment: data?.equipment ?? null,
      currentTask: data?.currentTask ?? null,
      reliableTask: data?.reliableTask ?? null,
      currentStep: data?.currentStep ?? null,
      activeSkill: data?.activeSkill ?? null,
      attempt: data?.attempt ?? 0,
      maxAttempts: data?.maxAttempts ?? 0,
      lastError: data?.lastError ?? null,
      pathStatus: data?.pathStatus ?? null,
      safetyState: data?.safetyState ?? 'unknown',
      curriculum: data?.curriculum ?? null,
      taskLog: Array.isArray(data?.taskLog) ? data.taskLog.slice(0,20) : [],
      team: data?.team ?? null,
      planner: settings.dashboard.debugMode ? data?.planner ?? null : undefined,
      currentPlan: settings.dashboard.debugMode ? data?.currentPlan ?? [] : undefined,
      chatHistory: Array.isArray(data?.chatHistory) ? data.chatHistory.slice(0, 80) : [],
      username: data?.botUsername ||
        data?.chatHistory?.find(entry => entry?.role === 'ai')?.author ||
        data?.botSettings?.username ||
        null
    }
    entry.receivedAt = new Date().toISOString()
    if(Date.now()-entry.lastDashboardPushAt>=settings.dashboard.positionUpdateIntervalMs){entry.lastDashboardPushAt=Date.now();dashboardEvent({type:'bot.status',level:'debug',botId:bot.id,message:`${bot.name} status updated`})}
  })
  telemetrySockets.set(bot.id, entry)
  return entry
}

function sendToBots(botIds, text) {
  const message = String(text || '').trim()
  if (!message) throw new Error('Enter a message or AI command.')
  if (message.length > 256) throw new Error('Messages and commands may contain at most 256 characters.')
  const ids = [...new Set((botIds || []).map(String))]
  const targets = ids.length ? settings.bots.filter(bot => ids.includes(bot.id)) : settings.bots
  if (!targets.length) throw new Error('No bots were selected.')
  const sent = []
  const skipped = []
  for (const bot of targets) {
    const telemetry = ensureTelemetry(bot)
    if (!telemetry.socket.connected || telemetry.data?.connected !== true) {
      skipped.push(bot.name)
      continue
    }
    telemetry.socket.emit('command', message)
    sent.push(bot.name)
  }
  return { sent, skipped, message }
}

function mergedKnowledgeList() {
  if (!fs.existsSync(mergedRoot)) return []
  return fs.readdirSync(mergedRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const folder = path.join(mergedRoot, entry.name)
      const files = fs.readdirSync(folder).filter(name => name.endsWith('.json')).sort()
      return {
        id: entry.name,
        folder,
        files,
        fileCount: files.length,
        createdAt: fs.statSync(folder).birthtime.toISOString()
      }
    })
    .filter(entry => entry.fileCount)
    .sort((left, right) => right.id.localeCompare(left.id))
}

function copyKnowledgeExact(source, target) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('Merged knowledge folder does not exist.')
  fs.mkdirSync(target, { recursive: true })
  for (const name of fs.readdirSync(target)) {
    const file = path.join(target, name)
    if (fs.statSync(file).isFile() && name.endsWith('.json')) fs.unlinkSync(file)
  }
  for (const name of fs.readdirSync(source)) {
    const file = path.join(source, name)
    if (!fs.statSync(file).isFile() || !name.endsWith('.json')) continue
    fs.copyFileSync(file, path.join(target, name))
  }
}

function tailLog(bot, search = '') {
  const file = path.join(logsRoot, `${bot.id}.log`)
  if (!fs.existsSync(file)) return []
  const query = String(search || '').toLowerCase()
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter(line => line && (!query || line.toLowerCase().includes(query))).slice(-300)
}

function tailFile(file, lines = 80) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines)
}

function parseChannelMap(value) {
  return String(value || '').split(',').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const index = entry.includes(':') ? entry.indexOf(':') : entry.indexOf('=')
    if (index <= 0) return null
    const channelId = entry.slice(0, index).trim()
    const botId = entry.slice(index + 1).trim()
    const bot = settings.bots.find(item => item.id === botId || item.name === botId)
    return { channelId, botId, botName: bot?.name || botId }
  }).filter(Boolean)
}

function discordBridgeStatus() {
  const env = readEnv(discordEnvFile)
  const pid = fs.existsSync(discordPidFile) ? Number(fs.readFileSync(discordPidFile, 'utf8').trim()) : 0
  const outLines = tailFile(discordOutLog, 80)
  const errLines = tailFile(discordErrLog, 80)
  const lastError = errLines.slice().reverse().find(line => line && !/^Node\.js/i.test(line)) || ''
  return {
    installed: fs.existsSync(discordBridgeFile),
    tokenConfigured: Boolean(env.DISCORD_TOKEN),
    running: processAlive(pid),
    pid: processAlive(pid) ? pid : null,
    prefix: env.DISCORD_PREFIX || '!mc',
    hubUrl: env.HUB_URL || `http://localhost:${HUB_PORT}`,
    channelId: env.DISCORD_CHANNEL_ID || '',
    botChannels: parseChannelMap(env.DISCORD_BOT_CHANNELS),
    serverChatChannels: parseChannelMap(env.DISCORD_SERVER_CHAT_CHANNELS),
    botChannelCount: parseChannelMap(env.DISCORD_BOT_CHANNELS).length,
    serverChatChannelCount: parseChannelMap(env.DISCORD_SERVER_CHAT_CHANNELS).length,
    lastError,
    lastOutput: outLines.slice(-12),
    errorLines: errLines.slice(-12)
  }
}

async function saveDiscordToken(token, remove = false) {
  const value = String(token || '').trim()
  if (!remove && !/^[A-Za-z0-9._-]{30,200}$/.test(value)) throw new Error('Enter a valid Discord bot token without spaces.')
  writeEnvValue(discordEnvFile, 'DISCORD_TOKEN', remove ? '' : value)
  if (remove) await stopDiscordBridge()
  else await restartDiscordBridge()
  return discordBridgeStatus()
}

function dashboardUpdateStatus() {
  const state = readJson(dashboardUpdateStateFile, {})
  const pid = fs.existsSync(dashboardUpdatePidFile) ? Number(fs.readFileSync(dashboardUpdatePidFile, 'utf8').trim()) : 0
  const running=Boolean(pid&&processAlive(pid)),transitional=new Set(['starting','checking','applying','restarting'])
  const startupGrace=state.status==='starting'&&state.startedAt&&Date.now()-Date.parse(state.startedAt)<15000
  if(startupGrace)return{appVersion,running:true,status:'starting',message:String(state.message||'Update wordt voorbereid.'),startedAt:state.startedAt,finishedAt:null}
  if(!running&&transitional.has(state.status))return{appVersion,running:false,status:'failed',message:'Het updateproces is onverwacht gestopt. Bekijk Logs/dashboard-update-launcher.err.log, Logs/dashboard-update.err.log en Logs/update.log.',startedAt:state.startedAt||null,finishedAt:new Date().toISOString()}
  return { appVersion, running, status:state.status||'idle', message:String(state.message||''), startedAt:state.startedAt||null, finishedAt:state.finishedAt||null }
}

async function startDashboardUpdate() {
  if (!fs.existsSync(dashboardUpdateScript)) throw new Error('Dashboard update script is missing.')
  if (!fs.existsSync(dashboardUpdateLauncher)) throw new Error('Dashboard update launcher is missing.')
  const current = dashboardUpdateStatus()
  if (current.running) throw new Error('An update is already running.')
  fs.mkdirSync(path.dirname(dashboardUpdateStateFile), { recursive:true })
  fs.writeFileSync(dashboardUpdateStateFile, `${JSON.stringify({status:'starting',message:'Update wordt voorbereid.',startedAt:new Date().toISOString()},null,2)}\n`, 'utf8')
  try{fs.rmSync(dashboardUpdatePidFile,{force:true})}catch{}
  // Info: antwoord zodra de launcher een echte updater-PID meldt; wacht niet op de volledige update.
  let launchError=null
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',dashboardUpdateLauncher],{cwd:portableRoot,windowsHide:true,stdio:'ignore'})
  child.once('error',error=>{launchError=error})
  child.unref()
  let pid=0
  for(let attempt=0;attempt<100&&!pid&&!launchError;attempt++){
    await wait(50)
    pid=fs.existsSync(dashboardUpdatePidFile)?Number(fs.readFileSync(dashboardUpdatePidFile,'utf8').trim()):0
  }
  if(launchError){
    const message=`Updater kon niet starten: ${launchError.message}`
    fs.writeFileSync(dashboardUpdateStateFile,`${JSON.stringify({status:'failed',message,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()},null,2)}\n`,'utf8')
    throw new Error(message)
  }
  if(!pid){
    const message='Updater kon niet starten: de launcher heeft binnen 5 seconden geen proces-ID teruggegeven.'
    fs.writeFileSync(dashboardUpdateStateFile,`${JSON.stringify({status:'failed',message,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()},null,2)}\n`,'utf8')
    throw new Error(message)
  }
  return { ...dashboardUpdateStatus(), running:true }
}

async function stopDiscordBridge() {
  const pid = fs.existsSync(discordPidFile) ? Number(fs.readFileSync(discordPidFile, 'utf8').trim()) : 0
  if (pid && processAlive(pid)) {
    try { await killPidTree(pid) } catch {
      try { process.kill(pid) } catch {}
    }
  }
  try { fs.unlinkSync(discordPidFile) } catch {}
}

function startDiscordBridge() {
  if (!fs.existsSync(discordBridgeFile)) throw new Error('Discord bridge is not installed.')
  fs.mkdirSync(path.dirname(discordOutLog), { recursive: true })
  const script = [
    `Start-Process -WindowStyle Hidden -FilePath ${psQuote(process.execPath)} -ArgumentList 'index.js' -WorkingDirectory ${psQuote(discordBridgeRoot)} -RedirectStandardOutput ${psQuote(discordOutLog)} -RedirectStandardError ${psQuote(discordErrLog)}`
  ].join('; ')
  const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  })
  child.unref()
}

async function restartDiscordBridge() {
  await stopDiscordBridge()
  await wait(700)
  startDiscordBridge()
  return discordBridgeStatus()
}

async function sendDiscordTestMessage(channelId) {
  const env = readEnv(discordEnvFile)
  const token = env.DISCORD_TOKEN
  if (!token) throw new Error('DISCORD_TOKEN is missing.')
  const status = discordBridgeStatus()
  const targetChannel = String(channelId || status.channelId || status.serverChatChannels[0]?.channelId || status.botChannels[0]?.channelId || '').trim()
  if (!/^\d{10,30}$/.test(targetChannel)) throw new Error('No Discord channel is linked yet.')
  const response = await fetch(`https://discord.com/api/v10/channels/${targetChannel}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `Hub testbericht ${localStamp()}`, allowed_mentions: { parse: [] } })
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || `Discord test failed: ${response.status}`)
  return { channelId: targetChannel }
}

function configBackupList() {
  if (!fs.existsSync(configBackupsRoot)) return []
  return fs.readdirSync(configBackupsRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => {
      const file = path.join(configBackupsRoot, entry.name)
      const stat = fs.statSync(file)
      return { name: entry.name, file, createdAt: stat.mtime.toISOString(), size: stat.size }
    })
    .sort((left, right) => right.name.localeCompare(left.name))
}

function backupConfigNow(reason = 'manual') {
  if (!fs.existsSync(settingsFile)) throw new Error('settings.json does not exist.')
  fs.mkdirSync(configBackupsRoot, { recursive: true })
  const file = path.join(configBackupsRoot, `settings-${reason}-${localStampFile()}.json`)
  fs.copyFileSync(settingsFile, file)
  return { name: path.basename(file), file }
}

function restoreLatestConfigBackup() {
  const latest = configBackupList()[0]
  if (!latest) throw new Error('No config backup is available.')
  backupConfigNow('before-restore')
  fs.copyFileSync(latest.file, settingsFile)
  settings = loadSettings()
  saveSettings()
  return latest
}

function setViewers(botIds, enabled) {
  const ids = new Set(Array.isArray(botIds) && botIds.length ? botIds.map(String) : settings.bots.map(bot => bot.id))
  const sent = []
  const skipped = []
  for (const bot of settings.bots.filter(item => ids.has(item.id))) {
    const telemetry = ensureTelemetry(bot)
    if (!telemetry.socket.connected) {
      skipped.push(bot.name)
      continue
    }
    telemetry.socket.emit('command', `ai viewer ${enabled ? 'on' : 'off'}`)
    sent.push(bot.name)
  }
  return { sent, skipped }
}

function displayedStats(bot) {
  const lines = tailLog(bot)
  const workerCrashes = lines.filter(line => /Bot worker stopped|Minecraft connection error|Priority loop error/i.test(line)).length
  const stats = bot.stats || { starts: 0, crashes: 0, totalRuntimeMs: 0, lastExit: null, lastError: '' }
  const lastErrorIndex = lines.findLastIndex(line => /error|timed out|ECONN|worker stopped/i.test(line))
  const lastRecoveryIndex = lines.findLastIndex(line => /Minecraft spawn complete|Hub online|HUD open/i.test(line))
  const lastError = lastRecoveryIndex > lastErrorIndex ? '' : (lastErrorIndex >= 0 ? lines[lastErrorIndex] : stats.lastError || '')
  return { ...stats, crashes: Math.max(stats.crashes || 0, workerCrashes), lastError }
}

function knowledgeScores(bot) {
  const folder = path.join(resolvedBotFolder(bot), 'knowledge')
  const sum = value => typeof value === 'number' ? value : value && typeof value === 'object'
    ? Object.values(value).reduce((total, child) => total + sum(child), 0) : 0
  return Object.fromEntries(['mining', 'combat', 'movement', 'crafting'].map(domain => {
    const data = readJson(path.join(folder, `${domain}.json`), {})
    return [domain, Math.round(sum(data.stats || {}) + sum(data.learning || {}))]
  }))
}

function updateBotCode(sourceFolder, bot) {
  const source = validateBotFolder(sourceFolder)
  const target = validateBotFolder(resolvedBotFolder(bot))
  // Info: Code-updates gebruiken een allowlist zodat knowledge, worlds, login-data, instellingen en logs nooit worden overschreven.
  const codeDirectories = new Set(['src', 'public', 'tools', 'test'])
  const codeFiles = new Set(['bot.js', 'package.json', 'package-lock.json', 'README.md'])
  const backup = path.join(updateBackupsRoot, bot.id, localStampFile())
  fs.mkdirSync(backup, { recursive: true })
  const copied = []
  const copyTree = (from, to, backupTo) => {
    fs.mkdirSync(to, { recursive: true })
    fs.mkdirSync(backupTo, { recursive: true })
    for (const name of fs.readdirSync(from)) {
      const sourceItem = path.join(from, name)
      const targetItem = path.join(to, name)
      const backupItem = path.join(backupTo, name)
      if (fs.statSync(sourceItem).isDirectory()) copyTree(sourceItem, targetItem, backupItem)
      else {
        if (fs.existsSync(targetItem)) fs.copyFileSync(targetItem, backupItem)
        fs.copyFileSync(sourceItem, targetItem)
        copied.push(path.relative(source, sourceItem))
      }
    }
  }
  for (const entry of fs.readdirSync(source, { withFileTypes:true })) {
    const name = entry.name
    const from = path.join(source, name)
    if (entry.isDirectory()) {
      if (codeDirectories.has(name)) copyTree(from, path.join(target, name), path.join(backup, name))
      continue
    }
    if (!entry.isFile() || !codeFiles.has(name)) continue
    const to = path.join(target, name)
    if (fs.existsSync(to)) fs.copyFileSync(to, path.join(backup, name))
    fs.copyFileSync(from, to)
    copied.push(name)
  }
  return { copied, backup }
}

function copyTreeFiltered(source, target, ignoredNames = new Set()) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name) || entry.name.startsWith('.')) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copyTreeFiltered(from, to, ignoredNames)
    else fs.copyFileSync(from, to)
  }
}

function uniqueBotFolderName(baseName) {
  const safeBase = String(baseName || 'minecraft-ai-bot')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'minecraft-ai-bot'
  let name = safeBase
  let counter = 2
  while (fs.existsSync(path.join(botsRoot, name))) name = `${safeBase}-${counter++}`
  return name
}

async function cloneBot(sourceBot, requestedName) {
  if ((await botStatus(sourceBot)).running) throw new Error(`Stop ${sourceBot.name} before cloning it.`)
  const source = validateBotFolder(resolvedBotFolder(sourceBot))
  const name = uniqueBotFolderName(requestedName || `${sourceBot.name}-copy`)
  const target = path.join(botsRoot, name)
  const ignored = new Set(['node_modules', 'bot-output.log', 'bot-error.log', 'logs', 'backups'])
  copyTreeFiltered(source, target, ignored)
  const bot = normalizeBot({
    ...sourceBot,
    id: crypto.randomUUID(),
    name,
    username: minecraftUsername(name),
    folder: portablePath(target),
    stats: { starts: 0, crashes: 0, totalRuntimeMs: 0, lastExit: null, lastError: '', recentCrashes: [] },
    disabledUntil: null
  })
  const ports = nextPorts([...settings.bots, bot])
  bot.hudPort = ports.hudPort
  bot.viewerPort = ports.viewerPort
  settings.bots.push(bot)
  settings.viewerLayout.order = [...new Set([...(settings.viewerLayout.order || []), bot.id])]
  saveSettings()
  await assignFreePorts(bot)
  return bot
}

function latestDirectory(root) {
  if (!fs.existsSync(root)) return null
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const folder = path.join(root, entry.name)
      const stat = fs.statSync(folder)
      return { name: entry.name, folder, createdAt: localStamp(stat.birthtime), modifiedAt: localStamp(stat.mtime), modifiedMs: stat.mtimeMs }
    })
    .sort((left, right) => right.modifiedMs - left.modifiedMs)[0] || null
}

function fileCount(root, extension = '') {
  if (!fs.existsSync(root)) return 0
  let count = 0
  const visit = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (!extension || entry.name.toLowerCase().endsWith(extension)) count++
    }
  }
  visit(root)
  return count
}

function diskInfo() {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const drive = path.parse(portableRoot).root.replace(/\\$/, '')
  const script = `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress`
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.once('error', () => resolve(null))
    child.once('exit', () => {
      try {
        const data = JSON.parse(output || '{}')
        resolve({ drive, size: Number(data.Size || 0), free: Number(data.FreeSpace || 0) })
      } catch {
        resolve(null)
      }
    })
  })
}

async function systemHealth() {
  return buildSystemHealth({
    settings,
    HUB_PORT,
    portableRoot,
    hubRoot: __dirname,
    settingsFile,
    portsFile,
    logsRoot,
    startupBackupsRoot,
    botsRoot,
    path,
    fs,
    portListening,
    latestDirectory,
    fileCount,
    diskInfo,
    resolvedBotFolder,
    botStatus,
    displayedStats,
    configBackupList,
    discordBridgeStatus
  })
}

async function statePayload() {
  const registeredIds = new Set(settings.bots.map(bot => bot.id))
  for (const [id, entry] of telemetrySockets) {
    if (!registeredIds.has(id)) {
      entry.socket.close()
      telemetrySockets.delete(id)
    }
  }
  return {
    appVersion,
    hubPort: HUB_PORT,
    mergedKnowledge: mergedKnowledgeList(),
    groups: [...new Set([...settings.groups, ...settings.bots.map(bot => bot.group)])].sort(),
    serverProfiles: settings.serverProfiles,
    supportedMinecraftVersions,
    schedules: settings.schedules,
    viewerLayout: settings.viewerLayout,
    dashboard: settings.dashboard,
    mergeHistory: settings.mergeHistory.slice(-50).reverse(),
    discordBridge: (() => {
      const status = discordBridgeStatus()
      return {
        installed: status.installed,
        running: status.running,
        pid: status.pid,
        botChannelCount: status.botChannelCount,
        serverChatChannelCount: status.serverChatChannelCount,
        lastError: status.lastError
      }
    })(),
    bots: await Promise.all(settings.bots.map(async bot => {
      const telemetry = ensureTelemetry(bot)
      const stats = displayedStats(bot)
      if (telemetry.data?.connected) stats.lastError = ''
      return { ...bot, stats, folder: resolvedBotFolder(bot), status: await botStatus(bot), telemetry: telemetry.data, telemetryAt: telemetry.receivedAt }
    })),
    team: teamCoordinator.snapshot()
  }
}

async function portsAvailable(bot) {
  const conflicts = settings.bots.filter(other =>
    other.id !== bot.id &&
    [other.hudPort, other.viewerPort].some(port => port === bot.hudPort || port === bot.viewerPort) &&
    runningBots.has(other.id)
  )
  if (conflicts.length) throw new Error(`HUD/viewer port conflicts with ${conflicts.map(item => item.name).join(', ')}.`)
  if (await portListening(bot.hudPort)) throw new Error(`HUD port ${bot.hudPort} is already in use.`)
  if (await portListening(bot.viewerPort)) throw new Error(`Viewer port ${bot.viewerPort} is already in use.`)
}

async function assignFreePorts(bot) {
  const currentHud = normalizePort(bot.hudPort, 0)
  const currentViewer = normalizePort(bot.viewerPort, 0)
  const usedByOtherBots = new Set(settings.bots
    .filter(other => other.id !== bot.id)
    .flatMap(other => [other.hudPort, other.viewerPort].map(Number)))

  const pairIsUsable = async (hudPort, viewerPort) => {
    if (!hudPort || !viewerPort || hudPort === viewerPort) return false
    if (hudPort === HUB_PORT || viewerPort === HUB_PORT) return false
    if (usedByOtherBots.has(hudPort) || usedByOtherBots.has(viewerPort)) return false
    return !(await portListening(hudPort)) && !(await portListening(viewerPort))
  }

  if (await pairIsUsable(currentHud, currentViewer)) return false

  let hudPort = botPortBase
  while (!(await pairIsUsable(hudPort, hudPort + 1))) hudPort += botPortStep
  bot.hudPort = hudPort
  bot.viewerPort = hudPort + 1
  saveSettings()
  return true
}

async function startBot(bot) {
  const pausedMs = botPauseMs(bot)
  if (pausedMs > 0) throw new Error(`${bot.name} is paused by crash monitor for ${Math.ceil(pausedMs / 60000)} more minute(s).`)
  bot.disabledUntil = null
  if (runningBots.has(bot.id) && processAlive(runningBots.get(bot.id).pid)) throw new Error('This bot is already running from the Hub.')
  const folder = validateBotFolder(resolvedBotFolder(bot))
  await assignFreePorts(bot)
  await portsAvailable(bot)
  fs.mkdirSync(logsRoot, { recursive: true })
  const logFile = path.join(logsRoot, `${bot.id}.log`)
  const logHandle = fs.openSync(logFile, 'a')
  const childEnv = { ...process.env }
  delete childEnv.NODE_TLS_REJECT_UNAUTHORIZED
  const child = spawn(process.execPath, [path.join(folder, 'bot.js')], {
    cwd: folder,
    env: {
      ...childEnv,
      PORT: String(bot.hudPort),
      VIEWER_PORT: String(bot.viewerPort),
      VIEWER_DISTANCE: '2',
      MC_HOST: bot.host,
      MC_PORT: String(bot.port),
      MC_VERSION: bot.version,
      MC_USERNAME: bot.username || bot.name,
      ...(bot.auth ? { MC_AUTH: bot.auth } : {}),
      VIEWER_AUTOSTART: bot.viewerEnabled === true ? '1' : '0',
      MINECRAFT_AI_WORKER: '1'
      ,BOT_ID: bot.id
      ,BOT_TYPE: path.basename(folder)
      ,HUB_URL: `http://127.0.0.1:${HUB_PORT}`
      ,TEAM_ENABLED: settings.team.enabled ? '1' : '0'
      ,TEAM_HEARTBEAT_INTERVAL_MS: String(settings.team.heartbeatIntervalMs)
      ,BOT_OWNER_PLAYER: bot.ownerPlayer || ''
      ,BOT_WHITELISTED_PLAYERS: JSON.stringify(bot.whitelistedPlayers || [])
    },
    detached: false,
    windowsHide: true,
    stdio: ['ignore', logHandle, logHandle]
  })
  fs.closeSync(logHandle)
  bot.stats.starts = (bot.stats.starts || 0) + 1
  saveSettings()
  const runtime = { pid: child.pid, child, startedAt: new Date().toISOString(), stopping: false }
  runningBots.set(bot.id, runtime)
  child.once('exit', (code, signal) => {
    const runtime = runningBots.get(bot.id)
    if (!runtime) return
    bot.stats.totalRuntimeMs = (bot.stats.totalRuntimeMs || 0) + Date.now() - Date.parse(runtime.startedAt)
    bot.stats.lastExit = new Date().toISOString()
    const plannedReconnect = Number(code) === 75
    if (!runtime.stopping && !plannedReconnect) {
      recordBotCrash(bot, `Worker exited (${signal || code || 'unknown'}).`)
    }
    runningBots.delete(bot.id)
    saveSettings()
    if (!runtime.stopping && bot.autoRestart && botPauseMs(bot) === 0) {
      const livedFor = Date.now() - Date.parse(runtime.startedAt)
      // Info: Oplopende reconnectvertraging en vaste spreiding voorkomen dat alle bots tegelijk door de server worden gethrottled.
      if (livedFor >= 120000) bot.reconnectAttempts = 0
      if (plannedReconnect) bot.reconnectAttempts = Math.min(20,Number(bot.reconnectAttempts||0)+1)
      const jitter=[...String(bot.id)].reduce((total,char)=>total+char.charCodeAt(0),0)%7000
      const reconnectBackoff=Math.min(120000,5000*(2**Math.min(4,Math.max(0,Number(bot.reconnectAttempts||1)-1))))
      const restartDelay = plannedReconnect ? reconnectBackoff+jitter : (livedFor < 30000 ? 30000+jitter : 5000+jitter)
      if(plannedReconnect)console.log(`${bot.name} reconnect attempt ${bot.reconnectAttempts} scheduled in ${Math.ceil(restartDelay/1000)}s.`)
      recordReconnect(bot,{delayMs:restartDelay,reason:plannedReconnect?'connection-retry':'unexpected-worker-exit'})
      saveSettings()
      setTimeout(() => startBot(bot).catch(() => {}), restartDelay)
    }
  })
  return runtime
}

async function stopBot(bot) {
  const runtime = runningBots.get(bot.id)
  if (runtime) {
    runtime.stopping = true
    try { runtime.child.kill('SIGTERM') } catch {}
    if (await waitForExit(runtime.child, 3500)) {
      runningBots.delete(bot.id)
      return
    }
  }
  const hudPid = runtime?.pid || await portOwnerPid(bot.hudPort)
  const pid = runtime?.pid || await botRootPid(hudPid)
  if (!pid) throw new Error(`Could not find the process using HUD port ${bot.hudPort}.`)
  try {
    await killPidTree(pid)
  } finally {
    runningBots.delete(bot.id)
  }
}

function chooseFolder() {
  if (process.platform !== 'win32') throw new Error('Folder picker is currently available on Windows only.')
  const requestId = crypto.randomUUID()
  const pickerDirectory = path.join(__dirname, '.picker')
  const scriptFile = path.join(pickerDirectory, `${requestId}.ps1`)
  const resultFile = path.join(pickerDirectory, `${requestId}.result`)
  fs.mkdirSync(pickerDirectory, { recursive: true })
  const quote = value => String(value).replace(/'/g, "''")
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    "$owner.Text = 'Minecraft AI Bot Hub'",
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $true',
    '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$owner.Size = New-Object System.Drawing.Size(1, 1)',
    '$owner.Show()',
    '$owner.Activate()',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    "$dialog.Title = 'Choose the folder containing bot.js'",
    `$dialog.InitialDirectory = '${quote(__dirname)}'`,
    "$dialog.FileName = 'Select Folder'",
    "$dialog.Filter = 'Folder|*.folder'",
    '$dialog.CheckFileExists = $false',
    '$dialog.CheckPathExists = $true',
    '$dialog.ValidateNames = $false',
    '$result = $dialog.ShowDialog($owner)',
    '$owner.Close()',
    "$value = if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Split-Path -Parent $dialog.FileName } else { '' }",
    `[System.IO.File]::WriteAllText('${quote(resultFile)}', $value)`
  ].join("\r\n")
  fs.writeFileSync(scriptFile, script, 'utf8')

  return new Promise((resolve, reject) => {
    const picker = spawn('cmd.exe', ['/d', '/c', 'start', '', 'powershell.exe', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
      detached: true,
      windowsHide: false,
      stdio: 'ignore'
    })
    picker.unref()
    const startedAt = Date.now()
    const cleanup = () => {
      try { fs.unlinkSync(scriptFile) } catch {}
      try { fs.unlinkSync(resultFile) } catch {}
    }
    const timer = setInterval(() => {
      if (fs.existsSync(resultFile)) {
        clearInterval(timer)
        const result = fs.readFileSync(resultFile, 'utf8').trim()
        cleanup()
        resolve(result)
      } else if (Date.now() - startedAt > 120000) {
        clearInterval(timer)
        cleanup()
        reject(new Error('Folder picker timed out. Try starting the Hub with start-hub.cmd.'))
      }
    }, 150)
  })
}

function findBot(id) {
  const bot = settings.bots.find(item => item.id === id)
  if (!bot) throw new Error('Bot registration was not found.')
  return bot
}

const dashboardWriteRates=new Map()
function dashboardControlAllowed(request){if(!settings.dashboard.enabled||!settings.dashboard.allowControlActions)return false;const address=String(request.socket.remoteAddress||'');const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);const token=process.env.DASHBOARD_TOKEN;return local||Boolean(token&&request.get('X-Dashboard-Token')===token)}
function requireDashboardControl(request){if(!dashboardControlAllowed(request))throw new Error('Dashboard control is only allowed locally or with DASHBOARD_TOKEN.');const key=String(request.socket.remoteAddress||'unknown'),now=Date.now(),recent=(dashboardWriteRates.get(key)||[]).filter(at=>now-at<60000);if(recent.length>=30)throw new Error('Dashboard control rate limit exceeded.');recent.push(now);dashboardWriteRates.set(key,recent);const origin=request.get('Origin');if(origin){const expected=request.get('Host');if(new URL(origin).host!==expected)throw new Error('Dashboard origin check failed.')}}
function teamBotChannel(id){const bot=findBot(id),telemetry=ensureTelemetry(bot);if(!telemetry.socket.connected)throw new Error('Bot is offline.');return{bot,socket:telemetry.socket}}

const app = express()
app.use(express.json({ limit: '256kb' }))
app.use((_request,response,next)=>{response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','same-origin');response.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src http: https:; img-src 'self' data:");next()})
app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'public', 'hub.html')))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/state', async (_request, response, next) => {
  try { response.json(await statePayload()) } catch (err) { next(err) }
})

app.get('/api/project/site-status/:port', (request, response) => {
  const port = Number(request.params.port)
  const allowedPorts = new Set([3101, ...(settings.bots || []).map(bot => Number(bot.hudPort))])
  response.setHeader('Cache-Control', 'no-store')
  if (!Number.isInteger(port) || !allowedPorts.has(port)) return response.status(400).json({ ok:false, online:false })

  let finished = false
  const finish = online => {
    if (finished) return
    finished = true
    response.json({ ok:true, online })
  }
  const probe = http.get({ hostname:LOCAL_HOST, port, path:'/', timeout:2200 }, result => {
    result.resume()
    finish(result.statusCode >= 200 && result.statusCode < 500)
  })
  probe.setTimeout(2200, () => probe.destroy(new Error('Site check timed out.')))
  probe.on('error', () => finish(false))
})

app.get('/api/dashboard/overview',(_request,response,next)=>{try{response.json({ok:true,overview:dashboardService.overview()})}catch(error){next(error)}})
app.post('/api/dashboard/auth-check',(request,response,next)=>{try{requireDashboardControl(request);response.json({ok:true,authorized:true})}catch(error){next(error)}})
app.get('/api/dashboard/reconnects',(_request,response)=>response.json({ok:true,...reconnectDashboardData()}))
app.get('/api/diagnostics/download',async(_request,response,next)=>{try{const report=await diagnosticReport();response.setHeader('Content-Type','application/json; charset=utf-8');response.setHeader('Content-Disposition',`attachment; filename="f-mineflayer-diagnostics-${new Date().toISOString().slice(0,10)}.json"`);response.send(`${JSON.stringify(report,null,2)}\n`)}catch(error){next(error)}})
app.get('/api/dashboard/stream',(request,response)=>{if(!settings.dashboard.enabled||!settings.dashboard.realtimeEnabled)return response.status(404).end();response.setHeader('Content-Type','text/event-stream');response.setHeader('Cache-Control','no-cache, no-transform');response.setHeader('Connection','keep-alive');response.flushHeaders?.();response.write(`event: connected\ndata: ${JSON.stringify({at:Date.now()})}\n\n`);dashboardStreams.add(response);const heartbeat=setInterval(()=>response.write(`: heartbeat ${Date.now()}\n\n`),15000);request.on('close',()=>{clearInterval(heartbeat);dashboardStreams.delete(response)})})
app.get('/api/team/bots/:id',(request,response,next)=>{try{const bot=dashboardService.bot(request.params.id);if(!bot)throw new Error('Bot not found.');response.json({ok:true,bot})}catch(error){next(error)}})
app.post('/api/team/bots/:id/:action',(request,response,next)=>{try{requireDashboardControl(request);const allowed=new Set(['pause','resume','cancel-task','return-home','idle','reconnect','emergency-stop']);const action=String(request.params.action);if(!allowed.has(action))throw new Error('Unsupported bot control action.');if(['emergency-stop','reconnect'].includes(action)&&request.body?.confirmed!==true)throw new Error('Confirmation is required.');const {bot,socket}=teamBotChannel(request.params.id);socket.emit('team:control',{action,requestedAt:Date.now()});dashboardEvent({type:'bot.control',level:action==='emergency-stop'?'critical':'warning',botId:bot.id,message:`Control ${action} sent to ${bot.name}`});response.json({ok:true,botId:bot.id,action})}catch(error){next(error)}})
app.get('/api/team/goals/:id',(request,response,next)=>{try{const goal=dashboardService.goals().find(item=>item.id===request.params.id);if(!goal)throw new Error('Goal not found.');response.json({ok:true,goal})}catch(error){next(error)}})
app.post('/api/team/goals/:id/:action',(request,response,next)=>{try{requireDashboardControl(request);const goal=teamCoordinator.goals().find(item=>item.id===request.params.id);if(!goal)throw new Error('Goal not found.');const tasks=teamCoordinator.tasks().filter(item=>item.teamGoalId===goal.id);const action=request.params.action;if(action==='cancel'){if(request.body?.confirmed!==true)throw new Error('Confirmation is required.');for(const task of tasks)if(!['completed','cancelled'].includes(task.status))teamCoordinator.cancelTask(task.id);goal.status='cancelled'}else if(action==='pause'){goal.paused=true;goal.status='blocked';for(const task of tasks)if(task.status==='available')task.status='blocked'}else if(action==='resume'||action==='replan'){goal.paused=false;for(const task of tasks)if(task.status==='blocked'||(action==='replan'&&task.status==='failed'))Object.assign(task,{status:'available',lastError:null,excludedInstanceIds:[]});goal.status='ready';teamCoordinator.assign()}else throw new Error('Unsupported goal action.');goal.updatedAt=Date.now();teamStore.save();dashboardEvent({type:`goal.${action}`,goalId:goal.id,message:`Goal ${goal.id} ${action}`});response.json({ok:true,goal:dashboardService.goalDto(goal)})}catch(error){next(error)}})
app.patch('/api/team/goals/:id',(request,response,next)=>{try{requireDashboardControl(request);const goal=teamCoordinator.goals().find(item=>item.id===request.params.id);if(!goal)throw new Error('Goal not found.');const priority=Math.max(0,Math.min(100,Number(request.body?.priority)));if(!Number.isFinite(priority))throw new Error('Invalid priority.');goal.priority=priority;for(const task of teamCoordinator.tasks().filter(item=>item.teamGoalId===goal.id&&!['completed','cancelled'].includes(item.status)))task.priority=priority;teamStore.save();response.json({ok:true,goal:dashboardService.goalDto(goal)})}catch(error){next(error)}})
app.get('/api/team/tasks/:id',(request,response,next)=>{try{const task=teamCoordinator.findTask(request.params.id);if(!task)throw new Error('Task not found.');response.json({ok:true,task:dashboardService.taskDto(task)})}catch(error){next(error)}})
app.get('/api/learning/skills',(request,response)=>response.json({ok:true,skills:dashboardService.skills().filter(skill=>!request.query.name||skill.name===request.query.name)}))
app.get('/api/learning/skills/:name',(request,response,next)=>{try{const skill=dashboardService.skills().find(item=>item.name===request.params.name);if(!skill)throw new Error('Skill not found.');response.json({ok:true,skill})}catch(error){next(error)}})
app.get('/api/learning/experiences',(request,response)=>response.json({ok:true,...dashboardService.experiences(request.query)}))
app.get('/api/learning/curriculum',(_request,response)=>response.json({ok:true,bots:dashboardService.bots().map(bot=>({botId:bot.botId,curriculum:telemetrySockets.get(bot.botId)?.data?.curriculum||null}))}))
app.get('/api/logistics/inventory',(_request,response)=>response.json({ok:true,...dashboardService.logistics()}))
app.get('/api/logistics/containers',(_request,response)=>response.json({ok:true,containers:dashboardService.logistics().containers}))
app.get('/api/logistics/reservations',(_request,response)=>response.json({ok:true,reservations:dashboardService.logistics().reservations}))
app.get('/api/world/reservations',(request,response)=>response.json({ok:true,reservations:teamStore.state.reservations.filter(item=>(!request.query.worldId||item.worldId===request.query.worldId)&&item.type==='area')}))
app.get('/api/events',(request,response)=>response.json({ok:true,...dashboardEvents.query(request.query)}))

// Info: Toegangsbeheer is per Hub-botinstantie, ook wanneer bots dezelfde productiecode gebruiken.
app.get('/api/bot-access',(_request,response)=>response.json({ok:true,bots:settings.bots.map(bot=>({id:bot.id,name:bot.name,username:bot.username,ownerPlayer:bot.ownerPlayer||'',whitelistedPlayers:bot.whitelistedPlayers||[],running:Boolean(runningBots.get(bot.id))}))}))
app.patch('/api/bots/:id/access',(request,response,next)=>{try{requireDashboardControl(request);const bot=findBot(request.params.id),rawOwner=String(request.body?.ownerPlayer||'').trim(),ownerPlayer=normalizePlayerName(rawOwner);if(rawOwner&&!ownerPlayer)throw new Error('Owner must be a valid Minecraft player name (1-16 letters, numbers or underscores).');const rawList=Array.isArray(request.body?.whitelistedPlayers)?request.body.whitelistedPlayers:String(request.body?.whitelistedPlayers||'').split(/[\r\n,;]+/),whitelistedPlayers=normalizePlayerList(rawList);if(whitelistedPlayers.length!==rawList.filter(value=>String(value||'').trim()).length)throw new Error('One or more whitelisted player names are invalid or duplicated.');Object.assign(bot,{ownerPlayer,whitelistedPlayers});saveSettings();const telemetry=telemetrySockets.get(bot.id),appliedLive=Boolean(telemetry?.socket.connected);if(appliedLive)telemetry.socket.emit('team:control',{action:'update-command-access',ownerPlayer,whitelistedPlayers,requestedAt:Date.now()});response.json({ok:true,bot:{id:bot.id,name:bot.name,username:bot.username,ownerPlayer,whitelistedPlayers},appliedLive,restartRequired:Boolean(runningBots.get(bot.id)&&!appliedLive)})}catch(error){next(error)}})

// Info: Schematics worden server-side gevalideerd; bots ontvangen alleen een begrensde lijst blokken via hun bestaande TaskManager.
app.get('/api/schematics',(_request,response)=>response.json({ok:true,schematics:schematicStore.list(),builds:[...schematicBuildJobs.values()].sort((a,b)=>b.createdAt-a.createdAt).slice(0,5)}))
app.post('/api/schematics/upload',express.raw({type:'application/octet-stream',limit:MAX_BYTES}),async(request,response,next)=>{try{requireDashboardControl(request);const filename=decodeURIComponent(String(request.get('X-Schematic-Name')||''));response.json({ok:true,schematic:await schematicStore.save(filename,request.body)})}catch(error){next(error)}})
app.delete('/api/schematics/builds/:id',(request,response,next)=>{try{requireDashboardControl(request);if(request.body?.confirmed!==true)throw new Error('Confirmation is required.');const job=schematicBuildJobs.get(request.params.id);if(!job)throw new Error('Build history item not found.');if(!['completed','failed','cancelled'].includes(job.status))throw new Error('An active build cannot be removed.');schematicBuildJobs.delete(job.id);persistSchematicBuilds();dashboardEvent({type:'schematic.history-removed',level:'info',message:`Removed ${job.schematicName} build history item`});response.json({ok:true,id:job.id})}catch(error){next(error)}})
app.delete('/api/schematics/:id',(request,response,next)=>{try{requireDashboardControl(request);if(request.body?.confirmed!==true)throw new Error('Confirmation is required.');if(!schematicStore.remove(request.params.id))throw new Error('Schematic not found.');response.json({ok:true})}catch(error){next(error)}})
app.post('/api/schematics/:id/build',(request,response,next)=>{try{requireDashboardControl(request);const schematic=schematicStore.get(request.params.id,true);if(!schematic)throw new Error('Schematic not found.');const origin={x:Number(request.body?.origin?.x),y:Number(request.body?.origin?.y),z:Number(request.body?.origin?.z)};if(!Object.values(origin).every(Number.isInteger))throw new Error('Build coordinates must be whole block coordinates.');const rotation=Number(request.body?.rotation||0);if(![0,90,180,270].includes(rotation))throw new Error('Invalid rotation.');const ids=[...new Set([String(request.body?.primaryBotId||''),...(Array.isArray(request.body?.helperBotIds)?request.body.helperBotIds.map(String):[])].filter(Boolean))];if(!ids.length)throw new Error('Choose a primary bot.');const primary=teamCoordinator.registry.get(ids[0]);if(!primary?.online)throw new Error('The primary bot is offline.');const bots=ids.map(id=>{const live=teamCoordinator.registry.get(id);if(!live?.online)throw new Error(`${findBot(id).name} is offline.`);if(live.worldId!==primary.worldId)throw new Error('All builders must be on the same server.');return live});const unsafe=bots.filter(live=>live.safetyState==='unsafe');if(unsafe.length)throw new Error(`Build not started: ${unsafe.map(live=>findBot(live.botId).name).join(', ')} ${unsafe.length===1?'is':'are'} unsafe. Wait until the bot status is safe and try again.`);const transformed=transformBlocks(schematic.blocks,rotation,schematic.width,schematic.length),assignments=bots.map(()=>[]),buildId=crypto.randomUUID();transformed.forEach((block,index)=>assignments[index%bots.length].push(block));const job={id:buildId,schematicId:schematic.id,schematicName:schematic.name,worldId:primary.worldId,origin,rotation,status:'sent',createdAt:Date.now(),updatedAt:Date.now(),builders:bots.map((live,index)=>({botId:live.botId,name:findBot(live.botId).name,blocks:assignments[index].length,requestId:`${buildId}:${live.botId}`,status:'sent',errorCode:null}))};schematicBuildJobs.set(buildId,job);persistSchematicBuilds();bots.forEach((live,index)=>{const channel=teamBotChannel(live.botId),builder=job.builders[index];channel.socket.emit('team:control',{action:'build-schematic',requestId:builder.requestId,schematicId:schematic.id,schematicName:schematic.name,origin,rotation,blocks:assignments[index],totalBlocks:transformed.length,requestedAt:Date.now()})});dashboardEvent({type:'schematic.build',level:'info',botId:ids[0],message:`Schematic ${schematic.name} sent to ${bots.length} bot(s); waiting for validated results`});response.json({ok:true,buildId,schematic:{...schematic,blocks:undefined},builders:job.builders.map(({requestId,...builder})=>builder),origin,rotation})}catch(error){next(error)}})

// Info: Teambeheer blijft HTTP; live opdrachten en heartbeats lopen over de bestaande bot-sockets.
app.get('/api/team/bots', (_request,response) => response.json({ok:true,bots:teamCoordinator.registry.list()}))
app.get('/api/team/goals', (_request,response) => response.json({ok:true,goals:teamCoordinator.goals(),dashboardGoals:dashboardService.goals()}))
app.post('/api/team/goals', (request,response,next) => { try { requireDashboardControl(request);const body=request.body||{};if(!/^[a-z0-9_-]{1,64}$/i.test(String(body.type||'')))throw new Error('Invalid goal type.');if(!/^[a-f0-9_-]{8,128}$/i.test(String(body.worldId||'')))throw new Error('Invalid worldId.');if(body.amount!==undefined&&(!Number.isInteger(Number(body.amount))||Number(body.amount)<1||Number(body.amount)>2304))throw new Error('Invalid goal amount.');response.json({ok:true,goal:teamCoordinator.createGoal(body)}) } catch(error){next(error)} })
app.get('/api/team/tasks', (_request,response) => response.json({ok:true,tasks:teamCoordinator.tasks()}))
app.post('/api/team/tasks/:id/cancel', (request,response,next) => { try { requireDashboardControl(request);if(request.body?.confirmed!==true)throw new Error('Confirmation is required.');response.json({ok:true,task:teamCoordinator.cancelTask(request.params.id)}) } catch(error){next(error)} })
app.get('/api/team/reservations', (_request,response) => response.json({ok:true,reservations:teamStore.state.reservations}))
app.get('/api/team/inventory', (_request,response) => response.json({ok:true,inventory:teamCoordinator.inventory.snapshot()}))

// Info: Alleen lokale/geauthenticeerde dashboardbesturing mag secrets wijzigen of een systeemupdate starten.
app.get('/api/settings/integrations',(_request,response)=>response.json({ok:true,discord:{installed:fs.existsSync(discordBridgeFile),tokenConfigured:Boolean(readEnv(discordEnvFile).DISCORD_TOKEN),running:discordBridgeStatus().running},update:dashboardUpdateStatus()}))
app.post('/api/settings/discord',(request,response,next)=>{try{requireDashboardControl(request);if(request.body?.confirmed!==true)throw new Error('Confirmation is required.');saveDiscordToken(request.body?.token,request.body?.remove===true).then(discord=>response.json({ok:true,discord})).catch(next)}catch(error){next(error)}})
app.get('/api/system/update/status',(_request,response)=>response.json({ok:true,update:dashboardUpdateStatus()}))
app.post('/api/system/update',async(request,response,next)=>{try{requireDashboardControl(request);if(request.body?.confirmed!==true)throw new Error('Confirmation is required.');const update=await startDashboardUpdate();dashboardEvent({type:'system.update',level:'warning',message:'System update started; Hub will restart automatically'});response.status(202).json({ok:true,update})}catch(error){next(error)}})

registerSupportRoutes(app, {
  fs,
  settingsFile,
  systemHealth,
  discordBridgeStatus,
  restartDiscordBridge,
  sendDiscordTestMessage,
  configBackupList,
  backupConfigNow,
  restoreLatestConfigBackup
})

app.post('/api/maintenance/cleanup', (_request, response, next) => {
  try {
    response.json({ ok: true, ...runMaintenance() })
  } catch (err) { next(err) }
})

app.post('/api/command', (request, response, next) => {
  try {
    const result = sendToBots(request.body?.botIds, request.body?.text)
    response.json({ ok: true, ...result })
  } catch (err) { next(err) }
})

app.get('/api/logs/:id', (request, response, next) => {
  try { response.json({ ok: true, lines: tailLog(findBot(request.params.id), request.query.search) }) } catch (err) { next(err) }
})

app.get('/api/knowledge-scores', (_request, response, next) => {
  try { response.json({ ok: true, bots: settings.bots.map(bot => ({ id: bot.id, name: bot.name, scores: knowledgeScores(bot) })) }) } catch (err) { next(err) }
})

app.post('/api/config', (request, response, next) => {
  try {
    if(request.body?.dashboard||request.body?.team)requireDashboardControl(request)
    settings.groups = Array.isArray(request.body?.groups) ? request.body.groups.map(String).filter(Boolean) : settings.groups
    settings.serverProfiles = Array.isArray(request.body?.serverProfiles) ? request.body.serverProfiles : settings.serverProfiles
    settings.schedules = Array.isArray(request.body?.schedules) ? request.body.schedules : settings.schedules
    if (request.body?.team && typeof request.body.team === 'object') {
      settings.team = normalizeTeamSettings({ ...settings.team, ...request.body.team })
      teamCoordinator.options = { ...teamCoordinator.options, ...settings.team }
      teamCoordinator.registry.offlineAfterMs = settings.team.botOfflineAfterMs
    }
    if(request.body?.dashboard&&typeof request.body.dashboard==='object')settings.dashboard=normalizeDashboardSettings({...settings.dashboard,...request.body.dashboard})
    if (request.body?.viewerLayout && typeof request.body.viewerLayout === 'object') {
      const layout = request.body.viewerLayout
      settings.viewerLayout = {
        columns: [1, 2, 3, 4].includes(Number(layout.columns)) ? Number(layout.columns) : settings.viewerLayout.columns,
        order: Array.isArray(layout.order) ? layout.order.map(String) : settings.viewerLayout.order,
        hidden: Array.isArray(layout.hidden) ? layout.hidden.map(String) : settings.viewerLayout.hidden
      }
    }
    saveSettings()
    response.json({ ok: true })
  } catch (err) { next(err) }
})

app.post('/api/group/action', async (request, response, next) => {
  try {
    const bots = settings.bots.filter(bot => bot.group === String(request.body?.group || ''))
    const action = request.body?.action
    const results = []
    for (const bot of bots) {
      try {
        if (action === 'start' && !(await botStatus(bot)).running) await startBot(bot)
        if (action === 'stop' && runningBots.has(bot.id)) await stopBot(bot)
        results.push(bot.name)
      } catch {}
    }
    response.json({ ok: true, bots: results })
  } catch (err) { next(err) }
})

app.post('/api/group/delete', async (request, response, next) => {
  try {
    const group = String(request.body?.group || '').trim()
    if (!group || group === 'Ungrouped') throw new Error('This group cannot be deleted.')
    for (const bot of settings.bots) {
      if (bot.group === group) bot.group = 'Ungrouped'
    }
    settings.groups = settings.groups.filter(item => item !== group)
    settings.schedules = settings.schedules.filter(schedule => schedule.group !== group)
    saveSettings()
    response.json({ ok: true, group })
  } catch (err) { next(err) }
})

app.post('/api/bots/action', async (request, response, next) => {
  try {
    const action = String(request.body?.action || '')
    if (!['start', 'stop'].includes(action)) throw new Error('Bot action must be start or stop.')
    const results = []
    const skipped = []
    const errors = []
    for (const bot of settings.bots) {
      try {
        const status = await botStatus(bot)
        if (action === 'start') {
          if (status.running) {
            skipped.push(bot.name)
          } else {
            await startBot(bot)
            results.push(bot.name)
          }
        } else if (action === 'stop') {
          if (!status.running) {
            skipped.push(bot.name)
          } else {
            await stopBot(bot)
            results.push(bot.name)
          }
        }
      } catch (err) {
        errors.push({ bot: bot.name, error: err.message || String(err) })
      }
    }
    response.json({ ok: true, action, bots: results, skipped, errors })
  } catch (err) { next(err) }
})

app.post('/api/server-profile/apply', (request, response, next) => {
  try {
    const profile = settings.serverProfiles.find(item => item.id === request.body?.profileId)
    if (!profile) throw new Error('Server profile was not found.')
    const ids = new Set(Array.isArray(request.body?.botIds) ? request.body.botIds : [])
    for (const bot of settings.bots.filter(item => ids.has(item.id))) {
      bot.host = profile.host
      bot.port = normalizePort(profile.port, 25565)
      bot.version = normalizeMinecraftVersion(profile.version, bot.version)
    }
    saveSettings()
    response.json({ ok: true })
  } catch (err) { next(err) }
})

app.post('/api/update-code', async (request, response, next) => {
  try {
    requireDashboardControl(request)
    const source = findBot(String(request.body?.sourceBotId || ''))
    const ids = [...new Set(Array.isArray(request.body?.targetBotIds) ? request.body.targetBotIds : [])].filter(id => id !== source.id)
    if (!ids.length) throw new Error('Choose at least one target bot that is not the source bot.')
    const targets = ids.map(findBot)
    for (const bot of targets) if ((await botStatus(bot)).running) throw new Error(`Stop ${bot.name} before updating code.`)
    const results = targets.map(bot => ({ bot: bot.name, ...updateBotCode(resolvedBotFolder(source), bot) }))
    response.json({ ok: true, results })
  } catch (err) { next(err) }
})

// Info: Deze éénknopsactie gebruikt official-bot als productiebron en behoudt alle persoonlijke runtime-data van doelbots.
app.post('/api/update-all-bot-code', async (request, response, next) => {
  try {
    requireDashboardControl(request)
    if (request.body?.confirmed !== true) throw new Error('Confirmation is required.')
    const source = settings.bots.find(bot => bot.name === 'official-bot' || path.resolve(resolvedBotFolder(bot)) === path.resolve(path.join(botsRoot, 'official-bot')))
    if (!source) throw new Error('official-bot was not found and cannot be used as code source.')
    const targets = settings.bots.filter(bot => bot.id !== source.id)
    if (!targets.length) throw new Error('No other bots are registered.')
    const runningIds = new Set(),previousDisabledUntil=new Map(targets.map(bot=>[bot.id,bot.disabledUntil||null]))
    const stopped = [], restarted = [], results = [], errors = []
    for(const bot of targets)if((await botStatus(bot)).running)runningIds.add(bot.id)
    // Info: De tijdelijke pauze blokkeert ook een reeds geplande reconnect terwijl bestanden worden vervangen.
    for(const bot of targets)bot.disabledUntil=new Date(Date.now()+300000).toISOString()
    saveSettings()
    for (const bot of targets) {
      if(!runningIds.has(bot.id))continue
      try {
        await stopBot(bot)
        stopped.push(bot.name)
      } catch (error) {
        if(/Could not find the process/i.test(error.message||'')){runningBots.delete(bot.id);stopped.push(bot.name)}
        else errors.push({ bot:bot.name,stage:'stop',error:error.message||String(error) })
      }
    }
    for (const bot of targets) {
      if (errors.some(item => item.bot === bot.name && item.stage === 'stop')) continue
      try { results.push({ bot:bot.name,...updateBotCode(resolvedBotFolder(source),bot) }) }
      catch (error) { errors.push({ bot:bot.name,stage:'copy',error:error.message||String(error) }) }
    }
    for(const bot of targets)bot.disabledUntil=previousDisabledUntil.get(bot.id)
    saveSettings()
    for (const bot of targets.filter(item => runningIds.has(item.id))) {
      try { await startBot(bot);restarted.push(bot.name) }
      catch (error) { errors.push({ bot:bot.name,stage:'restart',error:error.message||String(error) }) }
    }
    dashboardEvent({type:'bots.code-updated',level:errors.length?'warning':'success',message:`Updated code for ${results.length} bot(s) from ${source.name}; ${errors.length} error(s)`})
    response.json({ok:errors.length===0,source:source.name,updated:results.map(item=>item.bot),stopped,restarted,results,errors})
  } catch (err) { next(err) }
})

app.post('/api/knowledge/restore-latest', async (request, response, next) => {
  try {
    const bot = findBot(String(request.body?.botId || ''))
    if ((await botStatus(bot)).running) throw new Error(`Stop ${bot.name} before restoring knowledge.`)
    const root = path.join(resolvedBotFolder(bot), 'knowledge-backups')
    const latest = fs.existsSync(root) ? fs.readdirSync(root).sort().pop() : null
    if (!latest) throw new Error('No knowledge backup is available for this bot.')
    copyKnowledgeExact(path.join(root, latest), path.join(resolvedBotFolder(bot), 'knowledge'))
    settings.mergeHistory.push({ at: localStamp(), action: 'restored', bots: [bot.name], backup: latest })
    saveSettings()
    response.json({ ok: true, bot: bot.name, backup: latest })
  } catch (err) { next(err) }
})

app.post('/api/knowledge/copy', async (request, response, next) => {
  try {
    const source = findBot(String(request.body?.sourceBotId || ''))
    const target = findBot(String(request.body?.targetBotId || ''))
    if (source.id === target.id) throw new Error('Choose two different bots.')
    if ((await botStatus(target)).running) throw new Error(`Stop ${target.name} before replacing its knowledge.`)
    const sourceKnowledge = path.join(resolvedBotFolder(source), 'knowledge')
    const targetKnowledge = path.join(resolvedBotFolder(target), 'knowledge')
    if (!fs.existsSync(sourceKnowledge) || !fs.statSync(sourceKnowledge).isDirectory()) throw new Error(`${source.name} has no knowledge folder.`)
    const backup = path.join(resolvedBotFolder(target), 'knowledge-backups', `copy-${localStampFile()}`)
    if (fs.existsSync(targetKnowledge)) copyKnowledgeExact(targetKnowledge, backup)
    copyKnowledgeExact(sourceKnowledge, targetKnowledge)
    settings.mergeHistory.push({ at: localStamp(), action: 'knowledge copied', bots: [source.name, target.name], backup })
    saveSettings()
    response.json({ ok: true, source: source.name, target: target.name, backup })
  } catch (err) { next(err) }
})

app.post('/api/folder-picker', async (_request, response, next) => {
  try { response.json({ folder: await chooseFolder() }) } catch (err) { next(err) }
})

app.post('/api/bots/import-folder', (request, response, next) => {
  try {
    const existing = new Set(settings.bots.map(bot => resolvedBotFolder(bot).toLowerCase()))
    const folders = findBotFolders(request.body?.folder)
    const added = []
    for (const folder of folders) {
      if (existing.has(folder.toLowerCase())) continue
      const bot = botFromFolder(folder, settings.bots)
      settings.bots.push(bot)
      existing.add(folder.toLowerCase())
      added.push(bot)
    }
    saveSettings()
    response.json({ ok: true, added, found: folders.length })
  } catch (err) { next(err) }
})

app.post('/api/bots/:id/clone', async (request, response, next) => {
  try {
    const bot = await cloneBot(findBot(request.params.id), request.body?.name)
    response.json({ ok: true, bot })
  } catch (err) { next(err) }
})

app.post('/api/bots/bulk-settings', async (request, response, next) => {
  try {
    const server = normalizeHostAndPort(request.body?.host, request.body?.port)
    const version = normalizeMinecraftVersion(request.body?.version, '1.21.4')
    if (!server.host) throw new Error('Enter a server host.')
    const updated = []
    const skipped = []
    for (const bot of settings.bots) {
      if ((await botStatus(bot)).running) {
        skipped.push(bot.name)
        continue
      }
      bot.host = server.host
      bot.port = server.port
      bot.version = version
      updated.push(bot.name)
    }
    saveSettings()
    response.json({ ok: true, updated, skipped, host: server.host, port: server.port, version })
  } catch (err) { next(err) }
})

app.post('/api/viewers/action', (request, response, next) => {
  try {
    const action = String(request.body?.action || '')
    if (!['on', 'off'].includes(action)) throw new Error('Viewer action must be on or off.')
    response.json({ ok: true, ...setViewers(request.body?.botIds, action === 'on') })
  } catch (err) { next(err) }
})

app.post('/api/bots', (request, response, next) => {
  try {
    const folder = validateBotFolder(request.body?.folder)
    if (settings.bots.some(bot => resolvedBotFolder(bot).toLowerCase() === folder.toLowerCase())) throw new Error('This bot folder is already registered.')
    const bot = botFromFolder(folder, settings.bots)
    settings.bots.push(bot)
    saveSettings()
    response.json({ ok: true, bot })
  } catch (err) { next(err) }
})

app.patch('/api/bots/:id', (request, response, next) => {
  try {
    const bot = findBot(request.params.id)
    if (runningBots.has(bot.id)) throw new Error('Stop the bot before changing its launch settings.')
    const server = normalizeHostAndPort(request.body?.host ?? bot.host, request.body?.port ?? bot.port)
    Object.assign(bot, normalizeBot({
      ...bot,
      name: request.body?.name ?? bot.name,
      username: request.body?.name !== undefined ? minecraftUsername(request.body.name) : bot.username,
      host: server.host,
      port: server.port,
      version: normalizeMinecraftVersion(request.body?.version ?? bot.version, bot.version),
      hudPort: request.body?.hudPort ?? bot.hudPort,
      viewerPort: request.body?.viewerPort ?? bot.viewerPort
    }))
    bot.group = String(request.body?.group ?? bot.group).trim().slice(0, 60) || 'Ungrouped'
    bot.autoRestart = request.body?.autoRestart !== false
    if (bot.hudPort === bot.viewerPort) throw new Error('HUD and viewer ports must be different.')
    saveSettings()
    response.json({ ok: true, bot })
  } catch (err) { next(err) }
})

app.delete('/api/bots/:id', async (request, response, next) => {
  try {
    const bot = findBot(request.params.id)
    if ((await botStatus(bot)).running) throw new Error('Stop the bot before removing it from the Hub.')
    telemetrySockets.get(bot.id)?.socket.close()
    telemetrySockets.delete(bot.id)
    settings.bots = settings.bots.filter(item => item.id !== bot.id)
    saveSettings()
    response.json({ ok: true })
  } catch (err) { next(err) }
})

app.post('/api/bots/:id/start', async (request, response, next) => {
  try {
    const runtime = await startBot(findBot(request.params.id))
    response.json({ ok: true, pid: runtime.pid })
  } catch (err) { next(err) }
})

app.post('/api/bots/:id/stop', async (request, response, next) => {
  try {
    await stopBot(findBot(request.params.id))
    response.json({ ok: true })
  } catch (err) { next(err) }
})

app.post('/api/merge', async (request, response, next) => {
  try {
    const ids = [...new Set(Array.isArray(request.body?.botIds) ? request.body.botIds.map(String) : [])]
    if (ids.length < 2) throw new Error('Select at least 2 bots.')
    const bots = ids.map(findBot)
    for (const bot of bots) {
      if ((await botStatus(bot)).running) throw new Error(`Stop ${bot.name} before merging its knowledge.`)
      validateBotFolder(resolvedBotFolder(bot))
    }
    const stamp = localStampFile()
    const output = path.join(mergedRoot, stamp)
    const results = mergeKnowledgeFoldersMany(bots.map(bot => path.join(resolvedBotFolder(bot), 'knowledge')), output)
    settings.mergeHistory.push({ at: localStamp(), action: 'created', mergeId: stamp, bots: bots.map(bot => bot.name) })
    saveSettings()
    response.json({ ok: true, output, files: results.map(result => result.name), bots: bots.map(bot => bot.name) })
  } catch (err) { next(err) }
})

app.post('/api/merge/apply', async (request, response, next) => {
  try {
    const mergeId = String(request.body?.mergeId || '')
    const merge = mergedKnowledgeList().find(entry => entry.id === mergeId)
    if (!merge) throw new Error('Select an existing merged knowledge folder.')
    const ids = [...new Set(Array.isArray(request.body?.botIds) ? request.body.botIds.map(String) : [])]
    if (ids.length < 1) throw new Error('Choose at least 1 target bot.')
    const bots = ids.map(findBot)
    for (const bot of bots) {
      if ((await botStatus(bot)).running) throw new Error(`Stop ${bot.name} before replacing its knowledge.`)
      validateBotFolder(resolvedBotFolder(bot))
    }

    const stamp = localStampFile()
    const applied = []
    for (const bot of bots) {
      const target = path.join(resolvedBotFolder(bot), 'knowledge')
      const backup = path.join(resolvedBotFolder(bot), 'knowledge-backups', stamp)
      if (fs.existsSync(target)) copyKnowledgeExact(target, backup)
      copyKnowledgeExact(merge.folder, target)
      applied.push({ bot: bot.name, target, backup })
    }
    settings.mergeHistory.push({ at: localStamp(), action: 'applied', mergeId, bots: bots.map(bot => bot.name) })
    saveSettings()
    response.json({ ok: true, bots: bots.map(bot => bot.name), mergeId, applied })
  } catch (err) { next(err) }
})

app.post('/api/open-folder', (request, response, next) => {
  try {
    const folder = path.resolve(String(request.body?.folder || ''))
    const allowed = folder === mergedRoot || folder.startsWith(`${mergedRoot}${path.sep}`) ||
      settings.bots.some(bot => folder === resolvedBotFolder(bot))
    if (!allowed || !fs.existsSync(folder)) throw new Error('Folder is not available.')
    spawn('explorer.exe', [folder], { detached: true, windowsHide: false, stdio: 'ignore' }).unref()
    response.json({ ok: true })
  } catch (err) { next(err) }
})

app.post('/api/shutdown', async (_request, response) => {
  response.json({ ok: true })
  teamCoordinator.close()
  clearInterval(teamSweepTimer)
  for(const stream of dashboardStreams)try{stream.end()}catch{}
  dashboardStreams.clear()
  for (const [id, runtime] of runningBots) {
    runtime.stopping = true
    try { runtime.child.kill() } catch {}
    runningBots.delete(id)
  }
  setTimeout(() => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }, 100).unref()
})

app.post('/api/restart-hub', (_request, response, next) => {
  try {
    response.json({ ok: true })
    const script = [
      'Start-Sleep -Milliseconds 1300',
      `Start-Process -WindowStyle Hidden -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(__filename)} -WorkingDirectory ${psQuote(__dirname)}`
    ].join('; ')
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    })
    child.unref()
    setTimeout(() => {
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 1500).unref()
    }, 100).unref()
  } catch (err) { next(err) }
})

app.use((err, _request, response, _next) => {
  response.status(400).json({ ok: false, error: err.message || 'Hub request failed.' })
})

let lastScheduleMinute = ''
const teamSweepTimer = setInterval(() => teamCoordinator.sweep(), settings.team.assignmentIntervalMs)
teamSweepTimer.unref?.()
setInterval(async () => {
  const now = new Date()
  const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  if (minute === lastScheduleMinute) return
  lastScheduleMinute = minute
  const time = minute.slice(-5)
  for (const schedule of settings.schedules.filter(item => item.enabled !== false && item.time === time)) {
    const bots = schedule.group ? settings.bots.filter(bot => bot.group === schedule.group) : settings.bots.filter(bot => (schedule.botIds || []).includes(bot.id))
    for (const bot of bots) {
      try {
        if (schedule.action === 'start' && !(await botStatus(bot)).running) await startBot(bot)
        else if (schedule.action === 'stop' && runningBots.has(bot.id)) await stopBot(bot)
        else if (schedule.action === 'command') sendToBots([bot.id], schedule.command)
      } catch {}
    }
  }
}, 15000)

const server = http.createServer(app).listen(HUB_PORT, HUB_HOST, () => {
  console.log(`Minecraft AI Bot Hub open: http://localhost:${HUB_PORT}`)
})
