# Deploy on Clever Cloud

This app is one **Node.js** process: Express + Socket.IO + API, and (after build) the **Vite** UI from `client/dist` on the same URL. That matches Clever’s [Node.js runtime](https://www.clever-cloud.com/developers/doc/applications/nodejs): listen on **`0.0.0.0`** and port **`8080`** (Clever sets `PORT`; our code uses `process.env.PORT`).

## 1. Create a Node.js application

1. Open the [Clever Cloud Console](https://console.clever-cloud.com/) (or use [Clever Tools](https://github.com/CleverCloud/clever-tools)).
2. **Create an application** → type **Node.js**.
3. Link your Git repository: `https://github.com/IhebDridi/AI-mediated-communication.git` (or your fork), branch **`main`**.

## 2. Build: compile client + server

Clever runs `npm install` at the **repository root** (workspaces install `client` and `server`). By default it does **not** run `npm run build`, so **`server/dist/index.js` is missing** and the app crashes with:

`Error: Cannot find module '.../server/dist/index.js'`.

### Option A - automatic (this repository)

The root **`postinstall`** script runs **`npm run build`** when Clever’s **`CC_APP_ID`** is present (Clever injects it before `npm install`). You do **not** need `CC_POST_BUILD_HOOK` for a basic deploy.

### Option B - deployment hook only

If you prefer not to use `postinstall`, remove or ignore it and set:

| Variable | Value |
|----------|--------|
| `CC_POST_BUILD_HOOK` | `npm run build` |

(or `./clevercloud/post_build.sh` - make the script executable in git if you use it directly).

Using **both** Option A and `CC_POST_BUILD_HOOK` builds twice per deploy; harmless, but you can drop the hook.

### TypeScript build needs devDependencies

With `NODE_ENV=production`, npm may skip `devDependencies`, but **`tsc`** lives under `server` devDependencies. Set:

| Variable | Value |
|----------|--------|
| `CC_NODE_DEV_DEPENDENCIES` | `install` |

(Alternatively you could move `typescript` to `server` `dependencies`; the env var is usually enough.)

## 3. Start command

Root `package.json` already has:

```json
"start": "npm run start -w server"
```

Clever will run `npm start` unless you override with **`CC_RUN_COMMAND`**. Default is fine.

## 4. Required environment variables

Set these in the Clever Console (same place as hooks):

| Variable | Example | Purpose |
|----------|---------|---------|
| `NODE_ENV` | `production` | Production mode ([Clever expects this](https://www.clever-cloud.com/developers/doc/applications/nodejs)). |
| `CLIENT_ORIGIN` | `https://your-app-id.cleverapps.io` | **Exact** public URL of this app (HTTPS, no trailing slash). CORS + Socket.IO must match the page origin. |
| `MISTRAL_API_KEY` | *(secret)* | Mistral API key for `@LLM` rooms. |
| `ADMIN_SECRET` | *(strong random string)* | Protects `POST/GET /api/admin/*`. |

### PostgreSQL (chat transcripts)

1. In the Clever Console, add a **[PostgreSQL](https://www.clever-cloud.com/developers/doc/addons/postgresql/)** add-on to your **organisation** (or link it to this Node app).
2. **Link** the add-on to your Node.js application so Clever injects connection variables at runtime.
3. The server recognises **`POSTGRESQL_ADDON_HOST`**, **`POSTGRESQL_ADDON_USER`**, **`POSTGRESQL_ADDON_PASSWORD`**, **`POSTGRESQL_ADDON_DB`**, and **`POSTGRESQL_ADDON_PORT`**, or a single **`DATABASE_URL`** if you set it yourself.

If you paste **`POSTGRESQL_ADDON_URI`** into **`DATABASE_URL`**, that is fine; the app strips `sslmode` query parameters so TLS still works with Node.js 20+ and **`pg`** (Clever’s certificate would otherwise trigger `DEPTH_ZERO_SELF_SIGNED_CERT`).

On startup it creates an **`archived_chats`** table. **Transcripts are written only when an admin clicks “Collect chat”** in `/admin`; that saves the full message list and removes the room.

Optional:

| Variable | Purpose |
|----------|---------|
| `MISTRAL_MODEL` | e.g. `mistral-small-latest` (default if unset). |

After the first deploy, Clever shows your app URL (e.g. `https://app-xxx.cleverapps.io`). Put **that** value in `CLIENT_ORIGIN`. If the URL changes, update `CLIENT_ORIGIN` and redeploy.

## 5. What the server does on Clever

- Listens on **`0.0.0.0`** and **`process.env.PORT`** (Clever uses **8080**).
- Serves **`client/dist`** when that folder exists (after `npm run build`), so `/`, `/admin`, and `/thankyou` load the React SPA.
- Proxies are handled with `trust proxy` for correct HTTPS / `X-Forwarded-*` behavior.

## 6. Health check

If you configure a health-check path in Clever, you can use something that always responds, e.g. extend the server with `GET /health` → `200 OK` (not added by default; add if your Clever org requires it).

## 7. Custom domain

If you add a custom domain in Clever, set **`CLIENT_ORIGIN`** to that HTTPS origin (the one participants type in the browser).

## 8. Local “production” smoke test

```bash
npm run build
NODE_ENV=production PORT=8080 CLIENT_ORIGIN=http://localhost:8080 npm start
```

Open `http://localhost:8080` - UI and WebSocket should use the same origin.

## References

- [Node.js on Clever Cloud](https://www.clever-cloud.com/developers/doc/applications/nodejs)
- [PostgreSQL add-on](https://www.clever-cloud.com/developers/doc/addons/postgresql/)
- [Deployment hooks (`CC_POST_BUILD_HOOK`)](https://www.clever-cloud.com/developers/doc/develop/build-hooks/)
