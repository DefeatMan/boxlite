/*
 * `npm run runner:update -- --stage <stage> [--version X.Y.Z] [--allow-downgrade]`
 *
 * Rolling the fleet's binary by hand, outside a deploy — and the only way to
 * move it *backwards*.
 *
 * A deploy already rolls the fleet forward: `stack/runner-upgrade.ts` renders
 * the payload and each provider chains one command per host. What a deploy
 * deliberately cannot do is downgrade. The payload refuses to replace a host
 * serving something newer than the target, because a host ahead of the declared
 * version is usually a deliberate hand-install and silently reverting it during
 * an unrelated deploy is a nasty surprise. That refusal exits 0, so a rollback
 * attempted by editing the version would report success and change nothing.
 *
 * So the force lives here instead of in the deploy, and that is the whole design
 * decision: a rollback is a decision someone makes, at a moment, watching the
 * output — not a state a stage's configuration can be left in. A stored flag
 * would be a stage that quietly permits downgrades on every future deploy, which
 * is exactly the surprise the guard exists to prevent.
 *
 * Everything else is shared with the deploy rather than reimplemented: the same
 * `renderUpgradePayload` converge/verify/swap/rollback script, the same
 * transports in `upgrade-runners.ts`, the same host-at-a-time sequencing that
 * stops on the first failure. This file only answers the two questions a deploy
 * answers structurally — which hosts, and in what order.
 *
 * A published release by default, and `--ref <commit>` for a binary `runner:
 * build` staged in this stage's artifacts bucket. Both reach the same resolver
 * the deploy uses, so the address, the tarball name and the identity a host
 * reports are composed once: a build identity is `X.Y.Z+<commit>`, which is
 * what lets the converge guard tell two builds of one checkout apart.
 *
 * `--ref` exists because a deploy is the wrong instrument for installing one:
 * `mdeploy` applies the whole stack, so a fleet-only change would also roll
 * every other resource the checkout has moved past the stage — and on a stage
 * behind the checkout that is a far larger action than the one being asked for.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseInvocation, type Options } from 'mstage/cli'
import { loadConfig } from 'mstage/config'
import { resolveHome } from 'mstage/home'
import { run as mstage } from 'mstage/run'
import { resolveScope } from 'mstage/scope'
import { deployRoot } from './config.ts'
import {
  sleepSeconds,
  spawnWith,
  upgradeFleetOverPolicy,
  upgradeOne,
  type RunCommand,
  type UpgradeOneRequest,
} from './upgrade-runners.ts'
import { encodeUpgradePayload, renderPolicyScripts } from '../stack/runner-upgrade.ts'
import { RUNNER_PORT, runnerNamePrefix, runnerPolicyName } from '../stack/runners.ts'
import {
  gcpRunnerArtifactsBucket,
  resolveRunnerBinary,
  runnerArtifactsBucket,
  type ArtifactStaging,
} from '../stack/runner-binary.ts'
import { zoneIn } from '../stack/providers/gcp/index.ts'

export class RunnerUpdateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerUpdateError'
  }
}

const USAGE = [
  'usage: npm run runner:update -- --stage <stage> [--version <X.Y.Z>] [--ref <commit>]',
  '                                [--host <name>[,<name>…]] [--allow-downgrade] [--confirm]',
  '',
  '  --version          the release line to install. Defaults to the checkout’s own',
  '                     version; name one with --ref when that commit was built from',
  '                     a different line.',
  '  --ref              install the build `runner:build` staged for this commit instead',
  '                     of a release. One full 40-character sha.',
  '  --host             only these hosts, by the name the console shows. Default: every one.',
  '  --allow-downgrade  replace a host serving something NEWER. This is the rollback.',
  '  --confirm          required for a stage mstage.config.json marks protected.',
].join('\n')

/**
 * This tool's own switches. mstage parses them but never advertises them.
 *
 * `--version` and `--confirm` are not here because mstage already knows both —
 * which is worth having rather than shadowing: its own guard catches the
 * `npm run … --version 0.9.5` that npm swallows before this ever runs.
 */
