/*
 * The out-of-band roll, and the one thing it can do that a deploy cannot.
 *
 * What is worth pinning is the boundary: this tool shares the payload, the
 * transports and the sequencing with the deploy, and differs in exactly two
 * ways — it discovers the fleet itself, and it can pass `allowDowngrade`. A
 * second, laxer implementation of the upgrade is the failure this guards
 * against, so the assertions are mostly about what it does *not* re-decide.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { RunnerUpdateError, compareHostsIn, updateRunners, type Host } from '../src/runner-update.ts'
import type { CommandResult, RunCommand } from '../src/upgrade-runners.ts'

const ok = (stdout = ''): CommandResult => ({ ok: true, status: 0, stdout, stderr: '' })

/**
 * The committed example, not this machine's stage file.
 *
 * These drive the real `--stage` resolution, so the stages they name have to be
 * declared somewhere — and `.mstage.config.json` is not committed, so on a
 * runner there is nothing to declare them. Reading the example also keeps it
 * from going stale: a stage dropped from it fails here.
 */
const EXAMPLE = fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url))

const failed = (stderr: string): CommandResult => ({ ok: false, status: 1, stdout: '', stderr })

/**
 * A fleet of two on AWS, and an SSM command that succeeds.
 *
 * `account` and `staged` are what the `--ref` path adds: the session's own
 * account id qualifies the bucket, and the object has to be found before any
 * host is stopped. Both default to the answers a healthy stage gives.
 */
const awsFleet = (
  calls: string[][] = [],
  { account = '123456789012', staged = true }: { account?: string; staged?: boolean } = {},
): RunCommand => {
  return (file, args) => {
    calls.push([file, ...args])
    if (args[1] === 'describe-instances') {
      return ok('i-0002\tboxlite-app-dev-runner-2\ni-0001\tboxlite-app-dev-runner')
    }
    if (args[1] === 'get-caller-identity') return account ? ok(account) : failed('ExpiredToken')
    if (args[1] === 'head-object') return staged ? ok('') : failed('Not Found')
    if (args[1] === 'send-command') return ok('cmd-1')
    if (args.includes('Status')) return ok('Success')
    return ok('')
  }
}

/**
 * A fleet of two on GCP.
 *
 * `reports` scripts what each host's `describe` answers, one entry per pass, so
 * a test can put a host through the states a real agent goes through before it
 * converges. The default is COMPLIANT on the first pass, which is what lets
 * every other test finish without spending the roll's deadline.
 */
const gcpFleet = (
  calls: string[][] = [],
  reports: Record<string, CommandResult[]> = {},
): RunCommand => {
  return (file, args) => {
    calls.push([file, ...args])
    if (args[1] === 'instances') return ok('boxlite-app-dev2-runner\nboxlite-app-dev2-runner-2')
    // `describe` answers for the one instance it was asked about, so the
    // fixture answers the way gcloud does rather than handing back a fleet-wide
    // table no surface emits.
    if (args[3] === 'describe') {
      const host = args.find((argument) => argument.startsWith('--instance='))?.slice('--instance='.length) ?? ''
      return reports[host]?.shift() ?? ok('COMPLIANT')
    }
    return ok('new identity: 0.10.0')
  }
}

const drive = (argv: string[], run: RunCommand, home: 'aws' | 'gcp' = 'aws') =>
  updateRunners({
    argv,
    environment: { MSTAGE_CONFIG: EXAMPLE },
    cwd: new URL('../..', import.meta.url).pathname,
    log: () => {},
    checkLogin: async () => 0,
    resolveHomeWith: (async () => ({
      identity: { home, childEnvironment: async () => ({ env: {}, expiresAt: null }) },
      backend: {},
    })) as never,
    run,
    sleep: () => {},
  })

