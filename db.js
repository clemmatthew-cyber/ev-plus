// ─── SQLite Database Layer for EV+ ───
// Synchronous via better-sqlite3. All CRUD helpers exported for use in server.js.

import Database from "better-sqlite3";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use RAILWAY_VOLUME_MOUNT_PATH for persistent storage across deploys,
// otherwise fall back to local directory (dev mode).
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = join(DATA_DIR, "ev-plus.db");
console.log(`[db] SQLite path: ${DB_PATH}`);

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");