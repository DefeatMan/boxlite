# deploy-v2

`stack/deploy.ts` builds the whole stack in one 300-line function, where a module runs after
another because its `const` sits lower in the file. This package holds the same deploy as twelve
modules whose order and data flow come from a manifest.

Additive: `stack/deploy.ts` and the `sst.config.ts` that calls it are unchanged and still the
deploy path in use. Nothing here runs until someone adopts it.

```text
sst.config.ts run()
  └─ deploy-v2/index.ts  deployStackV2()
       ├─ pipeline.yml                  the graph — jobs, needs, retry, outputs
       ├─ pipeline/manifest.ts   (199)  parse + validate the YAML
       ├─ pipeline/schedule.ts    (69)  topological order; direct-needs visibility
       ├─ pipeline/retry.ts      (119)  withRetry, exponential backoff, abort-aware
       ├─ pipeline/module.ts      (83)  StackModule; the scoped context view
       ├─ pipeline/run.ts        (127)  resolve → declare → check outputs, per job
       ├─ stack-context.ts        (83)  every value modules pass between each other
       └─ modules/*.ts         (33-86)  twelve modules, delegating to stack/*.ts
```

`pipeline/` is a generic DAG runner with no SST globals in it — it type-checks and tests without
`sst install`. `modules/`, `index.ts` and `stack-context.ts` are the SST-typed half.

## The graph lives in pipeline.yml

Written in GitHub Actions workflow syntax, and read by `pipeline/manifest.ts`. It sits outside
`.github/workflows/`, so GitHub never dispatches it — it is a manifest that borrows a vocabulary
this repo already reads.

```yaml
  observability:
    name: OpenTelemetry collector and Jaeger ingest
    needs: [config, foundation, secrets, clickhouse]
    uses: ./modules/observability.ts
    with:
      retry-attempts: 2
    outputs:
      otelCollector: The collector service, depended on by the ClickHouse readiness gate
      otelCollectorOtlpHttpUrl: OTLP/HTTP endpoint the API, runners, hosts and boxes emit to
```

Three fields depart from what GitHub would enforce: `uses:` names a module rather than a workflow,
`with:` carries a retry policy rather than reusable-workflow inputs, and `outputs:` maps a name to
prose rather than to an expression. Everything else behaves as it reads.

**`needs:` is enforced, not documentation.** A module receives a view of the accumulated context
containing only the outputs of the jobs it directly needs — the same reach `needs.<job>.outputs`
gives on GitHub. Reading anything else throws and names the edge to add:

```
deploy-v2: module 'edge' read 'otelCollectorOtlpHttpUrl', which jobs.observability produces
— add observability to jobs.edge.needs in pipeline.yml
```

**`outputs:` is enforced too.** A module must return exactly the keys its job declares. Returning
an extra one is an error rather than a value some later module can quietly start reading.

## Retry covers the resolve phase

A module has two phases, and only one can be repeated:

| phase | what it does | retried |
|---|---|---|
| `resolve(context)` | async work before anything is declared — an AWS lookup, loading a builder | yes, under the job's `with:` policy |
| `declare(context, resolved)` | registers resources | no — it runs exactly once |

Declaration is registration. Re-running it after a failure re-registers the same URNs and the
Pulumi engine rejects the duplicate, so a retry there would turn one recoverable failure into an
unrecoverable one. Apply-time failures stay Pulumi's to retry.

That is why three jobs — `s3-access`, `secrets`, `router` — carry no `with:` block. They have no
resolve phase, and a policy on them would advertise a guarantee this pipeline cannot make. A test
asserts the correspondence in both directions, so a module that grows an async phase must also
declare its policy.

Defaults when a `with:` key is omitted: 3 attempts, 2s first wait, doubling to a 30s cap. Waits
honour the run's `AbortSignal`, so a cancelled deploy stops rather than sleeping out its backoff.

Today `config` is the only job whose resolve phase talks to the cloud (`sts:GetCallerIdentity`);
the rest load their builder. The wiring is what matters: an async lookup added to any module is
already covered.

## Adding a module

1. Write `modules/<id>.ts` exporting a `StackModule<StackContext>` whose `id` matches the job id.
2. Add its job to `pipeline.yml` — `name`, `needs`, `uses`, `outputs`, and `with:` if it resolves.
3. Add any new output keys to `StackContext` in `stack-context.ts`.
4. Import and list it in `index.ts`.

Skip a step and a test says which: the suite pairs jobs to modules by id, checks `uses:` resolves
to that module, checks every `StackContext` key is exactly one job's output, and checks every
builder `stack/deploy.ts` calls is also called here.

## Adopting it

One line in `sst.config.ts`, whenever the switch is wanted:

```diff
   async run() {
-    const { deployStack } = await import('./stack/deploy.js')
-    return deployStack()
+    const { deployStackV2 } = await import('./deploy-v2/index.js')
+    return deployStackV2()
   },
```

Both entry points call the same `stack/*.ts` builders with the same inputs, so the resource graph
is unchanged — preview with `npm run sst -- diff --stage <stage>` before applying, and expect an
empty diff.

## Verification

```bash
make test:apps:infra         # pipeline/ typecheck + the whole suite, no `sst install` needed
make test:apps:infra-config  # installs the SST platform, then type-checks modules/ too
```
