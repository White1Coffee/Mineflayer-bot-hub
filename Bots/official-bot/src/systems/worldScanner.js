const ORE_BLOCKS = [
  'coal_ore', 'deepslate_coal_ore',
  'copper_ore', 'deepslate_copper_ore',
  'iron_ore', 'deepslate_iron_ore',
  'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'diamond_ore', 'deepslate_diamond_ore',
  'emerald_ore', 'deepslate_emerald_ore',
  'ancient_debris', 'nether_quartz_ore'
]

const DANGER_BLOCKS = ['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow']
const STATION_BLOCKS = [
  'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'chipped_anvil',
  'damaged_anvil', 'enchanting_table', 'brewing_stand', 'smithing_table'
]
const STORAGE_BLOCKS = ['chest', 'trapped_chest', 'barrel']
const BED_BLOCKS = [
  'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed', 'lime_bed',
  'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
  'brown_bed', 'green_bed', 'red_bed', 'black_bed'
]
const FARM_BLOCKS = ['farmland', 'wheat', 'carrots', 'potatoes', 'beetroots', 'melon', 'pumpkin', 'sugar_cane']
const VILLAGE_BLOCKS = ['bell', 'composter', 'lectern', 'cartography_table', 'stonecutter', 'loom', ...BED_BLOCKS]
const MINE_BLOCKS = ['rail', 'cobweb', 'oak_planks', 'oak_fence']
const PORTAL_BLOCKS = ['nether_portal', 'end_portal', 'end_portal_frame']

class WorldScanner {
  constructor(bot, state, worldMemory, options = {}) {
    this.bot = bot
    this.state = state || {}
    this.worldMemory = worldMemory || {}
    this.mcDataProvider = options.mcData || null
    this.save = options.save || (() => {})
    this.timestamp = options.timestamp || (() => new Date().toISOString())
    this.dimensionProvider = options.dimension || (() => 'unknown')
    this.maxEntries = Number(options.maxEntries || 120)
  }

  async tick() {
    if (!this.bot?.entity || !this.bot.findBlocks) return { changed: false, seen: 0 }
    this.ensureShape()
    let changed = false
    const scans = [
      ['ores', ORE_BLOCKS, 32, 48], ['dangers', DANGER_BLOCKS, 24, 24],
      ['stations', STATION_BLOCKS, 24, 24], ['storage', STORAGE_BLOCKS, 24, 16],
      ['beds', BED_BLOCKS, 32, 16], ['farms', FARM_BLOCKS, 32, 24],
      ['villages', VILLAGE_BLOCKS, 40, 32], ['mines', MINE_BLOCKS, 32, 24],
      ['portals', PORTAL_BLOCKS, 32, 12]
    ]
    const seen = {}
    for (let index = 0; index < scans.length; index++) {
      const [key, blocks, distance, count] = scans[index]
      seen[key] = this.scanBlocks(blocks, distance, count)
      // findBlocks is synchronous; yield regularly so packet and heartbeat work can run between batches.
      if (index % 3 === 2 && index < scans.length - 1) {
        await new Promise(resolve => setImmediate(resolve))
        if (!this.bot?.entity) return { changed: false, seen: 0 }
      }
    }

    for (const block of seen.ores) changed = this.remember('ores', block.position, { block: block.name, source: 'world_scanner' }, 12) || changed
    for (const block of seen.dangers) changed = this.remember('dangerZones', block.position, { block: block.name, source: 'world_scanner' }, 16) || changed
    for (const block of seen.stations) changed = this.remember('workstations', block.position, { block: block.name, source: 'world_scanner' }, 10) || changed
    for (const block of seen.storage) changed = this.remember('storage', block.position, { block: block.name, source: 'world_scanner' }, 10) || changed
    for (const block of seen.beds) changed = this.remember('beds', block.position, { block: block.name, source: 'world_scanner' }, 10) || changed
    for (const block of seen.farms) changed = this.remember('farms', block.position, { block: block.name, source: 'world_scanner' }, 12) || changed
    for (const block of seen.portals) changed = this.remember('portals', block.position, { block: block.name, source: 'world_scanner' }, 8) || changed

    if (seen.storage.length >= 2 && seen.stations.length) changed = this.remember('bases', this.bot.entity.position, { source: 'scanner_storage_cluster' }, 24) || changed
    if (seen.villages.length >= 2) changed = this.remember('villages', seen.villages[0].position, { source: 'scanner_village_blocks' }, 32) || changed
    if (seen.mines.filter(block => block.position.y < 50).length >= 2) changed = this.remember('mines', seen.mines[0].position, { source: 'scanner_mine_blocks' }, 32) || changed

    changed = this.updateOreHeatmap(seen.ores) || changed
    if (changed) this.save()
    return {
      changed,
      seen: Object.fromEntries(Object.entries(seen).map(([key, value]) => [key, value.length]))
    }
  }

