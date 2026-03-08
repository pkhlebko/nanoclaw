import { createTask, deleteTask, getTaskById, updateTask } from '../db/tasks.js';
import { isValidGroupFolder } from '../groups/folder.js';
import { logger } from '../logger.js';
import { computeNextRun, InvalidScheduleError } from '../scheduling/utils.js';
import { AvailableGroup, RegisteredGroup } from '../types.js';

/** Subset of IpcDeps required by task IPC processing. */
export interface IpcTasksDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (groupFolder: string, isMain: boolean, availableGroups: AvailableGroup[]) => void;
}

/** Payload shape received in an IPC task file. */
export interface IpcTaskPayload {
  type: string;
  taskId?: string;
  prompt?: string;
  schedule_type?: string;
  schedule_value?: string;
  context_mode?: string;
  groupFolder?: string;
  chatJid?: string;
  targetJid?: string;
  jid?: string;
  name?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  containerConfig?: RegisteredGroup['containerConfig'];
}

/** Prefix used when generating unique task IDs. */
const TASK_ID_PREFIX = 'task-';
const TASK_ID_RANDOM_RADIX = 36;
const TASK_ID_RANDOM_START = 2;
const TASK_ID_RANDOM_END = 8;

function generateTaskId(): string {
  return `${TASK_ID_PREFIX}${Date.now()}-${Math.random().toString(TASK_ID_RANDOM_RADIX).slice(TASK_ID_RANDOM_START, TASK_ID_RANDOM_END)}`;
}

async function handleScheduleTask(data: IpcTaskPayload, sourceGroup: string, isMain: boolean, deps: IpcTasksDeps): Promise<void> {
  if (!data.prompt || !data.schedule_type || !data.schedule_value || !data.targetJid) {
    return;
  }

  const registeredGroups = deps.registeredGroups();
  const targetGroupEntry = registeredGroups[data.targetJid];

  if (!targetGroupEntry) {
    logger.warn({ targetJid: data.targetJid }, 'Cannot schedule task: target group not registered');

    return;
  }

  const targetFolder = targetGroupEntry.folder;

  if (!isMain && targetFolder !== sourceGroup) {
    logger.warn({ sourceGroup, targetFolder }, 'Unauthorized schedule_task attempt blocked');

    return;
  }

  const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';
  let nextRun: string | null;

  try {
    nextRun = computeNextRun(scheduleType, data.schedule_value);
  } catch (err) {
    if (err instanceof InvalidScheduleError) {
      logger.warn({ scheduleValue: data.schedule_value }, err.message);
    } else {
      logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
    }

    return;
  }

  const taskId = generateTaskId();
  const contextMode = data.context_mode === 'group' || data.context_mode === 'isolated' ? data.context_mode : 'isolated';

  createTask({
    id: taskId,
    group_folder: targetFolder,
    chat_jid: data.targetJid,
    prompt: data.prompt,
    schedule_type: scheduleType,
    schedule_value: data.schedule_value,
    context_mode: contextMode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  logger.info({ taskId, sourceGroup, targetFolder, contextMode }, 'Task created via IPC');
}

function handleRegisterGroup(data: IpcTaskPayload, isMain: boolean, deps: IpcTasksDeps): void {
  if (!isMain) {
    logger.warn({ sourceGroup: 'unknown' }, 'Unauthorized register_group attempt blocked');

    return;
  }

  if (!data.jid || !data.name || !data.folder || !data.trigger) {
    logger.warn({ data }, 'Invalid register_group request - missing required fields');

    return;
  }

  if (!isValidGroupFolder(data.folder)) {
    logger.warn({ folder: data.folder }, 'Invalid register_group request - unsafe folder name');

    return;
  }

  deps.registerGroup(data.jid, {
    name: data.name,
    folder: data.folder,
    trigger: data.trigger,
    added_at: new Date().toISOString(),
    containerConfig: data.containerConfig,
    requiresTrigger: data.requiresTrigger,
  });
}

/**
 * Processes a single IPC task payload dispatched from the IPC watcher.
 *
 * @param data - Parsed task payload from an IPC JSON file.
 * @param sourceGroup - The group folder that wrote the file (verified by directory).
 * @param isMain - Whether the source group is the main group.
 * @param deps - External dependencies required for task operations.
 */
export async function processTaskIpc(data: IpcTaskPayload, sourceGroup: string, isMain: boolean, deps: IpcTasksDeps): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      await handleScheduleTask(data, sourceGroup, isMain, deps);
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);

        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task pause attempt');
        }
      }

      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);

        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task resume attempt');
        }
      }

      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);

        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
        }
      }

      break;

    case 'refresh_groups':
      if (isMain) {
        logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
        await deps.syncGroupMetadata(true);
        const availableGroups = deps.getAvailableGroups();

        deps.writeGroupsSnapshot(sourceGroup, true, availableGroups);
      } else {
        logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
      }

      break;

    case 'register_group':
      handleRegisterGroup(data, isMain, deps);
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
