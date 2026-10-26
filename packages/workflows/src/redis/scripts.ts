import * as Redis from 'effect/persistence/Redis'

/**
 * Every write of the store is one of these scripts, and every script checks
 * all it must before its first write: Redis has no rollback, so a script that
 * found something wrong halfway would leave half a mutation behind.
 *
 * A script is given one key, the root every other key is built from. The root
 * is a hash tag, so all keys of a store are in one slot of a cluster and a
 * script may reach any of them.
 *
 * Records travel as JSON text and are stored as given: a script never decodes
 * one, so no number loses precision and no empty array turns into an object.
 * What a script must know of a record, the adapter puts beside it.
 */

const PRELUDE = `
local root = KEYS[1]

-- The time of everything: snapshots, leases and when a command is due.
local function clock()
  local time = redis.call('TIME')
  return time[1] * 1000 + math.floor(time[2] / 1000)
end

-- A time as fifteen digits, so that text sorts as the times do.
local function instant(at)
  return string.format('%015d', math.max(0, math.floor(at)))
end
`

/**
 * What a guard is compared by: the token of the commit that last wrote what
 * it names, and nothing when that is absent. A family is guarded by its root
 * and its two counts, a dead command by the token of the claim that set it
 * aside.
 *
 * A token is made by the process that commits, at random, and never by the
 * server: a counter kept there goes back when a failover restores an earlier
 * state, and would then give a later writer the revision an earlier reader
 * still holds.
 */
const REVISION = `
local function revision(kind, name)
  if kind == 'run' then
    return redis.call('HGET', root .. 'run:' .. name, 'rev') or ''
  elseif kind == 'key' then
    return string.match(redis.call('HGET', root .. 'keys', name) or '', '^%S*')
  elseif kind == 'definition' then
    return string.match(redis.call('HGET', root .. 'definitions', name) or '', '^%S*')
  elseif kind == 'schedule' then
    return string.match(redis.call('HGET', root .. 'schedules', name) or '', '^%S*')
  elseif kind == 'scheduleNames' then
    return redis.call('HGET', root .. 'meta', 'schedules') or ''
  elseif kind == 'dead' then
    return redis.call('HGET', root .. 'command:' .. name, 'buried') or ''
  end
  local rev = redis.call('HGET', root .. 'run:' .. name, 'rev')
  if not rev then return '' end
  return rev
    .. ':' .. redis.call('ZCARD', root .. 'runs:root:' .. name)
    .. ':' .. redis.call('ZCARD', root .. 'runs:active:' .. name)
end
`

/**
 * A command is in one place: due in its lane by its turn in the queue,
 * waiting in its lane for a time (its own, or the end of its claim), or dead.
 * It is listed under its key in `waiting:<dedupe>`, by its turn, while no
 * claim was taken on it since it was queued or given back.
 */
const QUEUE = `
local function unwait(dedupe, id)
  redis.call('ZREM', root .. 'waiting:' .. dedupe, id)
end

-- Takes a command away wherever it is: queued, claimed or dead.
local function discard(id)
  local key = root .. 'command:' .. id
  local command = redis.call('HMGET', key, 'lane', 'runId', 'dedupe', 'expiresAt', 'deadOrder')
  local lane, runId, dedupe = command[1], command[2], command[3]
  if not lane then return end
  if command[5] then
    redis.call('ZREM', root .. 'dead', id)
    redis.call('ZREM', root .. 'dead:active', id)
    redis.call('ZREM', root .. 'dead:run:' .. runId, id)
    redis.call('SREM', root .. 'dead:key:' .. dedupe, id)
  else
    redis.call('ZREM', root .. 'due:' .. lane, id)
    redis.call('ZREM', root .. 'wait:' .. lane, id)
    redis.call('ZREM', root .. 'claims:' .. runId, id)
    if not command[4] then unwait(dedupe, id) end
  end
  redis.call('SREM', root .. 'commands:' .. runId, id)
  redis.call('UNLINK', key)
end
`

/**
 * A claim holds while its token is the command's and its lease is ahead. A
 * command with no token was never claimed or was given back.
 */
const HOLDS = `
local function holds(id, token, now)
  local claim = redis.call('HMGET', root .. 'command:' .. id, 'token', 'expiresAt')
  return claim[1] == token and tonumber(claim[2]) > now
end
`

const script = <Result>(lua: string) =>
  Redis.script(
    (root: string, ...args: readonly (string | number)[]) => [root, ...args],
    { lua: PRELUDE + lua, numberOfKeys: 1 },
  ).withReturnType<Result>()

type Nullable<A> = A | null

/**
 * What a run owns beside its hash: the names of its nodes, a set, and the
 * children of each node by ordinal, sorted sets of the fields of children:
 * all of them, and of a map's those waiting and those under way. In the
 * hash, beside each child, the id of its current attempt. A run made before
 * them has none of them, and is marked so by the want of `indexed`: what it
 * lacks is never read as empty.
 */
