#!/bin/bash

# PM2 Manager Script for NeuroSim API
# Manages: neurosim-api

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"
ECOSYSTEM_FILE="$SCRIPT_DIR/ecosystem.config.js"
API_DIR="$SCRIPT_DIR/api"
SERVICE="neurosim-api"

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

clean_service_logs() {
    log_info "Cleaning logs for $SERVICE..."
    rm -f "$LOGS_DIR/$SERVICE-out-"*.log "$LOGS_DIR/$SERVICE-error-"*.log 2>/dev/null || true
    rm -f "$LOGS_DIR/$SERVICE-out.log" "$LOGS_DIR/$SERVICE-error.log" 2>/dev/null || true
    log_success "Cleaned logs"
}

create_ecosystem_config() {
    log_info "Creating ecosystem config..."
    cat > "$ECOSYSTEM_FILE" << EOF
module.exports = {
  apps: [{
    name: '$SERVICE',
    cwd: '$API_DIR',
    script: 'sh',
    args: ['-c', 'export NVM_DIR="\$HOME/.nvm" && [ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh" && nvm use 2>/dev/null; npm run build && npm start'],
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    out_file: '$LOGS_DIR/$SERVICE-out.log',
    error_file: '$LOGS_DIR/$SERVICE-error.log',
    combine_logs: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_restarts: 10,
    min_uptime: '10s',
    env_file: '.env'
  }]
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

start_service() {
    create_logs_dir
    service_exists && { log_warning "$SERVICE already running"; return 0; }
    log_info "Starting $SERVICE..."
    pm2 start "$ECOSYSTEM_FILE" --only "$SERVICE"
    log_success "Started"
}

stop_service() {
    service_exists || { log_warning "Not running"; return 0; }
    pm2 stop "$SERVICE"
    log_success "Stopped"
}

restart_service() {
    create_logs_dir
    clean_service_logs
    service_exists && pm2 delete "$SERVICE" 2>/dev/null || true
    pm2 start "$ECOSYSTEM_FILE" --only "$SERVICE"
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
    echo "PM2 Manager for NeuroSim API"
    echo "Usage: $0 {init|start|stop|restart|status|logs [N]|clean-logs|help}"
}

case "${1:-help}" in
    init) init ;;
    start) start_service ;;
    stop) stop_service ;;
    restart) restart_service ;;
    status) status_service ;;
    logs) logs_service "$2" ;;
    clean-logs) clean_service_logs ;;
    *) show_help ;;
esac
