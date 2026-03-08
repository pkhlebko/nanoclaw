import { createReadStream } from 'fs';
import path from 'path';

import { Bot, InputFile } from 'grammy';

import { TELEGRAM_MAX_MESSAGE_LENGTH } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OutboundMedia } from '../types.js';

import { chunkHtml, markdownToTelegramHtml } from './telegram-formatters.js';
import { TelegramChannelOpts, registerCommandHandlers, registerMediaHandlers, registerTextHandler } from './telegram-handlers.js';
import { ModelOverrideManager } from './telegram-model-override.js';

export type { TelegramChannelOpts } from './telegram-handlers.js';

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private readonly opts: TelegramChannelOpts;
  private readonly botToken: string;
  private readonly overrideMgr: ModelOverrideManager;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
    this.overrideMgr = new ModelOverrideManager((jid) => {
      this.sendMessage(jid, 'Model override expired, back to default.').catch((err) => {
        logger.error({ jid, err }, 'Failed to send model override expiry message');
      });
    });
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    registerCommandHandlers(this.bot, this.opts, this.overrideMgr);
    registerTextHandler(this.bot, this.opts, this.overrideMgr);
    registerMediaHandlers(this.bot, this.opts, (fileId) => this.downloadFile(fileId));

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    return new Promise<void>((resolve) => {
      void this.bot!.start({
        onStart: (botInfo) => {
          logger.info({ username: botInfo.username, id: botInfo.id }, 'Telegram bot connected');
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log("  Send /chatid to the bot to get a chat's registration ID\n");
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
    const html = markdownToTelegramHtml(text);
    const chunks = chunkHtml(html, TELEGRAM_MAX_MESSAGE_LENGTH);

    try {
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(numericId, chunk, { parse_mode: 'HTML' });
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message as HTML, retrying as plain text');

      try {
        for (const chunk of chunkHtml(text, TELEGRAM_MAX_MESSAGE_LENGTH)) {
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
    this.overrideMgr.clearAll();

    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  getModelOverride(jid: string): string | undefined {
    return this.overrideMgr.get(jid);
  }

  private async downloadFile(fileId: string): Promise<Buffer | null> {
    const file = await this.bot!.api.getFile(fileId);

    if (!file.file_path) return null;

    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const resp = await fetch(url);

    if (!resp.ok) return null;

    return Buffer.from(await resp.arrayBuffer());
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
      const file = new InputFile(createReadStream(media.path), media.filename ?? path.basename(media.path));
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
