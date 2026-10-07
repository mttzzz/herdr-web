#!/usr/bin/env bash
# herdr-web control script. Single entry point for the herdr actions and for manual use.
#
#   web-ctl.sh start|stop|status|url|open
#
# Herdr injects HERDR_BIN_PATH, HERDR_PLUGIN_STATE_DIR, HERDR_PLUGIN_CONFIG_DIR and
# HERDR_PLUGIN_CONTEXT_JSON; every one of them has a sane fallback so the script also
# works from a plain shell.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
HERDR_BIN="${HERDR_BIN_PATH:-herdr}"
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr/plugins/herdr-web}"
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr/plugins/config/herdr-web}"
mkdir -p "$STATE_DIR"

if [ -f "$CONFIG_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$CONFIG_DIR/.env"
  set +a
fi

PORT="${HERDR_WEB_PORT:-8793}"
HOST="${HERDR_WEB_HOST:-127.0.0.1}"
BASE="http://${HOST/0.0.0.0/127.0.0.1}:$PORT"
PIDFILE="$STATE_DIR/server.pid"
LOG="$STATE_DIR/server.log"
TOKEN_FILE="${HERDR_WEB_TOKEN_FILE:-$STATE_DIR/token}"

# Herdr's injected environment is the only hint about which context asked; keep the last
# invocation on disk so a misfiring keybinding can be diagnosed without instrumenting anything.
printenv | sed -n '/^HERDR_/p' >"$STATE_DIR/last-invocation.env" 2>/dev/null || true

BUN="${HERDR_WEB_BUN:-}"
if [ -z "$BUN" ]; then
  BUN="$(command -v bun 2>/dev/null || true)"
  [ -n "$BUN" ] || BUN="$HOME/.bun/bin/bun"
fi

die() {
  echo "herdr-web: $*" >&2
  exit 1
}

healthy() {
  curl -fsS -m 2 "$BASE/health" >/dev/null 2>&1
}

read_token() {
  [ -f "$TOKEN_FILE" ] && tr -d '[:space:]' <"$TOKEN_FILE" || true
}

lan_ip() {
  local ip
  # Linux: the source address of the default route.
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
  # macOS
  [ -n "$ip" ] || ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  printf '%s' "$ip"
}

cmd_start() {
  if healthy; then
    echo "already running: $BASE"
    return 0
  fi
  [ -x "$BUN" ] || command -v "$BUN" >/dev/null 2>&1 || die "bun not found (set HERDR_WEB_BUN)"
  HERDR_WEB_PORT="$PORT" HERDR_WEB_HOST="$HOST" HERDR_WEB_STATE_DIR="$STATE_DIR" \
    HERDR_WEB_TOKEN_FILE="$TOKEN_FILE" HERDR_BIN_PATH="$HERDR_BIN" \
    nohup "$BUN" run "$ROOT/server/server.ts" >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  for _ in $(seq 1 40); do
    if healthy; then
      echo "started: $BASE"
      return 0
    fi
    sleep 0.25
  done
  die "server did not come up; see $LOG"
}

cmd_stop() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid="$(cat "$PIDFILE")"
    kill "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  # Anything else still holding the port (stale run, manual launch).
  local held
  held="$(command -v lsof >/dev/null 2>&1 && lsof -ti "tcp:$PORT" 2>/dev/null || true)"
  [ -n "$held" ] && kill $held 2>/dev/null || true
  echo "stopped"
}

cmd_status() {
  if healthy; then
    curl -fsS -m 2 "$BASE/health"
    echo
    print_urls
  else
    echo "not running ($BASE)"
  fi
}

print_urls() {
  # HERDR_WEB_AUTH=off: the server checks neither a query token nor a cookie, so the URL is
  # printed bare — with ?token=… it would only mislead.
  local t q
  t="$(read_token)"
  if [ "${HERDR_WEB_AUTH:-token}" = "off" ]; then
    q=""
  else
    [ -n "$t" ] || return 0
    q="?token=$t"
  fi
  echo "local: http://127.0.0.1:$PORT/$q"
  if [ "$HOST" = "0.0.0.0" ]; then
    local lan
    lan="$(lan_ip)"
    [ -n "$lan" ] && echo "lan:   http://$lan:$PORT/$q"
  else
    echo "(LAN access disabled; set HERDR_WEB_HOST=0.0.0.0 in $CONFIG_DIR/.env to allow phone/iPad)"
  fi
}

copy_clip() {
  local url="$1"
  if [ -x /mnt/c/Windows/System32/clip.exe ]; then
    printf '%s' "$url" | /mnt/c/Windows/System32/clip.exe >/dev/null 2>&1 || true
    return 0
  fi
  for c in wl-copy pbcopy; do
    if command -v "$c" >/dev/null 2>&1; then
      printf '%s' "$url" | "$c" >/dev/null 2>&1 || true
      return 0
    fi
  done
  if command -v xclip >/dev/null 2>&1; then
    printf '%s' "$url" | xclip -selection clipboard >/dev/null 2>&1 || true
  fi
}

open_browser() {
  [ "${HERDR_WEB_OPEN:-1}" = "1" ] || return 0
  local url="$1"
  for opener in wslview xdg-open open; do
    if command -v "$opener" >/dev/null 2>&1; then
      setsid "$opener" "$url" >/dev/null 2>&1 &
      return 0
    fi
  done
  [ -x /mnt/c/Windows/explorer.exe ] && /mnt/c/Windows/explorer.exe "$url" >/dev/null 2>&1 || true
}

announce() {
  local url="$1" label="${2:-open in browser}"
  printf '%s\n' "$url"
  # OSC-8: herdr passes it through, so the line is ctrl-clickable in a capable terminal.
  printf '\033]8;;%s\033\\%s\033]8;;\033\\\n' "$url" "$label"
  "$HERDR_BIN" notification show "herdr web" --body "$url" --position top-right >/dev/null 2>&1 || true
}

cmd_open() {
  cmd_start
  # With HERDR_WEB_AUTH=off the server has no token (and checks none): the URL goes bare.
  local q=""
  if [ "${HERDR_WEB_AUTH:-token}" != "off" ]; then
    local t
    t="$(read_token)"
    [ -n "$t" ] || die "token file missing: $TOKEN_FILE"
    q="?token=$t"
  fi
  local local_url="http://127.0.0.1:$PORT/$q"
  local share_url="$local_url"
  if [ "$HOST" = "0.0.0.0" ]; then
    local lan
    lan="$(lan_ip)"
    [ -n "$lan" ] && share_url="http://$lan:$PORT/$q"
  fi
  print_urls
  # Clipboard gets the shareable URL (LAN when bound to 0.0.0.0, local otherwise);
  # the browser on this machine always opens the local one.
  copy_clip "$share_url"
  announce "$share_url" "web mirror"
  open_browser "$local_url"
}

case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  url) print_urls ;;
  open) cmd_open ;;
  *) die "usage: web-ctl.sh start|stop|status|url|open" ;;
esac
