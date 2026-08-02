-- SVSMCPBridgeStop.lua
--
-- Sends a shutdown request to the resident SVS MCP bridge (see
-- SVSMCPBridge.lua) by writing it to the shared bridge directory.

local function bridgeDir()
  local dir = os.getenv("SVS_MCP_BRIDGE_DIR")
  if dir == nil or dir == "" then
    dir = os.getenv("HOME") .. "/.svs-mcp/bridge"
  end
  return dir
end

function getClientInfo()
  return {
    name = "SVS MCP Bridge: Stop",
    category = "SVS MCP",
    author = "svs-mcp",
    versionNumber = 1,
    minEditorVersion = 0x020000
  }
end

function main()
  local dir = bridgeDir()
  local tmpPath = dir .. "/stop-request.tmp"
  local f = io.open(tmpPath, "w")
  if f == nil then
    SV:showMessageBox("SVS MCP Bridge", "Could not write to " .. dir .. ". Is the bridge installed?")
    return
  end
  f:write('{"id":"stop-' .. tostring(os.time()) .. '","action":"shutdown","params":{}}')
  f:close()
  os.remove(dir .. "/request.json")
  os.rename(tmpPath, dir .. "/request.json")
  SV:showMessageBox("SVS MCP Bridge", "Stop request sent. The bridge will exit within a second.")
end
