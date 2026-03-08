import { VolumeMount } from './container-mounts.js';

export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface StreamChunkResult {
  nextBuffer: string;
  outputs: ContainerOutput[];
  newSessionId?: string;
  parseErrors: string[];
}

/**
 * Parse a streaming stdout chunk for OUTPUT_START/END marker pairs.
 * Pure function — returns the remaining unparsed buffer and all complete outputs found.
 */
export function parseStreamChunk(buffer: string): StreamChunkResult {
  const outputs: ContainerOutput[] = [];
  let newSessionId: string | undefined;
  const parseErrors: string[] = [];
  let remaining = buffer;
  let startIdx: number;

  while ((startIdx = remaining.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = remaining.indexOf(OUTPUT_END_MARKER, startIdx);

    if (endIdx === -1) break; // Incomplete pair, wait for more data

    const jsonStr = remaining.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();

    remaining = remaining.slice(endIdx + OUTPUT_END_MARKER.length);

    try {
      const parsed: ContainerOutput = JSON.parse(jsonStr);

      if (parsed.newSessionId) {
        newSessionId = parsed.newSessionId;
      }

      outputs.push(parsed);
    } catch (err) {
      parseErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { nextBuffer: remaining, outputs, newSessionId, parseErrors };
}

export type LegacyParseResult = { ok: true; output: ContainerOutput } | { ok: false; error: string };

/**
 * Parse the last OUTPUT_START/END marker pair from accumulated stdout (legacy / non-streaming mode).
 * Falls back to the last non-empty line if markers are absent.
 * Pure function — returns a tagged union instead of throwing.
 */
export function parseLegacyOutput(stdout: string): LegacyParseResult {
  try {
    const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
    const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
    let jsonLine: string;

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      jsonLine = stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
    } else {
      // Fallback: last non-empty line (backwards compatibility)
      const lines = stdout.trim().split('\n');

      jsonLine = lines[lines.length - 1];
    }

    const output: ContainerOutput = JSON.parse(jsonLine);

    return { ok: true, output };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RunLogData {
  group: string;
  isMain: boolean;
  promptLength: number;
  sessionId: string | undefined;
  serializedInput: string;
  duration: number;
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  mounts: VolumeMount[];
  containerArgs: string[];
  isVerbose: boolean;
}

/** Pure function — builds log lines for a completed (non-timeout) container run. */
export function buildRunLogLines(data: RunLogData): string[] {
  const logLines = [
    '=== Container Run Log ===',
    `Timestamp: ${new Date().toISOString()}`,
    `Group: ${data.group}`,
    `IsMain: ${data.isMain}`,
    `Duration: ${data.duration}ms`,
    `Exit Code: ${data.code}`,
    `Stdout Truncated: ${data.stdoutTruncated}`,
    `Stderr Truncated: ${data.stderrTruncated}`,
    '',
  ];

  const isError = data.code !== 0;

  if (data.isVerbose || isError) {
    logLines.push(
      '=== Input ===',
      data.serializedInput,
      '',
      '=== Container Args ===',
      data.containerArgs.join(' '),
      '',
      '=== Mounts ===',
      data.mounts.map((m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'),
      '',
      `=== Stderr${data.stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
      data.stderr,
      '',
      `=== Stdout${data.stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
      data.stdout,
    );
  } else {
    logLines.push(
      '=== Input Summary ===',
      `Prompt length: ${data.promptLength} chars`,
      `Session ID: ${data.sessionId || 'new'}`,
      '',
      '=== Mounts ===',
      data.mounts.map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'),
      '',
    );
  }

  return logLines;
}

export interface TimeoutLogData {
  group: string;
  containerName: string;
  duration: number;
  code: number | null;
  hadStreamingOutput: boolean;
}

/** Pure function — builds log lines for a timed-out container run. */
export function buildTimeoutLogLines(data: TimeoutLogData): string[] {
  return [
    '=== Container Run Log (TIMEOUT) ===',
    `Timestamp: ${new Date().toISOString()}`,
    `Group: ${data.group}`,
    `Container: ${data.containerName}`,
    `Duration: ${data.duration}ms`,
    `Exit Code: ${data.code}`,
    `Had Streaming Output: ${data.hadStreamingOutput}`,
  ];
}
