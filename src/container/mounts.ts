import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, TIMEZONE } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from '../groups/folder.js';
import { logger } from '../logger.js';
import { validateAdditionalMounts } from '../security/mount-security.js';
import { RegisteredGroup } from '../types.js';

import { readonlyMountArgs } from './runtime.js';

// Container runs as user `node` (uid 1000); skip --user flag when host uid matches
const CONTAINER_NODE_UID = 1000;

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export function buildVolumeMounts(group: RegisteredGroup, isMain: boolean): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({ hostPath: projectRoot, containerPath: '/workspace/project', readonly: true });
    mounts.push({ hostPath: groupDir, containerPath: '/workspace/group', readonly: false });
  } else {
    mounts.push({ hostPath: groupDir, containerPath: '/workspace/group', readonly: false });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');

    if (fs.existsSync(globalDir)) {
      mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');

  fs.mkdirSync(groupSessionsDir, { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');

  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');

  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);

      if (!fs.statSync(srcDir).isDirectory()) continue;

      const dstDir = path.join(skillsDst, skillDir);

      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  mounts.push({ hostPath: groupSessionsDir, containerPath: '/home/node/.claude', readonly: false });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);

  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({ hostPath: groupIpcDir, containerPath: '/workspace/ipc', readonly: false });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  const groupAgentRunnerDir = path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src');

  if (fs.existsSync(agentRunnerSrc)) {
    if (!fs.existsSync(groupAgentRunnerDir)) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    } else {
      // Sync upstream changes: overwrite per-group files that are older than upstream
      const srcIndex = path.join(agentRunnerSrc, 'index.ts');
      const dstIndex = path.join(groupAgentRunnerDir, 'index.ts');

      if (fs.existsSync(srcIndex) && fs.existsSync(dstIndex)) {
        const srcMtime = fs.statSync(srcIndex).mtimeMs;
        const dstMtime = fs.statSync(dstIndex).mtimeMs;

        if (srcMtime > dstMtime) {
          fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
          logger.info({ group: group.folder }, 'Updated agent-runner source from upstream');
        }
      }
    }
  }

  mounts.push({ hostPath: groupAgentRunnerDir, containerPath: '/app/src', readonly: false });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(group.containerConfig.additionalMounts, group.name, isMain);

    mounts.push(...validatedMounts);
  }

  return mounts;
}

export function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass Home Assistant credentials if configured
  const haEnv = readEnvFile(['HA_URL', 'HA_TOKEN']);

  if (haEnv.HA_URL) args.push('-e', `HA_URL=${haEnv.HA_URL}`);

  if (haEnv.HA_TOKEN) args.push('-e', `HA_TOKEN=${haEnv.HA_TOKEN}`);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();

  if (hostUid !== undefined && hostUid !== 0 && hostUid !== CONTAINER_NODE_UID) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}
