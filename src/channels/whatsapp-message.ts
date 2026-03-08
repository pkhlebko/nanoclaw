import { WAMessage } from '@whiskeysockets/baileys';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME } from '../config.js';
import { NewMessage } from '../types.js';

/**
 * Extracts the text content from a WhatsApp message.
 * Returns an empty string when no textual content is present.
 *
 * @param msg - The raw WhatsApp message.
 * @returns The extracted text, or an empty string.
 */
export function extractContent(msg: WAMessage): string {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''
  );
}

/**
 * Builds a structured {@link NewMessage} from a raw WAMessage.
 *
 * @param msg - The raw WhatsApp message.
 * @param chatJid - The resolved chat JID (phone format, not LID).
 * @param timestamp - ISO timestamp of the message.
 * @param content - The already-extracted text content.
 * @returns A NewMessage object ready for the agent.
 */
export function buildInboundMessage(msg: WAMessage, chatJid: string, timestamp: string, content: string): NewMessage {
  const sender = msg.key.participant || msg.key.remoteJid || '';
  const senderName = msg.pushName || sender.split('@')[0];
  const fromMe = msg.key.fromMe || false;
  const isBotMessage = ASSISTANT_HAS_OWN_NUMBER ? fromMe : content.startsWith(`${ASSISTANT_NAME}:`);

  return {
    id: msg.key.id || '',
    chat_jid: chatJid,
    sender,
    sender_name: senderName,
    content,
    timestamp,
    is_from_me: fromMe,
    is_bot_message: isBotMessage,
  };
}
