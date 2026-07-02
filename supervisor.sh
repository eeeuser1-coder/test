#!/usr/bin/env bash
# 守护脚本 — 监控代理服务和 Cloudflare 隧道，自动重启崩溃进程
# 用法:
#   supervisor.sh          — 前台启动守护进程
#   supervisor.sh daemon   — 后台启动守护进程（setsid 独立会话）
#   supervisor.sh status   — 查看运行状态
#   supervisor.sh stop     — 停止守护进程及所有子进程

PROXY_SCRIPT="/workspace/test/proxy.mjs"
PROXY_PORT="${PROXY_PORT:-8080}"
LOG_DIR="/tmp/supervisor"
PROXY_LOG="${LOG_DIR}/proxy.log"
TUNNEL_LOG="${LOG_DIR}/tunnel.log"
SUPERVISOR_LOG="${LOG_DIR}/supervisor.log"
PIDFILE_PROXY="${LOG_DIR}/proxy.pid"
PIDFILE_TUNNEL="${LOG_DIR}/tunnel.pid"
PIDFILE_SUPER="${LOG_DIR}/supervisor.pid"
TUNNEL_URL_FILE="${LOG_DIR}/tunnel_url"
HEALTH_INTERVAL=5
RESTART_DELAY=2
MAX_RAPID_RESTARTS=10
RAPID_WINDOW=60

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$SUPERVISOR_LOG"
}

read_pid() {
  local f="$1"
  [ -f "$f" ] && cat "$f" 2>/dev/null || echo ""
}

pid_alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

# ── status 子命令 ────────────────────────────────────────────────────────────
cmd_status() {
  echo "=== 守护进程状态 ==="
  local spid; spid=$(read_pid "$PIDFILE_SUPER")
  if pid_alive "$spid"; then
    echo "守护进程:     运行中 (PID: $spid)"
  else
    echo "守护进程:     未运行"
  fi

  local ppid; ppid=$(read_pid "$PIDFILE_PROXY")
  if pid_alive "$ppid"; then
    echo "代理服务:     运行中 (PID: $ppid)"
  else
    echo "代理服务:     已停止"
  fi

  local tpid; tpid=$(read_pid "$PIDFILE_TUNNEL")
  if pid_alive "$tpid"; then
    echo "Cloudflare:   运行中 (PID: $tpid)"
  else
    echo "Cloudflare:   已停止"
  fi

  if [ -f "$TUNNEL_URL_FILE" ]; then
    echo "公网端点:     $(cat "$TUNNEL_URL_FILE")"
  fi

  echo ""
  echo "=== 最近日志 ==="
  tail -15 "$SUPERVISOR_LOG" 2>/dev/null || echo "(无日志)"
}

# ── stop 子命令 ──────────────────────────────────────────────────────────────
cmd_stop() {
  local spid; spid=$(read_pid "$PIDFILE_SUPER")
  if pid_alive "$spid"; then
    echo "正在停止守护进程 (PID: $spid)..."
    kill "$spid" 2>/dev/null
    sleep 2
    pid_alive "$spid" && kill -9 "$spid" 2>/dev/null
    echo "已停止"
  else
    echo "守护进程未运行，清理残留子进程..."
  fi
  local ppid; ppid=$(read_pid "$PIDFILE_PROXY")
  pid_alive "$ppid" && kill "$ppid" 2>/dev/null
  local tpid; tpid=$(read_pid "$PIDFILE_TUNNEL")
  pid_alive "$tpid" && kill "$tpid" 2>/dev/null
  sleep 1
  pid_alive "$ppid" && kill -9 "$ppid" 2>/dev/null
  pid_alive "$tpid" && kill -9 "$tpid" 2>/dev/null
  rm -f "$PIDFILE_PROXY" "$PIDFILE_TUNNEL" "$PIDFILE_SUPER"
  echo "清理完成"
}

# ── daemon 子命令：用 setsid 启动独立会话 ────────────────────────────────────
cmd_daemon() {
  local spid; spid=$(read_pid "$PIDFILE_SUPER")
  if pid_alive "$spid"; then
    echo "守护进程已在运行 (PID: $spid)"
    return 0
  fi
  setsid bash "$0" </dev/null >>"$SUPERVISOR_LOG" 2>&1 &
  disown 2>/dev/null || true
  sleep 2
  spid=$(read_pid "$PIDFILE_SUPER")
  if pid_alive "$spid"; then
    echo "守护进程已启动 (PID: $spid)"
  else
    echo "守护进程启动失败，请检查 $SUPERVISOR_LOG"
  fi
}

# ── 路由子命令 ───────────────────────────────────────────────────────────────
case "${1:-run}" in
  status) cmd_status; exit 0 ;;
  stop)   cmd_stop;   exit 0 ;;
  daemon) cmd_daemon; exit 0 ;;
  run)    ;; # 继续进入主循环
  *)      echo "用法: $0 {run|daemon|status|stop}"; exit 1 ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# 以下为主守护循环（仅 run 模式进入）
# ══════════════════════════════════════════════════════════════════════════════