  scanBlocks(names, maxDistance, count) {
    const mcData = this.mcData()
    if (!mcData || !this.bot?.findBlocks || !this.bot.entity) return []
    const matching = names
      .map(name => mcData.blocksByName?.[name]?.id)
      .filter(id => typeof id === 'number')
    if (!matching.length) return []
    try {
      return this.bot.findBlocks({ matching, maxDistance, count })
        .map(position => ({ name: this.bot.blockAt(position)?.name || 'unknown', position }))
        .filter(block => block.position)
    } catch {
      return []
    }
  }

  remember(type, position, extra = {}, radius = 16) {
    if (!position) return false
    this.worldMemory[type] ||= []
    const entry = this.memoryPosition(position)
    const existing = this.worldMemory[type].find(item => this.distance(item, entry) <= radius)
    if (existing) {
      Object.assign(existing, extra, { lastSeenAt: entry.at })
      return true
    }
    this.worldMemory[type].push({ ...entry, ...extra })
    this.trim(type)
    return true
  }

  updateOreHeatmap(ores = []) {
    if (!ores.length) return false
    this.worldMemory.oreChunks ||= {}
    for (const ore of ores) {
      const chunkX = Math.floor(ore.position.x / 16)
      const chunkZ = Math.floor(ore.position.z / 16)
      const key = `${this.dimension()}:${chunkX},${chunkZ}`
      const chunk = this.worldMemory.oreChunks[key] ||= {
        dimension: this.dimension(),
        chunkX,
        chunkZ,
        blocks: {},
        sightings: 0,
        firstSeenAt: this.timestamp(),
        lastSeenAt: null
      }
      chunk.blocks[ore.name] = (chunk.blocks[ore.name] || 0) + 1
      chunk.sightings += 1
      chunk.lastSeenAt = this.timestamp()
    }
    return true
  }

  memoryPosition(position) {
    return {
      x: Math.floor(Number(position.x)),
      y: Math.floor(Number(position.y)),
      z: Math.floor(Number(position.z)),
      at: this.timestamp(),
      dimension: this.dimension()
    }
  }

  distance(left, right) {
    if (!left || !right) return Infinity
    if (left.dimension && right.dimension && left.dimension !== right.dimension) return Infinity
    return Math.hypot(Number(left.x) - Number(right.x), Number(left.y) - Number(right.y), Number(left.z) - Number(right.z))
  }

  trim(type) {
    const entries = this.worldMemory[type]
    if (!Array.isArray(entries) || entries.length <= this.maxEntries) return
    entries.sort((left, right) => Date.parse(right.lastSeenAt || right.at || 0) - Date.parse(left.lastSeenAt || left.at || 0))
    entries.splice(this.maxEntries)
  }

  ensureShape() {
    for (const key of ['ores', 'workstations', 'beds', 'portals', 'foodSources']) this.worldMemory[key] ||= []
    this.worldMemory.oreChunks ||= {}
  }

  dimension() {
    return String(typeof this.dimensionProvider === 'function' ? this.dimensionProvider() : this.dimensionProvider || 'unknown')
  }

  mcData() {
    return typeof this.mcDataProvider === 'function' ? this.mcDataProvider() : this.mcDataProvider
  }
}

module.exports = {
  WorldScanner,
  ORE_BLOCKS,
  DANGER_BLOCKS,
  STATION_BLOCKS,
  FARM_BLOCKS,
  PORTAL_BLOCKS
}
