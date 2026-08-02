-- SVSMCPBridge.lua
--
-- Resident bridge between Synthesizer V Studio and the svs-mcp server.
--
-- SV's scripting API has no network access, so the MCP server and this
-- script exchange JSON files in ~/.svs-mcp/bridge/ (or $SVS_MCP_BRIDGE_DIR):
--
--   request.json   written by the server (atomically, via rename)
--   response.json  written by this script (atomically, via rename)
--
-- The script polls for requests every POLL_MS using SV:setTimeout and keeps
-- running until it receives a {"action": "shutdown"} request (sent by the
-- server or by the companion "SVS MCP Bridge: Stop" script).
--
-- This file embeds rxi/json.lua (MIT license, see its header below).
-- macOS only; target is SV Studio 2 Pro.

--
-- json.lua
--
-- Copyright (c) 2020 rxi
--
-- Permission is hereby granted, free of charge, to any person obtaining a copy of
-- this software and associated documentation files (the "Software"), to deal in
-- the Software without restriction, including without limitation the rights to
-- use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
-- of the Software, and to permit persons to whom the Software is furnished to do
-- so, subject to the following conditions:
--
-- The above copyright notice and this permission notice shall be included in all
-- copies or substantial portions of the Software.
--
-- THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
-- IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
-- FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
-- AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
-- LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
-- OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
-- SOFTWARE.
--

local json = { _version = "0.1.2" }

-------------------------------------------------------------------------------
-- Encode
-------------------------------------------------------------------------------

local encode

local escape_char_map = {
  [ "\\" ] = "\\",
  [ "\"" ] = "\"",
  [ "\b" ] = "b",
  [ "\f" ] = "f",
  [ "\n" ] = "n",
  [ "\r" ] = "r",
  [ "\t" ] = "t",
}

local escape_char_map_inv = { [ "/" ] = "/" }
for k, v in pairs(escape_char_map) do
  escape_char_map_inv[v] = k
end


local function escape_char(c)
  return "\\" .. (escape_char_map[c] or string.format("u%04x", c:byte()))
end


local function encode_nil(val)
  return "null"
end


local function encode_table(val, stack)
  local res = {}
  stack = stack or {}

  -- Circular reference?
  if stack[val] then error("circular reference") end

  stack[val] = true

  if rawget(val, 1) ~= nil or next(val) == nil then
    -- Treat as array -- check keys are valid and it is not sparse
    local n = 0
    for k in pairs(val) do
      if type(k) ~= "number" then
        error("invalid table: mixed or invalid key types")
      end
      n = n + 1
    end
    if n ~= #val then
      error("invalid table: sparse array")
    end
    -- Encode
    for i, v in ipairs(val) do
      table.insert(res, encode(v, stack))
    end
    stack[val] = nil
    return "[" .. table.concat(res, ",") .. "]"

  else
    -- Treat as an object
    for k, v in pairs(val) do
      if type(k) ~= "string" then
        error("invalid table: mixed or invalid key types")
      end
      table.insert(res, encode(k, stack) .. ":" .. encode(v, stack))
    end
    stack[val] = nil
    return "{" .. table.concat(res, ",") .. "}"
  end
end


local function encode_string(val)
  return '"' .. val:gsub('[%z\1-\31\\"]', escape_char) .. '"'
end


local function encode_number(val)
  -- Check for NaN, -inf and inf
  if val ~= val or val <= -math.huge or val >= math.huge then
    error("unexpected number value '" .. tostring(val) .. "'")
  end
  return string.format("%.14g", val)
end


local type_func_map = {
  [ "nil"     ] = encode_nil,
  [ "table"   ] = encode_table,
  [ "string"  ] = encode_string,
  [ "number"  ] = encode_number,
  [ "boolean" ] = tostring,
}


encode = function(val, stack)
  local t = type(val)
  local f = type_func_map[t]
  if f then
    return f(val, stack)
  end
  error("unexpected type '" .. t .. "'")
end


function json.encode(val)
  return ( encode(val) )
end


