import fs from 'fs';
import path from 'path';

import { Bot } from 'grammy';

import { ASSISTANT_NAME, MODEL_ALIAS_MAP, TELEGRAM_MAX_FILE_BYTES, TELEGRAM_MAX_IMAGE_BYTES, TRIGGER_PATTERN } from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { MessageAttachment, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

import { ModelOverrideManager } from './telegram-model-override.js';

const UNIX_TO_MS = 1000;

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

type DownloadFile = (fileId: string) => Promise<Buffer | null>;

interface MessageContext {
  chatJid: string;
  timestamp: string;
  senderName: string;
  sender: string;
  msgId: string;
  isGroup: boolean;
  caption: string;
}

function extractMessageContext(ctx: any): MessageContext {
  return {
    chatJid: `tg:${ctx.chat.id}`,
    timestamp: new Date(ctx.message.date * UNIX_TO_MS).toISOString(),
    senderName: ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown',
    sender: ctx.from?.id?.toString() || '',
    msgId: ctx.message.message_id.toString(),
    isGroup: ctx.chat.type === 'group' || ctx.chat.type === 'supergroup',
    caption: ctx.message.caption ? ` ${ctx.message.caption}` : '',
  };
}

function saveToMediaDir(buffer: Buffer, folder: string, savedName: string): void {
  const mediaDir = path.join(resolveGroupFolderPath(folder), 'media');

  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, savedName), buffer);
}

function storeSimpleMessage(ctx: any, placeholder: string, opts: TelegramChannelOpts): void {
  const { chatJid, timestamp, senderName, sender, msgId, isGroup, caption } = extractMessageContext(ctx);
  const group = opts.registeredGroups()[chatJid];

  if (!group) return;

  opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);
  opts.onMessage(chatJid, {
    id: msgId,
    chat_jid: chatJid,
    sender,
    sender_name: senderName,
    content: `${placeholder}${caption}`,
    timestamp,
    is_from_me: false,
  });
}

export function registerCommandHandlers(bot: Bot, opts: TelegramChannelOpts, overrideMgr: ModelOverrideManager): void {
  const handleModelCommand = (alias: string, displayName: string) => async (ctx: any) => {
    const chatJid = `tg:${ctx.chat.id}`;

    if (!opts.registeredGroups()[chatJid]) return;

    overrideMgr.set(chatJid, MODEL_ALIAS_MAP[alias]);
    await ctx.reply(`Switched to ${displayName} for 30 min.`);
  };

  bot.command('opus', handleModelCommand('opus', 'Opus'));
  bot.command('sonnet', handleModelCommand('sonnet', 'Sonnet'));
  bot.command('haiku', handleModelCommand('haiku', 'Haiku'));
  bot.command('default', async (ctx) => {
    const chatJid = `tg:${ctx.chat.id}`;

    if (!opts.registeredGroups()[chatJid]) return;

    overrideMgr.clear(chatJid);
    await ctx.reply('Model reset to default.');
  });
  bot.command('chatid', async (ctx) => {
    const chatType = ctx.chat.type;
    const chatName = chatType === 'private' ? ctx.from?.first_name || 'Private' : (ctx.chat as any).title || 'Unknown';

    await ctx.reply(`Chat ID: \`tg:${ctx.chat.id}\`\nName: ${chatName}\nType: ${chatType}`, { parse_mode: 'Markdown' });
  });
  bot.command('ping', async (ctx) => {
    await ctx.reply(`${ASSISTANT_NAME} is online.`);
  });
}

export function registerTextHandler(bot: Bot, opts: TelegramChannelOpts, overrideMgr: ModelOverrideManager): void {
  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;

    const { chatJid, timestamp, senderName, sender, msgId, isGroup } = extractMessageContext(ctx);

    overrideMgr.refresh(chatJid);

    let content = ctx.message.text;
    const botUsername = ctx.me?.username?.toLowerCase();

    if (botUsername) {
      const entities = ctx.message.entities || [];
      const isBotMentioned = entities.some((entity: any) => {
        if (entity.type === 'mention') {
          const mentionText = content.substring(entity.offset, entity.offset + entity.length).toLowerCase();

          return mentionText === `@${botUsername}`;
        }

        return false;
      });

      if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    const chatName = ctx.chat.type === 'private' ? senderName : (ctx.chat as any).title || chatJid;

    opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

    const group = opts.registeredGroups()[chatJid];

    if (!group) {
      logger.debug({ chatJid, chatName }, 'Message from unregistered Telegram chat');

      return;
    }

    opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, chatName, sender: senderName }, 'Telegram message stored');
  });
}

