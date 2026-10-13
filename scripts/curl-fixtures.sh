#!/usr/bin/env bash
# Hit the local skill with sample Alexa Launch / Intent payloads.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:43127}"

echo "== GET /health =="
curl -sS "${BASE_URL}/health" | tee /tmp/alexa-cos-health.json
echo

echo "== LaunchRequest → POST /alexa =="
curl -sS -X POST "${BASE_URL}/alexa" \
  -H "Content-Type: application/json" \
  -d @"${ROOT}/fixtures/launch.json" | tee /tmp/alexa-cos-launch.json
echo

echo "== AskIntent → POST /alexa =="
curl -sS -X POST "${BASE_URL}/alexa" \
  -H "Content-Type: application/json" \
  -d @"${ROOT}/fixtures/ask-intent.json" | tee /tmp/alexa-cos-ask.json
echo

echo "== HelpIntent → POST /alexa =="
curl -sS -X POST "${BASE_URL}/alexa" \
  -H "Content-Type: application/json" \
  -d @"${ROOT}/fixtures/help.json" | tee /tmp/alexa-cos-help.json
echo

echo "Done. Responses saved under /tmp/alexa-cos-*.json"
echo "Alexa Developer Console endpoint should be: https://<worker>/alexa"
