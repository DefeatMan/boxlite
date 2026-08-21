// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * Network, durable state and the cluster every service runs on.
 *
 * Network model + rationale (subnets / NAT / egress-only public IP, AWS citations):
 * docs/networking.md. The NAT is an instance (fck-nat, ~10x cheaper than a managed NAT Gateway).
 * The Fargate services run in private subnets with no public IP, so they reach ECR, Docker Hub,
 * the OIDC issuer, external ClickHouse, and AWS APIs through it. EC2 runners stay in public
 * subnets and egress via the Internet Gateway, not this NAT.
 *
 * S3 versioning is on in every stage: cheap, and the only guard against an object-level
 * overwrite/delete (which `removal` never covers). Redis is a transient cache, so it needs
 * neither that nor the prod-only RDS protections `isProd` selects.
 *
 * `needs: [boundary]` is the load-bearing edge: SST's components create IAM roles internally, and
 * the boundary transform only reaches roles registered after it.
 */
const loadFoundation = () => import('../../stack/foundation.js')

export const foundation: StackModule<StackContext, Awaited<ReturnType<typeof loadFoundation>>> = {
  id: 'foundation',
  resolve: loadFoundation,

  declare({ region, isProd }, { createFoundation }) {
    return { foundation: createFoundation(region, isProd) }
  },
}
