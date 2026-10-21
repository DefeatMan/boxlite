import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load } from 'js-yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const main = 'a'.repeat(40), head = 'b'.repeat(40), old = 'c'.repeat(40)
const merge = 'd'.repeat(40), refreshed = 'e'.repeat(40)
const snapshot = (changes: Record<string, unknown> = {}) => ({
  state: 'OPEN', baseRefName: 'main', headRefOid: head, isCrossRepository: true,
  mergeable: 'MERGEABLE', potentialMergeCommit: { oid: merge }, ...changes,
})

interface Scenario {
  snapshots?: ReturnType<typeof snapshot>[]
  parents?: Record<string, string[]>
  main?: string
  fail?: string
}

// Only GitHub and retry delays are substituted; each workflow's actual shell
// runs, including its shared resolver when present. No cloud jobs are invoked.
function runResolver(workflow: string, scenario: Scenario = {}, pr = '1611') {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-pr-merge-'))
  try {
    const document: any = load(readFileSync(join(root, '.github/workflows', workflow), 'utf8'))
    const legacy = workflow === 'deploy-infra.yml'
    const job = document.jobs[legacy ? 'resolve-ref' : 'resolve']
    const script = job.steps.find((step: any) => step.id === (legacy ? 'ref' : 'pr')).run
    const config = {
      main, snapshots: [snapshot()], parents: { [merge]: [main, head] }, ...scenario,
    }
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config))
    for (const file of ['output', 'calls', 'sleeps']) writeFileSync(join(directory, file), '')
    writeFileSync(join(directory, 'gh'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const dir = process.env.FIXTURE, args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(dir + '/config.json', 'utf8'));
let result, kind;
if (args[0] === 'pr' && args[1] === 'view') {
  kind = 'pr';
  const calls = fs.readFileSync(dir + '/calls', 'utf8').length;
  fs.appendFileSync(dir + '/calls', 'x');
  result = config.snapshots[Math.min(calls, config.snapshots.length - 1)];
} else if (args[0] === 'api' && args[1] === 'repos/example/boxlite/git/ref/heads/main') {
  kind = 'main'; result = { object: { sha: config.main } };
} else if (args[0] === 'api' && args[1].startsWith('repos/example/boxlite/git/commits/')) {
  kind = 'commit';
  const sha = args[1].split('/').pop();
  result = { sha, parents: (config.parents[sha] || []).map(sha => ({ sha })) };
} else { throw new Error('Unexpected GitHub request: ' + args.join(' ')); }
if (config.fail === kind) { process.stderr.write('GitHub API unavailable\\n'); process.exit(42); }
const filter = args.indexOf('--jq');
process.stdout.write(filter < 0 ? JSON.stringify(result) :
  cp.execFileSync('jq', ['-r', args[filter + 1]], { input: JSON.stringify(result), encoding: 'utf8' }));
`, { mode: 0o755 })
    writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nprintf x >> "$FIXTURE/sleeps"\n', { mode: 0o755 })
    const result = spawnSync('bash', ['-c', script], {
      cwd: root, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FIXTURE: directory,
        GITHUB_REPOSITORY: 'example/boxlite', GITHUB_OUTPUT: join(directory, 'output'),
        PR: pr, INPUT_PR: pr, INPUT_REF: '' },
    })
    assert.ifError(result.error)
    return { ...result, output: readFileSync(join(directory, 'output'), 'utf8'),
      calls: readFileSync(join(directory, 'calls'), 'utf8').length,
      sleeps: readFileSync(join(directory, 'sleeps'), 'utf8').length }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

for (const workflow of ['mdeploy-all.yml', 'deploy-infra.yml']) {
  for (const [name, parents] of Object.entries({
    'stale main': [old, head], 'stale head': [main, old],
    'reversed parents': [head, main], 'single parent': [main],
    'extra parent': [main, head, old],
  })) {
    test(`${workflow}: rejects ${name} despite MERGEABLE`, () => {
      const result = runResolver(workflow, { parents: { [merge]: parents } })
      assert.notEqual(result.status, 0, 'a stale or invalid merge must not be deployable')
      assert.equal(result.output, '', 'a failed resolver must publish no SHA')
      assert.equal(result.calls, 5)
      assert.equal(result.sleeps, 4)
      assert.match(result.stderr, /parents/)
    })
  }

  for (const fork of [true, false]) {
    test(`${workflow}: accepts fresh ${fork ? 'fork' : 'same-repo'} merge`, () => {
      const result = runResolver(workflow, { snapshots: [snapshot({ isCrossRepository: fork })] })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.output, `sha=${merge}\n`)
      assert.match(result.stdout, new RegExp(fork ? 'fork' : 'same-repo'))
      assert.equal(result.calls, 1)
      assert.equal(result.sleeps, 0)
    })
  }

  for (const [reason, first] of Object.entries({
    stale: snapshot(), unknown: snapshot({ mergeable: 'UNKNOWN' }),
    missing: snapshot({ potentialMergeCommit: null }),
  })) {
    test(`${workflow}: retries a ${reason} candidate`, () => {
      const result = runResolver(workflow, {
        snapshots: [first, snapshot({ potentialMergeCommit: { oid: refreshed } })],
        parents: { [merge]: [old, head], [refreshed]: [main, head] },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.output, `sha=${refreshed}\n`)
      assert.equal(result.calls, 2)
      assert.equal(result.sleeps, 1)
    })
  }

  for (const [name, changes] of Object.entries({
    closed: { state: 'CLOSED' }, conflicting: { mergeable: 'CONFLICTING' },
    retargeted: { baseRefName: 'release' }, moved: { headRefOid: old },
  })) {
    test(`${workflow}: refuses a PR that becomes ${name} while retrying`, () => {
      const result = runResolver(workflow, {
        snapshots: [snapshot({ mergeable: 'UNKNOWN' }), snapshot(changes)],
      })
      assert.notEqual(result.status, 0)
      assert.equal(result.output, '')
      assert.equal(result.calls, 2)
      assert.equal(result.sleeps, 1)
    })
  }

  for (const [reason, changes] of Object.entries({
    unknown: { mergeable: 'UNKNOWN' }, missing: { potentialMergeCommit: null },
  })) {
    test(`${workflow}: refuses a persistently ${reason} candidate after bounded retries`, () => {
      const result = runResolver(workflow, { snapshots: [snapshot(changes)] })
      assert.notEqual(result.status, 0)
      assert.equal(result.output, '')
      assert.equal(result.calls, 5)
      assert.equal(result.sleeps, 4)
    })
  }

  for (const [name, scenario] of Object.entries({
    main: { main: 'invalid' }, head: { snapshots: [snapshot({ headRefOid: 'invalid' })] },
    merge: { snapshots: [snapshot({ potentialMergeCommit: { oid: 'invalid' } })] },
  })) {
    test(`${workflow}: refuses malformed ${name} SHA before using it in API paths`, () => {
      const result = runResolver(workflow, scenario)
      assert.notEqual(result.status, 0)
      assert.equal(result.output, '')
      assert.match(result.stderr, /invalid .*SHA/)
      assert.equal(result.sleeps, 0)
    })
  }

  for (const fail of ['pr', 'main', 'commit']) {
    test(`${workflow}: propagates ${fail} API failure without a SHA`, () => {
      const result = runResolver(workflow, { fail })
      assert.notEqual(result.status, 0)
      assert.equal(result.output, '')
      assert.match(result.stderr, /GitHub API unavailable/)
    })
  }

  test(`${workflow}: validates the PR number before API access`, () => {
    const result = runResolver(workflow, {}, '1611/invalid')
    assert.notEqual(result.status, 0)
    assert.equal(result.output, '')
    assert.equal(result.calls, 0)
  })
}