const OWNED = `
local function owned(id)
  return root .. 'run:' .. id .. ':'
end

local function unindexed(id)
  return 'Workflow run [' .. id .. '] was stored without the indexes of its children'
end
`

export type Loaded = readonly [
  now: number,
  /** One for each guard asked, in their order. */
  revisions: readonly string[],
  /** Every field of each run's hash, as `HGETALL` gives them. */
  runs: readonly (readonly string[])[],
  heads: readonly (readonly [run: Nullable<string>, io: Nullable<string>])[],
  units: readonly (readonly [
    run: Nullable<string>,
    io: Nullable<string>,
    node: Nullable<string>,
    input: Nullable<string>,
    child: Nullable<string>,
    attempt: Nullable<string>,
  ])[],
  /** Of each run opened, nothing when it is absent. */
  open: readonly Nullable<
    readonly [
      run: string,
      io: string,
      /** A map's without its input, which is not read. */
      nodes: readonly (readonly [node: string, input: Nullable<string>])[],
      childSets: readonly (readonly [
        nodeName: string,
        /** `0` for all children, `1` for a map's window, `2` with more. */
        mapped: 0 | 1 | 2,
        children: readonly string[],
      ])[],
      attempts: readonly string[],
      /**
       * The run of each child read that has not ended, with its revision:
       * `[id, run, io, revision]`.
       */
      linked: readonly (readonly [
        id: string,
        run: Nullable<string>,
        io: Nullable<string>,
        revision: string,
      ])[],
    ]
  >[],
  /** Of each node asked: the node, its input and its children by ordinal. */
  results: readonly (readonly [
    node: Nullable<string>,
    input: Nullable<string>,
    children: readonly string[],
  ])[],
  keys: readonly Nullable<string>[],
  definitions: readonly Nullable<string>[],
  schedules: readonly Nullable<string>[],
  scheduleNames: Nullable<readonly string[]>,
  families: readonly (readonly [
    root: Nullable<string>,
    size: number,
    active: number,
    activeRunId: Nullable<string>,
    claimedRunId: Nullable<string>,
  ])[],
  dead: readonly Nullable<DeadFields>[],
]

/** What a command's hash says of it once it is dead. */
export type DeadFields = readonly [
  command: string,
  deliveries: string,
  error: Nullable<string>,
  createdAt: string,
  deadAt: string,
  deadOrder: string,
]

/**
 * `ARGV[1]`: what to load, and the guards to give revisions of. A unit is
 * `[runId, nodeName, child, attemptId]`, `child` being the field of the
 * child without its letter, and `attemptId` `false` for the child's current
 * attempt: its fields are read by name, and nothing else of its run.
 *
 * A run opened is `[runId, maps]`, each map `[nodeName, last]`, `last` the
 * place of one past its limit, which tells whether more wait and is read no
 * further, or `-1` for all. Its nodes are read by name, a map's
 * without its input, and of each that has not ended the children it waits
 * on, from its indexes: those of a map under way and the first waiting, all
 * of any other. A map not named has none read. Then the current attempt of
 * each child read, and the head and revision of the run of each that has
 * not ended by `ended`, which the commit compares as a guard's. A node
 * whose results are read is `[runId, nodeName]`: the node with its input and
 * all its children, by ordinal.
 */
