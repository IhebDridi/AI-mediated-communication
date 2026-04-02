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
| **Admin** | Researcher UI at **`/admin`**: create rooms, optional private labels, **copy join links** for each pair. Protected by **`ADMIN_SECRET`** in production. |
| **Messages** | **Markdown** rendering in the chat (headings, lists, bold, etc.). Assistant messages appear as **Assistant**. |

---

## Requirements

- **Node.js** (LTS) and **npm**
- **Mistral API key** (for `@LLM` rooms), server-side only
- **`ADMIN_SECRET`** recommended for any shared or production host

---

## Quick start

```bash
cp server/.env.example server/.env
# Edit server/.env: MISTRAL_API_KEY, ADMIN_SECRET (optional locally), CLIENT_ORIGIN if needed

npm run dev
```

- **App (participants):** [http://localhost:5173](http://localhost:5173)  
- **Admin:** [http://localhost:5173/admin](http://localhost:5173/admin)  
- **API + WebSocket:** [http://localhost:3001](http://localhost:3001) (proxied in dev)

---

## Configuration (`server/.env`)

| Variable | Purpose |
|----------|---------|
| `MISTRAL_API_KEY` | Required for assistant replies in `@LLM` rooms. |
| `MISTRAL_MODEL` | Optional; default `mistral-small-latest`. |
| `PORT` | Optional; default `3001`. |
| `CLIENT_ORIGIN` | Frontend origin for CORS (e.g. `http://localhost:5173`). |
| `ADMIN_SECRET` | If set, required for admin API (`Authorization: Bearer …`). If unset, server warns and allows admin without auth (**dev only**). |

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
├── server/
│   ├── src/
│   │   ├── index.ts          # HTTP, Socket.IO, admin routes
│   │   └── llmWatch.ts       # Mistral completions for @LLM
│   └── .env.example
└── client/
    └── src/
        ├── App.tsx           # routes
        ├── ParticipantApp.tsx
        ├── AdminApp.tsx
        └── MessageBody.tsx   # Markdown bodies
```

---

## API overview

**Public (participants)**  
- `GET /api/rooms/:roomId` → `{ occupantCount }`

**Admin** (Bearer `ADMIN_SECRET` when set)  
- `POST /api/admin/rooms` — body `{ treatment, label? }`  
- `GET /api/admin/rooms` — list rooms, counts, labels  

**Socket.IO:** `join`, `chat_message`; server emits `message`, `peer_joined`, `peer_left`, `llm_typing` (during tagged `@LLM` handling).

---

## Deployment notes

- Use **HTTPS** in production; set **`CLIENT_ORIGIN`** to your real frontend URL.
- Serve the **Vite build** and configure SPA fallback so `/admin` loads `index.html`.
- Set strong **`ADMIN_SECRET`** and **`MISTRAL_API_KEY`** as host secrets (not in git).

---

## License

Specify a license in the repository settings or add a `LICENSE` file when your team decides (research / institutional policy).
