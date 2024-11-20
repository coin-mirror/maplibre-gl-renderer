#!/bin/bash

# Start Xvfb
Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &

# Wait for Xvfb to start
until xdpyinfo -display :99 >/dev/null 2>&1; do
    echo "Waiting for Xvfb..."
    sleep 1
done

exec bun run start
