# PLAC3D

PLAC3D is a shared 3D voxel canvas built with Three.js, WebSockets, Node.js, and SQLite. Visitors can explore the world anonymously; placing and submitting voxels requires a verified account.

## Requirements

- Node.js 22 or newer
- Docker Desktop with Compose support for container deployment

## Local development

Install dependencies and start the Vite client and Node server together:

```sh
npm install
npm run dev:all
```

Open `http://localhost:5173`. Devices on the same network can use `http://<computer-ip>:5173`.

Shared settings come from `.env`; `.env.development` overrides the application origin for local development. Copy `.env.example` to `.env` before starting if one does not already exist. The real `.env` file is ignored by Git.

## Docker Compose

To run only the application locally:

```sh
docker compose up --build -d plac3d
```

To run the application and configured Cloudflare Tunnel:

```sh
docker compose up --build -d
```

The site is available locally at `http://localhost:5173`, with the server and health endpoint at `http://localhost:8787/health`.

Stop the stack with:

```sh
docker compose down
```

SQLite data is stored in `data/plac3d.db` and survives container recreation. Local development and Docker use this same database, so do not run `npm run dev:all` and the application container simultaneously.

Before editing the database manually, stop the stack and close every SQLite viewer before starting Docker again. An editor holding the database or its WAL files open can prevent the container from starting.

## Configuration

The checked-in `.env.example` lists the supported settings:

| Setting | Purpose |
| --- | --- |
| `APP_ORIGIN` | Public origin used for links, cookies, and same-origin checks |
| `APP_PORT` | Host port used by the Compose application |
| `PORT` | Node server port |
| `DATABASE_PATH` | SQLite path for local development |
| `DOCKER_DATABASE_PATH` | SQLite path inside the container |
| `SESSION_SECRET` | Session-signing secret; production requires at least 32 characters |
| `CLOUDFLARE_TUNNEL_TOKEN` | Token used by the tunnel container |
| `RESEND_API_KEY` | Resend API key for account emails |
| `RESEND_FROM_EMAIL` | Verified sender used for account emails |

Production requires an HTTPS `APP_ORIGIN`, a secure `SESSION_SECRET`, and configured Resend credentials.

## Controls

Choose Mouse, Touchpad, or Mobile/Phone from the control-mode switcher.

- Mouse: left-click paints, right-drag rotates, middle-drag pans, and the wheel zooms.
- Touchpad: click paints and touchpad gestures control the camera.
- Mobile/Phone: tap paints, swipe rotates, and pinch zooms or pans.
- Select a palette color or erase, queue changes, then submit the batch.
- Each submitted batch starts a 60-second account cooldown.

## Accounts and progression

Registration requires an email address, username, password, and email confirmation. Confirmation and password-reset links are single-use and expire after 30 minutes. Login sessions last one hour and refresh when the site is visited or a batch is submitted.

Levels are calculated from lifetime submitted voxel changes:

- Level 1 starts at a 50-voxel batch limit.
- Each level requirement grows by 1.2×, rounded up.
- Batch capacity increases with level.
- Level 50 begins at 3,826,563 credited changes and allows 500 voxels per batch.

Passwords are stored as salted PBKDF2-HMAC-SHA-256 digests. Production traffic must use HTTPS so credentials are encrypted in transit.

## Project commands

```sh
npm run build
npm run build:server
npm test
```

The server is authoritative: it validates authentication, cooldowns, batch limits, coordinates, and palette values before committing changes to SQLite and broadcasting them to connected clients.
