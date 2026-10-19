/**
 * `e2e upgrade` (alias `update`): moves the project's `e2e` to the latest
 * release, a dist-tag, or one version, and every `@e2e-dev/*` package the
 * project declares along with it, each to the newest release whose peer
 * ranges accept the new versions. The project's package manager installs
 * them, so its lockfile, its workspace, and the section each package sits in
 * stay its own.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { InvalidArgumentError } from 'commander';
import picocolors from 'picocolors';
import { z } from 'zod';
import { detectWorkspacePackageManager, execCommand, type PackageManager } from '../internal/package-manager.ts';
import { compareVersions, formatVersion, parseVersion, satisfies } from '../internal/semver.ts';
import { findInstalledSkillDirs } from './init/agent-skill.ts';
import { describeManifestError, readPackage } from './init/package.ts';

/** What to upgrade to: a dist-tag such as `latest` or `nightly`, or one published version. */
export type UpgradeTarget = { readonly kind: 'tag'; readonly tag: string } | { readonly kind: 'version'; readonly version: string };

export interface UpgradeOptions {
  readonly target: UpgradeTarget;
  /** Print the plan and the install command, and change nothing. */
  readonly dryRun?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  /** Runs the install command; the CLI hands it to the terminal. */
  readonly spawn?: (command: string, args: readonly string[], cwd: string) => SpawnOutcome;
}

interface SpawnOutcome {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error | undefined;
}

const RUNNER = 'e2e';
const SCOPE = '@e2e-dev/';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const RELEASES_URL = 'https://github.com/tester-army/e2e/releases/tag/';
/** Each metadata request gets this long; a person waits on it. */
const REGISTRY_TIMEOUT_MS = 15_000;
/** The sections a package manager installs from, in the order a package is looked up. */
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
type Section = (typeof SECTIONS)[number];
/** Specs that do not name a registry version: a workspace, a path, a git or tarball URL, an alias, a pnpm catalog. */
const NON_REGISTRY_SPEC = /^(?:workspace|link|file|portal|patch|catalog|npm|git|git\+[a-z]+|github|gitlab|bitbucket|https?):|\//u;
const DIST_TAG = /^[a-z][a-z0-9._-]*$/iu;

/**
 * The `[version]` argument: an exact version (`0.22.0`, `v0.22.0`,
 * `0.22.1-nightly-20261019081103`) or a dist-tag (`latest`, `nightly`).
 * Ranges are refused: the command installs one version.
 */
export function parseUpgradeTarget(value: string): UpgradeTarget {
  const version = parseVersion(value);
  if (version !== undefined) return { kind: 'version', version: formatVersion(version) };
  if (DIST_TAG.test(value) && !/^v?\d/u.test(value)) return { kind: 'tag', tag: value };
  throw new InvalidArgumentError('must be a version such as 0.22.0 or a dist-tag such as latest or nightly, not a range');
}

const packumentSchema = z.looseObject({
  'dist-tags': z.record(z.string(), z.string()).default({}),
  versions: z.record(
    z.string(),
    z.looseObject({
      peerDependencies: z.record(z.string(), z.string()).optional(),
      deprecated: z.string().optional(),
    }),
  ),
});
type Packument = z.infer<typeof packumentSchema>;

/** A package the project declares and the command moves. */
interface Declared {
  readonly name: string;
  readonly section: Section;
  /** The spec in package.json, such as `^0.20.0`. */
  readonly spec: string;
  /** The version installed under node_modules, when one is. */
  readonly installed: string | undefined;
}

interface Planned extends Declared {
  readonly version: string;
  /** What the package manager is asked for: the version, with the range operator the old spec had. */
  readonly request: string;
}

/** A failure that ends the command: what to print and the exit code. */
class UpgradeError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/**
 * Runs `e2e upgrade`. Exit 0 when the packages were installed, were already
 * at the target, or `--dry-run` printed the plan; 2 for a project, version,
 * or tag the command cannot act on and for a failed installation; 3 when the
 * registry did not answer; 130 when the installation was interrupted.
 */
export async function upgrade(options: UpgradeOptions): Promise<number> {
  try {
    return await upgradeOrThrow(options);
  } catch (cause) {
    if (!(cause instanceof UpgradeError)) throw cause;
    process.stderr.write(`e2e upgrade: ${cause.message}\n`);
    return cause.exitCode;
  }
}

