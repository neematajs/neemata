import type { WorkflowRedisClient } from './client.ts'

// State-machine decisions stay inside Redis so correctness never depends on a
// client-held lock surviving network stalls or process pauses.

const RECORD_HELPERS = `
local function isTerminal(status)
  return status == 'completed' or status == 'failed' or status == 'cancelled'
end

local function contains(values, expected)
  for _, value in ipairs(values) do
    if value == expected then return true end
  end
  return false
end

local function applyChanges(record, changes, now)
  for key, value in pairs(changes) do record[key] = value end
  record.version = record.version + 1
  record.updatedAt = tonumber(now)
  return record
end
`

const FAMILY_HELPERS = `
local function append(meta, field, value)
  local values = cjson.decode(redis.call('HGET', meta, field) or '[]')
  table.insert(values, value)
  redis.call('HSET', meta, field, cjson.encode(values))
end

local function trackExternal(meta, key, owner)
  append(meta, 'externalKeys', key)
  redis.call('HSET', meta, 'owner:' .. key, owner)
end

local function mappedRun(prefix, mapping)
  if mapping == '' then return nil end
  local runId = redis.call('GET', mapping)
  if not runId then return nil end
  local rootRunId = redis.call('GET', prefix .. 'run-root:' .. runId)
  if rootRunId then
    local family = prefix .. 'family:' .. rootRunId
    local raw = redis.call('HGET', family .. ':runs', runId)
    if raw then
      local signature = redis.call('HGET', family .. ':signatures', runId) or ''
      local startAt = redis.call('HGET', family, 'startAt:' .. runId) or ''
      return { runId, rootRunId, raw, signature, startAt }
    end
  end
  redis.call('DEL', mapping)
  return nil
end
`

