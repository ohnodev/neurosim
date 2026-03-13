#!/bin/bash

# PM2 Manager Script for NeuroSim
# Manages: neurosim-brain (Rust socket service), neurosim-api (Node API)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"
ECOSYSTEM_FILE="$SCRIPT_DIR/ecosystem.config.js"
API_DIR="$SCRIPT_DIR/api"
BRAIN_SERVICE_DIR="$API_DIR/brain-sim-service"
SERVICE="neurosim-api"
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

create_ecosystem_config() {
    log_info "Creating ecosystem config..."
    cat > "$ECOSYSTEM_FILE" << EOF
module.exports = {
  apps: [
    {
      name: '$BRAIN_SERVICE',
      cwd: '$BRAIN_SERVICE_DIR',
      script: 'target/release/brain-service',
      instances: 1,
      autorestart: true,
      watch: false,
      log_file: '$LOGS_DIR/neurosim-brain.log',
      out_file: '/dev/null',
      error_file: '$LOGS_DIR/neurosim-brain.log',
      merge_logs: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: { NEUROSIM_BRAIN_SOCKET: '/tmp/neurosim-brain.sock', USE_CUDA: '1', NEUROSIM_CONNECTOME_PATH: '$SCRIPT_DIR/data/connectome-subset.json' },
    },
    {
      name: '$SERVICE',
      cwd: '$API_DIR',
      script: 'sh',
      args: ['-c', 'export NVM_DIR="\$HOME/.nvm" && [ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh" && nvm use 2>/dev/null; npm start'],
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '10G',
      log_file: '$LOGS_DIR/neurosim-api.log',
      out_file: '/dev/null',
      error_file: '$LOGS_DIR/neurosim-api.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_restarts: 10,
      min_uptime: '10s',
      env_file: '.env',
      env: { NEUROSIM_BRAIN_SOCKET: '/tmp/neurosim-brain.sock' },
    },
  ],
};
EOF
    log_success "Created ecosystem config"
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

service_exists() { pm2 list 2>/dev/null | grep -q "│ $SERVICE" || false; }
brain_exists() { pm2 list 2>/dev/null | grep -q "│ $BRAIN_SERVICE" || false; }

start_service() {
    create_logs_dir
    service_exists && { log_warning "$SERVICE already running"; return 0; }
    log_info "Starting $BRAIN_SERVICE and $SERVICE..."
    pm2 start "$ECOSYSTEM_FILE"
    log_success "Started"
}

stop_service() {
    brain_exists && pm2 stop "$BRAIN_SERVICE" 2>/dev/null || true
    service_exists && pm2 stop "$SERVICE" 2>/dev/null || true
    brain_exists || service_exists || { log_warning "Not running"; return 0; }
    log_success "Stopped"
}

restart_service() {
    create_logs_dir
    log_info "Building $BRAIN_SERVICE (GPU)..."
    (cd "$BRAIN_SERVICE_DIR" && cargo build --release 2>/dev/null) || \
    (cd "$BRAIN_SERVICE_DIR" && cargo build --release --no-default-features 2>/dev/null) || \
    { log_warning "Brain build failed, using existing binary"; }
    log_info "Rebuilding $SERVICE..."
    (cd "$API_DIR" && npm run build) || { log_error "API build failed"; exit 1; }
    log_info "Stopping services..."
    brain_exists && pm2 delete "$BRAIN_SERVICE" 2>/dev/null || true
    service_exists && pm2 delete "$SERVICE" 2>/dev/null || true
    sleep 2
    clean_all_logs
    log_info "Starting $BRAIN_SERVICE (then $SERVICE)..."
    pm2 start "$ECOSYSTEM_FILE"
    sleep 2
    log_success "Restarted"
}

quick_restart_service() {
    log_info "Quick restart (no rebuild)..."
    pm2 restart "$BRAIN_SERVICE" 2>/dev/null || true
    sleep 1
    pm2 restart "$SERVICE" 2>/dev/null || true
    log_success "Restarted"
}

status_service() { pm2 status; }
logs_service() { pm2 logs "$SERVICE" --lines "${1:-50}"; }

init() {
    log_info "Initializing PM2..."
    create_logs_dir
    create_ecosystem_config
    setup_log_rotation
    log_success "PM2 setup done"
}

show_help() {
    echo "PM2 Manager for NeuroSim (brain-service + API)"
    echo "Usage: $0 {init|start|stop|restart|quick-restart|status|logs [N]|clean-logs|help}"
    echo "  restart       - Full restart: build brain+API, stop, start both"
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
