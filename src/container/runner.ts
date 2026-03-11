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

import { buildContainerArgs, buildVolumeMounts, VolumeMount } from './mounts.js';
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

/** Mutable state accumulated during a container run. */
interface ContainerRunState {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  parseBuffer: string;
  newSessionId: string | undefined;
  hadStreamingOutput: boolean;
  outputChain: Promise<void>;
  timedOut: boolean;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

/** Process a stdout chunk: buffer it (with truncation) and parse streaming output markers. */
function handleStdoutChunk(
  state: ContainerRunState,
  chunk: string,
  groupName: string,
  onOutput: ((output: ContainerOutput) => Promise<void>) | undefined,
  resetTimeout: () => void,
): void {
  if (!state.stdoutTruncated) {
    const remaining = CONTAINER_MAX_OUTPUT_SIZE - state.stdout.length;

    if (chunk.length > remaining) {
      state.stdout += chunk.slice(0, remaining);
      state.stdoutTruncated = true;
      logger.warn({ group: groupName, size: state.stdout.length }, 'Container stdout truncated due to size limit');
    } else {
      state.stdout += chunk;
    }
  }

  if (onOutput) {
    state.parseBuffer += chunk;

    const result = parseStreamChunk(state.parseBuffer);

    state.parseBuffer = result.nextBuffer;

    if (result.newSessionId) state.newSessionId = result.newSessionId;

    for (const parseErr of result.parseErrors) {
      logger.warn({ group: groupName, error: parseErr }, 'Failed to parse streamed output chunk');
    }

    for (const parsed of result.outputs) {
      state.hadStreamingOutput = true;
      resetTimeout();
      state.outputChain = state.outputChain.then(() => onOutput(parsed));
    }
  }
}

interface CloseTimeoutContext {
  groupName: string;
  containerName: string;
  logsDir: string;
  duration: number;
  code: number | null;
  configTimeout: number;
}

/** Handle container close when a timeout occurred. */
function handleCloseTimeout(state: ContainerRunState, ctx: CloseTimeoutContext): ContainerOutput | Promise<ContainerOutput> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const timeoutLog = path.join(ctx.logsDir, `container-${ts}.log`);

  fs.writeFileSync(
    timeoutLog,
    buildTimeoutLogLines({
      group: ctx.groupName,
      containerName: ctx.containerName,
      duration: ctx.duration,
      code: ctx.code,
      hadStreamingOutput: state.hadStreamingOutput,
    }).join('\n'),
  );

  if (state.hadStreamingOutput) {
    logger.info(
      { group: ctx.groupName, containerName: ctx.containerName, duration: ctx.duration, code: ctx.code },
      'Container timed out after output (idle cleanup)',
    );

    return state.outputChain.then(() => ({ status: 'success' as const, result: null, newSessionId: state.newSessionId }));
  }

  logger.error(
    { group: ctx.groupName, containerName: ctx.containerName, duration: ctx.duration, code: ctx.code },
    'Container timed out with no output',
  );

  return { status: 'error', result: null, error: `Container timed out after ${ctx.configTimeout}ms` };
}

interface CloseNormalContext {
  groupName: string;
  input: ContainerInput;
  logsDir: string;
  containerArgs: string[];
  mounts: VolumeMount[];
  onOutput: ((output: ContainerOutput) => Promise<void>) | undefined;
}

