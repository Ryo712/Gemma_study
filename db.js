import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dbPath = join(__dirname, 'database.sqlite');

const db = new DatabaseSync(dbPath);

// Initialize DB schema
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    candidate_dates TEXT NOT NULL, -- JSON array of candidate dates
    capacity INTEGER,
    location TEXT,
    fee INTEGER,
    admin_password TEXT NOT NULL, -- plain text or simple hash
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL, -- attending, absent, undecided
    selected_date TEXT,
    notes TEXT,
    chat_history TEXT, -- JSON serialized message list
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
  );
`);

export default db;