const OWN_OPTIONS = { flags: ['allow-downgrade'], values: ['host', 'ref'] }

/**
 * How each cloud names a runner, which is also how each is found.
 *
 * The providers set both: AWS tags the instance `Name=boxlite-runner-*`, GCP
 * names it the same thing. Discovery matches that pattern rather than reading
 * the engine's state — a state file is one deploy's record, and this tool has to
 * work on a fleet whose last deploy failed halfway.
 */
// The prefix is `<app>-<stage>-runner`, built by the same `runnerNamePrefix`
// the stack names a host with — one definition, so discovery cannot drift from
// creation, and a roll in one stage never sees another stage's hosts.

export type Host = { target: string; label: string }

/**
 * The order the fleet was created in, which is the order to visit it in.
 *
 * Not the API's order — neither cloud promises one, and a roll that took what
 * it was given would visit the fleet differently every run, which defeats the
 * point of going one at a time: after a failure, *which* hosts are still
 * serving has to be knowable.
 *
 * Not lexicographic either, and that is the part worth stating. `stack-env.ts`
 * names the first host `boxlite-runner-default` and every later one
 * `boxlite-runner-<n>`, so sorting by string puts `-2` before `-default` and
 * `-10` before `-2`. The fleet's own order is: the first host, then the rest by
 * number — the same order the deploy's `dependsOn` chain walks.
 */
const numbered = (label: string, prefix: string): number | null => {
  if (label === prefix) return 0
  if (!label.startsWith(`${prefix}-`)) return null
  const suffix = label.slice(prefix.length + 1)
  return /^[0-9]+$/.test(suffix) ? Number(suffix) : null
}

/** The comparator for one stage's fleet, which is the only fleet it explains. */
export const compareHostsIn = (prefix: string) => (left: Host, right: Host): number => {
  const [a, b] = [numbered(left.label, prefix), numbered(right.label, prefix)]
  // A host neither pattern explains — renamed by hand, or from another fleet —
  // goes last, in its own stable order, rather than jumping the queue.
  if (a === null || b === null) {
    if (a === null && b === null) return left.label.localeCompare(right.label)
    return a === null ? 1 : -1
  }
  return a - b
}

/** Every running runner in the stage's region, in a stable order. */
const awsHosts = (region: string, run: RunCommand, prefix: string): Host[] => {
  const listed = run('aws', [
    'ec2',
    'describe-instances',
    '--region',
    region,
    '--filters',
    `Name=tag:Name,Values=${prefix}*`,
    'Name=instance-state-name,Values=running',
    '--query',
    'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`].Value|[0]]',
    '--output',
    'text',
  ])
  if (!listed.ok) throw new RunnerUpdateError(`could not list the fleet: ${listed.stderr || '(no stderr)'}`)
  return listed.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([id]) => id && id !== 'None')
    .map(([target, label]) => ({ target: target as string, label: label ?? (target as string) }))
    .sort(compareHostsIn(prefix))
}

/**
 * Which bucket this stage stages a build in, asked of the cloud rather than the
 * caller.
 *
 * `runner:build` composes the same two names from the same rule, so the object
 * this resolves is the object that command uploaded — the reason the name is
 * composed in `stack/runner-binary.ts` and never recorded anywhere.
 *
 * AWS needs the account id and reads it from the session actually doing the
 * roll, so a bucket qualified for one account is never addressed with another's
 * credentials. GCP needs only the project, which the stage already names.
 */
