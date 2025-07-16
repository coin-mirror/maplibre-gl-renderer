# MapLibre Map Renderer

**The problem:** Rendering Maplibre Maps on server-side into pictures (e.g. PNGs) was currently only possible through the [`maplibre-native`](https://github.com/maplibre/maplibre-native) package, with node or c++ bindings. The `maplibre-native` package does NOT support every aspect of the [Maplibre Style Spec](https://maplibre.org/maplibre-style-spec/).

**The solution:** With this standalone application we introduced the possiblity to render the map with the maplibre-gl (JS) package in a simulated browser (with Puppeteer). This enables us to support the complete Maplibre Style Spec with relative good performance.

## Requirements

The app does require a GPU for rendering (Software Rendering is not possible so far). This means, mounting a GPU `/dev/dri` device onto the Docker Container when running on Linux is required. (Better GPU Performance does also result in faster response times.)

On Mac, running in Docker Container is currently not possible, but you can run it in development.

Internally, we use some rendering workers and a queueing system. Each worker can only render one map at the time. The amount of workers depend on the available CPU count, but can be overwritten by setting env-variable `WORKER_COUNT` to the amount of workers.

## Usage

You can run the container with (Supported Platforms are x64 and ARM64):

```bash
docker run --rm ghcr.io/coin-mirror/maplibre-gl-renderer:v1.0.1
```

> Please note, that it may be required to mount a GPU to the container.

For production use with enhanced reliability:

```bash
docker run -d \
  --name maplibre-renderer \
  --restart unless-stopped \
  --device /dev/dri:/dev/dri \
  --shm-size=2g \
  -p 3000:3000 \
  -e WORKER_COUNT=2 \
  -e NODE_OPTIONS="--max-old-space-size=2048" \
  ghcr.io/coin-mirror/maplibre-gl-renderer:v1.0.1
```

Please read the License.

## API

### POST /render

Renders a map view according to the provided style and viewport settings.

**Request Body in JSON format:**

- `width`: Width (10-6000px, default: 1920)
- `height`: Height (10-4000px, default: 1080)
- `ratio`: Device scale factor (0-8, default: 1, zero will fallback to 1!)
- `center`: [longitude, latitude] (-180/180, -90/90)
- `zoom`: Zoom level (0-22)
- `pitch`: Tilt angle (0-85°, default: 0)
- `bearing`: Normalized Rotation (-180-180°, default: 0)
- `format`: "png", "jpeg" or "webp" (default: "webp")
- `quality`: Quality of picture, ignored for "png" format (0-100, default: 100)
- `optimize`: Optimizes processing for speed, quality-loss (!) (default: false)
- `style`: MapLibre Style Spec object

**Example:**

```json
{
  "height": 512,
  "width": 1024,
  "center": [7.65, 45.02],
  "zoom": 5.0613,
  "bearing": 0,
  "pitch": 0,
  "ratio": 1.7,
  "style": {
    // Maplibre Style Spec
  }
}
```

**Explaination for `ratio` property:**

The `ratio` refers always to the pixel-density ratio using to render the image. Internally, we are using the [window.devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio) for scaling along.

Unlike changing the `height` and `width` values (which always results in a different viewport of the map), the `ratio` keeps the viewport but scales the image.

For example, using a `ratio` of `2` would double a requested picture size from 512x512 to 1024x1024 (or 4-times the pixels). You can also downscale by using a value between `0` and `1`. That would mean, a `ratio` of `0.5` would halfen a requested picture size from 512x512 to 256x256.


## Reliability Features

### Automatic Crash Recovery

The application includes comprehensive crash detection and recovery mechanisms:

- **Browser Crash Detection**: Automatic detection of browser disconnections and crashes
- **Renderer Restart**: Failed renderers are automatically restarted without affecting other workers
- **Process Monitoring**: Continuous monitoring of Xvfb and application processes
- **Health Checks**: Regular health checks with automatic remediation

### Configuration

Environment variables for reliability tuning:

```bash
# Worker configuration
WORKER_COUNT=2                              # Number of rendering workers (default: CPU count, max 4)

# Memory management
NODE_OPTIONS="--max-old-space-size=2048"    # Node.js heap size limit
UV_THREADPOOL_SIZE=4                        # UV thread pool size

# Debug options
DEBUG_GPU=false                             # Enable GPU debugging
DEBUG_BROWSER=false                         # Enable browser debugging

# Performance tuning
NODE_GC_INTERVAL=100                        # Garbage collection interval
```

### Docker Compose Configuration

For production deployment, use the provided `docker-compose.yaml` with enhanced reliability settings:

```yaml
version: "3.8"
services:
  map-renderer:
    # ... other settings ...
    restart: unless-stopped
    stop_grace_period: 60s
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '2.0'
        reservations:
          memory: 2G
          cpus: '1.0'
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 15s
      retries: 5
      start_period: 30s
```

### Health Monitoring

The application provides several health check endpoints:

- `GET /health` - Overall service health including renderer status
- `GET /status/queue` - Detailed queue and worker status

Health check responses include:
- Service status (`ok`, `degraded`, or `error`)
- Number of healthy renderers
- Queue information (pending, in progress)
- Memory and resource usage

## Troubleshooting

### Common Issues

1. **High Memory Usage**: The application monitors memory usage and will log warnings when memory usage exceeds 1GB. Consider reducing `WORKER_COUNT` or increasing available memory.

2. **Browser Crashes**: Browser crashes are automatically handled with restart mechanisms. Check logs for patterns that might indicate resource exhaustion.

3. **Renderer Failures**: Individual renderer failures don't affect the entire service. The system will attempt to restart failed renderers automatically.

### Monitoring

Monitor the application using the health endpoints:

```bash
# Check overall health
curl http://localhost:3000/health

# Check detailed status
curl http://localhost:3000/status/queue
```

### Logs

The application provides structured logging with timestamps. Key log events include:

- Renderer initialization and failures
- Browser crash detection and recovery
- Memory usage warnings
- Health check failures
- Graceful shutdown events

## Development

The project requires [Bun](https://bun.sh) for dependency management and runtime.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun dev
```

Beyond that, we are packaging up the application as an Docker-Container, running on exposed port `3000`.

### Development Configuration

For development, you can use a single worker and enable debugging:

```bash
WORKER_COUNT=1 DEBUG_BROWSER=true bun dev
```
