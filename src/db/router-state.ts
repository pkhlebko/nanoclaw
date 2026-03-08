import { getDb } from './instance.js';

/** Get a value from the router_state key-value table. */
export function getRouterState(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM router_state WHERE key = ?').get(key) as { value: string } | undefined;

  return row?.value;
}

/** Set a value in the router_state key-value table. */
export function setRouterState(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)').run(key, value);
}
