import { createAppState, loadState, recoverPendingMessages, registerGroup } from './app-state.js';
import { TelegramChannel } from './channels/telegram.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { SHUTDOWN_TIMEOUT_MS, TELEGRAM_BOT_TOKEN, TELEGRAM_ONLY } from './config.js';
import { AvailableGroup, writeGroupsSnapshot } from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import { getAllChats, storeChatMetadata } from './db-chats.js';
import { initDatabase, storeMessage } from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { logger } from './logger.js';
import { startMessageLoop } from './message-loop.js';
import { processGroupMessages } from './message-processor.js';
import { findChannel, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';

const state = createAppState();
let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();

/**
 * Returns all known groups ordered by most recent activity.
 * Registered groups are flagged with `isRegistered: true`.
 */
export function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(state.registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  state.registeredGroups = groups;
}

async function main(): Promise<void> {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
  initDatabase();
  logger.info('Database initialized');
  loadState(state);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(SHUTDOWN_TIMEOUT_MS);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => {
      storeMessage(msg);

      if (msg.attachments?.length) {
        logger.info(
          { chatJid: msg.chat_jid, count: msg.attachments.length, kinds: msg.attachments.map((a) => a.kind) },
          'Caching attachments from inbound message',
        );
        const existing = state.pendingAttachments.get(msg.chat_jid) || [];

        existing.push(...msg.attachments);
        state.pendingAttachments.set(msg.chat_jid, existing);
      }
    },
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => state.registeredGroups,
  };

  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, channelOpts);

    channels.push(telegram);
    await telegram.connect();
  }

  if (!TELEGRAM_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  startSchedulerLoop({
    registeredGroups: () => state.registeredGroups,
    getSessions: () => state.sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);

      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');

        return;
      }

      const text = formatOutbound(rawText);

      if (text) await channel.sendMessage(jid, text);
    },
  });

  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);

      if (!channel) throw new Error(`No channel for JID: ${jid}`);

      return channel.sendMessage(jid, text);
    },
    sendMedia: (jid, media) => {
      const channel = findChannel(channels, jid);

      if (!channel?.sendMedia) throw new Error(`Channel for ${jid} does not support media`);

      return channel.sendMedia(jid, media);
    },
    registeredGroups: () => state.registeredGroups,
    registerGroup: (jid, group) => registerGroup(jid, group, state),
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag) => writeGroupsSnapshot(gf, im, ag),
  });

  queue.setProcessMessagesFn((chatJid) => processGroupMessages(chatJid, state, { channels, queue, getAvailableGroups }));
  recoverPendingMessages(state, queue);
  startMessageLoop(state, { channels, queue }).catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