export const READ = script<Loaded>(`
${REVISION}
${OWNED}
local scope = cjson.decode(ARGV[1])
local now = clock()
local ahead = string.format('(%d', now)
local ended = {}
for _, status in ipairs(scope.ended) do ended[status] = true end

local function each(names, read)
  local found = {}
  for i, name in ipairs(names) do found[i] = read(name) end
  return found
end

-- A run of no indexes is never read as one whose indexes are empty.
local unread = false

local function family(id)
  local members = redis.call('ZRANGE', root .. 'runs:root:' .. id, 0, -1)
  local claimed = false
  for _, place in ipairs(members) do
    local member = string.sub(place, 33)
    if redis.call('ZCOUNT', root .. 'claims:' .. member, ahead, '+inf') > 0 then
      claimed = member
      break
    end
  end
  local active = redis.call('ZRANGE', root .. 'runs:active:' .. id, 0, 0)[1]
  return {
    redis.call('HGET', root .. 'run:' .. id, 'run'),
    #members,
    redis.call('ZCARD', root .. 'runs:active:' .. id),
    active and string.sub(active, 33) or false,
    claimed,
  }
end

local loaded = {
  now,
  each(scope.guards, function(guard) return revision(guard[1], guard[2]) end),
  each(scope.runs, function(id) return redis.call('HGETALL', root .. 'run:' .. id) end),
  each(scope.heads, function(id) return redis.call('HMGET', root .. 'run:' .. id, 'run', 'io') end),
  each(scope.units, function(unit)
    local key = root .. 'run:' .. unit[1]
    local found = redis.call('HMGET', key, 'run', 'io', 'N' .. unit[2], 'I' .. unit[2],
      'C' .. unit[3], 'U' .. unit[3], 'indexed')
    if found[1] and not found[7] then unread = unit[1] end
    -- The current attempt is the one the child names, kept beside it.
    local id = unit[4] or found[6]
    local attempt = id and redis.call('HGET', key, 'A' .. id) or false
    return { found[1], found[2], found[3], found[4], found[5], attempt }
  end),
  each(scope.open, function(asked)
    local id, key = asked[1], root .. 'run:' .. asked[1]
    local head = redis.call('HMGET', key, 'run', 'io', 'indexed')
    if not head[1] then return false end
    if not head[3] then unread = id end
    local lasts = {}
    for _, map in ipairs(asked[2]) do lasts[map[1]] = map[2] end
    local nodes, sets, attempts, linked, seen = {}, {}, {}, {}, {}
    -- The run a child started is kept beside it. A map's children read are
    -- all under way or waiting; of another node's, those that ended are
    -- told by their record.
    local function children(members, mapped)
      local found = {}
      for i, pair in ipairs(members) do
        local child = redis.call('HMGET', key, 'C' .. pair, 'U' .. pair, 'O' .. pair)
        found[i] = child[1]
        local attempt = child[2] and redis.call('HGET', key, 'A' .. child[2])
        if attempt then attempts[#attempts + 1] = attempt end
        local started = child[3]
        if started and not seen[started]
          and (mapped or not ended[cjson.decode(child[1]).status]) then
          seen[started] = true
          local run = redis.call('HMGET', root .. 'run:' .. started, 'run', 'io', 'rev')
          linked[#linked + 1] = { started, run[1] or false, run[2] or false, run[3] or '' }
        end
      end
      return found
    end
    for _, name in ipairs(redis.call('SMEMBERS', owned(id) .. 'nodes')) do
      local node = redis.call('HMGET', key, 'N' .. name, 'S' .. name)
      local mapped = string.sub(node[2], 1, 1) == 'm'
      -- A map's input is its items, which a pass does not read.
      nodes[#nodes + 1] = { node[1], (not mapped) and redis.call('HGET', key, 'I' .. name) or false }
      if string.sub(node[2], 2, 2) == '0' then
        if not mapped then
          local all = redis.call('ZRANGE', owned(id) .. 'all:' .. name, 0, -1)
          sets[#sets + 1] = { name, 0, children(all, false) }
        elseif lasts[name] then
          local last = lasts[name]
          local active = redis.call('ZRANGE', owned(id) .. 'active:' .. name, 0, -1)
          local pending = redis.call('ZRANGE', owned(id) .. 'pending:' .. name, 0, last)
          -- The one past the limit only tells that more wait: it is not read.
          local more = last >= 0 and #pending > last
          if more then pending[#pending] = nil end
          for _, pair in ipairs(pending) do active[#active + 1] = pair end
          sets[#sets + 1] = { name, more and 2 or 1, children(active, true) }
        end
      end
    end
    return { head[1], head[2], nodes, sets, attempts, linked }
  end),
  each(scope.results, function(asked)
    local id, name = asked[1], asked[2]
    local key = root .. 'run:' .. id
    local node = redis.call('HMGET', key, 'N' .. name, 'I' .. name, 'indexed')
    if not node[1] then return { false, false, {} } end
    if not node[3] then unread = id end
    local found = {}
    for i, pair in ipairs(redis.call('ZRANGE', owned(id) .. 'all:' .. name, 0, -1)) do
      found[i] = redis.call('HGET', key, 'C' .. pair)
    end
    return { node[1], node[2], found }
  end),
  each(scope.keys, function(key) return redis.call('HGET', root .. 'keys', key) end),
  each(scope.definitions, function(key) return redis.call('HGET', root .. 'definitions', key) end),
  each(scope.schedules, function(name) return redis.call('HGET', root .. 'schedules', name) end),
  scope.scheduleNames and redis.call('HKEYS', root .. 'schedules') or false,
  each(scope.families, family),
  each(scope.dead, function(id)
    local fields = redis.call('HMGET', root .. 'command:' .. id,
      'command', 'deliveries', 'error', 'createdAt', 'deadAt', 'deadOrder')
    return fields[6] and fields or false
  end),
}
if unread then return redis.error_reply(unindexed(unread)) end
return loaded
`)

