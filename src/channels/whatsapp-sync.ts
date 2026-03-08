import { WASocket } from '@whiskeysockets/baileys';

import { WA_GROUP_SYNC_INTERVAL_MS } from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db/chats.js';
import { logger } from '../logger.js';

/**
 * Fetches all group metadata from WhatsApp and stores names in the database.
 * Respects a 24-hour cache unless {@link force} is true.
 *
 * @param sock - The active WASocket connection.
 * @param force - If true, bypass the cache and always sync.
 */
export async function syncGroupMetadataForSocket(sock: WASocket, force = false): Promise<void> {
  if (!force) {
    const lastSync = getLastGroupSync();

    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();

      if (Date.now() - lastSyncTime < WA_GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');

        return;
      }
    }
  }

  try {
    logger.info('Syncing group metadata from WhatsApp...');
    const groups = await sock.groupFetchAllParticipating();

    let count = 0;

    for (const [jid, metadata] of Object.entries(groups)) {
      if (metadata.subject) {
        updateChatName(jid, metadata.subject);
        count++;
      }
    }

    setLastGroupSync();
    logger.info({ count }, 'Group metadata synced');
  } catch (err) {
    logger.error({ err }, 'Failed to sync group metadata');
  }
}
