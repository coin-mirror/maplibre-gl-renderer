#!/bin/bash

# Start Xvfb
Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &

# Wait for Xvfb to start with timeout
timeout=60
counter=0
until xdpyinfo -display :99 >/dev/null 2>&1; do
    if [ $counter -ge $timeout ]; then
        echo "Error: Xvfb failed to start within $timeout seconds"
        cleanup
        exit 1
    fi

    echo "Waiting for Xvfb... ($counter/$timeout)"
    sleep 1
    counter=$((counter + 1))
done
echo "Xvfb is ready"

# Function to handle cleanup on exit
cleanup() {
    echo "Shutting down services..."
    
    # Find and kill Xvfb process
    if pgrep Xvfb > /dev/null; then
        echo "Stopping Xvfb..."
        pkill Xvfb
    fi
}

# Register the cleanup function for these signals
trap cleanup SIGTERM SIGINT SIGHUP

# Run the application
bun run start

status=$?
if [ $status -ne 0 ]; then
    echo "Application failed with status $status, running cleanup..."
    cleanup
    exit 1
fi

cleanup
exit 0