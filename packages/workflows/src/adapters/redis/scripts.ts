import type { WorkflowRedisClient } from './client.ts'

// Every queue mutation maintains these indexes in the same Lua execution.
// Length prefixes keep arbitrary workflow/activity names collision-free.
export const QUEUE_INDEXES = `
local function queueBase(items)
  return string.sub(items, 1, #items - 6)
end

local function routePart(value)
  return tostring(#value) .. ':' .. value
end

local function runCommands(items, runId)
  return queueBase(items) .. ':run:' .. runId
end

local function commandRoutes(items, payload)
  local base = queueBase(items) .. ':route:'
  if payload.kind == 'continueRun' then
    return { base .. 'workflow:' .. routePart(payload.workflowName) }
  end
  if payload.kind == 'taskAttempt' then
    return { base .. 'task:' .. routePart(payload.taskName) }
  end
  local workflow = base .. 'activity:' .. routePart(payload.workflowName)
  return { workflow, workflow .. ':' .. routePart(payload.activityName) }
end

local function addReady(items, item, score)
  for _, route in ipairs(commandRoutes(items, item.payload)) do
    redis.call('ZADD', route .. ':ready', score, item.id)
  end
end

local function removeReady(items, item)
  for _, route in ipairs(commandRoutes(items, item.payload)) do
    redis.call('ZREM', route .. ':ready', item.id)
  end
end

local function addClaimed(items, item, score)
  for _, route in ipairs(commandRoutes(items, item.payload)) do
    redis.call('ZADD', route .. ':claimed', score, item.id)
  end
end

local function removeClaimed(items, item)
  for _, route in ipairs(commandRoutes(items, item.payload)) do
    redis.call('ZREM', route .. ':claimed', item.id)
  end
end

local function indexRun(items, item)
  redis.call('SADD', runCommands(items, item.payload.runId), item.id)
end

local function removeCommandIndexes(items, item)
  removeReady(items, item)
  removeClaimed(items, item)
  redis.call('SREM', runCommands(items, item.payload.runId), item.id)
end
`

const SERVER_TIME = `
local function nowMs()
  local time = redis.call('TIME')
  return tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
end
`

const ROUTING = `
local function contains(values, expected)
  if not values then return false end
  for _, value in ipairs(values) do
    if value == expected then return true end
  end
  return false
end

local function selectedRoutes(items, routing)
  local routes = {}
  local seen = {}
  local base = queueBase(items)
  local function include(route)
    if not seen[route] then
      seen[route] = true
      table.insert(routes, route)
    end
  end
  if string.sub(base, -9) == ':continue' then
    for _, name in ipairs(routing.workflowNames) do
      include(base .. ':route:workflow:' .. routePart(name))
    end
  else
    for _, name in ipairs(routing.taskNames or {}) do
      include(base .. ':route:task:' .. routePart(name))
    end
    for _, workflow in ipairs(routing.workflowNames) do
      local route = base .. ':route:activity:' .. routePart(workflow)
      if not routing.activityNames then
        include(route)
      else
        for _, activity in ipairs(routing.activityNames) do
          include(route .. ':' .. routePart(activity))
        end
      end
    end
  end
  return routes
end

local function eligible(payload, routing)
  if payload.kind == 'continueRun' then
    return contains(routing.workflowNames, payload.workflowName)
  end
  if payload.kind == 'taskAttempt' then
    return contains(routing.taskNames, payload.taskName)
  end
  if not contains(routing.workflowNames, payload.workflowName) then return false end
  return not routing.activityNames or contains(routing.activityNames, payload.activityName)
end
`

const QUEUE_CLEANUP = `
local function dedupKey(item)
  if item.payload.kind == 'continueRun' then return item.payload.runId end
  return item.payload.attemptId
end

local function deleteItem(id, item)
  removeCommandIndexes(KEYS[1], item)
  redis.call('HDEL', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZREM', KEYS[3], id)
  redis.call('ZREM', KEYS[4], id)
  local key = dedupKey(item)
  if redis.call('HGET', KEYS[5], key) == id then
    redis.call('HDEL', KEYS[5], key)
  end
end

local function orphaned(item, prefix)
  return item.rootRunId and redis.call('EXISTS', prefix .. 'family:' .. item.rootRunId) == 0
end
`

