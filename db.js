const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
    original_filename TEXT,
    image_path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    score INTEGER,
    mean_angle_deg REAL,
    resultant_length_r REAL,
    circular_variance REAL,
    angular_stddev_deg REAL,
    edge_pixel_count INTEGER,
    histogram_json TEXT,
    notes TEXT,
    analyzed INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_samples_user ON samples(user_id);
  CREATE INDEX IF NOT EXISTS idx_samples_created ON samples(created_at);
`);

// --- migrations (safe to run on existing databases) -------------------
const existingCols = db.prepare(`PRAGMA table_info(samples)`).all().map(c => c.name);

if (!existingCols.includes('batch_id')) {
  db.exec(`ALTER TABLE samples ADD COLUMN batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL`);
}
if (!existingCols.includes('analyzed')) {
  db.exec(`ALTER TABLE samples ADD COLUMN analyzed INTEGER NOT NULL DEFAULT 1`);
}
if (!existingCols.includes('score') || db.prepare(`PRAGMA table_info(samples)`).all().find(c => c.name === 'score' && c.notnull === 1)) {
  // score was NOT NULL in old schema — SQLite can't drop NOT NULL, but existing rows are fine
  // new inserts always provide score so no action needed
}

// Create batches and pending_images tables if they don't exist yet
db.exec(`
  CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    notes TEXT,
    closed INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    original_filename TEXT,
    image_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_samples_batch ON samples(batch_id);
  CREATE INDEX IF NOT EXISTS idx_pending_batch ON pending_images(batch_id);
`);

module.exports = db;