test('a fleet is discovered and visited in a stable order, one host at a time', async () => {
  // describe-instances promises no order, so a roll that took it as given would
  // visit the fleet differently every run — and the whole point of going one at
  // a time is that a failure leaves a known set still serving.
  const calls: string[][] = []
  assert.equal(await drive(['--stage', 'dev'], awsFleet(calls)), 0)
  const sent = calls.filter((call) => call[2] === 'send-command')
  assert.equal(sent.length, 2, 'both hosts were rolled')
  const targets = sent.map((call) => call[call.indexOf('--instance-ids') + 1])
  assert.deepEqual(targets, ['i-0001', 'i-0002'], 'sorted by the name a console shows, not by the API’s order')
})

test('the fleet’s order is its own, not the string order of its names', () => {
  // The case a two-host fixture cannot show: `stack-env.ts` names hosts
  // `-default`, `-2`, `-3`… so sorting by string puts `-10` before `-2` and
  // both before `-default`. A roll has to walk the order the deploy's chain
  // walks, or "which hosts are still serving" means something different after a
  // failure than it did before.
  const PREFIX = 'boxlite-app-dev-runner'
  // The first host takes the bare prefix; the rest a number.
  const host = (label: string): Host => ({
    target: `i-${label}`,
    label: label === 'default' ? PREFIX : `${PREFIX}-${label}`,
  })
  const fleet = [host('10'), host('2'), host('default'), host('3')]
  assert.deepEqual(
    [...fleet].sort(compareHostsIn(PREFIX)).map((entry) => entry.label),
    [PREFIX, `${PREFIX}-2`, `${PREFIX}-3`, `${PREFIX}-10`],
  )

  // A host neither pattern explains goes last rather than jumping the queue: it
  // was renamed by hand, or belongs to something else entirely.
  const stranger = { target: 'i-x', label: 'someone-elses-box' }
  assert.deepEqual(
    [stranger, host('2'), host('default')].sort(compareHostsIn(PREFIX)).map((entry) => entry.label),
    [PREFIX, `${PREFIX}-2`, 'someone-elses-box'],
  )
})

test('the version is the checkout’s unless one is named, and a release unless --ref', async () => {
  // Without --ref this installs a published release: a bare roll must never
  // reach for a commit-keyed object that only some stages have staged.
  const calls: string[][] = []
  await drive(['--stage', 'dev', '--version', '0.9.5'], awsFleet(calls))
  const comment = calls.find((call) => call[2] === 'send-command')?.join(' ')
  assert.match(comment ?? '', /boxlite-runner upgrade to 0\.9\.5/)

  const fromCheckout: string[][] = []
  await drive(['--stage', 'dev'], awsFleet(fromCheckout))
  const withoutVersion = fromCheckout.find((call) => call[2] === 'send-command')?.join(' ')
  assert.match(withoutVersion ?? '', /boxlite-runner upgrade to \d+\.\d+\.\d+/)
  assert.doesNotMatch(withoutVersion ?? '', /\+[0-9a-f]{40}/, 'never a build identity')
})

test('the downgrade force reaches the payload only when it is asked for', async () => {
  // The whole reason this tool exists: the deploy path cannot set this, so a
  // stage cannot be left in a state where downgrades are quietly permitted.
  const decode = (calls: string[][]): string => {
    const parameters = calls.find((call) => call[2] === 'send-command')?.find((argument) => argument.startsWith('commands='))
    const encoded = parameters?.match(/echo ([A-Za-z0-9+/=]+) \|/)?.[1] as string
    return Buffer.from(encoded, 'base64').toString('utf8')
  }

  const guarded: string[][] = []
  await drive(['--stage', 'dev'], awsFleet(guarded))
  assert.match(decode(guarded), /ALLOW_DOWNGRADE=""/)

  const forced: string[][] = []
  await drive(['--stage', 'dev', '--allow-downgrade'], awsFleet(forced))
  assert.match(decode(forced), /ALLOW_DOWNGRADE="1"/)
  // And it is the same script either way — the converge, the verification and
  // the rollback are not re-decided here.
  assert.match(decode(forced), /already serving \$TARGET; leaving the unit untouched/)
  assert.match(decode(forced), /upgrade failed; rolling back/)
})

