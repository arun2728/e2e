/** Which package manager a project uses, for install hints that name a runnable command. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set<PackageManager>(['npm', 'pnpm', 'yarn', 'bun']);
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
] as const;

function isPackageManager(value: string | undefined): value is PackageManager {
  return value !== undefined && PACKAGE_MANAGERS.has(value);
}

/** The manager a `packageManager` field such as `pnpm@10.0.0` names, or undefined for another value. */
export function fieldManager(packageManagerField: string | undefined): PackageManager | undefined {
  const configured = packageManagerField?.split('@')[0];
  return isPackageManager(configured) ? configured : undefined;
}

/** The manager whose lockfile sits in `dir`, or undefined when none does. */
export function lockfileManager(dir: string): PackageManager | undefined {
  return LOCKFILES.find(([lock]) => existsSync(path.join(dir, lock)))?.[1];
}

/**
 * The `packageManager` field wins, then a lockfile in `dir`, then the manager
 * that invoked the current process, then npm.
 */
export function detectPackageManager(
  dir: string,
  packageManagerField?: string,
  env: NodeJS.ProcessEnv = process.env,
): PackageManager {
  const found = fieldManager(packageManagerField) ?? lockfileManager(dir);
  if (found !== undefined) return found;
  const invoking = env['npm_config_user_agent']?.split('/')[0];
  return isPackageManager(invoking) ? invoking : 'npm';
}

/**
 * The manager of a package that may sit inside a workspace, whose lockfile
 * and `packageManager` field are at the workspace root: the nearest field or
 * lockfile from `dir` up, then the manager that invoked the current process,
 * then npm.
 */
export function detectWorkspacePackageManager(dir: string, env: NodeJS.ProcessEnv = process.env): PackageManager {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const configured = readPackageManagerField(current)?.split('@')[0];
    if (isPackageManager(configured)) return configured;
    for (const [lock, manager] of LOCKFILES) {
      if (existsSync(path.join(current, lock))) return manager;
    }
    if (path.dirname(current) === current) break;
  }
  const invoking = env['npm_config_user_agent']?.split('/')[0];
  return isPackageManager(invoking) ? invoking : 'npm';
}

/** The `packageManager` field of `dir/package.json`, when it has one that is a string. */
function readPackageManagerField(dir: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const field = typeof manifest === 'object' && manifest !== null && 'packageManager' in manifest ? manifest.packageManager : undefined;
    return typeof field === 'string' ? field : undefined;
  } catch {
    return undefined;
  }
}

/** The command that runs the package.json script `name` with the given manager. */
export function runScriptCommand(manager: PackageManager, name: string): string {
  switch (manager) {
    case 'npm':
      return `npm run ${name}`;
    case 'pnpm':
      return `pnpm ${name}`;
    case 'yarn':
      return `yarn ${name}`;
    case 'bun':
      return `bun run ${name}`;
  }
}

/** The command that runs an installed binary, never a registry download, with the given manager. */
export function execCommand(manager: PackageManager, command: string): string {
  switch (manager) {
    case 'npm':
      return `npm exec -- ${command}`;
    case 'pnpm':
      return `pnpm exec ${command}`;
    case 'yarn':
      return `yarn ${command}`;
    case 'bun':
      return `bun run ${command}`;
  }
}

/** The command that adds `name` as a dev dependency with the given manager. */
export function addDevDependencyCommand(manager: PackageManager, name: string): string {
  switch (manager) {
    case 'npm':
      return `npm install --save-dev ${name}`;
    case 'pnpm':
      return `pnpm add -D ${name}`;
    case 'yarn':
      return `yarn add -D ${name}`;
    case 'bun':
      return `bun add -d ${name}`;
  }
}
