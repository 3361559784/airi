import type { ComputerUseConfig } from './types'

import { describe, expect, it } from 'vitest'

import { buildCoordinateSpaceInfo } from './runtime-probes'
import { createTestConfig } from './test-fixtures'

const baseConfig: ComputerUseConfig = createTestConfig({
  allowedBounds: { x: 0, y: 0, width: 1440, height: 900 },
})

describe('buildCoordinateSpaceInfo', () => {
  it('requires a screenshot before real input', () => {
    const info = buildCoordinateSpaceInfo({
      config: baseConfig,
    })

    expect(info.readyForMutations).toBe(false)
    expect(info.reason).toContain('capture a screenshot')
  })

  it('accepts matching bounds and screenshot dimensions', () => {
    const info = buildCoordinateSpaceInfo({
      config: baseConfig,
      lastScreenshot: {
        path: '/tmp/screenshot.png',
        width: 1440,
        height: 900,
        placeholder: false,
      },
    })

    expect(info.readyForMutations).toBe(true)
    expect(info.aligned).toBe(true)
  })

  it('flags logical-vs-physical mismatch on Retina displays', () => {
    const info = buildCoordinateSpaceInfo({
      config: baseConfig,
      lastScreenshot: {
        path: '/tmp/screenshot.png',
        width: 2880,
        height: 1800,
        placeholder: false,
      },
      displayInfo: {
        available: true,
        platform: 'darwin',
        logicalWidth: 1440,
        logicalHeight: 900,
        pixelWidth: 2880,
        pixelHeight: 1800,
        scaleFactor: 2,
        isRetina: true,
      },
    })

    expect(info.readyForMutations).toBe(false)
    expect(info.aligned).toBe(false)
    expect(info.reason).toContain('Retina')
  })

  it('flags mixed-scale physical mismatch with explicit remediation hint', () => {
    const info = buildCoordinateSpaceInfo({
      config: createTestConfig({
        allowedBounds: { x: 0, y: 0, width: 2360, height: 1440 },
      }),
      lastScreenshot: {
        path: '/tmp/screenshot.png',
        width: 3640,
        height: 1600,
        placeholder: false,
      },
      displayInfo: {
        available: true,
        platform: 'darwin',
        logicalWidth: 2360,
        logicalHeight: 1440,
        pixelWidth: undefined,
        pixelHeight: undefined,
        scaleFactor: 2,
        isRetina: true,
        displays: [
          {
            displayId: 1,
            isMain: true,
            isBuiltIn: true,
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            visibleBounds: { x: 0, y: 0, width: 1280, height: 760 },
            scaleFactor: 2,
            pixelWidth: 2560,
            pixelHeight: 1600,
          },
          {
            displayId: 2,
            isMain: false,
            isBuiltIn: false,
            bounds: { x: 1280, y: 0, width: 1080, height: 1440 },
            visibleBounds: { x: 1280, y: 0, width: 1080, height: 1400 },
            scaleFactor: 1,
            pixelWidth: 1080,
            pixelHeight: 1440,
          },
        ],
      },
    })

    expect(info.readyForMutations).toBe(false)
    expect(info.reason).toContain('mixed-scale')
  })
})