-------------------------------------------------------------------------------
-- Decode
-------------------------------------------------------------------------------

local parse

local function create_set(...)
  local res = {}
  for i = 1, select("#", ...) do
    res[ select(i, ...) ] = true
  end
  return res
end

local space_chars   = create_set(" ", "\t", "\r", "\n")
local delim_chars   = create_set(" ", "\t", "\r", "\n", "]", "}", ",")
local escape_chars  = create_set("\\", "/", '"', "b", "f", "n", "r", "t", "u")
local literals      = create_set("true", "false", "null")

local literal_map = {
  [ "true"  ] = true,
  [ "false" ] = false,
  [ "null"  ] = nil,
}


local function next_char(str, idx, set, negate)
  for i = idx, #str do
    if set[str:sub(i, i)] ~= negate then
      return i
    end
  end
  return #str + 1
end


local function decode_error(str, idx, msg)
  local line_count = 1
  local col_count = 1
  for i = 1, idx - 1 do
    col_count = col_count + 1
    if str:sub(i, i) == "\n" then
      line_count = line_count + 1
      col_count = 1
    end
  end
  error( string.format("%s at line %d col %d", msg, line_count, col_count) )
end


local function codepoint_to_utf8(n)
  -- http://scripts.sil.org/cms/scripts/page.php?site_id=nrsi&id=iws-appendixa
  local f = math.floor
  if n <= 0x7f then
    return string.char(n)
  elseif n <= 0x7ff then
    return string.char(f(n / 64) + 192, n % 64 + 128)
  elseif n <= 0xffff then
    return string.char(f(n / 4096) + 224, f(n % 4096 / 64) + 128, n % 64 + 128)
  elseif n <= 0x10ffff then
    return string.char(f(n / 262144) + 240, f(n % 262144 / 4096) + 128,
                       f(n % 4096 / 64) + 128, n % 64 + 128)
  end
  error( string.format("invalid unicode codepoint '%x'", n) )
end


local function parse_unicode_escape(s)
  local n1 = tonumber( s:sub(1, 4),  16 )
  local n2 = tonumber( s:sub(7, 10), 16 )
   -- Surrogate pair?
  if n2 then
    return codepoint_to_utf8((n1 - 0xd800) * 0x400 + (n2 - 0xdc00) + 0x10000)
  else
    return codepoint_to_utf8(n1)
  end
end


local function parse_string(str, i)
  local res = ""
  local j = i + 1
  local k = j

  while j <= #str do
    local x = str:byte(j)

    if x < 32 then
      decode_error(str, j, "control character in string")

    elseif x == 92 then -- `\`: Escape
      res = res .. str:sub(k, j - 1)
      j = j + 1
      local c = str:sub(j, j)
      if c == "u" then
        local hex = str:match("^[dD][89aAbB]%x%x\\u%x%x%x%x", j + 1)
                 or str:match("^%x%x%x%x", j + 1)
                 or decode_error(str, j - 1, "invalid unicode escape in string")
        res = res .. parse_unicode_escape(hex)
        j = j + #hex
      else
        if not escape_chars[c] then
          decode_error(str, j - 1, "invalid escape char '" .. c .. "' in string")
        end
        res = res .. escape_char_map_inv[c]
      end
      k = j + 1

    elseif x == 34 then -- `"`: End of string
      res = res .. str:sub(k, j - 1)
      return res, j + 1
    end

    j = j + 1
  end

  decode_error(str, i, "expected closing quote for string")
end


local function parse_number(str, i)
  local x = next_char(str, i, delim_chars)
  local s = str:sub(i, x - 1)
  local n = tonumber(s)
  if not n then
    decode_error(str, i, "invalid number '" .. s .. "'")
  end
  return n, x
end


local function parse_literal(str, i)
  local x = next_char(str, i, delim_chars)
  local word = str:sub(i, x - 1)
  if not literals[word] then
    decode_error(str, i, "invalid literal '" .. word .. "'")
  end
  return literal_map[word], x
end


