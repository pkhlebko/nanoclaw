import fs, { createReadStream } from 'fs';
import path from 'path';

import { Bot, InputFile } from 'grammy';

import {
  ASSISTANT_NAME,
  MODEL_ALIAS_MAP,
  MODEL_OVERRIDE_TIMEOUT,
  TRIGGER_PATTERN,
} from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import {
  Channel,
  MessageAttachment,
  OnChatMetadata,
  OnInboundMessage,
  OutboundMedia,
  RegisteredGroup,
} from '../types.js';

/**
 * Converts markdown-formatted text to Telegram HTML subset.
 * Fenced code blocks and inline code are extracted as placeholders first
 * so their content is never processed by bold/italic regexes.
 */
export function markdownToTelegramHtml(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  // Step 1a: extract fenced code blocks
  let result = text.replace(/```(?:[^\n`]*)?\n([\s\S]*?)```/g, (_m, code: string) => {
    const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `\x00CB${codeBlocks.push(`<pre><code>${esc}</code></pre>`) - 1}\x00`;
  });

  // Step 1b: extract inline code spans
  result = result.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `\x00IC${inlineCode.push(`<code>${esc}</code>`) - 1}\x00`;
  });

  // Step 2: HTML-escape remaining plain text
  result = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Step 3: markdown → HTML (bold before italic to avoid ** partial match)
  result = result.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
  result = result.replace(/~~(.+?)~~/gs, '<s>$1</s>');
  result = result.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
  result = result.replace(/_([^_\n]+)_/g, '<i>$1</i>');
  result = result.replace(/^#{1,6} +(.+)$/gm, '<b>$1</b>');
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

  // Step 4 & 5: restore placeholders
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, i) => inlineCode[Number(i)]);
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, i) => codeBlocks[Number(i)]);

  return result;
}

/**
 * Splits a string into chunks of at most maxLen chars.
 * Prefers double-newline paragraph splits, then single-newline, then hard-split.
 */
export function chunkHtml(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];

  function splitLines(segment: string): void {
    const lines = segment.split('\n');
    let cur = '';
    for (const line of lines) {
      const cand = cur ? cur + '\n' + line : line;
      if (cand.length <= maxLen) {
        cur = cand;
        continue;
      }
      if (cur) chunks.push(cur);
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen));
        cur = '';
      } else {
        cur = line;
      }
    }
    if (cur) chunks.push(cur);
  }

  const paras = text.split('\n\n');
  let cur = '';
  for (const para of paras) {
    const cand = cur ? cur + '\n\n' + para : para;
    if (cand.length <= maxLen) {
      cur = cand;
      continue;
    }
    if (cur) chunks.push(cur);
    cur = '';
    if (para.length > maxLen) splitLines(para);
    else cur = para;
  }
  if (cur) chunks.push(cur);

  return chunks;
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private modelOverrides = new Map<string, string>();
  private modelTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Model switching commands
    const handleModelCommand = (
      alias: string,
      displayName: string,
    ): ((ctx: any) => void) => {
      return (ctx) => {
        const chatJid = `tg:${ctx.chat.id}`;
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) return;

        const model = MODEL_ALIAS_MAP[alias];
        this.setModelOverride(chatJid, model);
        ctx.reply(`Switched to ${displayName} for 30 min.`);
      };
    };

    this.bot.command('opus', handleModelCommand('opus', 'Opus'));
    this.bot.command('sonnet', handleModelCommand('sonnet', 'Sonnet'));
    this.bot.command('haiku', handleModelCommand('haiku', 'Haiku'));
    this.bot.command('default', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      this.clearModelOverride(chatJid);
      ctx.reply('Model reset to default.');
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;

      // Reset model override inactivity timer on any text message
      if (this.modelOverrides.has(chatJid)) {
        this.resetModelTimer(chatJid);
      }

      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      let content = `[Photo]${caption}`;

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let attachments: MessageAttachment[] | undefined;
      try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const buffer = await this.downloadFile(largest.file_id);
        if (buffer) {
          const ext = 'jpg';
          const savedName = `${Date.now()}-photo.${ext}`;
          const mediaDir = path.join(
            resolveGroupFolderPath(group.folder),
            'media',
          );
          fs.mkdirSync(mediaDir, { recursive: true });
          fs.writeFileSync(path.join(mediaDir, savedName), buffer);

          const MAX_BASE64_BYTES = 5 * 1024 * 1024;
          if (buffer.length <= MAX_BASE64_BYTES) {
            attachments = [
              {
                kind: 'image',
                mediaType: 'image/jpeg',
                base64: buffer.toString('base64'),
                filename: savedName,
              },
            ];
          } else {
            attachments = [
              {
                kind: 'file',
                filename: savedName,
                workspacePath: `media/${savedName}`,
              },
            ];
          }
        }
      } catch (err) {
        logger.warn({ err, chatJid }, 'Failed to download Telegram photo');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        attachments,
      });
    });

    this.bot.on('message:video', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      let content = `[Video]${caption}`;

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let attachments: MessageAttachment[] | undefined;
      const video = ctx.message.video;
      const MAX_FILE_BYTES = 20 * 1024 * 1024;
      if (video && (!video.file_size || video.file_size <= MAX_FILE_BYTES)) {
        try {
          const buffer = await this.downloadFile(video.file_id);
          if (buffer) {
            const ext = video.mime_type?.split('/')[1] || 'mp4';
            const savedName = `${Date.now()}-video.${ext}`;
            const mediaDir = path.join(
              resolveGroupFolderPath(group.folder),
              'media',
            );
            fs.mkdirSync(mediaDir, { recursive: true });
            fs.writeFileSync(path.join(mediaDir, savedName), buffer);
            attachments = [
              {
                kind: 'file',
                filename: savedName,
                workspacePath: `media/${savedName}`,
              },
            ];
          }
        } catch (err) {
          logger.warn({ err, chatJid }, 'Failed to download Telegram video');
        }
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        attachments,
      });
    });
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = '[Voice message]';
      try {
        const file = await this.bot!.api.getFile(ctx.message.voice.file_id);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const resp = await fetch(url);
          if (resp.ok) {
            const buffer = Buffer.from(await resp.arrayBuffer());
            const transcript = await transcribeAudio(buffer);
            if (transcript) {
              content = `[Voice: ${transcript}]`;
            }
          }
        }
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to download/transcribe voice');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));

    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const doc = ctx.message.document;
      const originalName = doc?.file_name || 'file';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      let content = `[Document: ${originalName}]${caption}`;

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let attachments: MessageAttachment[] | undefined;
      const MAX_FILE_BYTES = 20 * 1024 * 1024;
      if (!doc?.file_size || doc.file_size <= MAX_FILE_BYTES) {
        try {
          const buffer = await this.downloadFile(doc!.file_id);
          if (buffer) {
            const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
            const savedName = `${Date.now()}-${safeName}`;
            const mediaDir = path.join(
              resolveGroupFolderPath(group.folder),
              'media',
            );
            fs.mkdirSync(mediaDir, { recursive: true });
            fs.writeFileSync(path.join(mediaDir, savedName), buffer);

            // Images sent as documents (uncompressed) get vision support too
            const mime = doc?.mime_type || '';
            const imageTypes = [
              'image/jpeg',
              'image/png',
              'image/gif',
              'image/webp',
            ] as const;
            const isImage = imageTypes.includes(
              mime as (typeof imageTypes)[number],
            );
            const MAX_BASE64_BYTES = 5 * 1024 * 1024;
            if (isImage && buffer.length <= MAX_BASE64_BYTES) {
              attachments = [
                {
                  kind: 'image',
                  mediaType: mime as (typeof imageTypes)[number],
                  base64: buffer.toString('base64'),
                  filename: savedName,
                },
              ];
            } else {
              attachments = [
                {
                  kind: 'file',
                  filename: originalName,
                  workspacePath: `media/${savedName}`,
                },
              ];
            }
          }
        } catch (err) {
          logger.warn({ err, chatJid }, 'Failed to download Telegram document');
        }
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        attachments,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    const html = markdownToTelegramHtml(text);
    const chunks = chunkHtml(html, MAX_LENGTH);

    try {
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(numericId, chunk, { parse_mode: 'HTML' });
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error(
        { jid, err },
        'Failed to send Telegram message as HTML, retrying as plain text',
      );
      try {
        for (const chunk of chunkHtml(text, MAX_LENGTH)) {
          await this.bot.api.sendMessage(numericId, chunk);
        }
        logger.info({ jid, length: text.length }, 'Telegram message sent (plain text fallback)');
      } catch (fallbackErr) {
        logger.error({ jid, err: fallbackErr }, 'Failed to send Telegram message');
      }
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    for (const timer of this.modelTimers.values()) clearTimeout(timer);
    this.modelTimers.clear();
    this.modelOverrides.clear();

    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  getModelOverride(jid: string): string | undefined {
    return this.modelOverrides.get(jid);
  }

  private setModelOverride(chatJid: string, model: string): void {
    this.modelOverrides.set(chatJid, model);
    this.resetModelTimer(chatJid);
  }

  private clearModelOverride(chatJid: string): void {
    const timer = this.modelTimers.get(chatJid);
    if (timer) clearTimeout(timer);
    this.modelTimers.delete(chatJid);
    this.modelOverrides.delete(chatJid);
  }

  private async downloadFile(fileId: string): Promise<Buffer | null> {
    const file = await this.bot!.api.getFile(fileId);
    if (!file.file_path) return null;
    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  }

  private resetModelTimer(chatJid: string): void {
    const existing = this.modelTimers.get(chatJid);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.modelOverrides.delete(chatJid);
      this.modelTimers.delete(chatJid);
      this.sendMessage(chatJid, 'Model override expired, back to default.');
    }, MODEL_OVERRIDE_TIMEOUT);

    this.modelTimers.set(chatJid, timer);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async sendMedia(jid: string, media: OutboundMedia): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      const file = new InputFile(
        createReadStream(media.path),
        media.filename ?? path.basename(media.path),
      );
      const opts = media.caption ? { caption: media.caption } : {};
      switch (media.kind) {
        case 'photo':
          await this.bot.api.sendPhoto(numericId, file, opts);
          break;
        case 'document':
          await this.bot.api.sendDocument(numericId, file, opts);
          break;
        case 'video':
          await this.bot.api.sendVideo(numericId, file, opts);
          break;
        case 'audio':
          await this.bot.api.sendAudio(numericId, file, opts);
          break;
        case 'voice':
          await this.bot.api.sendVoice(numericId, file, opts);
          break;
        case 'animation':
          await this.bot.api.sendAnimation(numericId, file, opts);
          break;
      }
      logger.info({ jid, kind: media.kind }, 'Telegram media sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram media');
    }
  }
}