export type Committed =
  | readonly ['done']
  /** Something read has changed: nothing was written, plan again. */
  | readonly ['changed']
  | readonly ['stale', commandId: string]
  | readonly ['unguarded' | 'missing' | 'saved', name: string]
  /** A number written that is none, or an ordinal that is no integer. */
  | readonly ['malformed', name: string]
  /** A node written but for its input that is not stored. */
  | readonly ['unstored', node: string]

/**
 * `ARGV[1]`: the mutation, with the guards it was planned under and `rev`,
 * the token of this commit. Answers with what was found wrong, having
 * written nothing, or with `done`, having written all of it.
 */
export const COMMIT = script<Committed>(`
${REVISION}
${QUEUE}
${HOLDS}
${OWNED}
local m = cjson.decode(ARGV[1])
local now = clock()

local function exists(id)
  return redis.call('HEXISTS', root .. 'run:' .. id, 'run') == 1
end

-- Every check, before any write.
for _, guard in ipairs(m.guards) do
  if revision(guard[1], guard[2]) ~= guard[3] then return { 'changed' } end
end
for _, ack in ipairs(m.acks) do
  if not holds(ack[1], ack[2], now) then return { 'stale', ack[1] } end
end
for _, hold in ipairs(m.holds) do
  if not holds(hold[1], hold[2], now) then return { 'stale', hold[1] } end
end
for _, id in ipairs(m.fresh) do
  if exists(id) then return { 'unguarded', id } end
end
for _, id in ipairs(m.owners) do
  if not exists(id) then return { 'missing', id } end
end
-- Written but for its input, a node is one that is stored.
for _, node in ipairs(m.nodes) do
  if node[7] and redis.call('HEXISTS', root .. 'run:' .. node[1], 'N' .. node[2]) == 0 then
    return { 'unstored', cjson.encode({ node[1], node[2] }) }
  end
end
for _, definition in ipairs(m.definitions) do
  if redis.call('HEXISTS', root .. 'definitions', definition[1]) == 1 then
    return { 'saved', definition[1] }
  end
end
-- Every number a write takes, as decoded: JSON has no NaN, so one that was
-- comes as a null, which would fail a write halfway.
local function finite(value)
  return type(value) == 'number' and value > -math.huge and value < math.huge
end
for _, run in ipairs(m.runs) do
  if not (finite(run.createdAt) and finite(run.updatedAt)) then
    return { 'malformed', run.id }
  end
end
for _, child in ipairs(m.children) do
  local ordinal = child[7]
  if ordinal ~= false and not (finite(ordinal) and ordinal == math.floor(ordinal)) then
    return { 'malformed', child[5] }
  end
end
for _, schedule in ipairs(m.schedules) do
  if schedule.due ~= nil and not finite(schedule.due) then
    return { 'malformed', schedule.name }
  end
end
for _, entry in ipairs(m.enqueue) do
  if entry.availableAt ~= nil and not finite(entry.availableAt) then
    return { 'malformed', entry.dedupe }
  end
end

-- The revision of all this commit writes.
local rev = m.rev

-- A family goes whole: every run under the root, with all it owns, the keys
-- it holds and its commands.
for _, family in ipairs(m.remove) do
  for _, member in ipairs(redis.call('ZRANGE', root .. 'runs:root:' .. family, 0, -1)) do
    local id = string.sub(member, 33)
    local key = root .. 'run:' .. id
    local stored = redis.call('HMGET', key, 'place', 'terms', 'agedIn', 'agedAt')
    for _, term in ipairs(cjson.decode(stored[2])) do
      redis.call('ZREM', root .. 'runs:' .. term, stored[1])
    end
    if stored[3] then redis.call('ZREM', root .. 'roots:' .. stored[3], stored[4]) end
    for _, held in ipairs(redis.call('SMEMBERS', root .. 'held:' .. id)) do
      redis.call('HDEL', root .. 'keys', held)
    end
    for _, command in ipairs(redis.call('SMEMBERS', root .. 'commands:' .. id)) do
      discard(command)
    end
    for _, name in ipairs(redis.call('SMEMBERS', owned(id) .. 'nodes')) do
      redis.call('UNLINK', owned(id) .. 'all:' .. name, owned(id) .. 'pending:' .. name,
        owned(id) .. 'active:' .. name)
    end
    redis.call('UNLINK', key, root .. 'held:' .. id, owned(id) .. 'nodes')
  end
end

for _, run in ipairs(m.runs) do
  local key = root .. 'run:' .. run.id
  local stored = redis.call('HMGET', key, 'place', 'terms', 'ended', 'agedIn', 'agedAt')
  -- A run's place in every list of runs: when it was created, then its turn
  -- among all runs, which it keeps.
  local turn = stored[1] and string.sub(stored[1], 16)
    or string.format('%016d', redis.call('HINCRBY', root .. 'meta', 'runs', 1)) .. ':' .. run.id
  local place = instant(run.createdAt) .. turn

  local listed = {}
  for _, term in ipairs(run.terms) do listed[term] = true end
  for _, term in ipairs(stored[2] and cjson.decode(stored[2]) or {}) do
    if stored[1] == place and listed[term] then
      listed[term] = false
    else
      redis.call('ZREM', root .. 'runs:' .. term, stored[1])
    end
  end
  for _, term in ipairs(run.terms) do
    if listed[term] then redis.call('ZADD', root .. 'runs:' .. term, 0, place) end
  end

  -- A root is listed under its status by how long it is unchanged, then by
  -- its turn.
  if stored[4] then redis.call('ZREM', root .. 'roots:' .. stored[4], stored[5]) end
  if run.aged then
    local at = instant(run.updatedAt) .. turn
    redis.call('ZADD', root .. 'roots:' .. run.aged, 0, at)
    redis.call('HSET', key, 'agedIn', run.aged, 'agedAt', at)
  else
    redis.call('HDEL', key, 'agedIn', 'agedAt')
  end

  -- The dead commands of a run are listed apart while it has not ended.
  local ended = run.ended and '1' or '0'
  if stored[3] ~= ended then
    local dead = redis.call('ZRANGE', root .. 'dead:run:' .. run.id, 0, -1, 'WITHSCORES')
    for i = 1, #dead, 2 do
      if run.ended then
        redis.call('ZREM', root .. 'dead:active', dead[i])
      else
        redis.call('ZADD', root .. 'dead:active', dead[i + 1], dead[i])
      end
    end
  end

  redis.call('HSET', key, 'run', run.run, 'io', run.io, 'place', place,
    'terms', cjson.encode(run.terms), 'ended', ended, 'rev', rev)
  -- Made here: what it owns is indexed from its first record on.
  if not stored[1] then redis.call('HSET', key, 'indexed', 1) end
end

for _, node in ipairs(m.nodes) do
  local key, name = root .. 'run:' .. node[1], node[2]
  if redis.call('HSET', key, 'N' .. name, node[3]) == 1 then
    redis.call('HINCRBY', key, 'nodes', 1)
  end
  -- Its input with it, unless it is kept as stored.
  if not node[7] then
    if node[5] then redis.call('HSET', key, 'I' .. name, node[5])
    else redis.call('HDEL', key, 'I' .. name) end
  end
  redis.call('HSET', key, 'S' .. name, node[6])
  redis.call('SADD', owned(node[1]) .. 'nodes', name)
  if node[4] then
    if redis.call('HSETNX', key, 'D' .. name, 1) == 1 then redis.call('HINCRBY', key, 'done', 1) end
  elseif redis.call('HDEL', key, 'D' .. name) == 1 then
    redis.call('HINCRBY', key, 'done', -1)
  end
  redis.call('HSET', key, 'rev', rev)
end

for _, child in ipairs(m.children) do
  local key, pair, started, origin = root .. 'run:' .. child[1], child[2], child[4], child[5]
  -- The run a child started is told where it came from, and the run it
  -- started before, if another, is told no more.
  local before = redis.call('HGET', key, 'O' .. pair)
  if before ~= started then
    if before and redis.call('HGET', root .. 'run:' .. before, 'origin') == origin then
      redis.call('HDEL', root .. 'run:' .. before, 'origin')
    end
    if started then
      redis.call('HSET', root .. 'run:' .. started, 'origin', origin)
      redis.call('HSET', key, 'O' .. pair, started)
    else
      redis.call('HDEL', key, 'O' .. pair)
    end
  end
  redis.call('HSET', key, 'C' .. pair, child[3], 'rev', rev)
  if child[9] then redis.call('HSET', key, 'U' .. pair, child[9])
  else redis.call('HDEL', key, 'U' .. pair) end
  -- Filed under its node, a map's item also by where it stands.
  local function index(kind) return owned(child[1]) .. kind .. ':' .. child[6] end
  local ordinal, standing = child[7], child[8]
  redis.call('ZADD', index('all'), ordinal or 0, pair)
  if ordinal then
    if standing == 'pending' then
      redis.call('ZADD', index('pending'), ordinal, pair)
    else
      redis.call('ZREM', index('pending'), pair)
    end
    if standing == 'active' then
      redis.call('ZADD', index('active'), ordinal, pair)
    else
      redis.call('ZREM', index('active'), pair)
    end
  end
end

for _, attempt in ipairs(m.attempts) do
  redis.call('HSET', root .. 'run:' .. attempt[1], 'A' .. attempt[2], attempt[3], 'rev', rev)
end

for _, change in ipairs(m.keys) do
  local key = change[2]
  local holder = string.match(redis.call('HGET', root .. 'keys', key) or '', ' (.*)$')
  if holder then redis.call('SREM', root .. 'held:' .. holder, key) end
  if change[1] == 'acquire' then
    redis.call('HSET', root .. 'keys', key, rev .. ' ' .. change[3])
    redis.call('SADD', root .. 'held:' .. change[3], key)
  else
    redis.call('HDEL', root .. 'keys', key)
  end
end

for _, definition in ipairs(m.definitions) do
  redis.call('HSET', root .. 'definitions', definition[1], rev .. ' ' .. definition[2])
end

local renamed = false
for _, schedule in ipairs(m.schedules) do
  local name = schedule.name
  if redis.call('HSET', root .. 'schedules', name, rev .. ' ' .. schedule.value) == 1 then
    redis.call('ZADD', root .. 'schedules:names', 0, name)
    renamed = true
  end
  if schedule.due then
    redis.call('ZADD', root .. 'schedules:due', schedule.due, name)
  else
    redis.call('ZREM', root .. 'schedules:due', name)
  end
end
for _, name in ipairs(m.unschedule) do
  if redis.call('HDEL', root .. 'schedules', name) == 1 then
    redis.call('ZREM', root .. 'schedules:names', name)
    redis.call('ZREM', root .. 'schedules:due', name)
    renamed = true
  end
end
if renamed then redis.call('HSET', root .. 'meta', 'schedules', rev) end

for _, ack in ipairs(m.acks) do discard(ack[1]) end

local kinds = {}
for _, entry in ipairs(m.enqueue) do
  -- Queued or skipped, it is what decides this work now: the dead go.
  for _, id in ipairs(redis.call('SMEMBERS', root .. 'dead:key:' .. entry.dedupe)) do
    discard(id)
  end
  local at = entry.availableAt or m.now
  local waiting = redis.call('ZRANGE', root .. 'waiting:' .. entry.dedupe, 0, 0)[1]
  if waiting then
    -- Not added: the one that waits, the first queued of them, is due no
    -- later than this one would have been. One that is due already is in
    -- no wait, and stays as it is.
    local command = redis.call('HMGET', root .. 'command:' .. waiting, 'lane', 'seq', 'kind', 'availableAt')
    local due = redis.call('ZSCORE', root .. 'wait:' .. command[1], waiting)
    -- When it is due is kept as the other stores keep it: the earlier of the
    -- two, even for one that is due already.
    if command[4] and at < tonumber(command[4]) then
      redis.call('HSET', root .. 'command:' .. waiting, 'availableAt', at)
    end
    if due and at < tonumber(due) then
      if at <= now then
        redis.call('ZREM', root .. 'wait:' .. command[1], waiting)
        redis.call('ZADD', root .. 'due:' .. command[1], command[2], waiting)
        kinds[command[3]] = true
      else
        redis.call('ZADD', root .. 'wait:' .. command[1], at, waiting)
      end
    end
  else
    local turn = redis.call('HINCRBY', root .. 'meta', 'commands', 1)
    local id = string.format('%d', turn)
    redis.call('HSET', root .. 'command:' .. id, 'command', entry.command,
      'dedupe', entry.dedupe, 'kind', entry.kind, 'lane', entry.lane,
      'runId', entry.runId, 'seq', turn, 'deliveries', 0, 'createdAt', m.now,
      'availableAt', at)
    redis.call('SADD', root .. 'commands:' .. entry.runId, id)
    redis.call('ZADD', root .. 'waiting:' .. entry.dedupe, turn, id)
    if at <= now then
      redis.call('ZADD', root .. 'due:' .. entry.lane, turn, id)
      kinds[entry.kind] = true
    else
      redis.call('ZADD', root .. 'wait:' .. entry.lane, at, id)
    end
  end
end

for kind in pairs(kinds) do redis.call('PUBLISH', root .. 'hints', 'kind:' .. kind) end
for _, topic in ipairs(m.notify) do redis.call('PUBLISH', root .. 'hints', 'topic:' .. topic) end
return { 'done' }
`)