local function parse_array(str, i)
  local res = {}
  local n = 1
  i = i + 1
  while 1 do
    local x
    i = next_char(str, i, space_chars, true)
    -- Empty / end of array?
    if str:sub(i, i) == "]" then
      i = i + 1
      break
    end
    -- Read token
    x, i = parse(str, i)
    res[n] = x
    n = n + 1
    -- Next token
    i = next_char(str, i, space_chars, true)
    local chr = str:sub(i, i)
    i = i + 1
    if chr == "]" then break end
    if chr ~= "," then decode_error(str, i, "expected ']' or ','") end
  end
  return res, i
end


local function parse_object(str, i)
  local res = {}
  i = i + 1
  while 1 do
    local key, val
    i = next_char(str, i, space_chars, true)
    -- Empty / end of object?
    if str:sub(i, i) == "}" then
      i = i + 1
      break
    end
    -- Read key
    if str:sub(i, i) ~= '"' then
      decode_error(str, i, "expected string for key")
    end
    key, i = parse(str, i)
    -- Read ':' delimiter
    i = next_char(str, i, space_chars, true)
    if str:sub(i, i) ~= ":" then
      decode_error(str, i, "expected ':' after key")
    end
    i = next_char(str, i + 1, space_chars, true)
    -- Read value
    val, i = parse(str, i)
    -- Set
    res[key] = val
    -- Next token
    i = next_char(str, i, space_chars, true)
    local chr = str:sub(i, i)
    i = i + 1
    if chr == "}" then break end
    if chr ~= "," then decode_error(str, i, "expected '}' or ','") end
  end
  return res, i
end


local char_func_map = {
  [ '"' ] = parse_string,
  [ "0" ] = parse_number,
  [ "1" ] = parse_number,
  [ "2" ] = parse_number,
  [ "3" ] = parse_number,
  [ "4" ] = parse_number,
  [ "5" ] = parse_number,
  [ "6" ] = parse_number,
  [ "7" ] = parse_number,
  [ "8" ] = parse_number,
  [ "9" ] = parse_number,
  [ "-" ] = parse_number,
  [ "t" ] = parse_literal,
  [ "f" ] = parse_literal,
  [ "n" ] = parse_literal,
  [ "[" ] = parse_array,
  [ "{" ] = parse_object,
}


parse = function(str, idx)
  local chr = str:sub(idx, idx)
  local f = char_func_map[chr]
  if f then
    return f(str, idx)
  end
  decode_error(str, idx, "unexpected character '" .. chr .. "'")
end


function json.decode(str)
  if type(str) ~= "string" then
    error("expected argument of type string, got " .. type(str))
  end
  local res, idx = parse(str, next_char(str, 1, space_chars, true))
  idx = next_char(str, idx, space_chars, true)
  if idx <= #str then
    decode_error(str, idx, "trailing garbage")
  end
  return res
end

-- ===========================================================================
-- Configuration
-- ===========================================================================

local POLL_MS = 100
local BRIDGE_VERSION = 1

local function bridgeDir()
  local dir = os.getenv("SVS_MCP_BRIDGE_DIR")
  if dir == nil or dir == "" then
    dir = os.getenv("HOME") .. "/.svs-mcp/bridge"
  end
  return dir
end

local BRIDGE_DIR = bridgeDir()
local REQUEST_PATH = BRIDGE_DIR .. "/request.json"
local RESPONSE_PATH = BRIDGE_DIR .. "/response.json"
local STATUS_PATH = BRIDGE_DIR .. "/bridge.json"

function getClientInfo()
  return {
    name = "SVS MCP Bridge: Start",
    category = "SVS MCP",
    author = "svs-mcp",
    versionNumber = BRIDGE_VERSION,
    minEditorVersion = 0x020000
  }
end

-- ===========================================================================
-- Request handlers
-- ===========================================================================

local function handlePing(params)
  local host = SV:getHostInfo()
  return {
    hostName = host.hostName,
    hostVersion = host.hostVersion,
    osType = host.osType,
    languageCode = host.languageCode,
    bridgeVersion = BRIDGE_VERSION
  }
end

