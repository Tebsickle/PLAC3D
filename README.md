# PLAC3D

A shared 3D voxel landscape inspired by collaborative pixel canvases. The browser renders nearby occupied chunks with Three.js; a Node WebSocket server owns the world state and persists it in SQLite.

## Run locally

Requires Node.js 22 or newer.

```sh
npm install
npm run dev:all
```

Open `http://localhost:5173`. Other devices on the same network can use `http://<your-computer-ip>:5173`. In development, Vite forwards the app's `/ws` connection to the local WebSocket server, so only port `5173` needs to be reachable. Set `VITE_WS_URL` only when the WebSocket server uses a different URL.

Both Vite and the development server load their shared settings from `.env`. Development then loads `.env.development`, which keeps the local application origin at `http://localhost:5173`. The checked-in `.env.example` documents every shared setting; the real `.env` is intentionally ignored by Git.

## Run the server with Docker Compose

Requires Docker Desktop or another running Docker Engine with Compose support.

```sh
docker-compose up --build
```

Compose builds and starts the `plac3d` website and WebSocket server together. Open the website at `http://localhost:5173`; the same service is available for WebSocket and health checks on port `8787`. SQLite data is stored in the local `data` directory mounted into the container, so the database, WAL, and shared-memory files persist together when the container is recreated. Check that the server is running at `http://localhost:8787/health`.

The Compose setup serves the production Vite build, so no separate `npm run dev` process is needed. Stop the service with `docker-compose down`; this leaves the database in the local `data` directory intact.

Local development and Docker use the same `data/plac3d.db` database. Stop one before starting the other; do not run `npm run dev:all` and the Docker application container at the same time.

## Interaction

- Right mouse button rotates the camera.
- Middle mouse button pans.
- Mouse wheel zooms.
- Left click queues a voxel; click-drag to queue voxels across the landscape. Dragging does not target voxels created earlier in the same gesture.
- Choose one of the preset palette colors or erase, then submit up to the batch limit granted by your account level.
- Each submitted batch starts a 60-second cooldown for that account.

## Account progression

Levels are derived from lifetime submitted voxel changes and are never stored or assigned manually. Progression runs from level 1 through level 50. Level 1 starts with a 50-voxel batch limit and requires 100 voxel changes. Each following level requirement is the previous requirement multiplied by `1.2` and rounded up. Batch gains accelerate with level: each level-up receives a share of the 450 available batch upgrades weighted by its destination level, reaching exactly 500 voxels per batch at level 50 after 3,826,563 lifetime voxel changes.

## Architecture

The server is authoritative. It accepts only integer coordinates from `0` through `999`, approved palette IDs, and batches no larger than the authenticated user's level permits. Occupied voxels are stored sparsely in SQLite and streamed by chunk to connected clients. Accepted changes are broadcast to subscribers of affected chunks.

Anonymous visitors can stream and navigate the world but cannot queue or submit voxel changes. Registration stores a salted PBKDF2-HMAC-SHA-256 password digest in a pending record; the user row is created only after its 30-minute email confirmation link is opened. Login uses a one-hour `HttpOnly`, `SameSite=Lax` session cookie that refreshes on page visits and successful submissions. Password-reset links are single-use, expire after 30 minutes, and revoke every existing session when the password changes.

Authentication writes and WebSocket connections enforce same-origin browser requests and per-client attempt limits. Missing-user logins perform the same password-derivation work as registered-user logins, expired account tokens and sessions are removed automatically, and production refuses to start without HTTPS in `APP_ORIGIN` and a `SESSION_SECRET` containing at least 32 characters. Public traffic must use HTTPS so passwords are encrypted in transit before reaching the server.

During local development without transactional email credentials, the registration screen exposes a development-only confirmation link and the server logs it. Production requires a configured sender and API key; it never returns the confirmation token to the browser.

## Production container

```sh
docker build -t plac3d .
docker run --rm -p 8787:8787 -v plac3d-data:/app/data -e SESSION_SECRET=change-this plac3d
```

The current container serves the server and health endpoint. Build the Vite client separately and serve `dist` from a static host or reverse proxy configured to forward WebSocket traffic to port `8787`.