async function upgradeOrThrow(options: UpgradeOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  const project = findProject(cwd);
  const { declared, linked } = declaredPackages(project.dir, project.manifest);
  const runner = declared.find((entry) => entry.name === RUNNER);
  if (runner === undefined) {
    const spec = linked.find((entry) => entry.name === RUNNER)?.spec;
    throw new UpgradeError(
      `e2e is "${spec}" in ${relative(cwd, project.manifestPath)}, not a registry version; change that spec yourself`,
      2,
    );
  }
  for (const entry of linked) out(picocolors.dim(`Skipping ${entry.name}: "${entry.spec}" is not a registry version`));

  const registry = registryUrl(env);
  const fetchImpl = options.fetch ?? fetch;
  const packuments = new Map(
    await Promise.all(declared.map(async (entry) => [entry.name, await fetchPackument(registry, entry.name, fetchImpl)] as const)),
  );
  const target = resolveRunner(options.target, packuments.get(RUNNER));
  const versions = resolveSiblings(options.target, target, declared, packuments, (name) => out(picocolors.dim(`Skipping ${name}: the registry has no such package`)));
  const plan = declared.flatMap((entry): Planned[] => {
    const version = versions.get(entry.name);
    return version === undefined ? [] : [{ ...entry, version, request: requestFor(entry.spec, version, options.target) }];
  });

  const manager = detectWorkspacePackageManager(project.dir, env);
  const where = path.resolve(project.dir) === path.resolve(cwd) ? '' : ` in ${relative(cwd, project.dir)}`;
  const changing = plan.filter((entry) => entry.installed !== entry.version);
  if (changing.length === 0) {
    out(`Already up to date${where}: ${plan.map((entry) => `${entry.name} ${entry.version}`).join(', ')}`);
    return 0;
  }
  out(`${options.dryRun === true ? 'Would upgrade' : 'Upgrading'}${where} with ${manager}:`);
  const width = Math.max(...plan.map((entry) => entry.name.length));
  for (const entry of plan) out(`  ${entry.name.padEnd(width)}  ${describeChange(entry)}`);
  const commands = installCommands(manager, changing, existsSync(path.join(project.dir, 'pnpm-workspace.yaml')));
  for (const args of commands) out(picocolors.dim(`$ ${manager} ${args.join(' ')}`));
  if (options.dryRun === true) return 0;

  const spawn = options.spawn ?? spawnInstall;
  for (const args of commands) {
    const result = spawn(manager, args, project.dir);
    if (result.error !== undefined || result.status !== 0) {
      const reason = result.error?.message ?? `exit ${result.status ?? result.signal}`;
      process.stderr.write(`e2e upgrade: ${manager} failed (${reason}); retry with ${manager} ${args.join(' ')}\n`);
      return result.signal === 'SIGINT' ? 130 : 2;
    }
  }

  out(`${picocolors.green('Upgraded')}${where}: ${changing.map((entry) => `${entry.name} ${entry.version}`).join(', ')}`);
  const runnerVersion = versions.get(RUNNER)!;
  if (parseVersion(runnerVersion)?.prerelease.length === 0 && runner.installed !== runnerVersion) {
    out(`Release notes: ${RELEASES_URL}${encodeURIComponent(`${RUNNER}@${runnerVersion}`)}`);
  }
  const skillDirs = findInstalledSkillDirs(project.dir);
  if (skillDirs.length > 0) {
    out(`The agent skill in ${skillDirs.map((dir) => `${dir}/e2e`).join(' and ')} is the old version's; refresh it with ${execCommand(manager, 'e2e init')}`);
  }
  return 0;
}

/** The nearest package.json from `cwd` up that declares `e2e`. */
function findProject(cwd: string): { dir: string; manifestPath: string; manifest: ReturnType<typeof readPackage>['manifest'] } {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const manifestPath = path.join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      let manifest: ReturnType<typeof readPackage>['manifest'];
      try {
        ({ manifest } = readPackage(dir));
      } catch (cause) {
        throw new UpgradeError(`${relative(cwd, manifestPath)} could not be read: ${describeManifestError(cause)}`, 2);
      }
      if (SECTIONS.some((section) => manifest[section]?.[RUNNER] !== undefined)) return { dir, manifestPath, manifest };
    }
    if (path.dirname(dir) === dir) break;
  }
  throw new UpgradeError('no package.json from here up lists e2e as a dependency; run e2e init to set up a project', 2);
}

/** `e2e` and the `@e2e-dev/*` packages the manifest installs, split by whether their spec names a registry version. */
function declaredPackages(dir: string, manifest: ReturnType<typeof readPackage>['manifest']): { declared: Declared[]; linked: Declared[] } {
  const seen = new Set<string>();
  const all: Declared[] = [];
  for (const section of SECTIONS) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if ((name !== RUNNER && !name.startsWith(SCOPE)) || seen.has(name)) continue;
      seen.add(name);
      all.push({ name, section, spec, installed: installedVersion(dir, name) });
    }
  }
  // The runner leads every list the command prints.
  all.sort((a, b) => Number(b.name === RUNNER) - Number(a.name === RUNNER));
  const registry = (entry: Declared): boolean => !NON_REGISTRY_SPEC.test(entry.spec.trim());
  return { declared: all.filter(registry), linked: all.filter((entry) => !registry(entry)) };
}