local function mainGroupOf(track)
  for g = 1, track:getNumGroups() do
    local ref = track:getGroupReference(g)
    if ref:isMain() then
      return ref
    end
  end
  return nil
end

local function trackByIndex(project, index)
  local count = project:getNumTracks()
  if type(index) ~= "number" or index < 1 or index > count or index % 1 ~= 0 then
    error("Track " .. tostring(index) .. " does not exist (project has " ..
      count .. " track(s), indices are 1-based)", 0)
  end
  return project:getTrack(index)
end

local function firstNonMainRef(track)
  for g = 1, track:getNumGroups() do
    local ref = track:getGroupReference(g)
    if not ref:isMain() then
      return ref, g
    end
  end
  return nil, nil
end

-- Resolve a group reference and its index. With an explicit 1-based index,
-- use that. With nil, prefer the first non-main group: in SV Studio 2 the
-- singer is attached per group and notes in the main group are not
-- synthesized, so the main group is only used as a last resort (reads).
local function groupRefByIndex(track, groupIndex)
  if groupIndex == nil then
    local ref, index = firstNonMainRef(track)
    if ref ~= nil then
      return ref, index
    end
    local mainRef = mainGroupOf(track)
    if mainRef == nil then
      error("Track has no note groups", 0)
    end
    return mainRef, 1
  end
  local count = track:getNumGroups()
  if type(groupIndex) ~= "number" or groupIndex < 1 or groupIndex > count or groupIndex % 1 ~= 0 then
    error("Group " .. tostring(groupIndex) .. " does not exist (track has " ..
      count .. " group(s), indices are 1-based)", 0)
  end
  return track:getGroupReference(groupIndex), groupIndex
end

-- Create a new group on the track and return (ref, refIndex).
local function newGroupOnTrack(project, track, name)
  local group = SV:create("NoteGroup")
  if name ~= nil then
    group:setName(name)
  end
  project:addNoteGroup(group)
  local ref = SV:create("NoteGroupReference")
  ref:setTarget(group)
  local refIndex = track:addGroupReference(ref)
  return ref, refIndex
end

-- Note onsets inside a group are relative to the reference's time offset;
-- the bridge always speaks absolute (project) positions.
local function noteToTable(note, index, timeOffset)
  return {
    index = index,
    lyrics = note:getLyrics(),
    phonemes = note:getPhonemes(),
    pitch = note:getPitch(),
    onset = note:getOnset() + timeOffset,
    duration = note:getDuration(),
    languageOverride = note:getLanguageOverride()
  }
end

local function timeAxisTables(timeAxis)
  local tempo = {}
  for _, mark in ipairs(timeAxis:getAllTempoMarks()) do
    table.insert(tempo, {
      positionBlick = mark.position,
      positionSeconds = mark.positionSeconds,
      bpm = mark.bpm
    })
  end
  local timeSignatures = {}
  for _, mark in ipairs(timeAxis:getAllMeasureMarks()) do
    table.insert(timeSignatures, {
      measure = mark.position,
      positionBlick = mark.positionBlick,
      numerator = mark.numerator,
      denominator = mark.denominator
    })
  end
  return tempo, timeSignatures
end

local function handleGetProjectInfo(params)
  local project = SV:getProject()
  local tempo, timeSignatures = timeAxisTables(project:getTimeAxis())

  local tracks = {}
  for i = 1, project:getNumTracks() do
    local track = project:getTrack(i)
    local noteCount = 0
    local ref = mainGroupOf(track)
    if ref ~= nil then
      noteCount = ref:getTarget():getNumNotes()
    end
    local mixer = track:getMixer()
    local groups = {}
    for g = 1, track:getNumGroups() do
      local groupRef = track:getGroupReference(g)
      table.insert(groups, {
        index = g,
        name = groupRef:getTarget():getName(),
        isMain = groupRef:isMain(),
        isInstrumental = groupRef:isInstrumental(),
        muted = groupRef:isMuted(),
        noteCount = groupRef:getTarget():getNumNotes(),
        onsetBlick = groupRef:getOnset()
      })
    end
    table.insert(tracks, {
      index = i,
      name = track:getName(),
      noteCount = noteCount,
      muted = mixer:isMuted(),
      solo = mixer:isSolo(),
      gainDb = mixer:getGainDecibel(),
      groups = groups
    })
  end

  return {
    fileName = project:getFileName(),
    durationBlick = project:getDuration(),
    tempo = tempo,
    timeSignatures = timeSignatures,
    tracks = tracks
  }
