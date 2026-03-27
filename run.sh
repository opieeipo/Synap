#!/usr/bin/env bash
# Launch Synap locally
# Usage: ./run.sh [config_file]
# Examples:
#   ./run.sh                          # Opens with default config (configs/sample.json)
#   ./run.sh configs/my-study.json    # Opens with a specific config

PORT=8000
CONFIG="${1:-}"
URL="http://localhost:${PORT}"

if [ -n "$CONFIG" ]; then
  URL="${URL}?config=${CONFIG}"
fi

echo "Starting Synap on ${URL}"
echo "Press Ctrl+C to stop"
echo ""

# Open browser after a short delay to let the server start
(sleep 1 && open "$URL") &

python3 -m http.server "$PORT"