function registerPhotoHandler(bot: Bot, opts: TelegramChannelOpts, downloadFile: DownloadFile): void {
  bot.on('message:photo', async (ctx) => {
    const { chatJid, timestamp, senderName, sender, msgId, isGroup, caption } = extractMessageContext(ctx);
    const group = opts.registeredGroups()[chatJid];

    if (!group) return;

    opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

    let attachments: MessageAttachment[] | undefined;

    try {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const buffer = await downloadFile(largest.file_id);

      if (buffer) {
        const savedName = `${Date.now()}-photo.jpg`;

        saveToMediaDir(buffer, group.folder, savedName);
        attachments =
          buffer.length <= TELEGRAM_MAX_IMAGE_BYTES
            ? [{ kind: 'image', mediaType: 'image/jpeg', base64: buffer.toString('base64'), filename: savedName }]
            : [{ kind: 'file', filename: savedName, workspacePath: `media/${savedName}` }];
      }
    } catch (err) {
      logger.warn({ err, chatJid }, 'Failed to download Telegram photo');
    }

    opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: `[Photo]${caption}`,
      timestamp,
      is_from_me: false,
      attachments,
    });
  });
}

function registerVideoHandler(bot: Bot, opts: TelegramChannelOpts, downloadFile: DownloadFile): void {
  bot.on('message:video', async (ctx) => {
    const { chatJid, timestamp, senderName, sender, msgId, isGroup, caption } = extractMessageContext(ctx);
    const group = opts.registeredGroups()[chatJid];

    if (!group) return;

    const video = ctx.message.video;
    let attachments: MessageAttachment[] | undefined;

    opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

    if (video && (!video.file_size || video.file_size <= TELEGRAM_MAX_FILE_BYTES)) {
      try {
        const buffer = await downloadFile(video.file_id);

        if (buffer) {
          const ext = video.mime_type?.split('/')[1] || 'mp4';
          const savedName = `${Date.now()}-video.${ext}`;

          saveToMediaDir(buffer, group.folder, savedName);
          attachments = [{ kind: 'file', filename: savedName, workspacePath: `media/${savedName}` }];
        }
      } catch (err) {
        logger.warn({ err, chatJid }, 'Failed to download Telegram video');
      }
    }

    opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: `[Video]${caption}`,
      timestamp,
      is_from_me: false,
      attachments,
    });
  });
}

function registerVoiceHandler(bot: Bot, opts: TelegramChannelOpts, downloadFile: DownloadFile): void {
  bot.on('message:voice', async (ctx) => {
    const { chatJid, timestamp, senderName, sender, msgId, isGroup } = extractMessageContext(ctx);
    const group = opts.registeredGroups()[chatJid];

    if (!group) return;

    opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

    let content = '[Voice message]';

    try {
      const buffer = await downloadFile(ctx.message.voice.file_id);

      if (buffer) {
        const transcript = await transcribeAudio(buffer);

        if (transcript) content = `[Voice: ${transcript}]`;
      }
    } catch (err) {
      logger.error({ err, chatJid }, 'Failed to download/transcribe voice');
    }

    opts.onMessage(chatJid, { id: msgId, chat_jid: chatJid, sender, sender_name: senderName, content, timestamp, is_from_me: false });
  });
}

function registerDocumentHandler(bot: Bot, opts: TelegramChannelOpts, downloadFile: DownloadFile): void {
  bot.on('message:document', async (ctx) => {
    const { chatJid, timestamp, senderName, sender, msgId, isGroup, caption } = extractMessageContext(ctx);
    const group = opts.registeredGroups()[chatJid];

    if (!group) return;

    const doc = ctx.message.document;
    const originalName = doc?.file_name || 'file';
    let attachments: MessageAttachment[] | undefined;

    opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

    if (!doc?.file_size || doc.file_size <= TELEGRAM_MAX_FILE_BYTES) {
      try {
        const buffer = await downloadFile(doc!.file_id);

        if (buffer) {
          const savedName = `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

          saveToMediaDir(buffer, group.folder, savedName);

          const mime = doc?.mime_type || '';
          const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
          const isImage = imageTypes.includes(mime as (typeof imageTypes)[number]);

          attachments =
            isImage && buffer.length <= TELEGRAM_MAX_IMAGE_BYTES
              ? [{ kind: 'image', mediaType: mime as (typeof imageTypes)[number], base64: buffer.toString('base64'), filename: savedName }]
              : [{ kind: 'file', filename: originalName, workspacePath: `media/${savedName}` }];
        }
      } catch (err) {
        logger.warn({ err, chatJid }, 'Failed to download Telegram document');
      }
    }

    opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: `[Document: ${originalName}]${caption}`,
      timestamp,
      is_from_me: false,
      attachments,
    });
  });
}

export function registerMediaHandlers(bot: Bot, opts: TelegramChannelOpts, downloadFile: DownloadFile): void {
  registerPhotoHandler(bot, opts, downloadFile);
  registerVideoHandler(bot, opts, downloadFile);
  registerVoiceHandler(bot, opts, downloadFile);
  registerDocumentHandler(bot, opts, downloadFile);
  bot.on('message:audio', (ctx) => storeSimpleMessage(ctx, '[Audio]', opts));
  bot.on('message:sticker', (ctx) => {
    const emoji = ctx.message.sticker?.emoji || '';

    storeSimpleMessage(ctx, `[Sticker ${emoji}]`, opts);
  });
  bot.on('message:location', (ctx) => storeSimpleMessage(ctx, '[Location]', opts));
  bot.on('message:contact', (ctx) => storeSimpleMessage(ctx, '[Contact]', opts));
}