const stagingFor = ({
  cloud,
  app,
  scope,
  run,
}: {
  cloud: 'aws' | 'gcp'
  app: string
  scope: { stage?: unknown; project?: unknown; region?: unknown }
  run: RunCommand
}): ArtifactStaging => {
  const stage = scope.stage as string
  if (cloud === 'gcp') {
    const project = (scope.project as string | undefined)?.trim()
    if (!project) throw new RunnerUpdateError(`stage ${stage} names no GCP project, so its artifacts bucket has no name`)
    return { cloud, bucket: gcpRunnerArtifactsBucket({ app, stage, project }) }
  }
  const read = run('aws', [
    'sts',
    'get-caller-identity',
    '--query',
    'Account',
    '--output',
    'text',
    '--region',
    scope.region as string,
  ])
  const accountId = read.ok ? read.stdout.trim() : ''
  if (!/^[0-9]{12}$/.test(accountId)) {
    throw new RunnerUpdateError(
      `could not read the AWS account id (got ${JSON.stringify(accountId)}): ${read.stderr || '(no stderr)'}`,
    )
  }
  return { cloud, bucket: runnerArtifactsBucket({ app, stage, accountId }) }
}

/**
 * That both objects this is about to install exist, asked before a single host
 * is stopped.
 *
 * `runner:build` checks its destination before spending minutes compiling, for
 * the same reason in the other direction. Here the cost of finding out late is
 * worse than wasted time: the roll stops hosts one at a time, so an address
 * nothing published fails on the first host with the rest of the fleet still to
 * go and one machine already down.
 *
 * Two ways to arrive at such an address, and this catches both: a commit whose
 * build was never staged for this stage, and a `--version` that names a release
 * line the build under that commit was not stamped with — the tarball carries
 * both, so either one alone composes a name nobody uploaded.
 */
const assertStaged = ({
  cloud,
  binary,
  scope,
  run,
}: {
  cloud: 'aws' | 'gcp'
  binary: { tarballUrl: string; checksumUrl: string }
  scope: { region?: unknown }
  run: RunCommand
}): void => {
  // Both objects, because a host fetches both and verifies one against the
  // other. `runner:build` treats a prefix holding only some of what it uploads
  // as a reachable state it reports rather than repairs, so the half-published
  // case is real — and checking only the tarball would hand it to the first
  // host to stop, which is the failure this whole check exists to move earlier.
  for (const url of [binary.tarballUrl, binary.checksumUrl]) {
    const found =
      cloud === 'gcp'
        ? run('gcloud', ['storage', 'objects', 'describe', url, '--format=value(name)'])
        : run('aws', [
            's3api',
            'head-object',
            '--region',
            scope.region as string,
            '--bucket',
            url.replace(/^s3:\/\//, '').split('/')[0] as string,
            '--key',
            url.replace(/^s3:\/\/[^/]+\//, ''),
          ])
    if (!found.ok) {
      throw new RunnerUpdateError(
        `nothing is staged at ${url}. Run \`npm run runner:build -- --stage <stage>\` from that ` +
          `commit's checkout, or drop --ref to install a release: ${found.stderr || '(no stderr)'}`,
      )
    }
  }
}

const gcpHosts = ({
  project,
  zone,
  run,
  prefix,
}: {
  project: string
  zone: string
  run: RunCommand
  prefix: string
}): Host[] => {
  const listed = run('gcloud', [
    'compute',
    'instances',
    'list',
    `--project=${project}`,
    `--zones=${zone}`,
    `--filter=name~^${prefix} AND status=RUNNING`,
    '--format=value(name)',
  ])
  if (!listed.ok) throw new RunnerUpdateError(`could not list the fleet: ${listed.stderr || '(no stderr)'}`)
  return listed.stdout
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
    // The name *is* the target on this cloud: `gcloud compute ssh` takes it.
    .map((name) => ({ target: name, label: name }))
    .sort(compareHostsIn(prefix))
}

/** The subset an operator named, or all of them. Naming one that is not there is a mistake, not a filter. */
/**
 * Where the rewritten policy is handed to gcloud.
 *
 * A file rather than stdin: `os-policy-assignments update` takes `--file`, and
 * the scripts inside carry newlines and shell metacharacters that no command
 * line survives. Written under the OS temp directory, which is this process's
 * own and goes away with it.
 */
const writePolicyFile = (contents: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'boxlite-runner-policy-')), 'policy.json')
  writeFileSync(path, contents, { mode: 0o600 })
  return path
}

