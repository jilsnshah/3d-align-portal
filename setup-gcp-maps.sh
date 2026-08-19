#!/usr/bin/env bash
# Creates a Google Cloud project for 3D Align and issues a restricted Maps key.
#
# Steps 1 and 2 need a human: an interactive browser login, and a billing
# account with a payment method on it. Everything after that is automated.
#
#   ./setup-gcp-maps.sh
#
# The key is written straight to backend/.env and never printed.

set -euo pipefail

GCLOUD="${GCLOUD:-gcloud}"
PROJECT_ID="${PROJECT_ID:-align-maps-$(date +%s | tail -c 6)}"
PROJECT_NAME="3D Align Maps"
SERVER_KEY_NAME="3d-align-server"
BROWSER_KEY_NAME="3d-align-browser"
# Domains allowed to load the interactive map. Add the production host here.
ALLOWED_REFERRERS="${ALLOWED_REFERRERS:-http://localhost:5173/*,http://127.0.0.1:5173/*}"
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/backend/.env"

command -v "$GCLOUD" >/dev/null || { echo "gcloud not on PATH. Set GCLOUD=/path/to/gcloud"; exit 1; }

# 1. Who are you (opens a browser)
"$GCLOUD" auth list --format="value(account)" | grep -q . || "$GCLOUD" auth login

# 2. Which billing account pays for this
BILLING=$("$GCLOUD" billing accounts list --filter=open=true --format="value(name)" --limit=1)
if [ -z "$BILLING" ]; then
  echo "No open billing account found."
  echo "Create one at https://console.cloud.google.com/billing then re-run."
  exit 1
fi

# 3. Project
"$GCLOUD" projects create "$PROJECT_ID" --name="$PROJECT_NAME"
"$GCLOUD" billing projects link "$PROJECT_ID" --billing-account="$BILLING"
"$GCLOUD" config set project "$PROJECT_ID"

# 4. Only the APIs the portal actually calls.
#    Routes gives traffic-aware durations; Maps JavaScript draws the lab's
#    interactive route map in the browser.
"$GCLOUD" services enable \
  routes.googleapis.com \
  geocoding-backend.googleapis.com \
  maps-backend.googleapis.com \
  --project="$PROJECT_ID"

# 5. Two keys, because they have different exposure.
#
#    The server key is called only from the backend and must never reach a
#    browser. Add --allowed-ips once the production egress IP is known; until
#    then it is unrestricted by IP, so treat it as a secret.
#
#    The browser key is embedded in the page by design — that is how the Maps
#    JavaScript API works — so it is restricted by HTTP referrer instead, which
#    is what stops someone else's site billing your project.
"$GCLOUD" services api-keys create \
  --display-name="$SERVER_KEY_NAME" \
  --api-target=service=routes.googleapis.com \
  --api-target=service=geocoding-backend.googleapis.com \
  --project="$PROJECT_ID"

"$GCLOUD" services api-keys create \
  --display-name="$BROWSER_KEY_NAME" \
  --api-target=service=maps-backend.googleapis.com \
  --allowed-referrers="$ALLOWED_REFERRERS" \
  --project="$PROJECT_ID"

key_string_for() {
  local uid
  uid=$("$GCLOUD" services api-keys list --project="$PROJECT_ID" \
    --filter="displayName=$1" --format="value(uid)" --limit=1)
  "$GCLOUD" services api-keys get-key-string "$uid" \
    --project="$PROJECT_ID" --format="value(keyString)"
}

# 6. Straight into .env, never onto the terminal
write_env() {
  local name="$1" value="$2"
  if grep -q "^${name}=" "$ENV_FILE"; then
    # macOS sed needs the empty -i argument
    sed -i '' "s|^${name}=.*|${name}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
  fi
}

touch "$ENV_FILE"
write_env GOOGLE_MAPS_API_KEY "$(key_string_for "$SERVER_KEY_NAME")"
write_env GOOGLE_MAPS_BROWSER_KEY "$(key_string_for "$BROWSER_KEY_NAME")"

echo
echo "Project:  $PROJECT_ID"
echo "Billing:  $BILLING"
echo "Both keys written to backend/.env (not printed here)."
echo "Browser key referrers: $ALLOWED_REFERRERS"
echo "  -> re-run with ALLOWED_REFERRERS=\"https://your-domain/*\" before going live"
echo
echo "Next: restart the API, then  .venv/bin/python regeocode.py"
