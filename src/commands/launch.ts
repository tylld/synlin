import { spawn } from 'node:child_process';
import { SynlinError } from '../lib/errors.js';

export interface LaunchTarget {
  readonly bin: string;
  readonly args: readonly string[];
  readonly label: string;
}

/** External agent CLIs launchable via synlin, with their skip-permissions flags. */
export const LAUNCH_TARGETS: Record<'claude' | 'codex', LaunchTarget> = {
  claude: { bin: 'claude', args: ['--dangerously-skip-permissions'], label: 'Claude Code' },
  codex: { bin: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox'], label: 'Codex' },
};

/** Injectable process spawner so the handler is testable; resolves to the exit code. */
export type Spawner = (bin: string, args: readonly string[]) => Promise<number>;

function spawnInherit(bin: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal !== null ? 1 : 0)));
  });
}

/**
 * Hand the terminal to an external agent CLI and resolve to its exit code.
 * Extra args are forwarded after the built-in flags.
 */
export async function launchCommand(
  target: LaunchTarget,
  extraArgs: readonly string[] = [],
  spawner: Spawner = spawnInherit,
): Promise<number> {
  try {
    return await spawner(target.bin, [...target.args, ...extraArgs]);
  } catch (error: unknown) {
    if (isEnoent(error)) {
      throw new SynlinError(`"${target.bin}" not found on PATH — is ${target.label} installed?`);
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
