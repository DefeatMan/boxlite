// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * Every role created by this stack must stay inside the boundary provisioned with the GitHub
 * deployment role. The raw-resource transform also covers IAM roles created internally by SST
 * components, not only the roles declared by this stack's own modules.
 *
 * Its own job because the transform has to be registered before the first role exists, and that
 * ordering is otherwise invisible — in stack/deploy.ts it held only because these lines sat above
 * createFoundation. Here `foundation` names it in `needs:`, so moving either one cannot silently
 * leave a role unbounded.
 */
const loadEnvironment = () => import('../../deployment/environment.js')

export const boundary: StackModule<StackContext, Awaited<ReturnType<typeof loadEnvironment>>> = {
  id: 'boundary',
  resolve: loadEnvironment,

  declare(_context, { requireIamPermissionsBoundaryStage }) {
    requireIamPermissionsBoundaryStage($app.stage)

    const runtimePermissionsBoundaryArn = $interpolate`arn:aws:iam::${aws.getCallerIdentityOutput().accountId}:policy/${$app.name}-${$app.stage}-runtime-boundary`
    $transform(aws.iam.Role, (args: any) => {
      args.permissionsBoundary ??= runtimePermissionsBoundaryArn
    })

    return {}
  },
}
