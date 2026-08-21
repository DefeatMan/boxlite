// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * The observability backend this stage resolved to: the private single-node instance, an existing
 * managed service, or nothing. Which one it is decides the collector's exporter lists, so both
 * come out of this job rather than being recomputed wherever they are read.
 *
 * Traces additionally fan out to Jaeger; metrics and logs stay off it, because Jaeger ingests
 * traces only.
 */
const loadClickHouse = () => import('../../stack/clickhouse.js')

export const clickhouse: StackModule<StackContext, Awaited<ReturnType<typeof loadClickHouse>>> = {
  id: 'clickhouse',
  resolve: loadClickHouse,

  async declare({ foundation, region, accountId }, { buildClickHouseStorage }) {
    const clickHouseResources = await buildClickHouseStorage({ foundation, region, accountId })

    return {
      clickHouseResources,
      collectorExporters: clickHouseResources.active ? '[boxlite_exporter,clickhouse]' : '[boxlite_exporter]',
      collectorTraceExporters: clickHouseResources.active
        ? '[boxlite_exporter,clickhouse,otlphttp/jaeger]'
        : '[boxlite_exporter,otlphttp/jaeger]',
    }
  },
}