test('a named host has to be one that is running, rather than silently matching nothing', async () => {
  await assert.rejects(
    () => drive(['--stage', 'dev', '--host', 'boxlite-app-dev-runner-9'], awsFleet()),
    (error: Error) => {
      assert.ok(error instanceof RunnerUpdateError)
      assert.match(error.message, /boxlite-app-dev-runner-9 is not a running runner in this stage/)
      assert.match(error.message, /Found: boxlite-app-dev-runner, boxlite-app-dev-runner-2/)
      return true
    },
  )
})

test('naming one host rolls that one and no other', async () => {
  const calls: string[][] = []
  await drive(['--stage', 'dev', '--host', 'boxlite-app-dev-runner-2'], awsFleet(calls))
  const sent = calls.filter((call) => call[2] === 'send-command')
  assert.equal(sent.length, 1)
  assert.ok(sent[0]?.includes('i-0002'))
})

test('a protected stage is confirmed, exactly as a deploy of it would be', async () => {
  // This restarts every runner in the fleet, and boxes on a host take the
  // restart. The gate is the same one `mdeploy` applies for the same reason.
  await assert.rejects(
    () => drive(['--stage', 'prod'], awsFleet()),
    /Stage "prod" is protected in .*Add --confirm to roll its fleet/s,
  )
  assert.equal(await drive(['--stage', 'prod', '--confirm'], awsFleet()), 0)
})

test('an empty fleet is a refusal, not a silent success', async () => {
  const empty: RunCommand = (_file, args) => (args[1] === 'describe-instances' ? ok('') : ok(''))
  await assert.rejects(() => drive(['--stage', 'dev'], empty), /no running runner in boxlite-app\/dev/)
})

test('on GCP the roll rewrites the fleet’s policy and waits for the agents', async () => {
  /*
   * No ssh at all on this cloud: the hosts are declared by one OS policy
   * assignment, so a hand roll edits that assignment and waits for every host
   * to report compliant. A second assignment would be a second enforcer, and
   * the two would take turns undoing each other.
   */
  const calls: string[][] = []
  assert.equal(await drive(['--stage', 'dev2'], gcpFleet(calls), 'gcp'), 0)

  const listed = calls.find((call) => call[2] === 'instances')
  assert.ok(listed?.some((argument) => argument.startsWith('--filter=name~^boxlite-app-dev2-runner')))

  const written = calls.find((call) => call[3] === 'os-policy-assignments' && call[4] === 'update')
  assert.ok(written, 'the roll never rewrote the assignment')
  assert.ok(written?.includes('boxlite-app-dev2-runner-binary'), 'it rewrote some other assignment')
  assert.ok(written?.some((argument) => argument.startsWith('--file=')), 'the policy has to arrive as a file')

  // Pinned to the surface that can actually answer. `list` carries a rendered
  // "1/1 policies compliant" and no compliance state, so a roll polling it reads
  // empty for every host and waits out its whole deadline on a fleet that
  // converged minutes ago.
  const polled = calls.filter((call) => call[3] === 'os-policy-assignment-reports')
  assert.ok(polled.length > 0, 'the roll never waited for the agents to converge')
  for (const call of polled) {
    assert.equal(call[4], 'describe', 'only describe returns a compliance state')
    assert.ok(
      call.some((argument) => argument.includes('osPolicyCompliances[0].complianceState')),
      'the state is the field the roll keys on',
    )
  }
  assert.deepEqual(
    polled.map((call) => call.find((argument) => argument.startsWith('--instance='))),
    ['--instance=boxlite-app-dev2-runner', '--instance=boxlite-app-dev2-runner-2'],
    'describe answers per instance, so every host is asked about by name',
  )
  assert.equal(calls.filter((call) => call[2] === 'ssh').length, 0, 'the tunnel is gone from this path')
})

