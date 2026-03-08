import { getDb } from './instance.js';

/** Store or update a session ID for a group folder. */
export function setSession(groupFolder: string, sessionId: string): void {
  getDb().prepare('INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)').run(groupFolder, sessionId);
}

/** Retrieve all stored sessions as a folder→sessionId map. */
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
