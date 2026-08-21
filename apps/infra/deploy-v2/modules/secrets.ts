// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * Generated secrets, and the app secrets this stage reads from the SST store.
 *
 * Auto-generated ones are created here and handed to whichever service needs them — override any
 * one by setting the matching env var.
 *
 * App secrets are set via `npm run sst -- secret set <NAME> --stage <stage>` (or bulk
 * `npm run sst -- secret load <dotenv>`); stored encrypted in SST state and shared per-stage by
 * anyone with deploy access. OIDC_CLIENT_ID is required and has no deployable fallback: a
 * placeholder would let the stack become healthy while every interactive login fails. Optional
 * secrets carry an empty-string fallback, where empty means that the feature is disabled.
 *
 * NB: the Cloudflare provider creds can't live here (the provider initializes in app() before
 * run() exists); deployment/sst.ts injects them from SSM instead.
 *
 * No resolve phase, so nothing to retry and no `with:` in pipeline.yml: every line below is a
 * resource declaration, and the engine owns retrying those.
 */
export const secrets: StackModule<StackContext> = {
  id: 'secrets',

  declare({ randomKey, defaultRunnerConfig }) {
    return {
      encryptionKey: randomKey('EncryptionKey', 64),
      encryptionSalt: randomKey('EncryptionSalt', 32),
      proxyApiKey: randomKey('ProxyApiKey'),
      adminApiKey: randomKey('AdminApiKey'),
      defaultRunnerApiKey: randomKey('DefaultRunnerApiKey'),
      defaultRunnerName: defaultRunnerConfig.controlPlaneRunnerName,
      pgAdminPassword: randomKey('PgAdminPassword', 24),

      oidcClientId: new sst.Secret('OIDC_CLIENT_ID'),
      oidcMgmtClientId: new sst.Secret('OIDC_MANAGEMENT_API_CLIENT_ID'),
      oidcMgmtClientSecret: new sst.Secret('OIDC_MANAGEMENT_API_CLIENT_SECRET'),
      posthogApiKey: new sst.Secret('POSTHOG_API_KEY', ''),
      svixAuthToken: new sst.Secret('SVIX_AUTH_TOKEN', ''),

      // The credential the usage exporter presents to Commerce's ingest route: half of a shared
      // secret whose other half is a Secrets Manager container owned by boxlite-commerce's own
      // stack, so both ends are set out of band from one value rather than generated here.
      //
      // It is a secret of this stack rather than a read of that container because the Api's
      // *runtime* role could not read it if we tried. Its execution role carries the
      // boxlite-<stage>-runtime-boundary, which admits only secret:boxlite-<stage>-* —
      // deliberately, so one stage's tasks cannot reach another's secrets. ECS says so plainly
      // when asked: it refuses to place the task with "no permissions boundary allows the
      // secretsmanager:GetSecretValue action". (The deploy role is not the constraint — its
      // boxlite-sst-deploy policy grants secretsmanager on this stage's own secrets, and it
      // carries no boundary at all.)
      //
      // Empty means the exporter stays off; see USAGE_EXPORT_ENABLED in the api job.
      usageExportToken: new sst.Secret('USAGE_EXPORT_TOKEN', ''),
    }
  },
}
