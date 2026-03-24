import { describe, expect, it } from 'vitest'

import { buildDisplayInfoFromSnapshot, resolveRetinaScreenshotNormalization } from './runtime'

describe('display runtime helpers', () => {
  it('builds combined display info for uniform-scale snapshots', () => {
    const info = buildDisplayInfoFromSnapshot({
      displays: [{
        displayId: 1,
        isMain: true,
        isBuiltIn: true,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        visibleBounds: { x: 0, y: 0, width: 1440, height: 860 },
        scaleFactor: 2,
        pixelWidth: 2880,
        pixelHeight: 1800,
      }],
      combinedBounds: { x: 0, y: 0, width: 1440, height: 900 },
      capturedAt: '2026-03-23T00:00:00.000Z',
    })

    expect(info.logicalWidth).toBe(1440)
    expect(info.logicalHeight).toBe(900)
    expect(info.pixelWidth).toBe(2880)
    expect(info.pixelHeight).toBe(1800)
    expect(info.isRetina).toBe(true)
  })

  it('plans screenshot normalization when physical pixel captures exceed logical bounds', () => {
    const plan = resolveRetinaScreenshotNormalization({
      available: true,
      platform: 'darwin',
      logicalWidth: 1440,
      logicalHeight: 900,
      pixelWidth: 2880,
      pixelHeight: 1800,
      scaleFactor: 2,
      isRetina: true,
    }, {
      width: 2880,
      height: 1800,
    })

    expect(plan).toMatchObject({
      width: 1440,
      height: 900,
    })
  })

  it('does not pretend mixed-scale screenshots can be normalized globally', () => {
    const plan = resolveRetinaScreenshotNormalization({
      available: true,
      platform: 'darwin',
      logicalWidth: 2360,
      logicalHeight: 1440,
      pixelWidth: undefined,
      pixelHeight: undefined,
      scaleFactor: 2,
      isRetina: true,
      note: 'enumerated 2 display(s) with mixed scale factors',
    }, {
      width: 4280,
      height: 2160,
    })

    expect(plan).toBeUndefined()
  })
})
