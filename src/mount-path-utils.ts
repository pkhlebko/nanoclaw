import fs from 'fs';
import os from 'os';
import path from 'path';

import { AllowedRoot } from './types.js';

/**
 * Expand ~ to home directory and resolve to absolute path
 */
export function expandPath(p: string): string {
  const homeDir = process.env.HOME || os.homedir();

  if (p.startsWith('~/')) {
    return path.join(homeDir, p.slice(2));
  }

  if (p === '~') {
    return homeDir;
  }

  return path.resolve(p);
}

/**
 * Get the real path, resolving symlinks.
 * Returns null if the path doesn't exist.
 */
export function getRealPath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Check if a path matches any blocked pattern.
 * Returns the matching pattern, or null if none.
 */
export function matchesBlockedPattern(realPath: string, blockedPatterns: string[]): string | null {
  const pathParts = realPath.split(path.sep);

  for (const pattern of blockedPatterns) {
    for (const part of pathParts) {
      if (part === pattern || part.includes(pattern)) {
        return pattern;
      }
    }

    if (realPath.includes(pattern)) {
      return pattern;
    }
  }

  return null;
}

/**
 * Check if a real path is under an allowed root.
 * Returns the matching root, or null if none.
 */
export function findAllowedRoot(realPath: string, allowedRoots: AllowedRoot[]): AllowedRoot | null {
  for (const root of allowedRoots) {
    const expandedRoot = expandPath(root.path);
    const realRoot = getRealPath(expandedRoot);

    if (realRoot === null) {
      continue;
    }

    const relative = path.relative(realRoot, realPath);

    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return root;
    }
  }

  return null;
}

/**
 * Validate the container path to prevent escaping /workspace/extra/
 */
export function isValidContainerPath(containerPath: string): boolean {
  if (containerPath.includes('..')) {
    return false;
  }

  if (containerPath.startsWith('/')) {
    return false;
  }

  if (!containerPath || containerPath.trim() === '') {
    return false;
  }

  return true;
}
