import { AppState, saveState } from './app-state.js';
import { ASSISTANT_NAME, MAIN_GROUP_FOLDER, MODEL_FLAG_REGEX, POLL_INTERVAL, TRIGGER_PATTERN } from './config.js';
import { getMessagesSince, getNewMessages } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { findChannel, formatMessages } from './router.js';
import { Channel, NewMessage } from './types.js';

/** Dependencies required by the message loop. */
export interface LoopDeps {
  channels: Channel[];
  queue: GroupQueue;
}

function routeGroupMessages(chatJid: string, groupMessages: NewMessage[], state: AppState, deps: LoopDeps): void {
  const group = state.registeredGroups[chatJid];

  if (!group) return;

  const channel = findChannel(deps.channels, chatJid);

  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');

    return;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

  if (needsTrigger) {
    const hasTrigger = groupMessages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));

    if (!hasTrigger) return;
  }

  const allPending = getMessagesSince(chatJid, state.lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);
  const messagesToSend = allPending.length > 0 ? allPending : groupMessages;
  const formatted = formatMessages(messagesToSend);
  const lastContent = messagesToSend[messagesToSend.length - 1].content.trim();
  const hasModelFlag = MODEL_FLAG_REGEX.test(lastContent);
  const hasAttachments = state.pendingAttachments.has(chatJid);

  if (!hasModelFlag && !hasAttachments && deps.queue.sendMessage(chatJid, formatted)) {
    logger.debug({ chatJid, count: messagesToSend.length }, 'Piped messages to active container');
    state.lastAgentTimestamp[chatJid] = messagesToSend[messagesToSend.length - 1].timestamp;
    saveState(state);
    channel.setTyping?.(chatJid, true)?.catch((err) => logger.warn({ chatJid, err }, 'Failed to set typing indicator'));
  } else {
    if (hasModelFlag || hasAttachments) {
      logger.debug({ chatJid, hasModelFlag, hasAttachments }, 'Closing active container to force new one');
      deps.queue.closeStdin(chatJid);
    }

    deps.queue.enqueueMessageCheck(chatJid);
  }
}

/**
 * Poll for new messages and route them to the appropriate group handler.
 * Runs until the process exits. Only one instance should run at a time.
 */
export async function startMessageLoop(state: AppState, deps: LoopDeps): Promise<void> {
  if (state.messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');

    return;
  }

  state.messageLoopRunning = true;
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(state.registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, state.lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');
        state.lastTimestamp = newTimestamp;
        saveState(state);

        const messagesByGroup = new Map<string, NewMessage[]>();

        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);

          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          routeGroupMessages(chatJid, groupMessages, state, deps);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}