test('--host is refused on GCP, because the policy is the whole fleet', async () => {
  // Narrowing the assignment would leave it pointing at one machine after the
  // roll, which is a fleet whose other hosts are declared by nothing.
  await assert.rejects(
    () => drive(['--stage', 'dev2', '--host', 'boxlite-app-dev2-runner'], gcpFleet(), 'gcp'),
    /--host is not available on GCP/,
  )
})

test('a stage is required, and mstage says which ones there are', async () => {
  // Refused by `resolveScope` rather than by a check here: it already names the
  // stages the config declares, which is what someone who mistyped one needs.
  await assert.rejects(() => drive([], awsFleet()), /--stage is required\..*declares: dev, prod, dev2/s)
})

test('--ref installs the build staged for that commit, addressed in this stage’s bucket', async () => {
  // The whole point of the switch: `mdeploy` applies the entire stack, so a
  // fleet-only change to a stage behind the checkout would drag every other
  // resource forward with it. The address has to be the one `runner:build`
  // uploaded to, and the identity the one a converged host reports.
  const REF = 'b8ae3f9cc5062570c0722302dafbbeb10d4f3d00'
  const calls: string[][] = []
  const fleet = gcpFleet(calls)
  // On GCP the payload travels in the policy document, not on the command line,
  // so the file has to be read while the command that names it is in flight.
  let policy = ''
  const capturing: RunCommand = (file, args) => {
    const named = args.find((argument) => argument.startsWith('--file='))
    if (named) policy = readFileSync(named.slice('--file='.length), 'utf8')
    return fleet(file, args)
  }
  assert.equal(await drive(['--stage', 'dev2', '--ref', REF], capturing, 'gcp'), 0)

  assert.match(policy, new RegExp(`gs://[a-z0-9-]+-artifacts-[a-z0-9-]+/runner/${REF}/`), 'the staged address')
  assert.match(policy, new RegExp(`boxlite-runner-v\\d+\\.\\d+\\.\\d+-${REF}-linux-amd64\\.tar\\.gz`))
  assert.match(policy, new RegExp(`\\d+\\.\\d+\\.\\d+\\+${REF}`), 'the build identity a host reports')

  // Asserted, not merely executed: gcpFleet answers every unrecognised command
  // with ok(), so a misspelled probe would pass here and only fail closed on a
  // real stage — against an object that is in fact staged.
  const probed = calls
    .filter((call) => call[1] === 'storage' && call[2] === 'objects' && call[3] === 'describe')
    .map((call) => call[4] as string)
  assert.equal(probed.length, 2, 'both objects a host fetches are checked, before any host is stopped')
  // The version is left open: it comes from the workspace, so pinning it here
  // would break this test on the next release bump for no reason of its own.
  assert.match(
    probed[0] as string,
    new RegExp(
      `^gs://boxlite-app-dev2-artifacts-your-gcp-project-id/runner/${REF}/` +
        `boxlite-runner-v\\d+\\.\\d+\\.\\d+-${REF}-linux-amd64\\.tar\\.gz$`,
    ),
  )
  assert.equal(probed[1], `${probed[0]}.sha256`, 'the checksum is the tarball’s own, not a second address')
})

test('--ref takes one full commit sha, and says so before the fleet is touched', async () => {
  // A short sha resolves to no object at all, and finding that out after the
  // roll has begun is finding it out on a host that is already stopped.
  const calls: string[][] = []
  await assert.rejects(
    () => drive(['--stage', 'dev', '--ref', 'b8ae3f9c'], awsFleet(calls)),
    (error: Error) => error instanceof RunnerUpdateError && /full 40-character commit sha/.test(error.message),
  )
  assert.equal(
    calls.filter((call) => call[2] === 'send-command').length,
    0,
    'no host was rolled',
  )
})

