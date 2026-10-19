/** Which package manager a project uses, for install hints that name a runnable command. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { compileGlob, matchesGlob } from './globs.ts';

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
 * The manager of the package in `dir`, which may be a member of a workspace
 * whose lockfile and `packageManager` field are at the workspace root: the
 * package's own field or lockfile, else those of the nearest workspace root
 * above whose package globs include it, else the manager that invoked the
 * current process, else npm. A lockfile above that belongs to no workspace
 * holding the package is another project's, and does not count.
 */
export function detectWorkspacePackageManager(dir: string, env: NodeJS.ProcessEnv = process.env): PackageManager {
  const project = path.resolve(dir);
  const own = managerAt(project);
  if (own !== undefined) return own;
  for (let current = path.dirname(project); ; current = path.dirname(current)) {
    const workspace = workspaceGlobs(current);
    if (workspace !== undefined) {
      const member = includesPackage(workspace.globs, path.relative(current, project).split(path.sep).join('/'));
      if (member) return managerAt(current) ?? workspace.manager ?? invokingManager(env);
      break;
    }
    if (path.dirname(current) === current) break;
  }
  return invokingManager(env);
}

function invokingManager(env: NodeJS.ProcessEnv): PackageManager {
  const invoking = env['npm_config_user_agent']?.split('/')[0];
  return isPackageManager(invoking) ? invoking : 'npm';
}

/** The manager `dir` names itself: its `packageManager` field, else its lockfile. */
function managerAt(dir: string): PackageManager | undefined {
  const field = readManifest(dir)?.['packageManager'];
  const configured = typeof field === 'string' ? field.split('@')[0] : undefined;
  if (isPackageManager(configured)) return configured;
  return LOCKFILES.find(([lock]) => existsSync(path.join(dir, lock)))?.[1];
}

function readManifest(dir: string): Record<string, unknown> | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The package globs of a workspace root at `dir`: `pnpm-workspace.yaml`'s
 * `packages` list (a pnpm workspace), else the `workspaces` field of its
 * package.json, an array or `{ packages }` (npm, Yarn, Bun). Undefined when
 * `dir` is no workspace root.
 */
function workspaceGlobs(dir: string): { globs: string[]; manager: PackageManager | undefined } | undefined {
  try {
    return { globs: pnpmWorkspacePackages(readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')), manager: 'pnpm' };
  } catch {
    // No pnpm workspace here; the manifest may declare one.
  }
  const field = readManifest(dir)?.['workspaces'];
  const list = Array.isArray(field) ? field : typeof field === 'object' && field !== null && 'packages' in field ? field.packages : undefined;
  if (!Array.isArray(list)) return undefined;
  return { globs: list.filter((glob): glob is string => typeof glob === 'string'), manager: undefined };
}

/** The entries of the top-level `packages:` list in a pnpm-workspace.yaml, without reading the rest of the YAML. */
function pnpmWorkspacePackages(text: string): string[] {
  const globs: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^packages:\s*(?:#.*)?$/u.test(line)) {
      inside = true;
      continue;
    }
    if (!inside || /^\s*(?:#.*)?$/u.test(line)) continue;
    const item = /^\s+-\s+(['"]?)(.+?)\1\s*(?:#.*)?$/u.exec(line);
    if (item === null) break;
    globs.push(item[2]!);
  }
  return globs;
}

/** Whether `relative`, a `/`-separated path from the workspace root, matches an including glob and no `!` one. */
function includesPackage(globs: readonly string[], relative: string): boolean {
  if (relative === '' || relative.startsWith('..')) return false;
  const matches = (pattern: string): boolean => {
    const normalized = pattern.replace(/^\.\//u, '').replace(/\/+$/u, '');
    if (normalized === relative) return true;
    try {
      return matchesGlob(compileGlob(normalized), relative);
    } catch {
      return false;
    }
  };
  return (
    globs.some((glob) => !glob.startsWith('!') && matches(glob)) &&
    !globs.some((glob) => glob.startsWith('!') && matches(glob.slice(1)))
  );
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
