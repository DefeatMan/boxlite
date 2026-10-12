## TL;DR

Select the telemetry backend with shared inputs, then use the chosen cloud’s lifecycle and access procedures.

# Shared observability configuration

[Infrastructure index](../README.md)

| Cloud | Guide |
| --- | --- |
| AWS | [CloudWatch, EBS and private UI access](aws/clickhouse.md) |
| GCP | [Cloud Logging, Hyperdisk and ClickStack PSC](gcp/clickhouse.md) |

## Two telemetry paths

Application OTLP travels through `apps/otel-collector`, which supports BoxLite organization export
and optional ClickHouse export. Platform stdout/stderr, load-balancer health and cloud logs remain
in the selected cloud’s logging service. Disabling ClickHouse does not disable platform logging
or organization-configured OTLP destinations.

## Select a backend

Set `stages.<stage>.deploy.clickhouse.mode` in `.mstage.config.json` for mdeploy.

| Mode | Resources owned by this stack | Operator responsibility |
| --- | --- | --- |
| `self-hosted` | VM, boot/data disks, credentials and private endpoint | Capacity, retention, recovery and schema lifecycle |
| `managed` | Runtime references to an existing endpoint and credentials | Provision compatible schema/users and network reachability |
| `disabled` | No ClickHouse backend/exporter | Use other telemetry destinations as needed |

Self-hosted size and disk capacity come from `deploy.clickhouse.instanceSize` and `dataGb`.
`CLICKHOUSE_RETENTION_HOURS` (stage environment, positive integer hours, default `720`) sets
the TTL of the seven telemetry tables. It is rejected unless the ClickHouse mode is `self-hosted`.

| Cloud | How a changed value reaches existing tables |
| --- | --- |
| AWS | The SSM readiness command re-runs and alters every table TTL during the deploy. |
| GCP | An OS Config policy alters the TTLs on the host's next agent cycle, without a restart or VM replacement. Check the `clickhouse-retention` compliance report before treating the change as applied. |

Both clouds judge compliance by the `toIntervalHour(N)` marker in each table's `create_table_query`.
New GCP tables are bootstrapped at the default TTL and converge to the configured value afterwards.
Expiry runs in the background; raising retention cannot recover rows already deleted.
Moving a GCP host off the former 72-hour bootstrap schema replaces its VM once; the data disk is kept.
Keep database/user settings aligned with the bundled schema and boot scripts;
`otel`, `otel_writer` and `otel_reader` are the example's supported baseline.

## Optional OpenAPI log reader

Set these optional values in the encrypted mstage `deploy` group. `PASSWORD` also
belongs to `secret` and holds a JSON reference, never a password. Keeping it in
`deploy` includes address changes in `--digest`; neither key is a workload variable.

| Key | Value |
| --- | --- |
| `CLICKHOUSE_OPENAPI_LOG_READER` | Dedicated SQL username, e.g. `audit_logs` |
| `CLICKHOUSE_OPENAPI_LOG_READER_PASSWORD` | `{"address":"<cloud-secret-address>"}`, or absent to request creation |

For an existing GCP credential, write both values together:

```bash
npm run mstage env set -- --stage dev --digest --json \
  'CLICKHOUSE_OPENAPI_LOG_READER="audit_logs"' \
  'CLICKHOUSE_OPENAPI_LOG_READER_PASSWORD={"address":"projects/example-project/secrets/log-reader-password"}'
```

Add `--confirm` for a protected stage. The shared secret parser validates the JSON
and cloud address; bare addresses are refused. Only the ClickHouse host reads the
secret payload. To request bootstrap, omit/delete the optional PASSWORD key;
`mstage env set` rejects empty values for keys in the secret group.

Both values must be nonempty before the account is enabled. An empty username
leaves it unmanaged, even if an address remains. With only a username, **mdeploy
apply** first creates `<app>-<stage>-clickhouse-<username>-password`, saves its
JSON reference and updates the stage digest, then enables the account. Preview refuses
this incomplete pair without writing anything; remove and refresh never bootstrap.
Creation requires the deploy identity's secret-create and stage-store-write access.