const COALESCE_READY = `
local function coalesceReady(item, items, ready, dedup)
  if item.payload.kind ~= 'continueRun' then return false end
  local currentId = redis.call('HGET', dedup, item.payload.runId)
  if not currentId or currentId == item.id then return false end
  local raw = redis.call('HGET', items, currentId)
  if not raw then return false end
  local current = cjson.decode(raw)
  if current.deadAt or current.leaseToken or not redis.call('ZSCORE', ready, currentId) then return false end
  -- The pending command owns the newest payload; only bring its wake forward.
  local score = current.runAtScore or current.createdAtScore
  local incomingScore = item.runAtScore or item.createdAtScore
  if incomingScore < score then
    current.runAt = item.runAt
    current.runAtScore = item.runAtScore
    redis.call('HSET', items, currentId, cjson.encode(current))
    redis.call('ZADD', ready, incomingScore, currentId)
    addReady(items, current, incomingScore)
  end
  -- Preserve the furthest retry progress so fresh wakes cannot reset poison work.
  if item.deliveryCount > current.deliveryCount then
    current.deliveryCount = item.deliveryCount
    current.lastError = item.lastError
    redis.call('HSET', items, currentId, cjson.encode(current))
  end
  return true
end
`

const SCRIPTS = {
  enqueue: `
${SERVER_TIME}
local dedupKey = ARGV[1]
local kind = ARGV[2]
local item = cjson.decode(ARGV[3])
local now = nowMs()
local score = item.runAtScore or now
item.createdAt = now
item.createdAtScore = now
local rootRunId = redis.call('GET', KEYS[6])
if rootRunId then item.rootRunId = rootRunId end
local markerTtl = -1
if ARGV[4] == '1' then
  if not rootRunId then return 0 end
  markerTtl = redis.call('PTTL', ARGV[5] .. 'family:' .. rootRunId)
  if markerTtl == -2 or markerTtl == 0 then return 0 end
end

local function recordMarker()
  if ARGV[4] ~= '1' then return end
  if markerTtl > 0 then
    redis.call('SET', KEYS[4], '1', 'PX', markerTtl)
  else
    redis.call('SET', KEYS[4], '1')
  end
end

local currentId = redis.call('HGET', KEYS[3], dedupKey)

if currentId then
  local currentRaw = redis.call('HGET', KEYS[1], currentId)
  if currentRaw then
    local current = cjson.decode(currentRaw)
    if kind == 'attempt' then
      recordMarker()
      return 1
    end
    if not current.deadAt and not current.leaseToken then
      removeReady(KEYS[1], current)
      current.payload = item.payload
      if not current.runAtScore or not item.runAtScore then
        current.runAt = nil
        current.runAtScore = nil
        score = current.createdAtScore
      elseif item.runAtScore < current.runAtScore then
        current.runAt = item.runAt
        current.runAtScore = item.runAtScore
        score = item.runAtScore
      else
        score = current.runAtScore
      end
      if item.rootRunId and not current.rootRunId then
        current.rootRunId = item.rootRunId
      end
      redis.call('HSET', KEYS[1], currentId, cjson.encode(current))
      redis.call('ZADD', KEYS[2], score, currentId)
      addReady(KEYS[1], current, score)
      recordMarker()
      if score <= now then redis.call('PUBLISH', KEYS[5], '1') end
      return 1
    end
  end
end

redis.call('HSET', KEYS[1], item.id, cjson.encode(item))
redis.call('ZADD', KEYS[2], score, item.id)
addReady(KEYS[1], item, score)
indexRun(KEYS[1], item)
redis.call('HSET', KEYS[3], dedupKey, item.id)
recordMarker()
if score <= now then redis.call('PUBLISH', KEYS[5], '1') end
return 1
`,
  claim: `
${SERVER_TIME}
${ROUTING}
${QUEUE_CLEANUP}
local now = nowMs()
local routing = cjson.decode(ARGV[2])
local routes = selectedRoutes(KEYS[1], routing)
-- Compare route heads so a busy route cannot starve the worker's other routes.
for cleanup = 1, tonumber(ARGV[1]) do
  local id = nil
  local score = nil
  local indexKey = nil
  for _, route in ipairs(routes) do
    local key = route .. ':ready'
    local head = redis.call('ZRANGEBYSCORE', key, '-inf', now, 'WITHSCORES', 'LIMIT', 0, 1)
    if #head > 0 then
      local candidateScore = tonumber(head[2])
      if not id or candidateScore < score or (candidateScore == score and head[1] < id) then
        id = head[1]
        score = candidateScore
        indexKey = key
      end
    end
  end
  if not id then return { 'empty' } end
  local raw = redis.call('HGET', KEYS[1], id)
  if not raw then
    redis.call('ZREM', indexKey, id)
    redis.call('ZREM', KEYS[2], id)
  else
    local item = cjson.decode(raw)
    if orphaned(item, ARGV[5]) then
      deleteItem(id, item)
    elseif item.deadAt or item.leaseToken then
      removeReady(KEYS[1], item)
      redis.call('ZREM', KEYS[2], id)
    elseif eligible(item.payload, routing) then
      local leaseExpiresAt = now + tonumber(ARGV[4])
      item.leaseToken = ARGV[3]
      item.leaseExpiresAt = leaseExpiresAt
      redis.call('HSET', KEYS[1], id, cjson.encode(item))
      redis.call('ZREM', KEYS[2], id)
      redis.call('ZADD', KEYS[3], leaseExpiresAt, id)
      removeReady(KEYS[1], item)
      addClaimed(KEYS[1], item, leaseExpiresAt)
      return { 'claimed', id, raw }
    else
      redis.call('ZREM', indexKey, id)
    end
  end
end
return { 'more' }
`,
  heartbeat: `
${SERVER_TIME}
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw or not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return {} end
local item = cjson.decode(raw)
if item.leaseToken ~= ARGV[2] then return {} end
local leaseExpiresAt = nowMs() + tonumber(ARGV[3])
item.leaseExpiresAt = leaseExpiresAt
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(item))
redis.call('ZADD', KEYS[2], leaseExpiresAt, ARGV[1])
addClaimed(KEYS[1], item, leaseExpiresAt)
local root = redis.call('GET', ARGV[4] .. 'run-root:' .. item.payload.runId)
local run = root and redis.call('HGET', ARGV[4] .. 'family:' .. root .. ':runs', item.payload.runId)
return { cjson.encode({ status = run and cjson.decode(run).status or 'queued' }) }
`,
  releaseClaimed: `
${SERVER_TIME}
${COALESCE_READY}
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
local item = cjson.decode(ARGV[3])
local now = nowMs()
local runAt = now + tonumber(ARGV[4])
item.runAt = runAt
item.runAtScore = runAt
if ARGV[5] == '1' then item.deadAt = now end
removeClaimed(KEYS[1], item)
if ARGV[5] ~= '1' and coalesceReady(item, KEYS[1], KEYS[3], KEYS[6]) then
  removeCommandIndexes(KEYS[1], item)
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('PUBLISH', KEYS[5], '1')
  return 1
end
local encoded = cjson.encode(item)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
redis.call('ZREM', KEYS[2], ARGV[1])
if ARGV[5] == '1' then
  redis.call('ZADD', KEYS[4], now, ARGV[1])
else
  redis.call('ZADD', KEYS[3], runAt, ARGV[1])
  addReady(KEYS[1], item, runAt)
  redis.call('PUBLISH', KEYS[5], '1')
end
return 1
`,
  reclaimExpired: `
${SERVER_TIME}
${ROUTING}
${QUEUE_CLEANUP}
${COALESCE_READY}
local now = nowMs()
local routing = cjson.decode(ARGV[3])
local routes = selectedRoutes(KEYS[1], routing)
local position = tonumber(ARGV[1])
local leaseError = cjson.decode(ARGV[5]).lastError
-- Share the budget across routes so empty routes do not each cost a round trip.
local budget = tonumber(ARGV[2])
while routes[position] and budget > 0 do
  local route = routes[position]
  local indexKey = route .. ':claimed'
  local entries = redis.call('ZRANGEBYSCORE', indexKey, '-inf', now, 'LIMIT', 0, budget)
  budget = budget - math.max(1, #entries)
  for _, id in ipairs(entries) do
    local raw = redis.call('HGET', KEYS[1], id)
    if not raw then
      redis.call('ZREM', indexKey, id)
      redis.call('ZREM', KEYS[3], id)
    else
      local item = cjson.decode(raw)
      if orphaned(item, ARGV[6]) then
        deleteItem(id, item)
      elseif item.leaseExpiresAt and eligible(item.payload, routing) then
        removeClaimed(KEYS[1], item)
        item.leaseToken = nil
        item.leaseExpiresAt = nil
        item.deliveryCount = item.deliveryCount + 1
        if not item.lastError then item.lastError = leaseError end
        redis.call('ZREM', KEYS[3], id)
        if item.deliveryCount >= tonumber(ARGV[4]) then
          item.deadAt = now
          redis.call('ZADD', KEYS[4], now, id)
          redis.call('HSET', KEYS[1], id, cjson.encode(item))
        else
          item.runAt = nil
          item.runAtScore = nil
          if coalesceReady(item, KEYS[1], KEYS[2], KEYS[5]) then
            removeCommandIndexes(KEYS[1], item)
            redis.call('HDEL', KEYS[1], id)
          else
            redis.call('ZADD', KEYS[2], now, id)
            addReady(KEYS[1], item, now)
            redis.call('HSET', KEYS[1], id, cjson.encode(item))
          end
        end
      else
        redis.call('ZREM', indexKey, id)
      end
    end
  end
  if #entries == 0 or budget > 0 then position = position + 1 end
end
if routes[position] then return position end
return 0
`,
  pruneOrphans: `
${QUEUE_CLEANUP}
local result = { '0' }
-- Each requested index contributes one page to this atomic cleanup round.
for position = 6, #KEYS do
  local indexKey = KEYS[position]
  local cursor = ARGV[position - 3]
  if cursor == '' then
    table.insert(result, '')
  else
    local scan = redis.call('ZSCAN', indexKey, cursor, 'COUNT', ARGV[1])
    local entries = scan[2]
    for index = 1, #entries, 2 do
      local id = entries[index]
      local raw = redis.call('HGET', KEYS[1], id)
      if not raw then
        redis.call('ZREM', indexKey, id)
        result[1] = '1'
      else
        local item = cjson.decode(raw)
        if orphaned(item, ARGV[2]) then
          deleteItem(id, item)
          result[1] = '1'
        end
      end
    end
    -- Empty marks a completed scan so later rounds only visit unfinished indexes.
    if scan[1] == '0' then table.insert(result, '')
    else table.insert(result, scan[1]) end
  end
end
return result
`,
  deleteForRuns: `
${QUEUE_CLEANUP}
local position = tonumber(ARGV[1])
local cursor = ARGV[2]
local budget = tonumber(ARGV[3])
local runIds = cjson.decode(ARGV[6])
local deleted = 0
local changed = ARGV[7] == '1'
while runIds[position] and budget > 0 do
  local runId = runIds[position]
  local indexKey = runCommands(KEYS[1], runId)
  local scan = redis.call('SSCAN', indexKey, cursor, 'COUNT', budget)
  cursor = scan[1]
  budget = budget - math.max(1, #scan[2])
  for _, id in ipairs(scan[2]) do
    local raw = redis.call('HGET', KEYS[1], id)
    if not raw then
      redis.call('SREM', indexKey, id)
      changed = true
    else
      local item = cjson.decode(raw)
      if item.payload.runId ~= runId then
        redis.call('SREM', indexKey, id)
        changed = true
      elseif orphaned(item, ARGV[4]) or ARGV[5] ~= '1' or
        (not item.leaseToken and not item.deadAt and redis.call('ZSCORE', KEYS[2], id)) then
        deleteItem(id, item)
        deleted = deleted + 1
        changed = true
      end
    end
  end
  if cursor == '0' then
    if changed then changed = false
    else position = position + 1 end
  end
end
if not runIds[position] then position = 0 end
return { tostring(position), cursor, tostring(deleted), changed and '1' or '0' }
`,
  listDead: `
${QUEUE_CLEANUP}
local command = ARGV[3] == '1' and 'ZREVRANGE' or 'ZRANGE'
local ids = redis.call(command, KEYS[4], ARGV[1], tonumber(ARGV[1]) + tonumber(ARGV[2]) - 1)
local result = { tostring(#ids) }
for _, id in ipairs(ids) do
  local raw = redis.call('HGET', KEYS[1], id)
  if raw then
    local item = cjson.decode(raw)
    if item.deadAt and not orphaned(item, ARGV[4]) and
      (ARGV[5] == '' or item.payload.runId == ARGV[5]) and
      (ARGV[6] ~= '1' or not item.reapedAt) then
      table.insert(result, raw)
      if #result - 1 >= tonumber(ARGV[7]) then break end
    end
  end
end
return result
`,
  pruneDead: `
${QUEUE_CLEANUP}
local ids = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
for _, id in ipairs(ids) do
  local raw = redis.call('HGET', KEYS[1], id)
  if raw then deleteItem(id, cjson.decode(raw))
  else redis.call('ZREM', KEYS[4], id) end
end
return #ids
`,
  transitionDead: `
${COALESCE_READY}
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
local item = cjson.decode(ARGV[3])
if coalesceReady(item, KEYS[1], KEYS[3], KEYS[4]) then
  removeCommandIndexes(KEYS[1], item)
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 1
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1])
addReady(KEYS[1], item, ARGV[4])
redis.call('HSET', KEYS[4], ARGV[5], ARGV[1])
return 1
`,
  updateDead: `
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
`,
  deleteCommand: `
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
removeCommandIndexes(KEYS[1], cjson.decode(ARGV[2]))
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
if redis.call('HGET', KEYS[5], ARGV[3]) == ARGV[1] then
  redis.call('HDEL', KEYS[5], ARGV[3])
end
return 1
`,
} as const