export type Claimed = readonly (readonly [
  id: string,
  token: string,
  command: string,
  deliveries: number,
  createdAt: number,
  availableAt: number,
  claimedAt: number,
])[]

/**
 * `ARGV`: lanes as JSON, the limit, the lease, the deliveries allowed, and a
 * token the process made at random. The claims of one call are told apart
 * by their turn in it, so a token is never given twice: one counted by the
 * server would be, once a failover had set the count back, and the claimant
 * of before would then hold the claim of another.
 */
export const CLAIM = script<Claimed>(`
${QUEUE}
local lanes = cjson.decode(ARGV[1])
local limit, lease, allowed = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local seed = ARGV[5]
local now = clock()

-- What waited for a time that has come, its own or the end of its claim, is
-- due again, at the turn it always had.
for _, lane in ipairs(lanes) do
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', root .. 'wait:' .. lane, '-inf', now)) do
    redis.call('ZADD', root .. 'due:' .. lane,
      redis.call('HGET', root .. 'command:' .. id, 'seq'), id)
    redis.call('ZREM', root .. 'wait:' .. lane, id)
  end
end

local claims = {}
-- A command set aside takes no place in the claim, so the lanes are asked
-- again for as many as are still wanted.
while #claims < limit do
  local wanted, found = limit - #claims, {}
  for _, lane in ipairs(lanes) do
    local due = redis.call('ZRANGE', root .. 'due:' .. lane, 0, wanted - 1, 'WITHSCORES')
    for i = 1, #due, 2 do
      found[#found + 1] = { id = due[i], turn = tonumber(due[i + 1]), lane = lane }
    end
  end
  if #found == 0 then break end
  -- The first of every lane together hold the first of all of them.
  table.sort(found, function(a, b) return a.turn < b.turn end)

  for i = 1, math.min(wanted, #found) do
    local id, lane = found[i].id, found[i].lane
    local key = root .. 'command:' .. id
    local command = redis.call('HMGET', key, 'command', 'deliveries', 'expiresAt', 'runId', 'dedupe',
      'createdAt', 'availableAt')
    local runId, dedupe = command[4], command[5]
    redis.call('ZREM', root .. 'due:' .. lane, id)
    if not command[3] then unwait(dedupe, id) end

    if tonumber(command[2]) >= allowed then
      local order = redis.call('HINCRBY', root .. 'meta', 'dead', 1)
      redis.call('HDEL', key, 'token', 'expiresAt')
      redis.call('HSET', key, 'deadAt', now, 'deadOrder', order, 'buried', seed)
      redis.call('ZREM', root .. 'claims:' .. runId, id)
      redis.call('ZADD', root .. 'dead', order, id)
      redis.call('ZADD', root .. 'dead:run:' .. runId, order, id)
      redis.call('SADD', root .. 'dead:key:' .. dedupe, id)
      if redis.call('HGET', root .. 'run:' .. runId, 'ended') == '0' then
        redis.call('ZADD', root .. 'dead:active', order, id)
      end
    else
      local token = seed .. ':' .. #claims
      local deliveries = command[2] + 1
      redis.call('HSET', key, 'token', token, 'expiresAt', now + lease, 'deliveries', deliveries)
      redis.call('ZADD', root .. 'wait:' .. lane, now + lease, id)
      redis.call('ZADD', root .. 'claims:' .. runId, now + lease, id)
      -- A command queued before \`availableAt\` was kept has only the time it
      -- was queued, which it is reported as due from.
      local created = tonumber(command[6])
      claims[#claims + 1] = { id, token, command[1], deliveries, created,
        tonumber(command[7]) or created, now }
    end
  end
end
return claims
`)

