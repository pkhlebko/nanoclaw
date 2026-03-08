/**
 * Mount Security Module for NanoClaw
 *
 * Validates additional mounts against an allowlist stored OUTSIDE the project root.
 * This prevents container agents from modifying security configuration.
 *
 * Allowlist location: ~/.config/nanoclaw/mount-allowlist.json
 */
import path from 'path';

import { CONTAINER_EXTRA_MOUNT_PREFIX, MOUNT_ALLOWLIST_PATH } from '../config.js';
import { logger } from '../logger.js';
import { AdditionalMount, AllowedRoot } from '../types.js';

import { loadMountAllowlist } from './allowlist-loader.js';
import { expandPath, findAllowedRoot, getRealPath, isValidContainerPath, matchesBlockedPattern } from './path-utils.js';

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
}

function checkContainerPath(containerPath: string): MountValidationResult | null {
  if (!isValidContainerPath(containerPath)) {
    return {
      allowed: false,
      reason: `Invalid container path: "${containerPath}" - must be relative, non-empty, and not contain ".."`,
    };
  }

  return null;
}

function resolveHostPath(hostPath: string): { realPath: string } | MountValidationResult {
  const expandedPath = expandPath(hostPath);
  const realPath = getRealPath(expandedPath);

  if (realPath === null) {
    return {
      allowed: false,
      reason: `Host path does not exist: "${hostPath}" (expanded: "${expandedPath}")`,
    };
  }

  return { realPath };
}

function checkBlockedPatterns(realPath: string, blockedPatterns: string[]): MountValidationResult | null {
  const blockedMatch = matchesBlockedPattern(realPath, blockedPatterns);

  if (blockedMatch !== null) {
    return { allowed: false, reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"` };
  }

  return null;
}

function checkAllowedRoot(realPath: string, allowedRoots: AllowedRoot[]): AllowedRoot | MountValidationResult {
  const allowedRoot = findAllowedRoot(realPath, allowedRoots);

  if (allowedRoot === null) {
    return {
      allowed: false,
      reason: `Path "${realPath}" is not under any allowed root. Allowed roots: ${allowedRoots.map((r) => expandPath(r.path)).join(', ')}`,
    };
  }

  return allowedRoot;
}

function determineReadonly(mount: AdditionalMount, allowedRoot: AllowedRoot, isMain: boolean, nonMainReadOnly: boolean): boolean {
  if (mount.readonly !== false) {
    return true;
  }

  if (!isMain && nonMainReadOnly) {
    logger.info({ mount: mount.hostPath }, 'Mount forced to read-only for non-main group');

    return true;
  }

  if (!allowedRoot.allowReadWrite) {
    logger.info({ mount: mount.hostPath, root: allowedRoot.path }, 'Mount forced to read-only - root does not allow read-write');

    return true;
  }

  return false;
}

/**
 * Validate a single additional mount against the allowlist.
 * Returns validation result with reason.
 */
export function validateMount(mount: AdditionalMount, isMain: boolean): MountValidationResult {
  const allowlist = loadMountAllowlist();

  if (allowlist === null) {
    return { allowed: false, reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}` };
  }

  const containerPath = mount.containerPath || path.basename(mount.hostPath);

  const containerPathDenial = checkContainerPath(containerPath);

  if (containerPathDenial) return containerPathDenial;

  const hostPathResult = resolveHostPath(mount.hostPath);

  if ('allowed' in hostPathResult) return hostPathResult;

  const { realPath } = hostPathResult;

  const blockedDenial = checkBlockedPatterns(realPath, allowlist.blockedPatterns);

  if (blockedDenial) return blockedDenial;

  const rootResult = checkAllowedRoot(realPath, allowlist.allowedRoots);

  if ('allowed' in rootResult) return rootResult;

  const allowedRoot = rootResult;

  const effectiveReadonly = determineReadonly(mount, allowedRoot, isMain, allowlist.nonMainReadOnly);

  return {
    allowed: true,
    reason: `Allowed under root "${allowedRoot.path}"${allowedRoot.description ? ` (${allowedRoot.description})` : ''}`,
    realHostPath: realPath,
    resolvedContainerPath: containerPath,
    effectiveReadonly,
  };
}

/**
 * Validate all additional mounts for a group.
 * Returns array of validated mounts (only those that passed validation).
 * Logs warnings for rejected mounts.
 */
export function validateAdditionalMounts(
  mounts: AdditionalMount[],
  groupName: string,
  isMain: boolean,
): Array<{
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}> {
  const validatedMounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }> = [];

  for (const mount of mounts) {
    const result = validateMount(mount, isMain);

    if (result.allowed) {
      validatedMounts.push({
        hostPath: result.realHostPath!,
        containerPath: `${CONTAINER_EXTRA_MOUNT_PREFIX}${result.resolvedContainerPath}`,
        readonly: result.effectiveReadonly!,
      });

      logger.debug(
        {
          group: groupName,
          hostPath: result.realHostPath,
          containerPath: result.resolvedContainerPath,
          readonly: result.effectiveReadonly,
          reason: result.reason,
        },
        'Mount validated successfully',
      );
    } else {
      logger.warn(
        {
          group: groupName,
          requestedPath: mount.hostPath,
          containerPath: mount.containerPath,
          reason: result.reason,
        },
        'Additional mount REJECTED',
      );
    }
  }

  return validatedMounts;
}
