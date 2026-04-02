# AI-mediated communication — study chat platform

Real-time **dyadic chat** for behavioral research comparing **human-only** dialogue with **optional AI assistance** (via [Mistral](https://mistral.ai/)). Pairs join a shared **room**; in the AI condition, participants request help only by starting a message with **`@LLM`**. The assistant does **not** monitor or intervene unless explicitly tagged.

**Repository:** [github.com/IhebDridi/AI-mediated-communication](https://github.com/IhebDridi/AI-mediated-communication)

```bash
git clone https://github.com/IhebDridi/AI-mediated-communication.git
cd AI-mediated-communication
npm install
```

The codebase is a small **npm monorepo** (`server` + `client`). Internal package name is `margarita`; the GitHub project name is **AI-mediated-communication**.

---

## Features (summary)

| Area | Behavior |
|------|-----------|
| **Design** | Two server-side **treatments**: human-only chat, or chat + `@LLM` → Mistral (full transcript per request). |
| **Blinding** | Participant UI does **not** advertise the alternate condition; copy is tailored per room. Public API only exposes **occupancy**, not treatment. |
| **Admin** | Researcher UI at **`/admin`**: create rooms, **live P1/P2 status** (connected vs finished vs offline), **Collect chat** to append the full transcript to **PostgreSQL** (e.g. Clever add-on), then close the room. **Open** and **CSV** on collected rows to review or export transcripts. |
| **Participants** | **Finish and leave** → **`/thankyou`** page. Chats are **not** written to the DB until the admin collects the room. |
| **Messages** | **Markdown** rendering in the chat (headings, lists, bold, etc.). Assistant messages appear as **Assistant**. |

---

## Requirements

- **Node.js** (LTS) and **npm**
- **Mistral API key** (for `@LLM` rooms only), server-side only
- **`ADMIN_SECRET`** recommended for any shared or production host
- **PostgreSQL** (optional locally) for **Collect chat** and archives — use [Docker](#local-testing-with-postgresql-docker), a local install, or Clever’s **PostgreSQL add-on**
- **Docker Desktop** (optional) — convenient way to run Postgres on your machine for local testing

---

## Quick start

```bash
cp server/.env.example server/.env
# Edit server/.env: MISTRAL_API_KEY (if using @LLM), ADMIN_SECRET (optional locally), DATABASE_URL (optional; see below)

npm run dev
```

- **App (participants):** [http://localhost:5173](http://localhost:5173)
- **Admin:** [http://localhost:5173/admin](http://localhost:5173/admin)
- **API + WebSocket:** [http://localhost:3001](http://localhost:3001) (proxied in dev)

Without **`DATABASE_URL`** (or Clever-style **`POSTGRESQL_ADDON_*`** variables), the app runs fine, but **Collect chat** and the archives table are disabled.

---

## Local testing with PostgreSQL (Docker)

Use this when you want to test **Collect chat**, **Open** transcript, and **CSV** export against a real database on your machine.

### 1. Start Postgres in Docker

Example (database `margarita`, user `postgres`, password `dev`, Postgres 16):

```bash
docker run --name margarita-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=margarita -p 5432:5432 -d postgres:16
```

On **Windows**, if `docker` is not on your `PATH`, use the full path to `docker.exe` (under `Docker\Docker\resources\bin`), or open a shell after Docker Desktop has updated your environment.

If **port 5432 is already used** (common when PostgreSQL is installed on the host), map a different host port, e.g. **5433**:

```bash
docker rm -f margarita-pg   # only if you need to recreate the container
docker run --name margarita-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=margarita -p 5433:5432 -d postgres:16
```

### 2. Point the server at the database

In **`server/.env`** set (adjust host port if you used `5433`):

```env
DATABASE_URL=postgresql://postgres:dev@127.0.0.1:5432/margarita
```

The server loads **`server/.env`** explicitly and applies it over stale shell variables so local settings match what you edit.

### 3. Run the app and exercise the flow

```bash
npm run dev
```

On startup you should see a line such as **`PostgreSQL: connecting as postgres @ 127.0.0.1:5432 / margarita`** and **`PostgreSQL: archived_chats table ready.`**

Then:

1. Open **`/admin`**, create a room, open two browser windows (or one + private window), join as both participants, send messages.
2. In admin, click **Collect chat** for that room.
3. The row appears under **Collected transcripts**; use **Open** to read the thread or **CSV** to download.

### 4. Troubleshooting (`28P01` / password authentication failed)

1. **Wrong Postgres on `5432`** — A host install may be answering instead of Docker. Use **`-p 5433:5432`** for the container and set **`DATABASE_URL`** to port **5433**.
2. **Old Docker data volume** — The superuser password is set only on **first** database init. To reset: remove the container and its volume, then `docker run` again, or keep the volume and use the password from the first init.
3. Confirm the startup log line shows the **host and port** you expect.

### 5. Production-style smoke test (same origin)

To mimic Clever (single origin, no Vite dev server):

```bash
npm run build
# PowerShell example:
$env:NODE_ENV="production"; $env:PORT="8080"; $env:CLIENT_ORIGIN="http://localhost:8080"; npm start
```

Open **http://localhost:8080** — UI and Socket.IO use the same origin.

---

## Configuration (`server/.env`)

| Variable | Purpose |
|----------|---------|
| `MISTRAL_API_KEY` | Required for assistant replies in `@LLM` rooms. |
| `MISTRAL_MODEL` | Optional; default `mistral-small-latest`. |
| `PORT` | Optional; default `3001`. |
| `CLIENT_ORIGIN` | Frontend origin for CORS (e.g. `http://localhost:5173` in dev). |
| `ADMIN_SECRET` | If set, required for admin API (`Authorization: Bearer …`). If unset, server warns and allows admin without auth (**dev only**). |
| `DATABASE_URL` | Optional. Full PostgreSQL URL. On Clever you can rely on **`POSTGRESQL_ADDON_*`** instead (see `server/src/db.ts`). Without DB, **Collect chat** is disabled. |

**Never commit `server/.env`.** It is listed in `.gitignore`. If a key was ever exposed, **revoke and rotate** it in the [Mistral console](https://console.mistral.ai).

---

## Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js, TypeScript (ESM), **Express**, **Socket.IO**, **@mistralai/mistralai** |
| Frontend | **Vite 6**, **React 19**, **react-router-dom**, **socket.io-client**, **react-markdown** + **remark-gfm** |

---

## Repository layout

```
├── package.json              # workspaces: server, client
├── docs/
│   └── CLEVER_CLOUD.md       # Clever Cloud deploy checklist
├── server/
│   ├── src/
│   │   ├── index.ts          # HTTP, Socket.IO, admin routes
│   │   ├── db.ts             # PostgreSQL pool, archives
│   │   └── llmWatch.ts       # Mistral completions for @LLM
│   └── .env.example
└── client/
    └── src/
        ├── App.tsx           # routes
        ├── ParticipantApp.tsx
        ├── AdminApp.tsx
        ├── ThankYouPage.tsx
        └── MessageBody.tsx   # Markdown bodies
```

---

## API overview

**Public (participants)**  
- `GET /api/rooms/:roomId` → `{ occupantCount }`

**Admin** (Bearer `ADMIN_SECRET` when set)  
- `POST /api/admin/rooms` — body `{ treatment, label? }`  
- `GET /api/admin/rooms` — list rooms, P1/P2 connection + voluntary-exit timestamps, `dbConfigured`  
- `POST /api/admin/rooms/:roomId/collect` — save transcript to PostgreSQL and remove room  
- `GET /api/admin/archives` — recent collected rows (metadata + message counts)  
- `GET /api/admin/archives/:id` — full archived row including `messages` (JSON)  
- `GET /api/admin/archives/:id/csv` — UTF-8 CSV download (one row per message; BOM for Excel)  

**Socket.IO:** `join`, `chat_message`, `exit_chat`; server emits `message`, `peer_joined`, `peer_left` (optional `{ voluntary }`), `voluntary_exit`, `llm_typing` (during tagged `@LLM` handling).

---

## Deployment notes

- Use **HTTPS** in production; set **`CLIENT_ORIGIN`** to your real frontend URL (exact origin, e.g. `https://your-app.cleverapps.io`).
- **Clever Cloud:** step-by-step guide in [docs/CLEVER_CLOUD.md](docs/CLEVER_CLOUD.md) (GitHub app, build hook, env vars, PostgreSQL add-on linked to the Node app, single process serving `client/dist` + API).
- Set strong **`ADMIN_SECRET`** and **`MISTRAL_API_KEY`** as host secrets (not in git).

---

## License

Specify a license in the repository settings or add a `LICENSE` file when your team decides (research / institutional policy).
