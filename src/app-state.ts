import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME } from './config.js';
import { getAllRegisteredGroups, setRegisteredGroup } from './db/groups.js';
import { getMessagesSince } from './db/messages.js';
import { getRouterState, setRouterState } from './db/router-state.js';
import { getAllSessions } from './db/sessions.js';
import { resolveGroupFolderPath } from './groups/folder.js';
import { GroupQueue } from './groups/queue.js';
import { logger } from './logger.js';
import { MessageAttachment, RegisteredGroup } from './types.js';

/** Mutable runtime state for the NanoClaw process. */
export interface AppState {
  lastTimestamp: string;
  sessions: Record<string, string>;
  registeredGroups: Record<string, RegisteredGroup>;
  lastAgentTimestamp: Record<string, string>;
  messageLoopRunning: boolean;
  pendingAttachments: Map<string, MessageAttachment[]>;
}

/** Create a fresh, empty AppState. */
export function createAppState(): AppState {
  return {
    lastTimestamp: '',
    sessions: {},
    registeredGroups: {},
    lastAgentTimestamp: {},
    messageLoopRunning: false,
    pendingAttachments: new Map(),
  };
}

/**
 * Populate state from the database.
 * Mutates the state object in place.
 */
export function loadState(state: AppState): void {
  state.lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');

  try {
    state.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    state.lastAgentTimestamp = {};
  }

  state.sessions = getAllSessions();
  state.registeredGroups = getAllRegisteredGroups();
  logger.info({ groupCount: Object.keys(state.registeredGroups).length }, 'State loaded');
}

/** Persist cursor positions to the database. */
export function saveState(state: AppState): void {
  setRouterState('last_timestamp', state.lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(state.lastAgentTimestamp));
}

/**
 * Register a group in state and on disk.
 * Validates the folder path and creates the logs directory.
 */
export function registerGroup(jid: string, group: RegisteredGroup, state: AppState): void {
  let groupDir: string;

  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn({ jid, folder: group.folder, err }, 'Rejecting group registration with invalid folder');

    return;
  }

  state.registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

/**
 * Startup recovery: enqueue groups that have unprocessed messages.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
export function recoverPendingMessages(state: AppState, queue: GroupQueue): void {
  for (const [chatJid, group] of Object.entries(state.registeredGroups)) {
    const sinceTimestamp = state.lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

    if (pending.length > 0) {
      logger.info({ group: group.name, pendingCount: pending.length }, 'Recovery: found unprocessed messages');
      queue.enqueueMessageCheck(chatJid);
    }
  }
}
