import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

const RANDOM_ID_BASE = 36;
const RANDOM_ID_START = 2;
const RANDOM_ID_END = 6;

/**
 * Write a follow-up message to an active container via IPC file.
 * Returns true if the file was written successfully.
 */
export function writeIpcMessage(groupFolder: string, text: string): boolean {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');

  try {
    fs.mkdirSync(inputDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(RANDOM_ID_BASE).slice(RANDOM_ID_START, RANDOM_ID_END)}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;

    fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
    fs.renameSync(tempPath, filepath);

    return true;
  } catch {
    return false;
  }
}

/**
 * Write a close sentinel to signal the container to wind down.
 */
export function writeIpcClose(groupFolder: string): void {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');

  try {
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, '_close'), '');
  } catch {
    // ignore
  }
}
