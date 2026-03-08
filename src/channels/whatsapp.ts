import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WAMessage,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, STORE_DIR, WA_GROUP_SYNC_INTERVAL_MS } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

import { buildInboundMessage, extractContent } from './whatsapp-message.js';
import { syncGroupMetadataForSocket } from './whatsapp-sync.js';

/** Delay in milliseconds before retrying a reconnect after a failed attempt. */
const WA_RECONNECT_DELAY_MS = 5_000;

/** Delay in milliseconds before exiting after a QR code appears (allows log flush). */
const WA_QR_EXIT_DELAY_MS = 1_000;

/** Multiplier to convert a UNIX timestamp (seconds) to milliseconds. */
const MS_PER_SECOND = 1_000;

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');

    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn({ err }, 'Failed to fetch latest WA Web version, using default');

      return { version: undefined };
    });

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) this.handleQrCode();

      if (connection === 'close') {
        this.handleConnectionClose(lastDisconnect);
      } else if (connection === 'open') {
        this.handleConnectionOpen(onFirstOpen);
        onFirstOpen = undefined;
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      await this.handleMessagesUpsert(messages);
    });
  }

  private handleQrCode(): void {
    const msg = 'WhatsApp authentication required. Run /setup in Claude Code.';

    logger.error(msg);
    exec(`osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`);
    setTimeout(() => process.exit(1), WA_QR_EXIT_DELAY_MS);
  }

  private handleConnectionClose(lastDisconnect: { error?: Error } | undefined): void {
    this.connected = false;
    const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
    const shouldReconnect = reason !== DisconnectReason.loggedOut;

    logger.info({ reason, shouldReconnect, queuedMessages: this.outgoingQueue.length }, 'Connection closed');

    if (shouldReconnect) {
      logger.info('Reconnecting...');
      this.connectInternal().catch((err) => {
        logger.error({ err }, 'Failed to reconnect, retrying in 5s');
        setTimeout(() => {
          this.connectInternal().catch((err2) => {
            logger.error({ err: err2 }, 'Reconnection retry failed');
          });
        }, WA_RECONNECT_DELAY_MS);
      });
    } else {
      logger.info('Logged out. Run /setup to re-authenticate.');
      process.exit(0);
    }
  }

  private handleConnectionOpen(onFirstOpen?: () => void): void {
    this.connected = true;
    logger.info('Connected to WhatsApp');

    // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
    this.sock.sendPresenceUpdate('available').catch((err) => {
      logger.warn({ err }, 'Failed to send presence update');
    });

    // Build LID to phone mapping from auth state for self-chat translation
    if (this.sock.user) {
      const phoneUser = this.sock.user.id.split(':')[0];
      const lidUser = this.sock.user.lid?.split(':')[0];

      if (lidUser && phoneUser) {
        this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
        logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
      }
    }

    // Flush any messages queued while disconnected
    this.flushOutgoingQueue().catch((err) => logger.error({ err }, 'Failed to flush outgoing queue'));

    this.syncGroupMetadata().catch((err) => logger.error({ err }, 'Initial group sync failed'));

    // Set up daily sync timer (only once)
    if (!this.groupSyncTimerStarted) {
      this.groupSyncTimerStarted = true;
      setInterval(() => {
        this.syncGroupMetadata().catch((err) => logger.error({ err }, 'Periodic group sync failed'));
      }, WA_GROUP_SYNC_INTERVAL_MS);
    }

    if (onFirstOpen) onFirstOpen();
  }

  private async handleMessagesUpsert(messages: WAMessage[]): Promise<void> {
    for (const msg of messages) {
      if (!msg.message) continue;

      const rawJid = msg.key.remoteJid;

      if (!rawJid || rawJid === 'status@broadcast') continue;

      const chatJid = await this.translateJid(rawJid);
      const timestamp = new Date(Number(msg.messageTimestamp) * MS_PER_SECOND).toISOString();
      const isGroup = chatJid.endsWith('@g.us');

      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'whatsapp', isGroup);

      const groups = this.opts.registeredGroups();

      if (!groups[chatJid]) continue;

      const content = extractContent(msg);

      if (!content) continue;

      this.opts.onMessage(chatJid, buildInboundMessage(msg, chatJid, timestamp, content));
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix with assistant name on shared numbers so users can tell bot from human messages.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER ? text : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info({ jid, length: prefixed.length, queueSize: this.outgoingQueue.length }, 'WA disconnected, message queued');

      return;
    }

    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';

      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    await syncGroupMetadataForSocket(this.sock, force);
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;

    const lidUser = jid.split('@')[0].split(':')[0];

    const cached = this.lidToPhoneMap[lidUser];

    if (cached) {
      logger.debug({ lidJid: jid, phoneJid: cached }, 'Translated LID to phone JID (cached)');

      return cached;
    }

    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);

      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;

        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info({ lidJid: jid, phoneJid }, 'Translated LID to phone JID (signalRepository)');

        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;

    this.flushing = true;

    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;

        await this.sock.sendMessage(item.jid, { text: item.text });
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}