/** `ARGV`: id, token, delay, the error as JSON or nothing. `0` when stale. */
export const RELEASE = script<number>(`
${HOLDS}
local id, delay = ARGV[1], tonumber(ARGV[3])
local now = clock()
if not holds(id, ARGV[2], now) then return 0 end

local key = root .. 'command:' .. id
local command = redis.call('HMGET', key, 'lane', 'runId', 'dedupe', 'seq', 'kind')
local lane = command[1]
redis.call('HDEL', key, 'token', 'expiresAt')
-- Only a delivery that failed counts against the command.
if ARGV[4] == '' then
  redis.call('HINCRBY', key, 'deliveries', -1)
else
  redis.call('HSET', key, 'error', ARGV[4])
end
redis.call('HSET', key, 'availableAt', now + math.max(delay, 0))
redis.call('ZADD', root .. 'waiting:' .. command[3], command[4], id)
redis.call('ZREM', root .. 'claims:' .. command[2], id)
if delay <= 0 then
  redis.call('ZREM', root .. 'wait:' .. lane, id)
  redis.call('ZADD', root .. 'due:' .. lane, command[4], id)
  redis.call('PUBLISH', root .. 'hints', 'kind:' .. command[5])
else
  redis.call('ZADD', root .. 'wait:' .. lane, now + delay, id)
end
return 1
`)

