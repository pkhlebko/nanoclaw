import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL, MAIN_GROUP_FOLDER } from '../config.js';
import { resolveGroupFolderPath } from '../groups/folder.js';
import { logger } from '../logger.js';
import { OutboundMedia, RegisteredGroup } from '../types.js';

import { IpcTasksDeps, IpcTaskPayload, processTaskIpc } from './tasks.js';

/** Full dependency surface required by the IPC watcher (superset of {@link IpcTasksDeps}). */
export interface IpcDeps extends IpcTasksDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendMedia?: (jid: string, media: OutboundMedia) => Promise<void>;
}

let ipcWatcherRunning = false;

/**
 * Moves a failed IPC file into the per-run errors directory so it does not block future polls.
 */
function quarantineFile(filePath: string, ipcBaseDir: string, sourceGroup: string, file: string): void {
  const errorDir = path.join(ipcBaseDir, 'errors');

  fs.mkdirSync(errorDir, { recursive: true });
  fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
}

/**
 * Reads and dispatches a single message or media IPC file.
 * Deletes the file on success; throws on error (caller handles quarantine).
 */
async function processMessageFile(
  filePath: string,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  if (data.type === 'message' && data.chatJid && data.text) {
    const targetGroup = registeredGroups[data.chatJid];

    if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
      await deps.sendMessage(data.chatJid, data.text);
      logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
    } else {
      logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
    }
  } else if (data.type === 'media' && data.chatJid && data.kind && data.workspacePath && deps.sendMedia) {
    const targetGroup = registeredGroups[data.chatJid];

    if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
      const groupDir = resolveGroupFolderPath(sourceGroup);
      const absolutePath = path.resolve(groupDir, data.workspacePath);
      const rel = path.relative(groupDir, absolutePath);

      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        await deps.sendMedia(data.chatJid, {
          kind: data.kind,
          path: absolutePath,
          caption: data.caption,
          filename: data.filename,
        });
        logger.info({ chatJid: data.chatJid, kind: data.kind, sourceGroup }, 'IPC media sent');
      } else {
        logger.warn({ workspacePath: data.workspacePath, sourceGroup }, 'IPC media path traversal blocked');
      }
    } else {
      logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC media attempt blocked');
    }
  }

  fs.unlinkSync(filePath);
}

/**
 * Starts the IPC file watcher that polls per-group `messages/` and `tasks/` directories.
 * Safe to call once; subsequent calls are no-ops.
 */
export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');

    return;
  }

  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');

  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async (): Promise<void> => {
    let groupFolders: string[];

    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f): boolean => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));

        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);

      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      try {
        if (fs.existsSync(messagesDir)) {
          for (const file of fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'))) {
            const filePath = path.join(messagesDir, file);

            try {
              await processMessageFile(filePath, sourceGroup, isMain, deps, registeredGroups);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              quarantineFile(filePath, ipcBaseDir, sourceGroup, file);
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
      }

      try {
        if (fs.existsSync(tasksDir)) {
          for (const file of fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'))) {
            const filePath = path.join(tasksDir, file);

            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as IpcTaskPayload;

              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
              quarantineFile(filePath, ipcBaseDir, sourceGroup, file);
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  void processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}
