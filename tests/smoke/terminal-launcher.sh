#!/usr/bin/env bash
set -euo pipefail

# Simple smoke test for terminal launcher behavior.
# It does NOT run pi or IPC; it only checks whether a terminal can be spawned
# and execute a basic shell command.
#
# Usage:
#   PI_TERMINAL=foot bash scripts/test-launcher.sh
#   PI_TERMINAL=xterm bash scripts/test-launcher.sh
#
# Optional:
#   TEST_TITLE="pi launcher smoke" PI_TERMINAL=foot bash scripts/test-launcher.sh
#   TEST_CWD=/tmp PI_TERMINAL=foot bash scripts/test-launcher.sh

APP="${PI_TERMINAL:-}"
TITLE="${TEST_TITLE:-pi-launcher-smoke}"
CWD="${TEST_CWD:-$(pwd)}"

if [[ -z "$APP" ]]; then
  echo "[error] PI_TERMINAL is not set"
  echo "Example: PI_TERMINAL=foot bash scripts/test-launcher.sh"
  exit 1
fi

if [[ ! -d "$CWD" ]]; then
  echo "[error] TEST_CWD does not exist: $CWD"
  exit 1
fi

CMD='sh -lc '\''echo "[launcher-test] started"; echo "terminal=$PI_TERMINAL"; echo "cwd=$(pwd)"; echo "shell=$SHELL"; echo "pid=$$"; sleep 6; echo "[launcher-test] done"'\'''

echo "[info] app=$APP"
echo "[info] title=$TITLE"
echo "[info] cwd=$CWD"

spawn_detached() {
  local bin="$1"
  shift
  (
    cd "$CWD"
    "$bin" "$@" >/dev/null 2>&1 &
    echo $! > /tmp/pi-launcher-test.pid
  )
}

case "$APP" in
  gnome-terminal)
    spawn_detached gnome-terminal --title "$TITLE" --working-directory "$CWD" -- sh -c "$CMD"
    ;;
  xterm)
    spawn_detached xterm -title "$TITLE" -e sh -c "$CMD"
    ;;
  foot)
    spawn_detached foot --title "$TITLE" sh -c "$CMD"
    ;;
  terminal)
    # macOS Terminal.app
    osascript -e "tell application \"Terminal\" to do script \"cd '$CWD' && $CMD\"" >/dev/null 2>&1
    ;;
  iterm)
    # macOS iTerm2
    osascript -e "tell application \"iTerm\" to create window with default profile command \"cd '$CWD' && $CMD\"" >/dev/null 2>&1
    ;;
  wt)
    spawn_detached wt --title "$TITLE" --startingDirectory "$CWD" cmd /c "$CMD"
    ;;
  *)
    # Generic fallback: <app> -e sh -c <cmd>
    spawn_detached "$APP" -e sh -c "$CMD"
    ;;
esac

if [[ -f /tmp/pi-launcher-test.pid ]]; then
  PID="$(cat /tmp/pi-launcher-test.pid || true)"
  rm -f /tmp/pi-launcher-test.pid
  if [[ -n "${PID:-}" ]]; then
    echo "[ok] Spawned terminal process pid=$PID"
    echo "[ok] If a window appeared and stayed alive ~6s, launcher works."
    exit 0
  fi
fi

echo "[ok] Launch command dispatched (PID unavailable for this terminal type)."
echo "[ok] If a window appeared and stayed alive ~6s, launcher works."
