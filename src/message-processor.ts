import { AppState, saveState } from './app-state.js';
import {
  ASSISTANT_NAME,
  DEFAULT_MODEL,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MODEL_ALIAS_MAP,
  MODEL_FLAG_REGEX,
  TRIGGER_PATTERN,
} from './config.js';
import { AvailableGroup, ContainerOutput, runContainerAgent, writeGroupsSnapshot, writeTasksSnapshot } from './container-runner.js';
import { getAllTasks } from './db-tasks.js';
import { getMessagesSince, setSession } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { findChannel, formatMessages } from './router.js';
import { Channel, MessageAttachment, RegisteredGroup } from './types.js';

/** Strips `<internal>…</internal>` reasoning blocks from agent output before sending to users. */
const INTERNAL_BLOCK_REGEX = /<internal>[\s\S]*?<\/internal>/g;

/** Options for a single agent container invocation. */
export interface RunAgentOpts {
  prompt: string;
  chatJid: string;
  model?: string;
  attachments?: MessageAttachment[];
  onOutput?: (output: ContainerOutput) => Promise<void>;
  /** Returns the current list of available groups for the snapshot written before each run. */
  getAvailableGroups: () => AvailableGroup[];
}

/** Mutable outcome flags written by the streaming output handler back to processGroupMessages. */
interface AgentRunResult {
  hadError: boolean;
  outputSentToUser: boolean;
}

/**
 * Parse `--model <alias>` prefix from a prompt and resolve to a full model ID.
 * Returns the resolved model and the prompt with the flag stripped.
 */
export function parseModelFlag(prompt: string): { model?: string; prompt: string } {
  const match = prompt.match(MODEL_FLAG_REGEX);

  if (!match) {
    return { model: undefined, prompt };
  }

  const alias = match[1];
  const model = MODEL_ALIAS_MAP[alias] ?? alias;

  return { model, prompt: prompt.slice(match[0].length) };
}

function updateSession(folder: string, newSessionId: string, state: AppState): void {
  state.sessions[folder] = newSessionId;
  setSession(folder, newSessionId);
}

function setupIdleTimer(group: RegisteredGroup, queue: GroupQueue, chatJid: string): { reset: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    reset: () => {
      if (timer) clearTimeout(timer);

      timer = setTimeout(() => {
        logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
        queue.closeStdin(chatJid);
      }, IDLE_TIMEOUT);
    },
    clear: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

function createOutputHandler(
  group: RegisteredGroup,
  channel: Channel,
  chatJid: string,
  queue: GroupQueue,
  opts: { onIdle: () => void; result: AgentRunResult },
): (output: ContainerOutput) => Promise<void> {
  const { onIdle, result } = opts;

  return async (output) => {
    if (output.result) {
      const raw = typeof output.result === 'string' ? output.result : JSON.stringify(output.result);
      const text = raw.replace(INTERNAL_BLOCK_REGEX, '').trim();

      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);

      if (text) {
        await channel.sendMessage(chatJid, text);
        result.outputSentToUser = true;
      }

      onIdle();
    }

    if (output.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (output.status === 'error') {
      result.hadError = true;
    }
  };
}

/**
 * Run a container agent for the given group.
 * Updates session ID in state when the container reports one.
 * @returns `'success'` or `'error'`
 */
export async function runAgent(
  group: RegisteredGroup,
  opts: RunAgentOpts,
  state: AppState,
  queue: GroupQueue,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = state.sessions[group.folder];

  writeTasksSnapshot(
    group.folder,
    isMain,
    getAllTasks().map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  writeGroupsSnapshot(group.folder, isMain, opts.getAvailableGroups());

  const wrappedOnOutput = opts.onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          updateSession(group.folder, output.newSessionId, state);
        }

        await opts.onOutput!(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: opts.prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid: opts.chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        model: opts.model,
        attachments: opts.attachments,
      },
      (proc, containerName) => queue.registerProcess(opts.chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      updateSession(group.folder, output.newSessionId, state);
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Container agent error');

      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');

    return 'error';
  }
}

/** Deps required by processGroupMessages. */
export interface ProcessDeps {
  channels: Channel[];
  queue: GroupQueue;
  /** Returns available groups for the agent snapshot written before each run. */
  getAvailableGroups: () => AvailableGroup[];
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it is this group's turn.
 * @returns `true` on success or skip, `false` on retriable error
 */
export async function processGroupMessages(chatJid: string, state: AppState, deps: ProcessDeps): Promise<boolean> {
  const group = state.registeredGroups[chatJid];

  if (!group) return true;

  const channel = findChannel(deps.channels, chatJid);

  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');

    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const missedMessages = getMessagesSince(chatJid, state.lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));

    if (!hasTrigger) return true;
  }

  const lastMsg = missedMessages[missedMessages.length - 1];
  const { model: flagModel, prompt: strippedContent } = parseModelFlag(lastMsg.content.trim());
  const overrideModel = channel.getModelOverride?.(chatJid);
  const parsedModel = flagModel ?? overrideModel ?? DEFAULT_MODEL;
  const messagesForFormat =
    strippedContent !== lastMsg.content.trim()
      ? [...missedMessages.slice(0, -1), { ...lastMsg, content: strippedContent }]
      : missedMessages;

  const prompt = formatMessages(messagesForFormat);
  const attachments = state.pendingAttachments.get(chatJid);

  state.pendingAttachments.delete(chatJid);

  const previousCursor = state.lastAgentTimestamp[chatJid] || '';

  state.lastAgentTimestamp[chatJid] = lastMsg.timestamp;
  saveState(state);
  logger.info({ group: group.name, messageCount: missedMessages.length, attachmentCount: attachments?.length || 0 }, 'Processing messages');

  const idleTimer = setupIdleTimer(group, deps.queue, chatJid);
  const agentResult: AgentRunResult = { hadError: false, outputSentToUser: false };
  const outputHandler = createOutputHandler(group, channel, chatJid, deps.queue, { onIdle: idleTimer.reset, result: agentResult });

  await channel.setTyping?.(chatJid, true);
  const runResult = await runAgent(
    group,
    { prompt, chatJid, model: parsedModel, attachments, onOutput: outputHandler, getAvailableGroups: deps.getAvailableGroups },
    state,
    deps.queue,
  );

  await channel.setTyping?.(chatJid, false);
  idleTimer.clear();

  if (runResult === 'error' || agentResult.hadError) {
    if (agentResult.outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');

      return true;
    }

    state.lastAgentTimestamp[chatJid] = previousCursor;
    saveState(state);
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');

    return false;
  }

  return true;
}