const selected = (hosts: Host[], named: string[]): Host[] => {
  if (named.length === 0) return hosts
  const missing = named.filter((name) => !hosts.some((host) => host.label === name || host.target === name))
  if (missing.length > 0) {
    throw new RunnerUpdateError(
      `${missing.join(', ')} is not a running runner in this stage. Found: ${hosts.map((host) => host.label).join(', ') || 'none'}`,
    )
  }
  return hosts.filter((host) => named.includes(host.label) || named.includes(host.target))
}

export type UpdateInput = {
  argv: string[]
  environment?: NodeJS.ProcessEnv
  cwd?: string
  log?: (line: string) => void
  checkLogin?: typeof mstage
  resolveHomeWith?: typeof resolveHome
  /** Injected so a roll is provable without an account, a project or a host. */
  run?: RunCommand
  sleep?: (seconds: number) => void
}

export const updateRunners = async ({
  argv,
  environment = process.env,
  cwd = process.cwd(),
  log = console.log,
  checkLogin = mstage,
  resolveHomeWith = resolveHome,
  run: injectedRun,
  sleep = sleepSeconds,
}: UpdateInput): Promise<number> => {
  if (argv[0] === 'help' || argv[0] === '--help') {
    log(USAGE)
    return 0
  }

  const { options, inner } = parseInvocation(['roll', ...argv], environment, OWN_OPTIONS)
  if (inner) throw new RunnerUpdateError(`runner:update takes no inner command.\n${USAGE}`)

  const config = loadConfig({ cwd, environment })
  // `resolveScope` refuses a missing --stage itself, and names the stages this
  // repository declares while doing it.
  const scope = resolveScope({ options: options as Options, config, environment })

  // Same gate a deploy applies, for the same reason: this restarts every runner
  // in the fleet, and boxes on a host take the restart.
  if (scope.protect && options.confirm !== true) {
    throw new RunnerUpdateError(`Stage "${scope.stage}" is protected in ${config.path}. Add --confirm to roll its fleet.`)
  }

  // Named with the stage, because which sign-ins this needs is the stage's
  // question: a repository with stages in both clouds declares both, and
  // without the stage an expired session in the cloud this fleet does not live
  // in would refuse the roll.
  const signedIn = await checkLogin({ argv: ['login', '--stage', scope.stage as string], environment, cwd, log })
  if (signedIn !== 0) throw new RunnerUpdateError('Required sign-ins are missing; run `npm run mstage login -- -f` first')

  const version = (options.version as string | undefined)?.trim()
  // Checked here rather than left to the resolver: a typo'd sha would otherwise
  // surface as a missing object after the fleet has already been discovered.
  const ref = (options.ref as string | undefined)?.trim().toLowerCase()
  if (ref !== undefined && !/^[0-9a-f]{40}$/.test(ref)) {
    throw new RunnerUpdateError(`--ref takes one full 40-character commit sha; got ${JSON.stringify(options.ref)}`)
  }
  const allowDowngrade = options['allow-downgrade'] === true
  const named = (options.host as string | undefined)
    ?.split(',')
    .map((name) => name.trim())
    .filter(Boolean) ?? []

  const home = await resolveHomeWith({ scope })
  const { env: credentials } = await home.identity.childEnvironment()
  const run = injectedRun ?? spawnWith({ ...environment, ...credentials })

  /*
   * The same resolution the stack does, told which of the two kinds to compose.
   *
   * `VERSION` and the artifact-source pair are the selectors
   * `stack/runner-binary.ts` already honours, so both kinds reach it the way a
   * deploy's would — one resolver, one set of asset names, one identity rule.
   * The source is stated rather than inherited so an exported
   * `RUNNER_ARTIFACT_SOURCE` from some earlier command cannot silently decide
   * which binary a hand-rolled fleet gets.
   *
   * Resolved after the cloud is known because a build's address is a bucket in
   * this stage, and which bucket is a question only the home can answer.
   */
  const binary = resolveRunnerBinary({
    environment: {
      ...environment,
      ...(version ? { VERSION: version } : {}),
      RUNNER_ARTIFACT_SOURCE: ref ? 'build' : 'release',
      BOXLITE_ARTIFACT_SOURCE: ref ? 'build' : 'release',
      ...(ref ? { RUNNER_ARTIFACT_REF: ref, BOXLITE_ARTIFACT_REF: ref } : {}),
    },
    configRoot: deployRoot({ cwd, environment }),
    staging: ref ? stagingFor({ cloud: home.identity.home, app: config.app, scope, run }) : null,
  })
  if (ref) assertStaged({ cloud: home.identity.home, binary, scope, run })

  const prefix = runnerNamePrefix({ app: config.app, stage: scope.stage as string })
  const hosts = selected(
    home.identity.home === 'aws'
      ? awsHosts(scope.region as string, run, prefix)
      : gcpHosts({
          project: scope.project as string,
          zone: zoneIn(scope.region as string, scope.zone ?? null),
          run,
          prefix,
        }),
    named,
  )
  if (hosts.length === 0) throw new RunnerUpdateError(`no running runner in ${config.app}/${scope.stage}`)

  const payload = encodeUpgradePayload({
    identity: binary.identity,
    binary,
    port: RUNNER_PORT,
    region: home.identity.home === 'aws' ? (scope.region as string) : null,
    allowDowngrade,
  })

  log(`==> rolling ${hosts.length} host(s) in ${config.app}/${scope.stage} to ${binary.identity}`)
  log(`==> artifact: ${binary.tarballUrl}`)
  if (allowDowngrade) log('==> --allow-downgrade: a host serving something newer WILL be replaced')

  /*
   * On GCP the fleet is declared, not commanded.
   *
   * A deploy owns one OS policy assignment over these hosts, so a hand roll
   * rewrites that assignment rather than reaching into each machine — there is
   * no ssh here that an account outside the instance's organization could open
   * anyway. The consequences are the two lines printed below: the roll covers
   * the whole fleet, and it lasts until the next deploy re-asserts the identity
   * the checkout declares.
   */
  if (home.identity.home === 'gcp') {
    if (named.length > 0) {
      throw new RunnerUpdateError(
        '--host is not available on GCP: the fleet is one declared state, and narrowing it would leave ' +
          'the assignment pointing at a single machine after the roll',
      )
    }
    const zone = zoneIn(scope.region as string, scope.zone ?? null)
    log('==> this rewrites the deployed policy; the next mdeploy restores the checkout’s identity')
    upgradeFleetOverPolicy({
      targets: hosts.map((host) => host.target),
      identity: binary.identity,
      scripts: renderPolicyScripts({
        identity: binary.identity,
        binary,
        port: RUNNER_PORT,
        allowDowngrade,
      }),
      project: scope.project as string,
      zone,
      assignment: runnerPolicyName({ app: config.app, stage: scope.stage as string }),
      run,
      sleep,
      log,
      writeFile: writePolicyFile,
    })
    log(`==> done (${hosts.length} host(s))`)
    return 0
  }

  for (const [index, host] of hosts.entries()) {
    log(`==> [${index + 1}/${hosts.length}]`)
    const request = {
      identity: binary.identity,
      payload,
      label: host.label,
      ...(home.identity.home === 'aws'
        ? { cloud: 'aws' as const, target: host.target, region: scope.region as string }
        : {
            cloud: 'gcp' as const,
            target: host.target,
            project: scope.project as string,
            zone: zoneIn(scope.region as string, scope.zone ?? null),
          }),
    } satisfies UpgradeOneRequest
    // Sequential, and a failure stops the roll: the hosts not yet visited keep
    // serving what they were serving. The same property the deploy gets from
    // its dependency chain.
    upgradeOne(request, { run, sleep, log })
  }

  /*
   * Deliberately does not assert the fleet is at the target.
   *
   * A host can be skipped as already-serving-it, left alone as still
   * bootstrapping, or refused as a downgrade — the per-host lines above say
   * which, and a blanket "all at vX" would be false for every one of those.
   */
  log(`==> done (${hosts.length} host(s))`)
  return 0
}