const SCRIPTS = {
  reopenFailedRun: `
${FAMILY_HELPERS}
${RECORD_HELPERS}
local expected = cjson.decode(ARGV[1])
if redis.call('EXISTS', KEYS[1]) == 0 then return { 'stale' } end
for index, records in ipairs(expected) do
  local count = 0
  for field, raw in pairs(records) do
    count = count + 1
    if redis.call('HGET', KEYS[index + 1], field) ~= raw then return { 'stale' } end
  end
  if redis.call('HLEN', KEYS[index + 1]) ~= count then return { 'stale' } end
end
local runIds = cjson.decode(ARGV[2])
local reopening = {}
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
for _, id in ipairs(runIds) do
  reopening[id] = true
  local lease = redis.call('HGET', KEYS[6], id)
  if lease and cjson.decode(lease).expiresAt > now then return { 'busy', id } end
end
local guards = cjson.decode(ARGV[3])
local owners = {}
for _, guard in ipairs(guards) do
  local owner = owners[guard.key]
  if owner and owner ~= guard.runId then return { 'conflict', expected[1][owner] } end
  owners[guard.key] = guard.runId
  local holder = mappedRun(ARGV[7], guard.key)
  if holder and holder[1] ~= guard.runId then return { 'conflict', holder[3] } end
end
local queues = { 12, 17 }
local queueRows = {}
for _, base in ipairs(queues) do
  local rows = redis.call('HGETALL', KEYS[base])
  queueRows[base] = rows
  for index = 1, #rows, 2 do
    local item = cjson.decode(rows[index + 1])
    if reopening[item.payload.runId] and not item.deadAt and item.leaseExpiresAt and item.leaseExpiresAt > now then
      return { 'claimed', item.payload.runId }
    end
  end
end

-- Reopening, retention removal, fencing and dispatch form one commit. A
-- duplicate request either observes the old family or fails its version check.
local function reset(record, status)
  record.status = status
  record.error = nil
  record.output = nil
  record.updatedAt = now
  record.version = record.version + 1
end
for _, id in ipairs(runIds) do
  local run = cjson.decode(expected[1][id])
  reset(run, 'queued')
  run.activeSince = now
  redis.call('HSET', KEYS[2], id, cjson.encode(run))
  redis.call('HDEL', KEYS[6], id)
end
redis.call('HINCRBY', KEYS[1], 'nonTerminalCount', #runIds)
for field, raw in pairs(expected[2]) do
  local node = cjson.decode(raw)
  if reopening[node.runId] and node.status ~= 'completed' then
    reset(node, 'pending')
    redis.call('HSET', KEYS[3], field, cjson.encode(node))
  end
end
for field, raw in pairs(expected[3]) do
  local child = cjson.decode(raw)
  local node = cjson.decode(expected[2][child.runId .. string.char(0) .. child.nodeName])
  if reopening[child.runId] and child.status ~= 'completed' and node.status ~= 'completed' then
    reset(child, 'pending')
    child.currentAttemptId = nil
    redis.call('HSET', KEYS[4], field, cjson.encode(child))
  end
end
for _, guard in ipairs(guards) do
  redis.call('SET', guard.key, guard.runId)
  redis.call('HSET', KEYS[1], 'owner:' .. guard.key, guard.runId)
end
for index = 1, 9 do redis.call('PERSIST', KEYS[index]) end
local external = cjson.decode(redis.call('HGET', KEYS[1], 'externalKeys') or '[]')
for _, key in ipairs(external) do
  if redis.call('GET', key) == redis.call('HGET', KEYS[1], 'owner:' .. key) then redis.call('PERSIST', key) end
end
local familyIds = cjson.decode(redis.call('HGET', KEYS[1], 'runIds'))
for _, id in ipairs(familyIds) do
  redis.call('ZREM', KEYS[11], id)
  redis.call('ZADD', KEYS[10], redis.call('HGET', KEYS[7], id), id)
end
for _, base in ipairs(queues) do
  local rows = queueRows[base]
  for index = 1, #rows, 2 do
    local id = rows[index]
    local item = cjson.decode(rows[index + 1])
    if reopening[item.payload.runId] then
      if item.deadAt then
        item.reapedAt = now
        redis.call('HSET', KEYS[base], id, cjson.encode(item))
      else
        redis.call('HDEL', KEYS[base], id)
        redis.call('ZREM', KEYS[base + 1], id)
        redis.call('ZREM', KEYS[base + 2], id)
        local dedup = item.payload.attemptId or item.payload.runId
        if redis.call('HGET', KEYS[base + 4], dedup) == id then redis.call('HDEL', KEYS[base + 4], dedup) end
      end
    end
  end
end
local attempt = cjson.decode(ARGV[4])
local base = 12
if attempt ~= cjson.null then
  base = 17
  local nodeField = attempt.runId .. string.char(0) .. attempt.nodeName
  local childField = nodeField .. string.char(0) .. attempt.childKey
  local child = cjson.decode(redis.call('HGET', KEYS[4], childField))
  local node = cjson.decode(redis.call('HGET', KEYS[3], nodeField))
  attempt.dispatchedAt = now
  redis.call('HSET', KEYS[5], attempt.id, cjson.encode(attempt))
  local attemptRoot = ARGV[7] .. 'attempt-root:' .. attempt.id
  redis.call('SET', attemptRoot, ARGV[6])
  trackExternal(KEYS[1], attemptRoot, ARGV[6])
  append(KEYS[8], 'attempts:' .. nodeField, attempt.id)
  child.currentAttemptId = attempt.id
  child.attemptCount = attempt.attemptNumber
  reset(child, 'running')
  reset(node, 'running')
  redis.call('HSET', KEYS[4], childField, cjson.encode(child))
  redis.call('HSET', KEYS[3], nodeField, cjson.encode(node))
end
local item = cjson.decode(ARGV[5])
item.createdAt = now
item.createdAtScore = now
redis.call('HSET', KEYS[base], item.id, cjson.encode(item))
redis.call('ZADD', KEYS[base + 1], now, item.id)
redis.call('HSET', KEYS[base + 4], item.payload.attemptId or item.payload.runId, item.id)
redis.call('PUBLISH', KEYS[22], '1')
redis.call('PUBLISH', KEYS[23], '1')
return { 'updated', redis.call('HGET', KEYS[2], ARGV[6]) }
`,
  createRun: `
${FAMILY_HELPERS}
local run = cjson.decode(ARGV[1])
local idempotent = mappedRun(ARGV[8], ARGV[5])
if idempotent then return { 'idempotent', idempotent[3], idempotent[4], idempotent[5] } end

local unique = mappedRun(ARGV[8], ARGV[6])
if unique then
  if ARGV[7] == 'join' then return { 'joined', unique[3], unique[4], unique[5] } end
  return { 'conflict', unique[3], unique[4] }
end

if run.rootRunId ~= run.id and redis.call('EXISTS', KEYS[1]) == 0 then
  return { 'missing-family' }
end
if run.rootRunId ~= run.id and tonumber(redis.call('HGET', KEYS[1], 'nonTerminalCount') or '0') == 0 then
  return { 'terminal-family' }
end

if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[1],
    'rootRunId', run.rootRunId,
    'runIds', '[]',
    'externalKeys', '[]',
    'nonTerminalCount', '0')
end

local order = redis.call('INCR', KEYS[6])
redis.call('HSET', KEYS[2], run.id, ARGV[1])
redis.call('HSET', KEYS[3], run.id, order)
redis.call('HSET', KEYS[4], run.id, ARGV[2])
redis.call('HINCRBY', KEYS[1], 'nonTerminalCount', 1)
if ARGV[9] ~= '' then redis.call('HSET', KEYS[1], 'startAt:' .. run.id, ARGV[9]) end
append(KEYS[1], 'runIds', run.id)
trackExternal(KEYS[1], ARGV[3], run.rootRunId)
trackExternal(KEYS[1], ARGV[4], '1')
redis.call('SET', ARGV[3], run.rootRunId)
redis.call('ZADD', KEYS[5], order, run.id)
if ARGV[5] ~= '' then
  redis.call('SET', ARGV[5], run.id)
  trackExternal(KEYS[1], ARGV[5], run.id)
end
if ARGV[6] ~= '' then
  redis.call('SET', ARGV[6], run.id)
  trackExternal(KEYS[1], ARGV[6], run.id)
end
redis.call('PUBLISH', KEYS[7], '1')
return { 'created', ARGV[1], ARGV[2], ARGV[9] }
`,

  createChildRun: `
${FAMILY_HELPERS}
${RECORD_HELPERS}
local childRaw = redis.call('HGET', KEYS[3], ARGV[1])
if not childRaw then return { 'missing-child' } end
if tonumber(redis.call('HGET', KEYS[1], 'nonTerminalCount') or '0') == 0 then
  return { 'terminal-family' }
end
local child = cjson.decode(childRaw)
local requested = cjson.decode(ARGV[2])

if child.childRunId then
  local existingRaw = redis.call('HGET', KEYS[2], child.childRunId)
  local signature = redis.call('HGET', KEYS[5], child.childRunId) or ''
  if not existingRaw then return { 'missing-run' } end
  if signature ~= ARGV[3] then return { 'conflict' } end
  return { 'replayed', childRaw, existingRaw }
end
if isTerminal(child.status) then return { 'terminal-child' } end

local runRaw = ARGV[2]
local created = true
local idempotent = mappedRun(ARGV[8], ARGV[6])
if idempotent then
  if idempotent[2] ~= requested.rootRunId or idempotent[4] ~= ARGV[3] then
    return { 'conflict' }
  end
  runRaw = idempotent[3]
  requested = cjson.decode(runRaw)
  created = false
else
  local order = redis.call('INCR', KEYS[7])
  redis.call('HSET', KEYS[2], requested.id, runRaw)
  redis.call('HSET', KEYS[4], requested.id, order)
  redis.call('HSET', KEYS[5], requested.id, ARGV[3])
  redis.call('HINCRBY', KEYS[1], 'nonTerminalCount', 1)
  append(KEYS[1], 'runIds', requested.id)
  trackExternal(KEYS[1], ARGV[4], requested.rootRunId)
  trackExternal(KEYS[1], ARGV[5], '1')
  redis.call('SET', ARGV[4], requested.rootRunId)
  redis.call('ZADD', KEYS[6], order, requested.id)
  if ARGV[6] ~= '' then
    redis.call('SET', ARGV[6], requested.id)
    trackExternal(KEYS[1], ARGV[6], requested.id)
  end
end

child = applyChanges(child, { childRunId = requested.id, status = 'running' }, ARGV[7])
local linkedRaw = cjson.encode(child)
redis.call('HSET', KEYS[3], ARGV[1], linkedRaw)
redis.call('PUBLISH', KEYS[8], '1')
if created then return { 'created', linkedRaw, runRaw } end
return { 'replayed', linkedRaw, runRaw }
`,

  createNode: `
if not redis.call('HGET', KEYS[4], ARGV[3]) then return { 'missing-run' } end
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing then return { 'existing', existing } end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
local field = 'nodes:' .. ARGV[3]
local fields = cjson.decode(redis.call('HGET', KEYS[2], field) or '[]')
table.insert(fields, ARGV[1])
redis.call('HSET', KEYS[2], field, cjson.encode(fields))
-- A coordinator may finish this write after the family became terminal.
local ttl = redis.call('PTTL', KEYS[4])
if ttl >= 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
  redis.call('PEXPIRE', KEYS[2], ttl)
end
redis.call('PUBLISH', KEYS[3], '1')
return { 'created', ARGV[2] }
`,

  ensureChildren: `
if not redis.call('HGET', KEYS[1], ARGV[1]) then return { 'missing-node' } end
local existing = redis.call('HGET', KEYS[3], ARGV[2])
if existing then return { 'existing', existing } end
local rows = cjson.decode(ARGV[3])
local fields = {}
for index, row in ipairs(rows) do
  redis.call('HSET', KEYS[2], row.field, row.raw)
  fields[index] = row.field
end
local encoded = '[]'
if #fields > 0 then encoded = cjson.encode(fields) end
redis.call('HSET', KEYS[3], ARGV[2], encoded)
local ttl = redis.call('PTTL', KEYS[1])
if ttl >= 0 then
  redis.call('PEXPIRE', KEYS[2], ttl)
  redis.call('PEXPIRE', KEYS[3], ttl)
end
redis.call('PUBLISH', KEYS[4], '1')
return { 'created', encoded }
`,

  updateRecord: `
${RECORD_HELPERS}
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return { 'missing' } end
local record = cjson.decode(raw)
local mode = ARGV[2]
local changes = cjson.decode(ARGV[3])

if mode == 'nodeCase' then
  if isTerminal(record.status) or record.selectedCase == changes.selectedCase then
    return { 'ok', raw }
  end
  if record.selectedCase then return { 'conflict', raw } end
elseif mode == 'runTransition' then
  if not contains(cjson.decode(ARGV[5]), record.status) then return { 'ok', raw } end
elseif mode == 'runCancellation' then
  if isTerminal(record.status) or record.status == 'cancelling' then return { 'ok', raw } end
elseif isTerminal(record.status) then
  return { 'ok', raw }
elseif mode == 'nodeWait' and record.status == 'waiting' then
  return { 'ok', raw }
end

record = applyChanges(record, changes, ARGV[4])
local updated = cjson.encode(record)
redis.call('HSET', KEYS[1], ARGV[1], updated)
redis.call('PUBLISH', KEYS[2], '1')
return { 'updated', updated }
`,

  createAttempt: `
${FAMILY_HELPERS}
${RECORD_HELPERS}
local childRaw = redis.call('HGET', KEYS[2], ARGV[1])
if not childRaw then return { 'missing-child' } end
local child = cjson.decode(childRaw)
if ARGV[8] == '1' and child.currentAttemptId then
  local current = redis.call('HGET', KEYS[4], child.currentAttemptId)
  if not current then return { 'missing-attempt' } end
  return { 'existing', current }
end
if isTerminal(child.status) then return { 'terminal-child' } end

local attempt = cjson.decode(ARGV[3])
attempt.attemptNumber = child.attemptCount + 1
attempt.retryAttemptNumber = 1
if child.currentAttemptId then
  local previous = redis.call('HGET', KEYS[4], child.currentAttemptId)
  if not previous then return { 'missing-attempt' } end
  attempt.retryAttemptNumber = cjson.decode(previous).retryAttemptNumber + 1
elseif child.attemptCount > 0 then
  local ids = cjson.decode(redis.call('HGET', KEYS[5], ARGV[7]) or '[]')
  local previous = nil
  for _, id in ipairs(ids) do
    local raw = redis.call('HGET', KEYS[4], id)
    if raw then
      local candidate = cjson.decode(raw)
      if candidate.childKey == child.childKey and candidate.attemptNumber == child.attemptCount then
        previous = candidate
        break
      end
    end
  end
  if not previous then return { 'missing-attempt' } end
  attempt.input = previous.input
  attempt.idempotencyKey = previous.idempotencyKey
end
local attemptRaw = cjson.encode(attempt)
redis.call('HSET', KEYS[4], attempt.id, attemptRaw)
redis.call('SET', ARGV[5], ARGV[6])
trackExternal(KEYS[1], ARGV[5], ARGV[6])
local ttl = redis.call('PTTL', KEYS[1])
if ttl >= 0 then
  redis.call('PEXPIRE', KEYS[4], ttl)
  redis.call('PEXPIRE', ARGV[5], ttl)
end
local attempts = cjson.decode(redis.call('HGET', KEYS[5], ARGV[7]) or '[]')
table.insert(attempts, attempt.id)
redis.call('HSET', KEYS[5], ARGV[7], cjson.encode(attempts))
if ttl >= 0 then redis.call('PEXPIRE', KEYS[5], ttl) end

child = applyChanges(child, {
  status = 'running',
  currentAttemptId = attempt.id,
  attemptCount = child.attemptCount + 1
}, ARGV[9])
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(child))

local nodeRaw = redis.call('HGET', KEYS[3], ARGV[2])
if nodeRaw then
  local node = cjson.decode(nodeRaw)
  if node.status == 'pending' or node.status == 'waiting' or node.status == 'running' then
    node = applyChanges(node, { status = 'running' }, ARGV[9])
    redis.call('HSET', KEYS[3], ARGV[2], cjson.encode(node))
  end
end
redis.call('PUBLISH', KEYS[6], '1')
return { 'created', attemptRaw }
`,

  settleAttempt: `
${RECORD_HELPERS}
local attemptRaw = redis.call('HGET', KEYS[1], ARGV[1])
if not attemptRaw then return { 'stale' } end
local attempt = cjson.decode(attemptRaw)
if attempt.leaseToken ~= ARGV[2] or attempt.status ~= 'started' then
  return { 'stale' }
end
local childRaw = redis.call('HGET', KEYS[2], ARGV[3])
if not childRaw then return { 'stale' } end
local child = cjson.decode(childRaw)
if isTerminal(child.status) or child.currentAttemptId ~= attempt.id then
  return { 'stale' }
end
local changes = cjson.decode(ARGV[4])
for key, value in pairs(changes) do attempt[key] = value end
attempt.completedAt = tonumber(ARGV[5])
local updated = cjson.encode(attempt)
redis.call('HSET', KEYS[1], ARGV[1], updated)
if ARGV[6] == '1' then
  local childChanges = { status = 'completed', output = changes.output }
  child = applyChanges(child, childChanges, ARGV[5])
  redis.call('HSET', KEYS[2], ARGV[3], cjson.encode(child))
end
redis.call('PUBLISH', KEYS[3], '1')
return { 'updated', updated }
`,

  terminalRun: `
${RECORD_HELPERS}
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then return { 'missing' } end
local run = cjson.decode(raw)
if isTerminal(run.status) then return { 'ok', raw } end
run = applyChanges(run, cjson.decode(ARGV[2]), ARGV[3])
local updated = cjson.encode(run)
redis.call('HSET', KEYS[2], ARGV[1], updated)
if ARGV[6] ~= '' and redis.call('GET', ARGV[6]) == run.id then
  redis.call('DEL', ARGV[6])
end
local remaining = redis.call('HINCRBY', KEYS[1], 'nonTerminalCount', -1)
if remaining == 0 then
  local clock = redis.call('TIME')
  local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
  local expiresAt = now + tonumber(ARGV[5])
  for index = 6, #KEYS do redis.call('PEXPIRE', KEYS[index], ARGV[5]) end
  local external = cjson.decode(redis.call('HGET', KEYS[1], 'externalKeys') or '[]')
  for _, key in ipairs(external) do
    if redis.call('GET', key) == redis.call('HGET', KEYS[1], 'owner:' .. key) then
      redis.call('PEXPIRE', key, ARGV[5])
    end
  end
  redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
  local runIds = cjson.decode(redis.call('HGET', KEYS[1], 'runIds') or '[]')
  for _, runId in ipairs(runIds) do
    redis.call('ZREM', KEYS[3], runId)
    redis.call('ZADD', KEYS[4], expiresAt, runId)
  end
  local latest = redis.call('ZREVRANGE', KEYS[4], 0, 0, 'WITHSCORES')
  if #latest > 0 then redis.call('PEXPIREAT', KEYS[4], latest[2]) end
end
redis.call('PUBLISH', KEYS[5], '1')
return { 'updated', updated, tostring(remaining) }
`,

  lease: `
local operation = ARGV[1]
local runId = ARGV[2]
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if operation == 'acquire' then
  local runRaw = redis.call('HGET', KEYS[1], runId)
  if not runRaw then return { 'missing' } end
  local existingRaw = redis.call('HGET', KEYS[2], runId)
  if existingRaw then
    local existing = cjson.decode(existingRaw)
    if existing.expiresAt > now then return { 'busy' } end
  end
  local lease = cjson.decode(ARGV[5])
  lease.expiresAt = now + tonumber(ARGV[4])
  lease.version = cjson.decode(runRaw).version
  local leaseRaw = cjson.encode(lease)
  redis.call('HSET', KEYS[2], runId, leaseRaw)
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl >= 0 then redis.call('PEXPIRE', KEYS[2], ttl) end
  redis.call('PUBLISH', KEYS[3], '1')
  return { 'updated', leaseRaw }
end
local existingRaw = redis.call('HGET', KEYS[2], runId)
if not existingRaw then return { 'missing' } end
local existing = cjson.decode(existingRaw)
if existing.leaseToken ~= ARGV[3] then return { 'stale' } end
if operation == 'release' then
  redis.call('HDEL', KEYS[2], runId)
  return { 'released' }
end
existing.expiresAt = now + tonumber(ARGV[4])
local updated = cjson.encode(existing)
redis.call('HSET', KEYS[2], runId, updated)
local ttl = redis.call('PTTL', KEYS[1])
if ttl >= 0 then redis.call('PEXPIRE', KEYS[2], ttl) end
redis.call('PUBLISH', KEYS[3], '1')
return { 'updated', updated }
`,

  cancelNodes: `
${RECORD_HELPERS}
local nodeFields = cjson.decode(redis.call('HGET', KEYS[3], 'nodes:' .. ARGV[1]) or '[]')
local updated = {}
for _, nodeField in ipairs(nodeFields) do
  local raw = redis.call('HGET', KEYS[1], nodeField)
  if raw then
    local node = cjson.decode(raw)
    if not isTerminal(node.status) then
      node = applyChanges(node, { status = 'cancelled' }, ARGV[2])
      redis.call('HSET', KEYS[1], nodeField, cjson.encode(node))
      table.insert(updated, node)
    end
    local attemptIds = cjson.decode(redis.call('HGET', KEYS[3], 'attempts:' .. nodeField) or '[]')
    for _, attemptId in ipairs(attemptIds) do
      local attemptRaw = redis.call('HGET', KEYS[5], attemptId)
      if attemptRaw then
        local attempt = cjson.decode(attemptRaw)
        if attempt.status == 'started' then
          attempt.status = 'cancelled'
          attempt.completedAt = tonumber(ARGV[2])
          redis.call('HSET', KEYS[5], attemptId, cjson.encode(attempt))
        end
      end
    end
    local childIndex = 'children:' .. nodeField
    local childFields = cjson.decode(redis.call('HGET', KEYS[3], childIndex) or '[]')
    for _, childField in ipairs(childFields) do
      local childRaw = redis.call('HGET', KEYS[2], childField)
      if childRaw then
        local child = cjson.decode(childRaw)
        if not isTerminal(child.status) then
          child = applyChanges(child, { status = 'cancelled' }, ARGV[2])
          redis.call('HSET', KEYS[2], childField, cjson.encode(child))
        end
      end
    end
  end
end
redis.call('PUBLISH', KEYS[4], '1')
if #updated == 0 then return '[]' end
return cjson.encode(updated)
`,

  deleteFamily: `
${RECORD_HELPERS}
local runIds = cjson.decode(redis.call('HGET', KEYS[1], 'runIds') or '[]')
if #runIds == 0 then return { 'missing' } end
if ARGV[1] then
  local rootId = redis.call('HGET', KEYS[1], 'rootRunId')
  local rootRaw = rootId and redis.call('HGET', KEYS[2], rootId)
  if not rootRaw then return { 'missing' } end
  local root = cjson.decode(rootRaw)
  -- Selection may predate a retry and completion; recheck before deleting.
  if root.updatedAt >= tonumber(ARGV[1]) or not contains(cjson.decode(ARGV[2]), root.status) then
    return { 'skipped' }
  end
end
for _, runId in ipairs(runIds) do
  local raw = redis.call('HGET', KEYS[2], runId)
  if raw and not isTerminal(cjson.decode(raw).status) then return { 'active' } end
end
local external = cjson.decode(redis.call('HGET', KEYS[1], 'externalKeys') or '[]')
for _, key in ipairs(external) do
  if redis.call('GET', key) == redis.call('HGET', KEYS[1], 'owner:' .. key) then
    redis.call('DEL', key)
  end
end
for _, runId in ipairs(runIds) do
  redis.call('ZREM', KEYS[3], runId)
  redis.call('ZREM', KEYS[4], runId)
end
for index = 5, #KEYS do redis.call('DEL', KEYS[index]) end
return { 'deleted', cjson.encode(runIds) }
`,

  pruneRunIndex: `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
return redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
`,
} as const

export type RedisStoreScriptName = keyof typeof SCRIPTS

export class RedisWorkflowStoreScripts {
  readonly #client: WorkflowRedisClient
  readonly #shas = new Map<RedisStoreScriptName, Promise<string>>()

  constructor(client: WorkflowRedisClient) {
    this.#client = client
  }

  async run(
    name: RedisStoreScriptName,
    keys: readonly string[],
    arguments_: readonly string[],
  ): Promise<unknown> {
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

  #load(name: RedisStoreScriptName): Promise<string> {
    const existing = this.#shas.get(name)
    if (existing) return existing
    const loading = this.#loadFromRedis(name)
    this.#shas.set(name, loading)
    void loading.catch(() => {
      if (this.#shas.get(name) === loading) this.#shas.delete(name)
    })
    return loading
  }

  async #loadFromRedis(name: RedisStoreScriptName): Promise<string> {
    const sha = await this.#client.script('LOAD', SCRIPTS[name])
    if (typeof sha !== 'string') {
      throw new Error(`Redis returned an invalid SHA for script [${name}]`)
    }
    return sha
  }
}
