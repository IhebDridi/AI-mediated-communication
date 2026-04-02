"use strict";

/**
 * Clever Cloud injects CC_APP_ID before `npm install`. Without a post-build hook,
 * the platform never runs `npm run build`, so `server/dist/index.js` is missing and
 * `npm start` fails. This runs the monorepo build once at install time.
 *
 * Local installs: no CC_APP_ID → this script exits immediately.
 */
const { execSync } = require("child_process");
const path = require("path");

if (!process.env.CC_APP_ID) {
  process.exit(0);
}

const root = path.resolve(__dirname, "..");
execSync("npm run build", { stdio: "inherit", cwd: root });
