#!/bin/bash

# Start Xvfb
Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &

# Wait for Xvfb to start
until xdpyinfo -display :99 >/dev/null 2>&1; do
    echo "Waiting for Xvfb..."
    sleep 1
done

# Function to handle cleanup on exit
cleanup() {
    echo "Shutting down services..."
    
    # Find and kill Xvfb process
    if pgrep Xvfb > /dev/null; then
        echo "Stopping Xvfb..."
        pkill Xvfb
    fi
    
    exit 0
}

# Register the cleanup function for these signals
trap cleanup SIGTERM SIGINT SIGHUP

# Run the application
exec bun run start
