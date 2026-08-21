// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * The NestJS control plane.
 *
 * Where the Api image comes from: `release` deploys the image published for a version, so a
 * release promotes the exact artifact that was tested rather than rebuilding one that merely
 * shares its commit. `build` deploys the image its own CI job built for the selected commit — the
 * Runner has always worked that way, and doing it here too means a build deploy installs bytes
 * that were built once and can be pointed at again, rather than bytes this particular deploy
 * happened to compile.
 *
 * A build with no Api ref means nothing published an Api image for this checkout, so SST builds
 * apps/api/Dockerfile the way it always did. That is a plain local `npm run deploy`, and also
 * `npm run runner:build-artifact`, which stages a Runner and sets only the Runner's ref.
 * deploy-infra.yml publishes both and sets the global one.
 *
 * SST hands an image string straight to the task definition (normalizeImage, sst/platform fargate
 * component), so the modes differ only in that expression.
 *
 * The stage bootstrap template (bootstrap/aws/github-deploy-role.yaml) owns the immutable
 * repository: an image has to be published before a fresh stack can consume one, so the consumer
 * cannot also be responsible for creating its input.
 */
const loadApi = () => import('../../stack/api.js')

export const api: StackModule<StackContext, Awaited<ReturnType<typeof loadApi>>> = {
  id: 'api',
  resolve: loadApi,

  declare(context, { buildApi }) {
    const { api: service } = buildApi({
      foundation: context.foundation,
      region: context.region,
      accountId: context.accountId,
      releaseVersion: context.releaseVersion,
      stackDomain: context.stackDomain,
      proxyDomain: context.proxyDomain,
      proxyProtocol: context.proxyProtocol,
      proxyTemplateUrl: context.proxyTemplateUrl,
      serviceDomain: context.serviceDomain,
      s3AccessRoleName: context.s3AccessRoleName,
      s3AccessRoleArn: context.s3AccessRoleArn,
      encryptionKey: context.encryptionKey,
      encryptionSalt: context.encryptionSalt,
      proxyApiKey: context.proxyApiKey,
      adminApiKey: context.adminApiKey,
      defaultRunnerApiKey: context.defaultRunnerApiKey,
      defaultRunnerName: context.defaultRunnerName,
      oidcClientId: context.oidcClientId,
      oidcMgmtClientId: context.oidcMgmtClientId,
      oidcMgmtClientSecret: context.oidcMgmtClientSecret,
      posthogApiKey: context.posthogApiKey,
      svixAuthToken: context.svixAuthToken,
      usageExportToken: context.usageExportToken,
      oidcIssuer: context.oidcIssuer,
      publicOidcIssuer: context.publicOidcIssuer,
      otelCollectorOtlpHttpUrl: context.otelCollectorOtlpHttpUrl,
      clickHouseResources: context.clickHouseResources,
      clickHouseReadyDependency: context.clickHouseReadyDependency,
    })

    return { api: service }
  },
}