test('on AWS the bucket is qualified by the session\u2019s own account, read at roll time', async () => {
  // S3\u2019s namespace is global, so the name carries an account qualifier. Reading
  // it from the session actually doing the roll is what keeps a bucket qualified
  // for one account from being addressed with another\u2019s credentials.
  const REF = 'b8ae3f9cc5062570c0722302dafbbeb10d4f3d00'
  const calls: string[][] = []
  assert.equal(await drive(['--stage', 'dev', '--ref', REF], awsFleet(calls)), 0)

  const heads = calls.filter((call) => call[2] === 'head-object')
  assert.equal(heads.length, 2, 'the tarball and its checksum, both before any host was stopped')
  for (const head of heads) {
    assert.equal(head[head.indexOf('--bucket') + 1], 'boxlite-app-dev-artifacts-123456789012')
  }
  const keys = heads.map((head) => head[head.indexOf('--key') + 1] as string)
  assert.match(
    keys[0] as string,
    new RegExp(`^runner/${REF}/boxlite-runner-v\\d+\\.\\d+\\.\\d+-${REF}-linux-amd64\\.tar\\.gz$`),
  )
  assert.equal(keys[1], `${keys[0]}.sha256`, 'the checksum is the tarball’s own, not a second address')
})

test('an unreadable AWS account id stops the roll rather than composing a bucket from it', async () => {
  // An expired session would otherwise compose `\u2026-artifacts-` and fail against
  // a bucket name that never existed, which reads as a missing artifact.
  const calls: string[][] = []
  await assert.rejects(
    () => drive(['--stage', 'dev', '--ref', 'b8ae3f9cc5062570c0722302dafbbeb10d4f3d00'], awsFleet(calls, { account: '' })),
    (error: Error) => error instanceof RunnerUpdateError && /could not read the AWS account id/.test(error.message),
  )
  assert.equal(calls.filter((call) => call[2] === 'send-command').length, 0, 'no host was rolled')
})

test('an address nothing published is refused before the first host is stopped', async () => {
  // The roll stops hosts one at a time, so discovering this on the first host
  // leaves the fleet half-served and one machine down for nothing.
  const calls: string[][] = []
  await assert.rejects(
    () => drive(['--stage', 'dev', '--ref', 'b8ae3f9cc5062570c0722302dafbbeb10d4f3d00'], awsFleet(calls, { staged: false })),
    (error: Error) => error instanceof RunnerUpdateError && /nothing is staged at s3:\/\//.test(error.message),
  )
  assert.equal(calls.filter((call) => call[2] === 'send-command').length, 0, 'no host was rolled')
})

test('a host that has not converged yet is carried to the next pass, not failed', async () => {
  // Every answer other than COMPLIANT means "not yet", and none of them tells
  // "will not converge" apart from "has not converged": a report the agent has
  // not written, a describe that failed, and NON_COMPLIANT all have to wait for
  // the deadline to draw that line rather than end the roll on the spot.
  const calls: string[][] = []
  const slow = {
    'boxlite-app-dev2-runner': [failed('NOT_FOUND: no report yet'), ok(''), ok('NON_COMPLIANT'), ok('COMPLIANT')],
  }
  assert.equal(await drive(['--stage', 'dev2'], gcpFleet(calls, slow), 'gcp'), 0)

  const asked = calls
    .filter((call) => call[4] === 'describe')
    .map((call) => call.find((argument) => argument.startsWith('--instance=')))
  assert.deepEqual(
    asked,
    [
      // Pass 1: both asked, one converges and drops out.
      '--instance=boxlite-app-dev2-runner',
      '--instance=boxlite-app-dev2-runner-2',
      // Passes 2-4: only the host still outstanding is asked again.
      '--instance=boxlite-app-dev2-runner',
      '--instance=boxlite-app-dev2-runner',
      '--instance=boxlite-app-dev2-runner',
    ],
    'the poll narrows to the hosts still outstanding and keeps asking until one converges',
  )
})