end

local function handleGetTimeAxis(params)
  local tempo, timeSignatures = timeAxisTables(SV:getProject():getTimeAxis())
  return { tempo = tempo, timeSignatures = timeSignatures }
end

-- params: track (1-based), group? (1-based ref index, default main),
-- startBlick?, endBlick? (absolute onset positions, end-exclusive)
local function handleGetNotes(params)
  local project = SV:getProject()
  local track = trackByIndex(project, params.track)
  local ref, refIndex = groupRefByIndex(track, params.group)
  local group = ref:getTarget()
  local timeOffset = ref:getTimeOffset()

  local notes = {}
  for i = 1, group:getNumNotes() do
    local note = group:getNote(i)
    local onset = note:getOnset() + timeOffset
    if (params.startBlick == nil or onset >= params.startBlick) and
       (params.endBlick == nil or onset < params.endBlick) then
      table.insert(notes, noteToTable(note, i, timeOffset))
    end
  end
  return {
    group = refIndex,
    groupName = group:getName(),
    totalNotes = group:getNumNotes(),
    notes = notes
  }
end

-- params: track (1-based), notes: array of {lyrics, pitch, onset, duration}.
-- Returns a snapshot of all notes overlapping the inserted time range,
-- because insertion renumbers onset-ordered indices.
local function handleInsertNotes(params)
  local project = SV:getProject()
  local track = trackByIndex(project, params.track)
  if type(params.notes) ~= "table" or #params.notes == 0 then
    error("No notes provided", 0)
  end

  project:newUndoRecord()

  -- Default target: first non-main group; auto-create one when the track has
  -- none, because main-group notes are not synthesized in SV Studio 2.
  local ref, refIndex
  local createdGroup = false
  if params.group == nil then
    ref, refIndex = firstNonMainRef(track)
    if ref == nil then
      ref, refIndex = newGroupOnTrack(project, track, "MCP Notes")
      createdGroup = true
    end
  else
    ref, refIndex = groupRefByIndex(track, params.group)
  end
  local group = ref:getTarget()
  local timeOffset = ref:getTimeOffset()

  local minOnset, maxEnd
  for _, n in ipairs(params.notes) do
    local note = SV:create("Note")
    note:setTimeRange(n.onset - timeOffset, n.duration)
    note:setPitch(n.pitch)
    note:setLyrics(n.lyrics or "")
    group:addNote(note)
    if minOnset == nil or n.onset < minOnset then minOnset = n.onset end
    local noteEnd = n.onset + n.duration
    if maxEnd == nil or noteEnd > maxEnd then maxEnd = noteEnd end
  end

  local notes = {}
  for i = 1, group:getNumNotes() do
    local note = group:getNote(i)
    if note:getOnset() + timeOffset < maxEnd and note:getEnd() + timeOffset > minOnset then
      table.insert(notes, noteToTable(note, i, timeOffset))
    end
  end
  return {
    group = refIndex,
    groupName = group:getName(),
    createdGroup = createdGroup,
    insertedCount = #params.notes,
    totalNotes = group:getNumNotes(),
    notes = notes
  }
end

