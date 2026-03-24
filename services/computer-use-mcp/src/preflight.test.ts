import { describe, expect, it } from 'vitest'

import { getRuntimePreflight } from './preflight'
import {
  createDisplayInfo,
  createLastScreenshot,
  createLocalExecutionTarget,
  createRemoteExecutionTarget,
  createTestConfig,
} from './test-fixtures'

describe('getRuntimePreflight', () => {
  it('denies non-remote execution for linux-x11 tools', () => {
    const preflight = getRuntimePreflight({
      config: createTestConfig(),
      lastScreenshot: createLastScreenshot(),
      displayInfo: createDisplayInfo(),
      executionTarget: createRemoteExecutionTarget({
        mode: 'dry-run',
        transport: 'local',
      }),
    })

    expect(preflight.blockingIssues).toContain('desktop tools require a remote linux-x11 execution target')
  })

  it('denies mismatched session tags', () => {
    const preflight = getRuntimePreflight({
      config: createTestConfig(),
      lastScreenshot: createLastScreenshot(),
      displayInfo: createDisplayInfo(),
      executionTarget: createRemoteExecutionTarget({
        sessionTag: 'different-session',
      }),
    })

    expect(preflight.blockingIssues[0]).toContain('does not match expected')
  })

  it('denies display mismatches against allowed bounds', () => {
    const preflight = getRuntimePreflight({
      config: createTestConfig(),
      lastScreenshot: createLastScreenshot(),
      displayInfo: createDisplayInfo({
        logicalWidth: 1440,
        logicalHeight: 900,
      }),
      executionTarget: createRemoteExecutionTarget(),
    })

    expect(preflight.blockingIssues[0]).toContain('does not match allowed bounds 1280x720')
  })

  it('requires a fresh screenshot after the runner is tainted', () => {
    const preflight = getRuntimePreflight({
      config: createTestConfig(),
      lastScreenshot: createLastScreenshot(),
      displayInfo: createDisplayInfo(),
      executionTarget: createRemoteExecutionTarget({
        tainted: true,
        note: 'ssh transport closed unexpectedly',
      }),
    })

    expect(preflight.mutationReadinessIssues).toContain('remote runner session is tainted; capture a fresh screenshot before resuming mutations')
  })

  it('allows macos-local execution without remote binding checks', () => {
    const preflight = getRuntimePreflight({
      config: createTestConfig({
        executor: 'macos-local',
        requireAllowedBoundsForMutatingActions: false,
        requireCoordinateAlignmentForMutatingActions: false,
        requireSessionTagForMutatingActions: false,
        sessionTag: undefined,
      }),
      lastScreenshot: createLastScreenshot({
        executionTargetMode: 'local-windowed',
        sourceHostName: 'macbook-pro',
        sourceDisplayId: undefined,
        sourceSessionTag: 'local-session',
      }),
      displayInfo: createDisplayInfo({
        platform: 'darwin',
      }),
      executionTarget: createLocalExecutionTarget(),
    })

    expect(preflight.blockingIssues).toEqual([])
    expect(preflight.mutationReadinessIssues).toEqual([])
  })

  it('enforces strict coordinate readiness for macos-local when enabled', () => {
    const preflight = getRuntimePreflight({
      config: createTestConfig({
        executor: 'macos-local',
        requireAllowedBoundsForMutatingActions: true,
        requireCoordinateAlignmentForMutatingActions: true,
        allowedBounds: { x: 0, y: 0, width: 1512, height: 982 },
      }),
      displayInfo: createDisplayInfo({
        platform: 'darwin',
        logicalWidth: 1512,
        logicalHeight: 982,
        pixelWidth: 3024,
        pixelHeight: 1964,
      }),
      executionTarget: createLocalExecutionTarget(),
    })

    expect(preflight.blockingIssues).toEqual([])
    expect(preflight.mutationReadinessIssues.some(issue => issue.includes('capture a fresh screenshot'))).toBe(true)
    expect(preflight.mutationReadinessIssues.some(issue => issue.includes('capture a screenshot before real input'))).toBe(true)
  })

  it('blocks strict macos-local mutations when local display mismatches allowed bounds', () => {
    const preflight = getRuntimePreflight({
      config: createTestConfig({
        executor: 'macos-local',
        requireAllowedBoundsForMutatingActions: true,
        requireCoordinateAlignmentForMutatingActions: false,
        allowedBounds: { x: 0, y: 0, width: 1280, height: 720 },
      }),
      lastScreenshot: createLastScreenshot({
        executionTargetMode: 'local-windowed',
        sourceHostName: 'macbook-pro',
        sourceDisplayId: undefined,
        sourceSessionTag: 'local-session',
      }),
      displayInfo: createDisplayInfo({
        platform: 'darwin',
        logicalWidth: 1512,
        logicalHeight: 982,
      }),
      executionTarget: createLocalExecutionTarget({
        hostName: 'macbook-pro',
      }),
    })

    expect(preflight.blockingIssues.some(issue => issue.includes('local display'))).toBe(true)
  })

  it('keeps screenshot binding as an independent readiness guard for macos-local', () => {
    const preflight = getRuntimePreflight({
      config: createTestConfig({
        executor: 'macos-local',
        requireAllowedBoundsForMutatingActions: false,
        requireCoordinateAlignmentForMutatingActions: false,
      }),
      lastScreenshot: createLastScreenshot({
        executionTargetMode: 'local-windowed',
        sourceHostName: 'other-mac',
        sourceDisplayId: undefined,
        sourceSessionTag: 'local-session',
      }),
      displayInfo: createDisplayInfo({
        platform: 'darwin',
        logicalWidth: 1512,
        logicalHeight: 982,
      }),
      executionTarget: createLocalExecutionTarget({
        hostName: 'macbook-pro',
      }),
    })

    expect(preflight.blockingIssues).toEqual([])
    expect(preflight.mutationReadinessIssues.some(issue => issue.includes('different local host'))).toBe(true)
  })
})
