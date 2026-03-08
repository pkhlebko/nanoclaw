import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { setRegisteredGroup } from './db-groups.js';
import { getDb, setDb } from './db-instance.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';

function createCoreTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
  `);
}

function createTaskTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);
    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);
  `);
}

function createStateTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);
}

function runMigrations(database: Database.Database): void {
  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec("ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'");
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec('ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0');
    // Backfill: mark existing bot messages that used the content prefix pattern
    database.prepare('UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?').run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec('ALTER TABLE chats ADD COLUMN channel TEXT');
    database.exec('ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0');
    // Backfill from JID patterns
    database.exec("UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'");
    database.exec("UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'");
    database.exec("UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'");
    database.exec("UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'");
  } catch {
    /* columns already exist */
  }
}

function createSchema(database: Database.Database): void {
  createCoreTables(database);
  createTaskTables(database);
  createStateTables(database);
  runMigrations(database);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const database = new Database(dbPath);

  createSchema(database);
  setDb(database);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  const database = new Database(':memory:');

  createSchema(database);
  setDb(database);
}

// --- Message operations ---

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(msg.id, msg.chat_jid, msg.sender, msg.sender_name, msg.content, msg.timestamp, msg.is_from_me ? 1 : 0, msg.is_bot_message ? 1 : 0);
}

export function getNewMessages(jids: string[], lastTimestamp: string, botPrefix: string): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;

  const rows = getDb()
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;

  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(chatJid: string, sinceTimestamp: string, botPrefix: string): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;

  return getDb().prepare(sql).all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM router_state WHERE key = ?').get(key) as { value: string } | undefined;

  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)').run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = getDb().prepare('SELECT session_id FROM sessions WHERE group_folder = ?').get(groupFolder) as
    | { session_id: string }
    | undefined;

  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  getDb().prepare('INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)').run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = getDb().prepare('SELECT group_folder, session_id FROM sessions').all() as Array<{
    group_folder: string;
    session_id: string;
  }>;
  const result: Record<string, string> = {};

  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }

  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string): unknown => {
    const filePath = path.join(DATA_DIR, filename);

    if (!fs.existsSync(filePath)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      fs.renameSync(filePath, `${filePath}.migrated`);

      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;

  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }

    if (routerState.last_agent_timestamp) {
      setRouterState('last_agent_timestamp', JSON.stringify(routerState.last_agent_timestamp));
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<string, string> | null;

  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<string, RegisteredGroup> | null;

  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn({ jid, folder: group.folder, err }, 'Skipping migrated registered group with invalid folder');
      }
    }
  }
}