/** Handle container close under normal (non-timeout) conditions. */
function handleCloseNormal(
  state: ContainerRunState,
  ctx: CloseNormalContext,
  duration: number,
  code: number | null,
): ContainerOutput | Promise<ContainerOutput> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(ctx.logsDir, `container-${timestamp}.log`);
  const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

  fs.writeFileSync(
    logFile,
    buildRunLogLines({
      group: ctx.groupName,
      isMain: ctx.input.isMain,
      promptLength: ctx.input.prompt.length,
      sessionId: ctx.input.sessionId,
      serializedInput: JSON.stringify(ctx.input, null, JSON_INDENT),
      duration,
      code,
      stdout: state.stdout,
      stderr: state.stderr,
      stdoutTruncated: state.stdoutTruncated,
      stderrTruncated: state.stderrTruncated,
      mounts: ctx.mounts,
      containerArgs: ctx.containerArgs,
      isVerbose,
    }).join('\n'),
  );

  logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

  if (code !== 0) {
    logger.error(
      { group: ctx.groupName, code, duration, stderr: state.stderr, stdout: state.stdout, logFile },
      'Container exited with error',
    );

    return { status: 'error', result: null, error: `Container exited with code ${code}: ${state.stderr.slice(-STDERR_TAIL_CHARS)}` };
  }

  if (ctx.onOutput) {
    return state.outputChain.then(() => {
      logger.info({ group: ctx.groupName, duration, newSessionId: state.newSessionId }, 'Container completed (streaming mode)');

      return { status: 'success' as const, result: null, newSessionId: state.newSessionId };
    });
  }

  // Legacy mode: parse the last output marker pair from accumulated stdout
  const parseResult = parseLegacyOutput(state.stdout);

  if (parseResult.ok) {
    logger.info(
      { group: ctx.groupName, duration, status: parseResult.output.status, hasResult: !!parseResult.output.result },
      'Container completed',
    );

    return parseResult.output;
  }

  logger.error(
    { group: ctx.groupName, stdout: state.stdout, stderr: state.stderr, error: parseResult.error },
    'Failed to parse container output',
  );

  return { status: 'error', result: null, error: `Failed to parse container output: ${parseResult.error}` };
}

/** Buffer a stderr chunk with truncation and debug-log each line. */
function handleStderrChunk(state: ContainerRunState, chunk: string, groupName: string, groupFolder: string): void {
  const lines = chunk.trim().split('\n');

  for (const line of lines) {
    if (line) logger.debug({ container: groupFolder }, line);
  }

  // Don't reset timeout on stderr — SDK writes debug logs continuously.
  // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
  if (state.stderrTruncated) return;

  const remaining = CONTAINER_MAX_OUTPUT_SIZE - state.stderr.length;

  if (chunk.length > remaining) {
    state.stderr += chunk.slice(0, remaining);
    state.stderrTruncated = true;
    logger.warn({ group: groupName, size: state.stderr.length }, 'Container stderr truncated due to size limit');
  } else {
    state.stderr += chunk;
  }
}

interface ContainerRunSetup {
  mounts: VolumeMount[];
  containerName: string;
  containerArgs: string[];
  logsDir: string;
}

/** Prepare directories, mounts, and container arguments. */
function prepareContainerRun(group: RegisteredGroup, isMain: boolean): ContainerRunSetup {
  const groupDir = resolveGroupFolderPath(group.folder);

  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, isMain);
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

  logger.info({ group: group.name, containerName, mountCount: mounts.length, isMain, model: '(default)' }, 'Spawning container agent');

  return { mounts, containerName, containerArgs, logsDir };
}

/** Spawn a container agent and collect its output. */
export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const { mounts, containerName, containerArgs, logsDir } = prepareContainerRun(group, input.isMain);

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    onProcess(container, containerName);

    const state: ContainerRunState = {
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      parseBuffer: '',
      newSessionId: undefined,
      hadStreamingOutput: false,
      outputChain: Promise.resolve(),
      timedOut: false,
    };

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + CONTAINER_TIMEOUT_GRACE_MS);

    const killOnTimeout = (): void => {
      state.timedOut = true;
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      exec(stopContainer(containerName), { timeout: GRACEFUL_STOP_TIMEOUT_MS }, (err) => {
        if (err) {
          logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = (): void => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.stdout.on('data', (data) => {
      handleStdoutChunk(state, data.toString(), group.name, onOutput, resetTimeout);
    });

    container.stderr.on('data', (data) => {
      handleStderrChunk(state, data.toString(), group.name, group.folder);
    });

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (state.timedOut) {
        const tCtx: CloseTimeoutContext = { groupName: group.name, containerName, logsDir, duration, code, configTimeout };

        void Promise.resolve(handleCloseTimeout(state, tCtx)).then(resolve);

        return;
      }

      const ctx: CloseNormalContext = { groupName: group.name, input, logsDir, containerArgs, mounts, onOutput };

      void Promise.resolve(handleCloseNormal(state, ctx, duration, code)).then(resolve);
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, containerName, error: err }, 'Container spawn error');
      resolve({ status: 'error', result: null, error: `Container spawn error: ${err.message}` });
    });
  });
}
