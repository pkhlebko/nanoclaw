import fs from 'fs';
import path from 'path';

import { JSON_INDENT } from '../config.js';
import { resolveGroupIpcPath } from '../groups/folder.js';
import { AvailableGroup } from '../types.js';

/**
 * Write current tasks snapshot into the group's IPC directory for the container to read.
 * Main group sees all tasks; non-main groups see only their own.
 */
export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);

  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain ? tasks : tasks.filter((t) => t.groupFolder === groupFolder);
  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');

  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, JSON_INDENT));
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(groupFolder: string, isMain: boolean, groups: AvailableGroup[]): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);

  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];
  const groupsFile = path.join(groupIpcDir, 'available_groups.json');

  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      JSON_INDENT,
    ),
  );
}
