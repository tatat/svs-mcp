-- Runs sv-scripts/SVSMCPBridge.lua outside Synthesizer V Studio by stubbing
-- the SV host object, so the real bridge code can be exercised in CI.
--
-- Usage: lua test/sv-stub.lua  (with SVS_MCP_BRIDGE_DIR set)
--
-- The stub models a project with one track ("Stub Track", 3 notes in the
-- main group), one tempo mark and one measure mark.

local finished = false
local timerQueue = {}

local WHOLE = 705600000 * 4

local stubTimeAxis = {
  -- Measure numbers are 0-based, matching the real SV API.
  measureMarks = { { position = 0, positionBlick = 0, numerator = 4, denominator = 4 } },
  getAllTempoMarks = function(self)
    return { { position = 0, positionSeconds = 0, bpm = 120 } }
  end,
  getAllMeasureMarks = function(self)
    return self.measureMarks
  end,
  addMeasureMark = function(self, measure, nomin, denom)
    -- Mimics the real SV quirk: adding at a measure that already has a mark
    -- is silently ignored (the docs claim it updates; SV 2.2.1 does not).
    for _, mark in ipairs(self.measureMarks) do
      if mark.position == measure then
        return
      end
    end
    table.insert(self.measureMarks, {
      position = measure, positionBlick = 0, numerator = nomin, denominator = denom
    })
    table.sort(self.measureMarks, function(a, b) return a.position < b.position end)
    local prev = nil
    for _, mark in ipairs(self.measureMarks) do
      if prev ~= nil then
        mark.positionBlick = prev.positionBlick +
          (mark.position - prev.position) * (WHOLE * prev.numerator / prev.denominator)
      end
      prev = mark
    end
  end,
  removeMeasureMark = function(self, measure)
    for i, mark in ipairs(self.measureMarks) do
      if mark.position == measure then
        table.remove(self.measureMarks, i)
        return true
      end
    end
    return false
  end
}

local QUARTER = 705600000

local function makeNote()
  local note = {
    onset = 0, duration = QUARTER, pitch = 60, lyrics = "", phonemes = ""
  }
  function note:getOnset() return self.onset end
  function note:getDuration() return self.duration end
  function note:getEnd() return self.onset + self.duration end
  function note:getPitch() return self.pitch end
  function note:getLyrics() return self.lyrics end
  function note:getPhonemes() return self.phonemes end
  function note:setTimeRange(onset, duration)
    self.onset = onset
    self.duration = duration
  end
  function note:setPitch(pitch) self.pitch = pitch end
  function note:setLyrics(lyrics) self.lyrics = lyrics end
  function note:setPhonemes(phonemes) self.phonemes = phonemes end
  function note:getLanguageOverride() return self.languageOverride or "" end
  function note:setLanguageOverride(language) self.languageOverride = language end
  return note
end

local function presetNote(onset, duration, pitch, lyrics)
  local note = makeNote()
  note:setTimeRange(onset, duration)
  note:setPitch(pitch)
  note:setLyrics(lyrics)
  return note
end

local function makeGroup(name)
  local group = { notes = {}, name = name }
  -- The real API keeps notes sorted by onset even when one is moved via
  -- setTimeRange/setOnset; emulate that by sorting before every access.
  local function sorted(self)
    table.sort(self.notes, function(a, b) return a.onset < b.onset end)
    return self.notes
  end
  function group:getNumNotes() return #sorted(self) end
  function group:getNote(i) return sorted(self)[i] end
  function group:addNote(note)
    table.insert(self.notes, note)
    local list = sorted(self)
    for i, existing in ipairs(list) do
      if existing == note then
        return i
      end
    end
  end
  function group:getName() return self.name end
  function group:setName(newName) self.name = newName end
  function group:removeNote(i) table.remove(self.notes, i) end
  return group
end

local function makeGroupRef(group, isMain)
  local ref = { target = group, main = isMain, timeOffset = 0 }
  function ref:isMain() return self.main end
  function ref:isInstrumental() return false end
  function ref:isMuted() return false end
  function ref:getOnset() return self.timeOffset end
  function ref:getTimeOffset() return self.timeOffset end
  function ref:setTimeOffset(blickOffset) self.timeOffset = blickOffset end
  function ref:getTarget() return self.target end
  function ref:setTarget(newTarget) self.target = newTarget end
  return ref
end

-- Measure 1: ら(C4) ら(D4) ら(E4), beat 4 empty (4/4).
local stubGroup = makeGroup("main")
stubGroup:addNote(presetNote(0, QUARTER, 60, "ら"))
stubGroup:addNote(presetNote(QUARTER, QUARTER, 62, "ら"))
stubGroup:addNote(presetNote(2 * QUARTER, QUARTER, 64, "ら"))

local stubMixer = {
  isMuted = function(self) return false end,
  isSolo = function(self) return false end,
  getGainDecibel = function(self) return 0 end
}

local function makeTrack(name)
  local track = { name = name, refs = { makeGroupRef(makeGroup("main"), true) } }
  function track:getName() return self.name end
  function track:setName(newName) self.name = newName end
  function track:getNumGroups() return #self.refs end
  function track:getGroupReference(i) return self.refs[i] end
  function track:addGroupReference(ref)
    table.insert(self.refs, ref)
    return #self.refs
  end
  function track:getMixer() return stubMixer end
  return track
end

local stubTrack = makeTrack("Stub Track")
stubTrack.refs[1].target = stubGroup

local stubProject = {
  tracks = { stubTrack },
  getFileName = function(self) return "/tmp/stub-project.svp" end,
  getDuration = function(self) return 705600000 * 16 end,
  getTimeAxis = function(self) return stubTimeAxis end,
  getNumTracks = function(self) return #self.tracks end,
  getTrack = function(self, i) return self.tracks[i] end,
  addTrack = function(self, track)
    table.insert(self.tracks, track)
    return #self.tracks
  end,
  newUndoRecord = function(self) end,
  addNoteGroup = function(self, group) return 1 end
}

SV = {
  QUARTER = QUARTER,
  create = function(self, objectType)
    if objectType == "Note" then
      return makeNote()
    elseif objectType == "NoteGroup" then
      return makeGroup("Unnamed Group")
    elseif objectType == "NoteGroupReference" then
      return makeGroupRef(nil, false)
    elseif objectType == "Track" then
      return makeTrack("Unnamed Track")
    end
    error("stub cannot create: " .. tostring(objectType))
  end,
  setTimeout = function(self, ms, callback)
    table.insert(timerQueue, callback)
  end,
  showMessageBox = function(self, title, message) end,
  showMessageBoxAsync = function(self, title, message) end,
  finish = function(self) finished = true end,
  getHostInfo = function(self)
    return {
      hostName = "Synthesizer V Studio Pro (stub)",
      hostVersion = "2.1.2",
      osType = "macOS",
      languageCode = "en-us"
    }
  end,
  getProject = function(self) return stubProject end,
  getPhonemesForGroup = function(self, ref)
    local phonemes = {}
    for i = 1, ref:getTarget():getNumNotes() do
      phonemes[i] = "l a"
    end
    return phonemes
  end
}

dofile("sv-scripts/SVSMCPBridge.lua")
main()

-- Pump the timer queue like the SV host would, with a short real delay.
while not finished do
  local callback = table.remove(timerQueue, 1)
  if callback == nil then
    break
  end
  os.execute("sleep 0.02")
  callback()
end
