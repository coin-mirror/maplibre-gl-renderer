# MapLibre Map Renderer

Rendering Maplibre Maps on server-side into pictures (e.g. PNGs) was currently only possible through the [`maplibre-native`](https://github.com/maplibre/maplibre-native) package, with node or c++ bindings. The `maplibre-native` package does NOT support every aspect of the [Maplibre Style Spec](https://maplibre.org/maplibre-style-spec/).

With this standalone application we introduced the possiblity to render the map with the maplibre-gl (JS) package in a simulated browser (with Puppeteer). This enables us to support the complete Maplibre Style Spec with relative good performance.

## Requirements

The app does require a GPU for rendering (Software Rendering is not possible so far). This means, mounting a GPU `/dev/dri` device onto the Docker Container when running on Linux is required. (Better GPU Performance does also result in faster response times.)

On Mac, running in Docker Container is currently not possible, but you can run it in development.

Internally, we use some rendering workers and a queueing system. Each worker can only render one map at the time. The amount of workers depend on the available CPU count, but can be overwritten by setting env-variable `WORKER_COUNT` to the amount of workers.

## Usage

You can run the container with (Supported Platforms are x64 and ARM64):

```bash
docker run --rm ghcr.io/coin-mirror/maplibre-gl-renderer:v0.1.0
```

> Please note, that it may be required to mount a GPU to the container.

Please read the License.

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
