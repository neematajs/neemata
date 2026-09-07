import type { WorkflowRedisClient } from './client.ts'

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
      recordMarker()
      if score <= now then redis.call('PUBLISH', KEYS[5], '1') end
      return 1
    end
  end
end

redis.call('HSET', KEYS[1], item.id, cjson.encode(item))
redis.call('ZADD', KEYS[2], score, item.id)
redis.call('HSET', KEYS[3], dedupKey, item.id)
recordMarker()
if score <= now then redis.call('PUBLISH', KEYS[5], '1') end
return 1
`,
  claim: `
${SERVER_TIME}
${ROUTING}
${QUEUE_CLEANUP}
local scan = redis.call('ZSCAN', KEYS[2], ARGV[1], 'COUNT', ARGV[2])
local nextCursor = scan[1]
local entries = scan[2]
local now = nowMs()
local routing = cjson.decode(ARGV[3])
local changed = 0
for index = 1, #entries, 2 do
  local id = entries[index]
  local raw = redis.call('HGET', KEYS[1], id)
  if not raw then
    redis.call('ZREM', KEYS[2], id)
    changed = 1
  else
    local item = cjson.decode(raw)
    if orphaned(item, ARGV[6]) then
      deleteItem(id, item)
      changed = 1
    elseif item.deadAt then
      redis.call('ZREM', KEYS[2], id)
      changed = 1
    elseif tonumber(entries[index + 1]) <= now then
      if eligible(item.payload, routing) then
        local leaseExpiresAt = now + tonumber(ARGV[5])
        item.leaseToken = ARGV[4]
        item.leaseExpiresAt = leaseExpiresAt
        redis.call('HSET', KEYS[1], id, cjson.encode(item))
        redis.call('ZREM', KEYS[2], id)
        redis.call('ZADD', KEYS[3], leaseExpiresAt, id)
        return { 'claimed', id, raw, nextCursor, tostring(changed) }
      end
    end
  end
end
return { 'empty', '', '', nextCursor, tostring(changed) }
`,
  heartbeat: `
${SERVER_TIME}
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
local item = cjson.decode(ARGV[2])
local leaseExpiresAt = nowMs() + tonumber(ARGV[3])
item.leaseExpiresAt = leaseExpiresAt
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(item))
redis.call('ZADD', KEYS[2], leaseExpiresAt, ARGV[1])
return 1
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
if ARGV[5] ~= '1' and coalesceReady(item, KEYS[1], KEYS[3], KEYS[6]) then
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
  redis.call('PUBLISH', KEYS[5], '1')
end
return 1
`,
  reclaimExpired: `
${SERVER_TIME}
${ROUTING}
${QUEUE_CLEANUP}
${COALESCE_READY}
local scan = redis.call('ZSCAN', KEYS[3], ARGV[1], 'COUNT', ARGV[2])
local nextCursor = scan[1]
local entries = scan[2]
local now = nowMs()
local routing = cjson.decode(ARGV[3])
local leaseError = cjson.decode(ARGV[5]).lastError
local requeued = 0
local changed = 0
for index = 1, #entries, 2 do
  local id = entries[index]
  local raw = redis.call('HGET', KEYS[1], id)
  if not raw then
    redis.call('ZREM', KEYS[3], id)
    changed = changed + 1
  else
    local item = cjson.decode(raw)
    if orphaned(item, ARGV[6]) then
      deleteItem(id, item)
      changed = changed + 1
    elseif tonumber(entries[index + 1]) <= now then
      if item.leaseExpiresAt and eligible(item.payload, routing) then
        item.leaseToken = nil
        item.leaseExpiresAt = nil
        item.deliveryCount = item.deliveryCount + 1
        if not item.lastError then item.lastError = leaseError end
        redis.call('ZREM', KEYS[3], id)
        changed = changed + 1
        if item.deliveryCount >= tonumber(ARGV[4]) then
          item.deadAt = now
          redis.call('ZADD', KEYS[4], now, id)
        else
          item.runAt = nil
          item.runAtScore = nil
          if coalesceReady(item, KEYS[1], KEYS[2], KEYS[5]) then
            redis.call('HDEL', KEYS[1], id)
          else
            redis.call('ZADD', KEYS[2], now, id)
            redis.call('HSET', KEYS[1], id, cjson.encode(item))
          end
          requeued = requeued + 1
        end
        if item.deadAt then redis.call('HSET', KEYS[1], id, cjson.encode(item)) end
      end
    end
  end
end
return { nextCursor, tostring(requeued), tostring(changed) }
`,
  pruneOrphans: `
${QUEUE_CLEANUP}
local indexKey = KEYS[tonumber(ARGV[4])]
local scan = redis.call('ZSCAN', indexKey, ARGV[1], 'COUNT', ARGV[2])
local nextCursor = scan[1]
local entries = scan[2]
local deleted = 0
local changed = 0
for index = 1, #entries, 2 do
  local id = entries[index]
  local raw = redis.call('HGET', KEYS[1], id)
  if not raw then
    redis.call('ZREM', indexKey, id)
    changed = changed + 1
  else
    local item = cjson.decode(raw)
    if orphaned(item, ARGV[3]) then
      deleteItem(id, item)
      deleted = deleted + 1
      changed = changed + 1
    end
  end
end
return { nextCursor, tostring(deleted), tostring(changed) }
`,
  deleteUnclaimed: `
${QUEUE_CLEANUP}
local scan = redis.call('ZSCAN', KEYS[2], ARGV[1], 'COUNT', ARGV[2])
local nextCursor = scan[1]
local entries = scan[2]
local runIds = cjson.decode(ARGV[3])
local targets = {}
for _, runId in ipairs(runIds) do targets[runId] = true end
local deleted = 0
local changed = 0
for index = 1, #entries, 2 do
  local id = entries[index]
  local raw = redis.call('HGET', KEYS[1], id)
  if not raw then
    redis.call('ZREM', KEYS[2], id)
    changed = changed + 1
  else
    local item = cjson.decode(raw)
    if orphaned(item, ARGV[4]) then
      deleteItem(id, item)
      changed = changed + 1
    elseif targets[item.payload.runId] and not item.leaseToken then
      deleteItem(id, item)
      deleted = deleted + 1
      changed = changed + 1
    end
  end
end
return { nextCursor, tostring(deleted), tostring(changed) }
`,
  ack: `
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
if redis.call('HGET', KEYS[5], ARGV[3]) == ARGV[1] then
  redis.call('HDEL', KEYS[5], ARGV[3])
end
return 1
`,
  transitionDead: `
${COALESCE_READY}
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
if coalesceReady(cjson.decode(ARGV[3]), KEYS[1], KEYS[3], KEYS[4]) then
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 1
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1])
redis.call('HSET', KEYS[4], ARGV[5], ARGV[1])
return 1
`,
  updateDead: `
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
`,
  delete: `
if ARGV[2] ~= '' and (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then
  return 0
end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
if redis.call('HGET', KEYS[5], ARGV[3]) == ARGV[1] then
  redis.call('HDEL', KEYS[5], ARGV[3])
end
return 1
`,
  deleteIndexed: `
if (redis.call('HGET', KEYS[1], ARGV[1]) or '') ~= ARGV[2] then return 0 end
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
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

export class RedisWorkflowScripts {
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
    const sha = await this.#client.script('LOAD', SCRIPTS[name])
    if (typeof sha !== 'string') {
      throw new Error(`Redis returned an invalid SHA for script [${name}]`)
    }
    return sha
  }
}