-- params: track (1-based). Returns per-note computed phonemes (the actual
-- text-to-phoneme output used for synthesis). May be marked incomplete if
-- the converter has not finished yet; retry in that case.
local function handleGetPhonemes(params)
  local project = SV:getProject()
  local track = trackByIndex(project, params.track)
  local ref = groupRefByIndex(track, params.group)
  local group = ref:getTarget()
  local computed = SV:getPhonemesForGroup(ref)
  local notes = {}
  for i = 1, group:getNumNotes() do
    local note = group:getNote(i)
    table.insert(notes, {
      index = i,
      lyrics = note:getLyrics(),
      userPhonemes = note:getPhonemes(),
      computedPhonemes = computed[i]
    })
  end
  return { complete = #computed > 0, notes = notes }
end

-- params: track (1-based), name?. Creates an empty NoteGroup, adds it to the
-- project library and references it from the track (time offset 0; note
-- positions are absolute anyway). Returns the new group reference index.
local function handleCreateGroup(params)
  local project = SV:getProject()
  local track = trackByIndex(project, params.track)
  project:newUndoRecord()
  local ref, refIndex = newGroupOnTrack(project, track, params.name)
  return { group = refIndex, name = ref:getTarget():getName() }
end

-- params: name?. Returns the new 1-based track index.
local function handleAddTrack(params)
  local project = SV:getProject()
  project:newUndoRecord()
  local track = SV:create("Track")
  if params.name ~= nil then
    track:setName(params.name)
  end
  local index = project:addTrack(track)
  return { track = index, name = track:getName() }
end

local handlers = {
  ping = handlePing,
  get_project_info = handleGetProjectInfo,
  get_time_axis = handleGetTimeAxis,
  get_notes = handleGetNotes,
  insert_notes = handleInsertNotes,
  get_phonemes = handleGetPhonemes,
  create_group = handleCreateGroup,
  add_track = handleAddTrack
}

-- ===========================================================================
-- File protocol
-- ===========================================================================

local finished = false

local function writeResponse(response)
  local tmpPath = RESPONSE_PATH .. ".tmp"
  local f = io.open(tmpPath, "w")
  if f == nil then
    return
  end
  f:write(json.encode(response))
  f:close()
  os.remove(RESPONSE_PATH)
  os.rename(tmpPath, RESPONSE_PATH)
end

-- Returns the decoded request, or nil if there is none. A file that exists
-- but cannot be parsed is deleted so the loop does not spin on it.
local function readRequest()
  local f = io.open(REQUEST_PATH, "r")
  if f == nil then
    return nil
  end
  local content = f:read("*a")
  f:close()
  if content == nil or content == "" then
    os.remove(REQUEST_PATH)
    return nil
  end
  local parsed, request = pcall(json.decode, content)
  if not parsed or type(request) ~= "table" or request.id == nil then
    os.remove(REQUEST_PATH)
    return nil
  end
  return request
end

local function processRequest()
  local request = readRequest()
  if request == nil then
    return
  end
  os.remove(REQUEST_PATH)

  if request.action == "shutdown" then
    writeResponse({ id = request.id, ok = true, result = { stopped = true } })
    os.remove(STATUS_PATH)
    finished = true
    SV:finish()
    return
  end

  local handler = handlers[request.action]
  local response
  if handler == nil then
    response = {
      id = request.id,
      ok = false,
      error = "Unknown action: " .. tostring(request.action)
    }
  else
    local success, result = pcall(handler, request.params or {})
    if success then
      response = { id = request.id, ok = true, result = result }
    else
      response = { id = request.id, ok = false, error = tostring(result) }
    end
  end
  writeResponse(response)
end

local function loop()
  if finished then
    return
  end
  pcall(processRequest)
  SV:setTimeout(POLL_MS, loop)
end

function main()
  os.execute('mkdir -p "' .. BRIDGE_DIR .. '"')
  -- Drop leftovers from previous runs so no stale command gets executed.
  os.remove(REQUEST_PATH)
  os.remove(RESPONSE_PATH)
  -- Announce readiness; clients can wait for this file after starting the
  -- bridge instead of racing the cleanup above.
  local status = io.open(STATUS_PATH, "w")
  if status ~= nil then
    status:write(json.encode({ bridgeVersion = BRIDGE_VERSION, startedAt = os.time() }))
    status:close()
  end
  SV:showMessageBoxAsync(
    "SVS MCP Bridge",
    "Bridge started. It keeps running in the background until you run " ..
    "\"SVS MCP Bridge: Stop\" or close the project."
  )
  loop()
end