type ScriptName = keyof typeof SCRIPTS

export class QueueScripts {
  readonly #client: WorkflowRedisClient
  readonly #shas = new Map<ScriptName, Promise<string>>()

  constructor(client: WorkflowRedisClient) {
    this.#client = client
  }

  async run(
    name: ScriptName,
    keys: readonly string[],
    arguments_: readonly string[],
  ): Promise<number> {
    const result = await this.#execute(name, keys, arguments_)
    return Number(result)
  }

  runRaw(
    name: ScriptName,
    keys: readonly string[],
    arguments_: readonly string[],
  ): Promise<unknown> {
    return this.#execute(name, keys, arguments_)
  }

  async #execute(
    name: ScriptName,
    keys: readonly string[],
    arguments_: readonly string[],
  ) {
    let sha = await this.#load(name)
    try {
      return await this.#client.evalsha(
        sha,
        keys.length,
        ...keys,
        ...arguments_,
      )
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) {
        throw error
      }
      this.#shas.delete(name)
      sha = await this.#load(name)
      return await this.#client.evalsha(
        sha,
        keys.length,
        ...keys,
        ...arguments_,
      )
    }
  }

  #load(name: ScriptName): Promise<string> {
    const existing = this.#shas.get(name)
    if (existing) return existing
    const loading = this.#loadFromRedis(name)
    this.#shas.set(name, loading)
    void loading.catch(() => {
      if (this.#shas.get(name) === loading) this.#shas.delete(name)
    })
    return loading
  }

  async #loadFromRedis(name: ScriptName): Promise<string> {
    const sha = await this.#client.script('LOAD', QUEUE_INDEXES + SCRIPTS[name])
    if (typeof sha !== 'string') {
      throw new Error(`Redis returned an invalid SHA for script [${name}]`)
    }
    return sha
  }
}
