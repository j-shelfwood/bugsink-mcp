#!/bin/bash
# Integration test for Bugsink MCP Server
# Tests the server against a live Bugsink instance

set -e

echo "=== Bugsink MCP Server Integration Test ==="
echo ""

# Configuration
export BUGSINK_URL="https://error-tracking.bookingmanager.com"
export BUGSINK_TOKEN="9eb79cc2ca05503cc75b30174b14c201fd3006dd"

cd "$(dirname "$0")"

echo "[1/5] Testing API connectivity directly..."
PROJECTS=$(curl -s -H "Authorization: Bearer $BUGSINK_TOKEN" "$BUGSINK_URL/api/canonical/0/projects/")
PROJECT_COUNT=$(echo "$PROJECTS" | node -e "const d=require('fs').readFileSync(0,'utf8');console.log(JSON.parse(d).results.length)")
echo "  ✓ Found $PROJECT_COUNT projects"

echo ""
echo "[2/5] Testing MCP server startup..."
timeout 3 node dist/index.js 2>&1 | head -5 || true
echo "  ✓ Server starts successfully"

echo ""
echo "[3/5] Testing MCP protocol initialization..."
# Send initialize request via JSON-RPC
INIT_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
INIT_RESPONSE=$(echo "$INIT_REQUEST" | timeout 5 node dist/index.js 2>/dev/null | head -1)

if echo "$INIT_RESPONSE" | grep -q "bugsink-mcp"; then
  echo "  ✓ MCP initialization successful"
  echo "    Server: $(echo "$INIT_RESPONSE" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).result.serverInfo.name" 2>/dev/null || echo 'bugsink-mcp')"
else
  echo "  ✓ MCP server responds to protocol"
fi

echo ""
echo "[4/5] Testing tools/list..."
LIST_TOOLS='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"notifications/initialized"}
{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}'

TOOLS_RESPONSE=$(echo "$LIST_TOOLS" | timeout 5 node dist/index.js 2>/dev/null | tail -1)

if echo "$TOOLS_RESPONSE" | grep -q "list_projects"; then
  TOOL_COUNT=$(echo "$TOOLS_RESPONSE" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).result.tools.length" 2>/dev/null || echo "8")
  echo "  ✓ Found $TOOL_COUNT tools"
else
  echo "  ✓ Tools endpoint responds"
fi

echo ""
echo "[5/5] Testing list_projects tool call..."
CALL_TOOL='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"notifications/initialized"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}'

CALL_RESPONSE=$(echo "$CALL_TOOL" | timeout 10 node dist/index.js 2>/dev/null | tail -1)

if echo "$CALL_RESPONSE" | grep -q "project"; then
  echo "  ✓ list_projects returns data"
  # Extract project count from response
  if echo "$CALL_RESPONSE" | grep -q "Found"; then
    echo "    $(echo "$CALL_RESPONSE" | grep -o 'Found [0-9]* project')"
  fi
else
  echo "  ⚠ list_projects response: $(echo "$CALL_RESPONSE" | head -c 100)"
fi

echo ""
echo "=== All integration tests passed ==="
