import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { instanceFor } from 'naming'
import { stageIn, type MstageConfig } from 'mstage/config'
import { digestOfGroup, readEnvironment, setValues, type StoreBackend } from 'mstage/env'
import { valuesOfGroup } from 'mstage/select-group'
import type { Identity } from 'mstage/identity'
import type { Scope } from 'mstage/scope'
import { parseDeployConfig } from './config.ts'
import { windowFor } from './credential-window.ts'
import type { DeployRequest } from './deploy.ts'
import { renderClickHouseLogReaderSql } from '../stack/clickhouse-host.ts'

const USER = 'CLICKHOUSE_OPENAPI_LOG_READER'
const PASSWORD = 'CLICKHOUSE_OPENAPI_LOG_READER_PASSWORD'

/** Bootstrap once, then require an explicit address for all reuse, including interrupted attempts. */
export async function prepareLogReaderSecret({ config, scope, backend, identity, request, execute = spawnSync }: {
  config: MstageConfig
  scope: Scope
  backend: StoreBackend
  identity: Pick<Identity, 'assertUsableFor' | 'childEnvironment'>
  request: DeployRequest
  execute?: typeof spawnSync
}): Promise<Record<string, string>> {
  const environment = request.stageEnvironment ?? {}
  const username = environment[USER]?.trim()
  if (!username || environment[PASSWORD]?.trim() || ['remove', 'refresh'].includes(request.intent ?? 'deploy')) return environment
  renderClickHouseLogReaderSql(username)
  const app = scope.app!, stage = scope.stage!
  const clickhouse = parseDeployConfig(config.path, JSON.stringify(stageIn(config, stage).deploy)).clickhouse
  if (clickhouse.mode !== 'self-hosted' || clickhouse.database !== 'otel' ||
    [clickhouse.writerUsername, clickhouse.readerUsername].includes(username)) {
    throw new Error(`${USER} requires self-hosted otel and a separate account`)
  }
  const name = instanceFor({ app, stage, artifact: `clickhouse-${username}-password` })
  if (!/^[a-z][a-z0-9_-]{0,254}$/.test(name)) throw new Error('Generated log-reader secret name is invalid')
  if (request.intent === 'diff') {
    throw new Error(`${PASSWORD} is empty: deploy must first create ${name} and save its address; preview cannot enable the account yet`)
  }
  const store = { clients: backend, app, stage }
  const unchanged = (values: Record<string, string>) => {
    if (values[USER]?.trim() !== username || values[PASSWORD]?.trim()) {
      throw new Error('Log-reader configuration changed; reload the stage before continuing')
    }
  }
  unchanged(await readEnvironment(store))
  await identity.assertUsableFor(windowFor('deploy'))
  const { env } = await identity.childEnvironment()
  const [file, args] = scope.home === 'gcp'
    ? ['gcloud', ['secrets', 'create', name, '--project', scope.project!, '--replication-policy=automatic', '--data-file=-', '--format=value(name)', '--quiet']] as const
    : ['aws', ['secretsmanager', 'create-secret', '--region', scope.region, '--name', name, '--secret-string', 'file:///dev/stdin', '--query', 'ARN', '--output', 'text']] as const
  const created = execute(file, args, { env: { ...env, AWS_PAGER: '' }, input: randomBytes(24).toString('base64url'), encoding: 'utf8', timeout: 60_000 })
  if (created.status !== 0) {
    const collision = /ALREADY_EXISTS|already exists|ResourceExistsException/i.test(String(created.stderr))
    throw new Error(collision
      ? `Secret ${name} already exists; set ${PASSWORD} explicitly to reuse it. Nothing was overwritten or backfilled.`
      : `Could not create secret ${name}; inspect its status before retrying. No address was backfilled.`)
  }
  // GCP may return a project number; store the configured project id used by the provider.
  const address = scope.home === 'gcp' ? `projects/${scope.project}/secrets/${name}/versions/1` : String(created.stdout).trim()
  if (scope.home === 'aws' && !/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(address)) {
    throw new Error(`Secret ${name} was created but returned no valid address; inspect it and set ${PASSWORD} explicitly`)
  }
  try {
    await setValues({ ...store, entries: [], derive: values => {
      unchanged(values)
      const entries: [string, string][] = [[PASSWORD, address]]
      const digest = config.envDigest
      if (digest) entries.push([digest.key, digestOfGroup({ digestKey: digest.key, values: valuesOfGroup({
        group: digest.group, groups: config.envSelectGroup, where: config.path,
        optional: [...(config.envOptional[digest.group] ?? []), digest.key], values: { ...values, [PASSWORD]: address },
      }) })])
      return entries
    } })
    const stored = await readEnvironment(store)
    if (stored[USER]?.trim() !== username || stored[PASSWORD] !== address) throw new Error('Writeback did not persist')
    request.log(`${PASSWORD} address saved; the OpenAPI log reader is now configured`)
    return { ...environment, [PASSWORD]: address, ...(config.envDigest ? { [config.envDigest.key]: stored[config.envDigest.key]! } : {}) }
  } catch {
    throw new Error(`Secret ${name} was created but address writeback failed; inspect it and set ${PASSWORD} explicitly before retrying`)
  }
}
