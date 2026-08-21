// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * Box-storage credential vending. The Api's ECS task role assumes the S3AccessRole declared after
 * the Api service with a per-organization inline session policy (apps/api object-storage.service.ts);
 * effective access is the intersection of the two. No IAM user / static keys: ECS already delivers
 * auto-rotated task-role credentials to the container.
 *
 * The role name is declared up front (deterministic, stage-scoped) so it can go into the Api env
 * and IAM grant as a plain string. The role itself can only be created after the Api service,
 * because its trust policy names the task role — which exists once the Api does. Declaring the
 * name first breaks that resource cycle, and giving the name its own job is what makes the api
 * job's dependency on it something a reader can see.
 *
 * No resolve phase, so nothing to retry and no `with:` in pipeline.yml: a name derived from $app
 * involves no I/O that could fail transiently.
 */
export const s3Access: StackModule<StackContext> = {
  id: 's3-access',

  declare() {
    const s3AccessRoleName = `${$app.name}-${$app.stage}-s3-access`
    return {
      s3AccessRoleName,
      s3AccessRoleArn: $interpolate`arn:aws:iam::${aws.getCallerIdentityOutput().accountId}:role/${s3AccessRoleName}`,
    }
  },
}
