import { Channel, NewMessage } from '../types.js';

/** Escape XML special characters in a string. */
export function escapeXml(s: string): string {
  if (!s) return '';

  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Format an array of messages into XML for the agent prompt. */
export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map(
    (m) => `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );

  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

/** Strip `<internal>…</internal>` reasoning blocks from agent output. */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/** Format outbound text by stripping internal tags. */
export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);

  if (!text) return '';

  return text;
}

/** Find the channel that owns a given JID. */
export function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