/**
 * `ARGV`: id, token, lease. Nothing when stale, else the head of the
 * command's run as `run` and `io`.
 */
export const RENEW = script<
  Nullable<readonly [run: Nullable<string>, io: Nullable<string>]>
>(`
${HOLDS}
local id = ARGV[1]
local now = clock()
if not holds(id, ARGV[2], now) then return false end

local key = root .. 'command:' .. id
local command = redis.call('HMGET', key, 'lane', 'runId')
local expires = now + tonumber(ARGV[3])
redis.call('HSET', key, 'expiresAt', expires)
redis.call('ZADD', root .. 'wait:' .. command[1], expires, id)
redis.call('ZADD', root .. 'claims:' .. command[2], expires, id)
return redis.call('HMGET', root .. 'run:' .. command[2], 'run', 'io')
`)

/** `ARGV[1]`: run ids as JSON. How many claims hold on each. */
export const CLAIMED = script<readonly number[]>(`
local ahead = string.format('(%d', clock())
local held = {}
for i, id in ipairs(cjson.decode(ARGV[1])) do
  held[i] = redis.call('ZCOUNT', root .. 'claims:' .. id, ahead, '+inf')
end
return held
`)

export type ListedRuns = readonly (readonly [
  place: string,
  fields: readonly [
    run: Nullable<string>,
    nodes: Nullable<string>,
    done: Nullable<string>,
    origin: Nullable<string>,
    io?: Nullable<string>,
  ],
])[]

