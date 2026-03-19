#!/bin/bash

# PM2 Manager Script for NeuroSim
# Manages: neurosim-brain (Rust socket service), neurosim-api (Node API)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"
ECOSYSTEM_FILE="$SCRIPT_DIR/ecosystem.config.js"
API_DIR="$SCRIPT_DIR/api"
BRAIN_DIR="$API_DIR/brain-sim-service"
API_SERVICE="neurosim-api"
BRAIN_SERVICE="neurosim-brain"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

create_logs_dir() {
    [ -d "$LOGS_DIR" ] || { mkdir -p "$LOGS_DIR"; log_info "Created $LOGS_DIR"; }
}

clean_all_logs() {
    log_info "Cleaning all logs..."
    find "$LOGS_DIR" -maxdepth 1 -type f -name "*.log" -delete 2>/dev/null || true
    find "$LOGS_DIR" -maxdepth 1 -type f -name "*.gz" -delete 2>/dev/null || true
    log_success "Cleaned all logs"
}

setup_log_rotation() {
    pm2 list 2>/dev/null | grep -q "pm2-logrotate" || pm2 install pm2-logrotate
    pm2 set pm2-logrotate:max_size 10M
    pm2 set pm2-logrotate:retain 2
    pm2 set pm2-logrotate:compress false
    pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
    pm2 set pm2-logrotate:workerInterval 30
    pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
    pm2 set pm2-logrotate:rotateModule true
    log_success "Log rotation configured"
}

pm2_is_online() {
    local svc="$1"
    if command -v jq >/dev/null 2>&1; then
        pm2 jlist 2>/dev/null | jq -e --arg n "$svc" '.[] | select(.name == $n and .pm2_env.status == "online")' >/dev/null 2>&1
    else
        # Fallback when jq is unavailable.
        pm2 list 2>/dev/null | grep -q "│ $svc" || false
    fi
}

api_exists() { pm2_is_online "$API_SERVICE"; }
brain_exists() { pm2_is_online "$BRAIN_SERVICE"; }
python_brain_exists() { pm2_is_online "python-brain"; }

ensure_ecosystem_file() {
    [ -f "$ECOSYSTEM_FILE" ] || { log_error "Missing ecosystem file: $ECOSYSTEM_FILE"; exit 1; }
}

start_service() {
    create_logs_dir
    ensure_ecosystem_file
    if brain_exists && api_exists; then
        log_warning "$BRAIN_SERVICE and $API_SERVICE already running"
        return 0
    fi
    python_brain_exists && pm2 delete "python-brain" 2>/dev/null || true
    log_info "Starting $BRAIN_SERVICE and $API_SERVICE..."
    pm2 start "$ECOSYSTEM_FILE" --only "$BRAIN_SERVICE,$API_SERVICE"
    log_success "Started"
}

stop_service() {
    local had_online=0
    python_brain_exists && pm2 stop "python-brain" 2>/dev/null || true
    if brain_exists; then had_online=1; pm2 stop "$BRAIN_SERVICE" 2>/dev/null || true; fi
    if api_exists; then had_online=1; pm2 stop "$API_SERVICE" 2>/dev/null || true; fi
    if [ "$had_online" -eq 0 ]; then
        log_warning "Not running"
        return 0
    fi
    log_success "Stopped"
}

restart_service() {
    create_logs_dir
    ensure_ecosystem_file
    log_info "Rebuilding $BRAIN_SERVICE..."
    (cd "$BRAIN_DIR" && cargo build --release) || { log_error "Rust brain build failed"; exit 1; }
    log_info "Rebuilding $API_SERVICE..."
    (cd "$API_DIR" && npm run build) || { log_error "API build failed"; exit 1; }
    log_info "Stopping services..."
    python_brain_exists && pm2 delete "python-brain" 2>/dev/null || true
    brain_exists && pm2 delete "$BRAIN_SERVICE" 2>/dev/null || true
    api_exists && pm2 delete "$API_SERVICE" 2>/dev/null || true
    sleep 2
    clean_all_logs
    log_info "Starting $BRAIN_SERVICE and $API_SERVICE..."
    pm2 start "$ECOSYSTEM_FILE" --only "$BRAIN_SERVICE,$API_SERVICE"
    sleep 2
    log_success "Restarted"
}

quick_restart_service() {
    log_info "Quick restart (no rebuild)..."
    python_brain_exists && pm2 delete "python-brain" 2>/dev/null || true
    pm2 restart "$BRAIN_SERVICE" 2>/dev/null || true
    sleep 1
    pm2 restart "$API_SERVICE" 2>/dev/null || true
    log_success "Restarted"
}

status_service() { pm2 status; }
logs_service() { pm2 logs "$API_SERVICE" --lines "${1:-50}"; }

init() {
    log_info "Initializing PM2..."
    create_logs_dir
    ensure_ecosystem_file
    python_brain_exists && pm2 delete "python-brain" 2>/dev/null || true
    setup_log_rotation
    log_success "PM2 setup done"
}

show_help() {
    echo "PM2 Manager for NeuroSim (Rust brain + API)"
    echo "Usage: $0 {init|start|stop|restart|quick-restart|status|logs [N]|clean-logs|help}"
    echo "  restart       - Full restart: build Rust brain+API, stop, start both"
    echo "  quick-restart - Restart both without rebuild"
}

case "${1:-help}" in
    init) init ;;
    start) start_service ;;
    stop) stop_service ;;
    restart) restart_service ;;
    quick-restart) quick_restart_service ;;
    status) status_service ;;
    logs) logs_service "$2" ;;
    clean-logs) clean_all_logs ;;
    *) show_help ;;
esac
