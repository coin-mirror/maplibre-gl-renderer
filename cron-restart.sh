#!/bin/bash

## File used to restart the docker-compose service (we have a crash from time to time)
## $ crontab -e
## 0 12 * * * /root/maplibre-gl-renderer-restart.sh >> /var/log/maplibre-gl-renderer-restart.log 2>&1
## TODO: Find the solution for the crashes and remove this stuff

# Path to docker-compose file
COMPOSE_PATH="/root/docker-compose.yaml"

# Stop the service
docker-compose -f $COMPOSE_PATH down

# Small delay to ensure clean shutdown
sleep 5

# Start the service
docker-compose -f $COMPOSE_PATH up -d