/**
 * `ARGV[1]`: `drivers`, each a set of indexes that together hold every run
 * the filter selects; `below`, where in the order to go on from; `count`;
 * and `io`, whether the payloads are wanted. Answers with the next runs of
 * the smallest driver, newest first.
 */
export const RUNS = script<ListedRuns>(`
local query = cjson.decode(ARGV[1])
local terms, fewest
for _, driver in ipairs(query.drivers) do
  local size = 0
  for _, term in ipairs(driver) do
    size = size + redis.call('ZCARD', root .. 'runs:' .. term)
  end
  if not fewest or size < fewest then terms, fewest = driver, size end
end

-- The newest of every index together hold the newest of all of them. A
-- place begins with digits, which sort alike wherever text is compared.
local places = {}
for _, term in ipairs(terms) do
  local found = redis.call('ZREVRANGEBYLEX', root .. 'runs:' .. term,
    query.below, '-', 'LIMIT', 0, query.count)
  for _, place in ipairs(found) do places[#places + 1] = place end
end
if #terms > 1 then table.sort(places, function(a, b) return a > b end) end

local fields = { 'run', 'nodes', 'done', 'origin' }
if query.io then fields[5] = 'io' end
local runs = {}
for i = 1, math.min(query.count, #places) do
  local key = root .. 'run:' .. string.sub(places[i], 33)
  runs[i] = { places[i], redis.call('HMGET', key, unpack(fields)) }
end
return runs
`)

export type ListedDead = readonly (readonly [id: string, fields: DeadFields])[]

/**
 * `ARGV[1]`: `indexes`, all of which must list a command; `after`, the
 * order of the last one seen; `count`; and `id`, to ask for one alone.
 */
export const DEAD = script<ListedDead>(`
local query = cjson.decode(ARGV[1])
local function order(id)
  local at
  for _, index in ipairs(query.indexes) do
    at = redis.call('ZSCORE', root .. index, id)
    if not at then return nil end
  end
  return tonumber(at)
end

local ids = {}
if query.id then
  local at = order(query.id)
  if at and at > query.after then ids[1] = query.id end
else
  local from = string.format('(%d', query.after)
  while #ids < query.count do
    local found = redis.call('ZRANGEBYSCORE', root .. query.indexes[1], from, '+inf',
      'WITHSCORES', 'LIMIT', 0, 100)
    if #found == 0 then break end
    for i = 1, #found, 2 do
      if #ids < query.count and order(found[i]) then ids[#ids + 1] = found[i] end
    end
    from = '(' .. found[#found]
  end
end

local dead = {}
for i, id in ipairs(ids) do
  dead[i] = { id, redis.call('HMGET', root .. 'command:' .. id,
    'command', 'deliveries', 'error', 'createdAt', 'deadAt', 'deadOrder') }
end
return dead
`)

/**
 * `ARGV[1]`: `after`, the name of the last one seen, when there is one;
 * `due`, to select those due by then; `count`. In the order of their names.
 */
export const SCHEDULES = script<readonly string[]>(`
local query = cjson.decode(ARGV[1])
local from, found = query.after and '(' .. query.after or '-', {}
while #found < query.count do
  local names = redis.call('ZRANGEBYLEX', root .. 'schedules:names', from, '+', 'LIMIT', 0, 100)
  if #names == 0 then break end
  for _, name in ipairs(names) do
    local at = query.due and redis.call('ZSCORE', root .. 'schedules:due', name)
    if #found < query.count and (not query.due or (at and tonumber(at) <= query.due)) then
      found[#found + 1] = redis.call('HGET', root .. 'schedules', name)
    end
  end
  from = '(' .. names[#names]
end
return found
`)

/** `ARGV`: the status, where to go on from, where to stop, the count. */
export const PRUNABLE = script<readonly string[]>(`
return redis.call('ZRANGEBYLEX', root .. 'roots:' .. ARGV[1], ARGV[2], ARGV[3],
  'LIMIT', 0, ARGV[4])
`)