/** The version under the nearest `node_modules/<name>`, or undefined (not installed, or Plug'n'Play). */
function installedVersion(dir: string, name: string): string | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(path.join(current, 'node_modules', name, 'package.json'), 'utf8'));
      const version = typeof manifest === 'object' && manifest !== null && 'version' in manifest ? manifest.version : undefined;
      if (typeof version === 'string') return version;
    } catch {
      // Not here; a workspace hoists to a parent.
    }
    if (path.dirname(current) === current) return undefined;
  }
}

/** The registry the package manager would use when it set one for this process, else npm's. */
function registryUrl(env: NodeJS.ProcessEnv): string {
  const configured = env['npm_config_registry']?.trim();
  const base = configured === undefined || configured === '' ? DEFAULT_REGISTRY : configured;
  return base.endsWith('/') ? base : `${base}/`;
}

/** The package's abbreviated metadata, or undefined when the registry has no such package. */
async function fetchPackument(registry: string, name: string, fetchImpl: typeof fetch): Promise<Packument | undefined> {
  const url = `${registry}${name.replace('/', '%2f')}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new UpgradeError(`could not reach the registry at ${registry}: ${cause instanceof Error ? cause.message : String(cause)}`, 3);
  }
  if (response.status === 404 && name !== RUNNER) return undefined;
  if (!response.ok) throw new UpgradeError(`the registry at ${registry} answered ${response.status} for ${name}`, 3);
  try {
    return packumentSchema.parse(await response.json());
  } catch {
    throw new UpgradeError(`the registry at ${registry} sent metadata for ${name} that could not be read`, 3);
  }
}

/** The `e2e` version the target names. */
function resolveRunner(target: UpgradeTarget, packument: Packument | undefined): string {
  if (packument === undefined) throw new UpgradeError('the registry has no e2e package', 3);
  const tags = packument['dist-tags'];
  if (target.kind === 'tag') {
    const version = tags[target.tag];
    if (version === undefined) {
      throw new UpgradeError(`e2e has no "${target.tag}" release; its dist-tags are ${Object.keys(tags).join(', ')}`, 2);
    }
    return version;
  }
  if (packument.versions[target.version] === undefined) {
    const latest = tags['latest'];
    throw new UpgradeError(`e2e ${target.version} was never published${latest === undefined ? '' : `; the latest release is ${latest}`}`, 2);
  }
  return target.version;
}

/**
 * Picks every declared package's version: `e2e` the target, each sibling the
 * release under the same dist-tag when its peer ranges accept the versions
 * chosen so far, else its newest one that does, never deprecated, and a
 * prerelease only when the runner is one. A sibling whose peer is another
 * sibling (an integration on its engine) waits for that one.
 */
function resolveSiblings(
  target: UpgradeTarget,
  runner: string,
  declared: readonly Declared[],
  packuments: ReadonlyMap<string, Packument | undefined>,
  missing: (name: string) => void,
): Map<string, string> {
  const chosen = new Map<string, string>([[RUNNER, runner]]);
  const allowPrerelease = (parseVersion(runner)?.prerelease.length ?? 0) > 0;
  let pending = declared.filter((entry) => entry.name !== RUNNER);
  for (const entry of pending.filter((candidate) => packuments.get(candidate.name) === undefined)) missing(entry.name);
  pending = pending.filter((entry) => packuments.get(entry.name) !== undefined);
  const planned = new Set(pending.map((entry) => entry.name));
  while (pending.length > 0) {
    const ready = pending.filter((entry) =>
      peerNames(packuments.get(entry.name)!).every((peer) => !planned.has(peer) || chosen.has(peer)),
    );
    // Peers that wait on each other: resolve them against what is chosen so far.
    const batch = ready.length > 0 ? ready : pending;
    for (const entry of batch) {
      chosen.set(entry.name, pickSibling(entry.name, packuments.get(entry.name)!, target, chosen, allowPrerelease));
    }
    pending = pending.filter((entry) => !batch.includes(entry));
  }
  return chosen;
}

/** Every peer any version of the package names. */
function peerNames(packument: Packument): string[] {
  return [...new Set(Object.values(packument.versions).flatMap((manifest) => Object.keys(manifest.peerDependencies ?? {})))];
}

function pickSibling(name: string, packument: Packument, target: UpgradeTarget, chosen: ReadonlyMap<string, string>, allowPrerelease: boolean): string {
  const fits = (version: string): boolean => {
    const manifest = packument.versions[version];
    if (manifest === undefined || manifest.deprecated !== undefined) return false;
    return Object.entries(manifest.peerDependencies ?? {}).every(([peer, range]) => {
      const peerVersion = chosen.get(peer);
      const parsed = peerVersion === undefined ? undefined : parseVersion(peerVersion);
      return peerVersion === undefined || (parsed !== undefined && satisfies(parsed, range));
    });
  };
  const tagged = packument['dist-tags'][target.kind === 'tag' ? target.tag : 'latest'];
  if (tagged !== undefined && fits(tagged) && (allowPrerelease || parseVersion(tagged)?.prerelease.length === 0)) return tagged;
  const candidates = Object.keys(packument.versions)
    .flatMap((version) => {
      const parsed = parseVersion(version);
      return parsed !== undefined && (allowPrerelease || parsed.prerelease.length === 0) && fits(version) ? [{ version, parsed }] : [];
    })
    .toSorted((a, b) => compareVersions(b.parsed, a.parsed));
  const [newest] = candidates;
  if (newest !== undefined) return newest.version;
  const latest = packument['dist-tags']['latest'];
  const needs = latest === undefined ? undefined : packument.versions[latest]?.peerDependencies?.[RUNNER];
  throw new UpgradeError(
    `no ${name} release works with e2e ${chosen.get(RUNNER)}${latest !== undefined && needs !== undefined ? `; ${name} ${latest} needs e2e ${needs}` : ''}`,
    2,
  );
}

/**
 * What to ask the package manager for. A named version or a prerelease is
 * pinned exactly; a dist-tag keeps the operator of the old spec (`^`, `~`, or
 * none for an exact pin), `^` for any other range.
 */
function requestFor(spec: string, version: string, target: UpgradeTarget): string {
  if (target.kind === 'version' || (parseVersion(version)?.prerelease.length ?? 0) > 0) return version;
  const trimmed = spec.trim();
  const operator = /^([~^])\s*v?\d/u.exec(trimmed)?.[1];
  if (operator !== undefined) return `${operator}${version}`;
  return parseVersion(trimmed.replace(/^=/u, '')) === undefined ? `^${version}` : version;
}

function describeChange(entry: Planned): string {
  const from = entry.installed ?? entry.spec;
  if (entry.installed === entry.version) return `${entry.version} ${picocolors.dim('(up to date)')}`;
  const before = entry.installed === undefined ? undefined : parseVersion(entry.installed);
  const after = parseVersion(entry.version);
  const downgrade = before !== undefined && after !== undefined && compareVersions(after, before) < 0;
  return `${from} → ${picocolors.bold(entry.version)}${downgrade ? picocolors.yellow(' (downgrade)') : ''}`;
}

/**
 * One add command per section, so every package stays in its section and the
 * packages of one section move together, which keeps npm's peer check from
 * failing between them. The command pins exactly when every request in it is
 * an exact version: npm would otherwise save one with a `^`, and its exact
 * flag would flatten a `^` request into a pin too.
 */
function installCommands(manager: PackageManager, entries: readonly Planned[], workspaceRoot: boolean): string[][] {
  return SECTIONS.flatMap((section) => {
    const group = entries.filter((entry) => entry.section === section);
    if (group.length === 0) return [];
    const exact = group.every((entry) => parseVersion(entry.request) !== undefined);
    return [[...addArgs(manager, section, exact, workspaceRoot), ...group.map((entry) => `${entry.name}@${entry.request}`)]];
  });
}

function addArgs(manager: PackageManager, section: Section, exact: boolean, workspaceRoot: boolean): string[] {
  switch (manager) {
    case 'npm':
      return ['install', { dependencies: '--save-prod', devDependencies: '--save-dev', optionalDependencies: '--save-optional' }[section], ...(exact ? ['--save-exact'] : [])];
    case 'pnpm':
      return [
        'add',
        { dependencies: '--save-prod', devDependencies: '--save-dev', optionalDependencies: '--save-optional' }[section],
        ...(exact ? ['--save-exact'] : []),
        ...(workspaceRoot ? ['--workspace-root'] : []),
      ];
    case 'yarn':
    case 'bun':
      return [
        'add',
        ...({ dependencies: [], devDependencies: ['--dev'], optionalDependencies: ['--optional'] }[section]),
        ...(exact ? ['--exact'] : []),
      ];
  }
}

function spawnInstall(command: string, args: readonly string[], cwd: string): SpawnOutcome {
  return spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

/** A path for a message: relative to the working directory, `.` for the directory itself. */
function relative(cwd: string, target: string): string {
  return path.relative(cwd, target) || '.';
}
