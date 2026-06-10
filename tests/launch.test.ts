import { describe, expect, it } from 'vitest';
import type { Spawner } from '../src/commands/launch.js';
import { LAUNCH_TARGETS, launchCommand } from '../src/commands/launch.js';
import { SynlinError } from '../src/lib/errors.js';

interface SpawnCall {
  readonly bin: string;
  readonly args: readonly string[];
}

function recordingSpawner(exitCode: number): { spawner: Spawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawner: Spawner = (bin, args) => {
    calls.push({ bin, args });
    return Promise.resolve(exitCode);
  };
  return { spawner, calls };
}

describe('LAUNCH_TARGETS', () => {
  it('maps each agent CLI to its skip-permissions flag', () => {
    expect(LAUNCH_TARGETS.claude.bin).toBe('claude');
    expect(LAUNCH_TARGETS.claude.args).toEqual(['--dangerously-skip-permissions']);
    expect(LAUNCH_TARGETS.codex.bin).toBe('codex');
    expect(LAUNCH_TARGETS.codex.args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });
});

describe('launchCommand', () => {
  it('spawns the target with its built-in flags and forwards extra args', async () => {
    const { spawner, calls } = recordingSpawner(0);
    const exitCode = await launchCommand(LAUNCH_TARGETS.claude, ['--resume', 'my-session'], spawner);
    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ bin: 'claude', args: ['--dangerously-skip-permissions', '--resume', 'my-session'] }]);
  });

  it('propagates the child exit code', async () => {
    const { spawner } = recordingSpawner(3);
    await expect(launchCommand(LAUNCH_TARGETS.codex, [], spawner)).resolves.toBe(3);
  });

  it('turns a missing binary (ENOENT) into a friendly SynlinError', async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const spawner: Spawner = () => Promise.reject(enoent);
    await expect(launchCommand(LAUNCH_TARGETS.claude, [], spawner)).rejects.toThrowError(SynlinError);
    await expect(launchCommand(LAUNCH_TARGETS.claude, [], spawner)).rejects.toThrowError(/not found on PATH.*Claude Code/);
  });

  it('rethrows non-ENOENT spawn errors unchanged', async () => {
    const eacces: NodeJS.ErrnoException = Object.assign(new Error('spawn claude EACCES'), { code: 'EACCES' });
    const spawner: Spawner = () => Promise.reject(eacces);
    await expect(launchCommand(LAUNCH_TARGETS.claude, [], spawner)).rejects.toBe(eacces);
  });
});
