#!/data/data/com.termux/files/usr/bin/sh
# pi-relay 启动/重启：WS 桥进程（:8346）。日志 logs/pi-relay.log
P="$HOME/pi-relay/pi-relay.mjs"
export PATH="$HOME/.pi/agent/bin:/data/data/com.termux/files/usr/bin:$PATH"

for pid in $(pgrep -f "node .*$P"); do kill "$pid" 2>/dev/null; done
sleep 1
cd "$HOME/pi-relay" || exit 1
PI_RELAY_QUIET=1 setsid nohup node "$P" >> "$HOME/pi-relay/logs/pi-relay.log" 2>&1 < /dev/null &
sleep 1.5
if pgrep -f "node .*$P" > /dev/null; then
  echo "pi-relay running: pid=$(pgrep -f "node .*$P" | tr '\n' ' ')"
  curl -s --max-time 3 "http://127.0.0.1:8346/health" || echo "(health check failed)"
  echo
else
  echo "pi-relay failed to start; tail of log:"
  tail -20 "$HOME/pi-relay/logs/pi-relay.log"
  exit 1
fi
