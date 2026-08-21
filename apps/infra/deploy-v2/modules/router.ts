// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * OIDC is delegated to an external provider (Auth0/Okta/etc.) via OIDC_ISSUER_BASE_URL. No
 * in-cluster Dex — that removes one ALB + ACM cert + service and the ephemeral-sqlite
 * key-rotation problem. Router still exists for dashboard HTTPS + routing /* to Api.
 *
 * NOTE: SST Router's placeholder origin is created with `OriginProtocolPolicy: "http-only"`,
 * which wins over the per-request customOriginConfig set by its CloudFront Function for HTTPS
 * origins (CF rejects the TLS handshake → 502). Flip it to `https-only` so CF respects the
 * CF-Function's HTTPS override.
 *
 * No resolve phase, so nothing to retry and no `with:` in pipeline.yml.
 */
export const router: StackModule<StackContext> = {
  id: 'router',

  declare({ stackDomain, cloudflareDns }) {
    return {
      router: new sst.aws.Router('ApiCdn', {
        domain: { name: stackDomain, dns: cloudflareDns },
        transform: {
          cdn: (cdnArgs: any) => {
            cdnArgs.origins = $util.output(cdnArgs.origins).apply((origins) =>
              (origins ?? []).map((o: any) => ({
                ...o,
                customOriginConfig: o.customOriginConfig
                  ? { ...o.customOriginConfig, originProtocolPolicy: 'https-only', originReadTimeout: 60 }
                  : o.customOriginConfig,
              })),
            )
          },
        },
      }),
    }
  },
}
