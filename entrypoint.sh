#!/bin/bash

set -e

# Process tracking
XVFB_PID=""
APP_PID=""
RESTART_COUNT=0
MAX_RESTARTS=3
RESTART_DELAY=5

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Cleanup function
cleanup() {
    log "Starting cleanup process..."
    
    # Kill application first
    if [ ! -z "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
        log "Stopping application (PID: $APP_PID)..."
        kill -TERM "$APP_PID" 2>/dev/null || true
        
        # Wait for graceful shutdown
        local timeout=30
        local counter=0
        while kill -0 "$APP_PID" 2>/dev/null && [ $counter -lt $timeout ]; do
            sleep 1
            counter=$((counter + 1))
        done
        
        # Force kill if still running
        if kill -0 "$APP_PID" 2>/dev/null; then
            log "Force killing application..."
            kill -KILL "$APP_PID" 2>/dev/null || true
        fi
        
        log "Application stopped"
    fi
    
    # Kill Xvfb
    if [ ! -z "$XVFB_PID" ] && kill -0 "$XVFB_PID" 2>/dev/null; then
        log "Stopping Xvfb (PID: $XVFB_PID)..."
        kill -TERM "$XVFB_PID" 2>/dev/null || true
        sleep 2
        
        # Force kill if still running
        if kill -0 "$XVFB_PID" 2>/dev/null; then
            log "Force killing Xvfb..."
            kill -KILL "$XVFB_PID" 2>/dev/null || true
        fi
        
        log "Xvfb stopped"
    fi
    
    # Clean up any remaining Chromium processes
    log "Cleaning up any remaining browser processes..."
    pkill -f chromium 2>/dev/null || true
    pkill -f chrome 2>/dev/null || true
    
    # Clean up lock files and temp directories
    rm -rf /tmp/.X99-lock 2>/dev/null || true
    rm -rf /tmp/.X11-unix/X99 2>/dev/null || true
    
    log "Cleanup completed"
}

# Signal handlers
handle_term() {
    log "Received SIGTERM signal"
    cleanup
    exit 0
}

handle_int() {
    log "Received SIGINT signal"
    cleanup
    exit 0
}

handle_hup() {
    log "Received SIGHUP signal"
    cleanup
    exit 0
}

# Monitor process function
monitor_process() {
    local pid=$1
    local name=$2
    
    while kill -0 "$pid" 2>/dev/null; do
        sleep 1
    done
    
    log "$name process (PID: $pid) has died"
}

# Start Xvfb with retry logic
start_xvfb() {
    local attempt=1
    local max_attempts=3
    
    while [ $attempt -le $max_attempts ]; do
        log "Starting Xvfb (attempt $attempt/$max_attempts)..."
        
        # Clean up any existing X server
        rm -rf /tmp/.X99-lock 2>/dev/null || true
        rm -rf /tmp/.X11-unix/X99 2>/dev/null || true
        
        # Start Xvfb in background
        Xvfb :99 -screen 0 1024x768x24 -ac -nolisten tcp -dpi 96 > /dev/null 2>&1 &
        XVFB_PID=$!
        
        # Wait for Xvfb to start
        local timeout=30
        local counter=0
        
        while [ $counter -lt $timeout ]; do
            if xdpyinfo -display :99 >/dev/null 2>&1; then
                log "Xvfb started successfully (PID: $XVFB_PID)"
                return 0
            fi
            
            if ! kill -0 "$XVFB_PID" 2>/dev/null; then
                log "Xvfb process died during startup"
                break
            fi
            
            sleep 1
            counter=$((counter + 1))
        done
        
        log "Xvfb failed to start (attempt $attempt/$max_attempts)"
        
        # Clean up failed attempt
        if [ ! -z "$XVFB_PID" ] && kill -0 "$XVFB_PID" 2>/dev/null; then
            kill -KILL "$XVFB_PID" 2>/dev/null || true
        fi
        
        attempt=$((attempt + 1))
        
        if [ $attempt -le $max_attempts ]; then
            log "Waiting before retry..."
            sleep 5
        fi
    done
    
    log "Failed to start Xvfb after $max_attempts attempts"
    return 1
}

# Start application with monitoring
start_application() {
    log "Starting application..."
    
    # Set environment variables
    export DISPLAY=:99
    export NODE_ENV=production
    
    # Start the application in background
    bun run start &
    APP_PID=$!
    
    log "Application started (PID: $APP_PID)"
    
    # Monitor both processes
    {
        monitor_process "$XVFB_PID" "Xvfb"
        kill -TERM "$APP_PID" 2>/dev/null || true
    } &
    
    {
        monitor_process "$APP_PID" "Application"
        kill -TERM "$XVFB_PID" 2>/dev/null || true
    } &
    
    # Wait for application to finish
    wait "$APP_PID"
    local exit_code=$?
    
    log "Application exited with code $exit_code"
    return $exit_code
}

# Main restart loop
main() {
    log "MapLibre GL Renderer container starting..."
    
    # Register signal handlers
    trap handle_term SIGTERM
    trap handle_int SIGINT
    trap handle_hup SIGHUP
    
    while [ $RESTART_COUNT -le $MAX_RESTARTS ]; do
        log "Starting services (attempt $((RESTART_COUNT + 1))/$((MAX_RESTARTS + 1)))..."
        
        # Start Xvfb
        if ! start_xvfb; then
            log "Failed to start Xvfb, aborting"
            cleanup
            exit 1
        fi
        
        # Start application
        if start_application; then
            log "Application exited normally"
            cleanup
            exit 0
        else
            local exit_code=$?
            log "Application crashed with exit code $exit_code"
            
            # Clean up before potential restart
            cleanup
            XVFB_PID=""
            APP_PID=""
            
            # Check if we should restart
            if [ $RESTART_COUNT -lt $MAX_RESTARTS ]; then
                RESTART_COUNT=$((RESTART_COUNT + 1))
                log "Restarting in $RESTART_DELAY seconds... (restart $RESTART_COUNT/$MAX_RESTARTS)"
                sleep $RESTART_DELAY
            else
                log "Maximum restart attempts ($MAX_RESTARTS) reached. Exiting."
                exit 1
            fi
        fi
    done
}

# Health check function for Docker
health_check() {
    if [ "$1" = "health" ]; then
        # Check if processes are running
        if [ ! -z "$XVFB_PID" ] && kill -0 "$XVFB_PID" 2>/dev/null && \
           [ ! -z "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
            exit 0
        else
            exit 1
        fi
    fi
}

# Check if called for health check
health_check "$1"

# Start main process
main