PROXY_PID=""
TUNNEL_PID=""
PROXY_RESTARTS=0
TUNNEL_RESTARTS=0
RESTART_TIMESTAMPS=()

cleanup() {
  log "[SUPERVISOR] 收到退出信号，正在停止子进程..."
  pid_alive "$PROXY_PID" && kill "$PROXY_PID" 2>/dev/null
  pid_alive "$TUNNEL_PID" && kill "$TUNNEL_PID" 2>/dev/null
  sleep 1
  pid_alive "$PROXY_PID" && kill -9 "$PROXY_PID" 2>/dev/null
  pid_alive "$TUNNEL_PID" && kill -9 "$TUNNEL_PID" 2>/dev/null
  rm -f "$PIDFILE_PROXY" "$PIDFILE_TUNNEL" "$PIDFILE_SUPER"
  log "[SUPERVISOR] 已停止"
  exit 0
}

trap cleanup SIGTERM SIGINT

start_proxy() {
  if pid_alive "$PROXY_PID"; then return 0; fi
  log "[PROXY] 启动代理服务..."
  node "$PROXY_SCRIPT" >> "$PROXY_LOG" 2>&1 &
  PROXY_PID=$!
  echo "$PROXY_PID" > "$PIDFILE_PROXY"
  sleep 1
  if pid_alive "$PROXY_PID"; then
    PROXY_RESTARTS=$((PROXY_RESTARTS + 1))
    log "[PROXY] 启动成功 (PID: $PROXY_PID, 累计启动: $PROXY_RESTARTS)"
  else
    log "[PROXY] 启动失败！"
    PROXY_PID=""
  fi
}

start_tunnel() {
  if pid_alive "$TUNNEL_PID"; then return 0; fi
  log "[TUNNEL] 启动 Cloudflare 隧道..."
  > "$TUNNEL_LOG"
  cloudflared tunnel --url "http://localhost:${PROXY_PORT}" >> "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  echo "$TUNNEL_PID" > "$PIDFILE_TUNNEL"
  sleep 2
  if pid_alive "$TUNNEL_PID"; then
    TUNNEL_RESTARTS=$((TUNNEL_RESTARTS + 1))
    log "[TUNNEL] 启动成功 (PID: $TUNNEL_PID, 累计启动: $TUNNEL_RESTARTS)"
  else
    log "[TUNNEL] 启动失败！"
    TUNNEL_PID=""
  fi
}

try_extract_url() {
  local url
  url=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1)
  if [ -n "$url" ]; then
    local old_url=""
    [ -f "$TUNNEL_URL_FILE" ] && old_url=$(cat "$TUNNEL_URL_FILE")
    if [ "$url" != "$old_url" ]; then
      echo "$url" > "$TUNNEL_URL_FILE"
      log "[TUNNEL] 公网端点: $url"
    fi
  fi
}

check_throttle() {
  local now; now=$(date +%s)
  local fresh=()
  for ts in "${RESTART_TIMESTAMPS[@]}"; do
    if [ $((now - ts)) -lt "$RAPID_WINDOW" ]; then
      fresh+=("$ts")
    fi
  done
  RESTART_TIMESTAMPS=("${fresh[@]}" "$now")
  if [ ${#RESTART_TIMESTAMPS[@]} -ge "$MAX_RAPID_RESTARTS" ]; then
    return 1
  fi
  return 0
}

# ── 写入 PID，启动主循环 ────────────────────────────────────────────────────
echo $$ > "$PIDFILE_SUPER"
log "============================================"
log "[SUPERVISOR] 进程守护启动 (PID: $$)"
log "[SUPERVISOR] 健康检查间隔: ${HEALTH_INTERVAL}s"
log "[SUPERVISOR] 快速重启保护: ${RAPID_WINDOW}s 内最多 ${MAX_RAPID_RESTARTS} 次"
log "============================================"

start_proxy
start_tunnel

TICK=0
while true; do
  sleep "$HEALTH_INTERVAL" &
  wait $! 2>/dev/null || true

  # 代理健康检查
  if ! pid_alive "$PROXY_PID"; then
    log "[WATCH] 代理服务 (PID: $PROXY_PID) 已退出"
    if check_throttle; then
      sleep "$RESTART_DELAY"
      start_proxy
    else
      log "[FATAL] 重启过于频繁，守护退出"
      cleanup
    fi
  fi

  # 隧道健康检查
  if ! pid_alive "$TUNNEL_PID"; then
    log "[WATCH] Cloudflare 隧道 (PID: $TUNNEL_PID) 已退出"
    if check_throttle; then
      sleep "$RESTART_DELAY"
      start_tunnel
    else
      log "[FATAL] 重启过于频繁，守护退出"
      cleanup
    fi
  fi

  # 异步提取隧道 URL
  try_extract_url

  # 每 60s 心跳
  TICK=$((TICK + 1))
  if [ $((TICK % 12)) -eq 0 ]; then
    log "[HEARTBEAT] 代理=$PROXY_PID 隧道=$TUNNEL_PID | 重启: 代理=${PROXY_RESTARTS} 隧道=${TUNNEL_RESTARTS}"
  fi
done
