import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { digestOfGroup, readEnvironment, writeStage, type StoreBackend } from 'mstage/env'
import { prepareLogReaderSecret } from '../src/openapi-log-reader.ts'
import { secretAddressesOf } from 'mstage/secret-address'

const USER = 'CLICKHOUSE_OPENAPI_LOG_READER', PASSWORD = 'CLICKHOUSE_OPENAPI_LOG_READER_PASSWORD'
const deploy = JSON.parse(readFileSync(new URL('../../.mstage.config.example.json', import.meta.url), 'utf8')).stages.dev.deploy

const fixture = async (cloud = 'gcp', values = { [USER]: 'audit_logs' }) => {
  let sealed: Buffer | null = null, failWrite = false, calls = 0
  const logs: string[] = []
  const backend = { home: cloud, read: async () => sealed, passphrase: async () => Buffer.alloc(32, 1),
    write: async ({ sealed: value }: { sealed: Buffer }) => { if (failWrite) throw new Error('write failed'); sealed = value },
  } as unknown as StoreBackend
  const store = { clients: backend, app: 'boxlite-app', stage: 'dev' }
  await writeStage({ ...store, values: { UNRELATED: 'preserved', ...values } })
  const address = cloud === 'gcp' ? 'projects/project/secrets/boxlite-app-dev-clickhouse-audit_logs-password/versions/1'
    : 'arn:aws:secretsmanager:us-east-1:123456789012:secret:boxlite-app-dev-clickhouse-audit_logs-password-AbCd12'
  const options = {
    config: { path: '/test/config', stages: { dev: { deploy } }, envSelectGroup: { deploy: [USER, PASSWORD, 'DIGEST'], secret: [PASSWORD] },
      envOptional: { deploy: [PASSWORD, 'DIGEST'], secret: [PASSWORD] }, envDigest: { group: 'deploy', key: 'DIGEST' } } as any,
    scope: { app: store.app, stage: store.stage, home: cloud, region: 'us-east-1', project: 'project' } as any,
    backend, identity: { assertUsableFor: async () => {}, childEnvironment: async () => ({ env: { RESOLVED_IDENTITY: 'yes' }, expiresAt: null }) },
    request: { intent: 'deploy' as const, stageEnvironment: values, log: (line: string) => logs.push(line) },
    execute: ((file: string, args: string[], input: any) => {
      calls++
      assert.equal(file, cloud === 'gcp' ? 'gcloud' : 'aws')
      assert.ok(args.includes('boxlite-app-dev-clickhouse-audit_logs-password'))
      assert.equal(input.env.RESOLVED_IDENTITY, 'yes')
      assert.match(input.input, /^[A-Za-z0-9_-]{32}$/)
      assert.ok(!JSON.stringify(args).includes(input.input), 'password must travel through stdin only')
      assert.ok(args.includes(cloud === 'gcp' ? '--data-file=-' : 'file:///dev/stdin'))
      return { status: 0, stdout: address, stderr: '' }
    }) as any,
  }
  return { options, address, logs, read: () => readEnvironment(store), calls: () => calls, fail: () => { failWrite = true } }
}

for (const cloud of ['gcp', 'aws']) {
  test(`${cloud} creates once, saves only the address, updates the digest and then reuses it`, async () => {
    const f = await fixture(cloud)
    const result = await prepareLogReaderSecret(f.options)
    assert.deepEqual(secretAddressesOf({ values: { [PASSWORD]: result[PASSWORD]! }, home: cloud as 'gcp' | 'aws' }), { [PASSWORD]: f.address })
    const saved = await f.read()
    assert.equal(saved[PASSWORD], JSON.stringify({ address: f.address }))
    assert.equal(saved.UNRELATED, 'preserved')
    assert.equal(saved.DIGEST, digestOfGroup({ values: { [USER]: 'audit_logs', [PASSWORD]: saved[PASSWORD]! }, digestKey: 'DIGEST' }))
    assert.deepEqual(await prepareLogReaderSecret({ ...f.options, request: { ...f.options.request, stageEnvironment: result } }), result)
    assert.equal(f.calls(), 1)
  })
  test(`${cloud} refuses a generated-name collision without backfill or secret reuse`, async () => {
    const f = await fixture(cloud)
    let calls = 0
    await assert.rejects(prepareLogReaderSecret({ ...f.options, execute: (() => {
      calls++
      return { status: 1, stderr: cloud === 'gcp' ? 'ALREADY_EXISTS' : 'ResourceExistsException' }
    }) as any }), /already exists; set CLICKHOUSE_OPENAPI_LOG_READER_PASSWORD explicitly/)
    assert.equal(calls, 1)
    assert.equal((await f.read())[PASSWORD], undefined)
    assert.deepEqual(f.logs, [])
  })
}

test('no credential creation without a username, with an explicit address, or for non-apply operations', async () => {
  const reference = JSON.stringify({ address: 'projects/project/secrets/existing' })
  for (const values of [{}, { [USER]: ' ' }, { [PASSWORD]: reference }, { [USER]: 'audit_logs', [PASSWORD]: reference }]) {
    const f = await fixture('gcp', values as any)
    assert.deepEqual(await prepareLogReaderSecret(f.options), values)
    assert.equal(f.calls(), 0)
  }
  for (const intent of ['diff', 'remove', 'refresh'] as const) {
    const f = await fixture()
    const call = prepareLogReaderSecret({ ...f.options, request: { ...f.options.request, intent } })
    if (intent === 'diff') await assert.rejects(call, /preview cannot enable/)
    else await call
    assert.equal(f.calls(), 0)
    assert.equal((await f.read())[PASSWORD], undefined)
  }
})

test('failed creation and writeback never enable the account', async () => {
  const f = await fixture()
  await assert.rejects(prepareLogReaderSecret({ ...f.options, execute: (() => ({ status: 1, stderr: 'sensitive diagnostic' })) as any }),
    error => /Could not create secret/.test(String(error)) && !String(error).includes('sensitive diagnostic'))
  assert.equal((await f.read())[PASSWORD], undefined)
  f.fail()
  await assert.rejects(prepareLogReaderSecret(f.options), /created but address writeback failed/)
  assert.equal((await f.read())[PASSWORD], undefined)
  assert.deepEqual(f.logs, [])
})

test('invalid or built-in usernames fail before cloud writes', async () => {
  for (const username of ['default', 'boxlite_admin', 'otel_reader', 'otel_writer', 'audit; DROP USER x', 'x'.repeat(65)]) {
    const f = await fixture('gcp', { [USER]: username })
    await assert.rejects(prepareLogReaderSecret(f.options), /distinct lowercase SQL username/)
    assert.equal(f.calls(), 0)
  }
})
