// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

/*
 * Everything one module hands another, in one place.
 *
 * These were locals in stack/deploy.ts, where "who can see this" was decided by where a `const`
 * happened to sit. Naming them as a type is what lets pipeline.yml declare each module's outputs
 * and lets pipeline/run.ts check the declaration against reality.
 *
 * Every key is required here even though a module only ever receives the subset its `needs:`
 * allows, because the alternative — optional everywhere — would push a `!` or a null check into
 * every consumer for a value the manifest already guarantees is there. The scoped view in
 * pipeline/module.ts is what enforces the subset, at runtime, with an error naming the missing
 * edge.
 */

import type { ApiResources } from '../stack/api.js'
import type { ClickHouseResources } from '../stack/clickhouse.js'
import type { FoundationResources } from '../stack/foundation.js'
import type { buildObservability } from '../stack/observability.js'
// eslint-disable-next-line @nx/enforce-module-boundaries -- Stack synthesis shares the policy host's CommonJS Runner model.
import type { resolveRunnerInventory } from '../runner/model/inventory.js'

type RunnerInventory = ReturnType<typeof resolveRunnerInventory>

export interface StackContext {
  // ── config ──────────────────────────────────────────────────────────────
  region: string
  accountId: string
  isProd: boolean
  stackDomain: string
  proxyDomain: string
  proxyProtocol: string
  proxyTemplateUrl: string
  releaseVersion: string
  oidcIssuer: string
  publicOidcIssuer: string | undefined
  runnerInventory: RunnerInventory
  defaultRunnerConfig: RunnerInventory[number]
  cloudflareDns: ReturnType<typeof sst.cloudflare.dns>
  serviceDomain: (name: string) => { name: string; dns: ReturnType<typeof sst.cloudflare.dns> }
  stripTrailingSlash: (url: $util.Output<string>) => $util.Output<string>
  randomKey: (name: string, length?: number) => random.RandomPassword

  // ── s3-access ───────────────────────────────────────────────────────────
  s3AccessRoleName: string
  s3AccessRoleArn: $util.Output<string>

  // ── secrets ─────────────────────────────────────────────────────────────
  encryptionKey: random.RandomPassword
  encryptionSalt: random.RandomPassword
  proxyApiKey: random.RandomPassword
  adminApiKey: random.RandomPassword
  defaultRunnerApiKey: random.RandomPassword
  defaultRunnerName: string
  pgAdminPassword: random.RandomPassword
  oidcClientId: sst.Secret
  oidcMgmtClientId: sst.Secret
  oidcMgmtClientSecret: sst.Secret
  posthogApiKey: sst.Secret
  svixAuthToken: sst.Secret
  usageExportToken: sst.Secret

  // ── foundation / router ─────────────────────────────────────────────────
  foundation: FoundationResources
  router: InstanceType<typeof sst.aws.Router>

  // ── clickhouse / observability ──────────────────────────────────────────
  clickHouseResources: ClickHouseResources
  collectorExporters: string
  collectorTraceExporters: string
  otelCollector: ReturnType<typeof buildObservability>['otelCollector']
  otelCollectorOtlpHttpUrl: $util.Output<string>
  /** Untyped for the same reason buildClickHouseWriterReady returns `any`: it is a Service, a
   *  local Command or nothing, depending on the backend, and its only use is as a dependsOn. */
  clickHouseReadyDependency: any

  // ── api ─────────────────────────────────────────────────────────────────
  api: ApiResources['api']
}