For example, `audit_logs` in `boxlite-app/dev` creates
`boxlite-app-dev-clickhouse-audit_logs-password`. GCP saves
`{"address":"projects/<project>/secrets/<name>/versions/1"}`; AWS wraps the returned
Secrets Manager ARN in the same JSON shape. Each stage creates its own password.
**If that name already exists while PASSWORD is empty, deployment fails.** It
never adopts or overwrites a same-name secret. This also applies after creation
succeeds but writeback fails: inspect the secret, then explicitly set its address
with `mstage env set --json` and `--digest` before retrying. Serialize stage configuration
edits with deployment, as the existing stage store uses read-modify-write updates.

An explicit JSON reference skips all credential creation and writeback. GCP accepts
`projects/<project>/secrets/<secret>[/versions/<version>]` in its `address` field,
within the stage project;
omitting the version selects `latest`. AWS accepts a Secrets Manager ARN.
Generated secrets remain outside the deployment stack's deletion lifecycle;
existing secrets retain their owner, address, value and consumer permissions.

The feature requires self-hosted `otel`. Usernames match `[a-z][a-z0-9_]{0,63}`
and cannot reuse the admin, default, writer or reader accounts. The existing GCP
startup script or AWS SSM readiness command preserves the user's identity and
reapplies the [SQL policy](../clickhouse/openapi-log-reader.sql), revoking inherited
roles and old grants even when the user already exists. Only SELECT and SHOW
COLUMNS on `otel.otel_logs` remain. The `<username>_limits` profile replaces all
settings with the policy's 18 immutable limits. SQL access data survives on the
retained data disk. GCP applies this on boot; AWS reconciles when deployment
inputs, policy SQL or credential versions change.

To adopt an existing account, set **both its current username and current secret
address together** before applying. The account switches to the per-user settings
profile with the same limits; old profiles are left untouched. Removing the keys
stops management and does not revoke an existing SQL user. Renaming a user or
changing secret ownership requires a separate migration.

Backoffice connects over its private ClickHouse endpoint using the configured
username and the referenced password through its existing secret injection.
Configure the consumer's username to match; grant its runtime identity access to
that one secret. Do not put a password in a URL, mstage value, code or deploy log.

For rotation, retain the old enabled version, create a new version, and coordinate
producer reconciliation with the consumer's credential rollout. Prefer a pinned
GCP version: changing `latest` alone does not rerun startup. AWS follows
`AWSCURRENT` on deployment. Rollback restores the previous reference/version and
reruns provisioning; changing the account password requires a coordinated switch.

Review rollout impact first: GCP startup changes replace the VM; AWS readiness
restarts ClickHouse. The data disk is retained, but neither path offers uninterrupted
adoption. Check authentication, denied writes/tables/settings and persistence after
restart. Run `BOXLITE_CLICKHOUSE_INTEGRATION=1 make test:apps:infra` with Docker for
a disposable local check. Full stack typechecking uses `make test:apps:infra-config`.

## Managed endpoint

Supply these three values together in the encrypted stage store:

| Key | Value |
| --- | --- |
| `CLICKHOUSE_URL` | HTTPS origin of the managed service |
| `CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN` | Writer credential reference for the stage's cloud |
| `CLICKHOUSE_READER_PASSWORD_SECRET_ARN` | Distinct reader credential reference for the stage's cloud |

The historical `_ARN` suffix remains part of the shared input contract. The selected cloud’s guide
defines its credential-address format and rotation behavior. Keep passwords out of the URL.
Provision the [bundled schema](../clickhouse/otel-schema-v0.144.0.sql) and appropriate reader/writer
grants before deploying; the collector does not create tables automatically.

## Retained data

Retained disks can outlive the instance or a switch to another backend mode. Take a verified backup
before intentional deletion or migration, and inventory detached disks during teardown.
A healthy VM does not prove tables exist or that the collector can insert into them.

## Verify ingestion and queries

1. Emit a uniquely identified test log/trace from a test box or service.
2. Check collector export errors and backend reachability.
3. Confirm the event exists using the reader path available to the API.
4. Verify timestamps and retention, then check any organization OTLP destination separately.

Inspect platform logs and application telemetry independently.

Sources: [shared contract](../mdeploy/stack/clickhouse.ts), [schema renderer](../mdeploy/stack/clickhouse-host.ts), [collector](../../otel-collector/config.yaml).
