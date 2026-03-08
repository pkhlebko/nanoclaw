/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_MAX_OUTPUT_SIZE, CONTAINER_TIMEOUT, IDLE_TIMEOUT, JSON_INDENT } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../groups/folder.js';
import { logger } from '../logger.js';
import { MessageAttachment, RegisteredGroup } from '../types.js';

import { buildContainerArgs, buildVolumeMounts } from './mounts.js';
import { type ContainerOutput, buildRunLogLines, buildTimeoutLogLines, parseLegacyOutput, parseStreamChunk } from './output.js';
import { CONTAINER_RUNTIME_BIN, stopContainer } from './runtime.js';

export type { ContainerOutput } from './output.js';

const CONTAINER_NAME_PREFIX = 'nanoclaw';
// Grace period added to the hard timeout so the graceful _close sentinel has time
// to trigger before the hard kill fires.
const CONTAINER_TIMEOUT_GRACE_MS = 30_000;
const GRACEFUL_STOP_TIMEOUT_MS = 15_000;
// Number of stderr characters to include in the error message on non-zero exit
const STDERR_TAIL_CHARS = 200;

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  model?: string;
  attachments?: MessageAttachment[];
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const groupDir = resolveGroupFolderPath(group.folder);

  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `${CONTAINER_NAME_PREFIX}-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);
  const logsDir = path.join(groupDir, 'logs');

  fs.mkdirSync(logsDir, { recursive: true });

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map((m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
      model: input.model || '(default)',
    },
    'Spawning container agent',
  );

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let hadStreamingOutput = false;
    let outputChain = Promise.resolve();
    let timedOut = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + CONTAINER_TIMEOUT_GRACE_MS);

    const killOnTimeout = (): void => {
      timedOut = true;
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      exec(stopContainer(containerName), { timeout: GRACEFUL_STOP_TIMEOUT_MS }, (err) => {
        if (err) {
          logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = (): void => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;

        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn({ group: group.name, size: stdout.length }, 'Container stdout truncated due to size limit');
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;

        const result = parseStreamChunk(parseBuffer);

        parseBuffer = result.nextBuffer;

        if (result.newSessionId) newSessionId = result.newSessionId;

        for (const parseErr of result.parseErrors) {
          logger.warn({ group: group.name, error: parseErr }, 'Failed to parse streamed output chunk');
        }

        for (const parsed of result.outputs) {
          hadStreamingOutput = true;
          resetTimeout();
          outputChain = outputChain.then(() => onOutput(parsed));
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');

      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }

      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;

      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;

      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn({ group: group.name, size: stderr.length }, 'Container stderr truncated due to size limit');
      } else {
        stderr += chunk;
      }
    });

    container.on('close', (code) => {
      clearTimeout(timeout);

      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);

        fs.writeFileSync(
          timeoutLog,
          buildTimeoutLogLines({ group: group.name, containerName, duration, code, hadStreamingOutput }).join('\n'),
        );

        if (hadStreamingOutput) {
          logger.info({ group: group.name, containerName, duration, code }, 'Container timed out after output (idle cleanup)');
          void outputChain.then(() => resolve({ status: 'success', result: null, newSessionId }));

          return;
        }

        logger.error({ group: group.name, containerName, duration, code }, 'Container timed out with no output');
        resolve({ status: 'error', result: null, error: `Container timed out after ${configTimeout}ms` });

        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      fs.writeFileSync(
        logFile,
        buildRunLogLines({
          group: group.name,
          isMain: input.isMain,
          promptLength: input.prompt.length,
          sessionId: input.sessionId,
          serializedInput: JSON.stringify(input, null, JSON_INDENT),
          duration,
          code,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          mounts,
          containerArgs,
          isVerbose,
        }).join('\n'),
      );

      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error({ group: group.name, code, duration, stderr, stdout, logFile }, 'Container exited with error');
        resolve({ status: 'error', result: null, error: `Container exited with code ${code}: ${stderr.slice(-STDERR_TAIL_CHARS)}` });

        return;
      }

      if (onOutput) {
        void outputChain.then(() => {
          logger.info({ group: group.name, duration, newSessionId }, 'Container completed (streaming mode)');
          resolve({ status: 'success', result: null, newSessionId });
        });

        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      const parseResult = parseLegacyOutput(stdout);

      if (parseResult.ok) {
        logger.info(
          { group: group.name, duration, status: parseResult.output.status, hasResult: !!parseResult.output.result },
          'Container completed',
        );
        resolve(parseResult.output);
      } else {
        logger.error({ group: group.name, stdout, stderr, error: parseResult.error }, 'Failed to parse container output');
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${parseResult.error}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, containerName, error: err }, 'Container spawn error');
      resolve({ status: 'error', result: null, error: `Container spawn error: ${err.message}` });
    });
  });
}
