# PLAC3D

A shared 3D voxel landscape inspired by collaborative pixel canvases. The browser renders nearby occupied chunks with Three.js; a Node WebSocket server owns the world state and persists it in SQLite.

## Run locally

Requires Node.js 22 or newer.

```sh
npm install
npm run dev:all
```

Open `http://localhost:5173`. Other devices on the same network can use `http://<your-computer-ip>:5173`. In development, Vite forwards the app's `/ws` connection to the local WebSocket server, so only port `5173` needs to be reachable. Set `VITE_WS_URL` only when the WebSocket server uses a different URL.

## Run the server with Docker Compose

Requires Docker Desktop or another running Docker Engine with Compose support.

```sh
docker compose up --build
```

Compose builds and starts the `plac3d` website and WebSocket server together. Open the website at `http://localhost:5173`; the same service is available for WebSocket and health checks on port `8787`. SQLite data is stored in the named `plac3d-data` volume, so stopping and recreating the container does not remove the voxel world. Check that the server is running at `http://localhost:8787/health`.

The Compose setup serves the production Vite build, so no separate `npm run dev` process is needed. Stop the service with `docker compose down`. To also delete the persisted voxel database, run `docker compose down --volumes`.

## Interaction

- Right mouse button rotates the camera.
- Middle mouse button pans.
- Mouse wheel zooms.
- Left click queues a voxel; click-drag to queue voxels across the landscape. Dragging does not target voxels created earlier in the same gesture.
- Choose one of the preset palette colors or erase, then submit up to 100 queued voxels.
- Each submitted batch starts a 60-second cooldown for that browser session.

## Architecture

The server is authoritative. It accepts only integer coordinates from `0` through `999`, approved palette IDs, and batches of at most 100 placements. Occupied voxels are stored sparsely in SQLite and streamed by chunk to connected clients. Accepted changes are broadcast to subscribers of affected chunks.

Anonymous sessions use a signed browser token for continuity and rate limiting. This is not authentication and does not stop a determined user from evading limits. Production deployments should add stronger abuse controls, origin configuration, TLS, and account or device identity as needed.

## Production container

```sh
docker build -t plac3d .
docker run --rm -p 8787:8787 -v plac3d-data:/app/data -e SESSION_SECRET=change-this plac3d
```

The current container serves the server and health endpoint. Build the Vite client separately and serve `dist` from a static host or reverse proxy configured to forward WebSocket traffic to port `8787`.
