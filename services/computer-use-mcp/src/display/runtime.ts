import type { ComputerUseConfig, DisplayInfo } from '../types'
import type { MultiDisplaySnapshot } from './types'

import { platform } from 'node:process'

import { probeDisplayInfo } from '../runtime-probes'
import { enumerateDisplays } from './enumerate'

function getUniformScaleFactor(snapshot: MultiDisplaySnapshot) {
  const scales = snapshot.displays
    .map(display => display.scaleFactor)
    .filter(scale => Number.isFinite(scale) && scale > 0)

  const first = scales[0]
  if (!first)
    return undefined

  return scales.every(scale => Math.abs(scale - first) < 0.001)
    ? first
    : undefined
}

export function buildDisplayInfoFromSnapshot(snapshot: MultiDisplaySnapshot): DisplayInfo {
  const main = snapshot.displays.find(display => display.isMain) ?? snapshot.displays[0]
  const uniformScaleFactor = getUniformScaleFactor(snapshot)

  return {
    available: snapshot.displays.length > 0,
    platform: 'darwin',
    logicalWidth: snapshot.combinedBounds.width,
    logicalHeight: snapshot.combinedBounds.height,
    pixelWidth: uniformScaleFactor
      ? Math.round(snapshot.combinedBounds.width * uniformScaleFactor)
      : undefined,
    pixelHeight: uniformScaleFactor
      ? Math.round(snapshot.combinedBounds.height * uniformScaleFactor)
      : undefined,
    scaleFactor: main?.scaleFactor,
    isRetina: snapshot.displays.some(display => display.scaleFactor > 1),
    displayCount: snapshot.displays.length,
    displays: snapshot.displays.map(display => ({
      displayId: display.displayId,
      isMain: display.isMain,
      isBuiltIn: display.isBuiltIn,
      bounds: display.bounds,
      visibleBounds: display.visibleBounds,
      scaleFactor: display.scaleFactor,
      pixelWidth: display.pixelWidth,
      pixelHeight: display.pixelHeight,
    })),
    combinedBounds: snapshot.combinedBounds,
    capturedAt: snapshot.capturedAt,
    note: uniformScaleFactor
      ? `enumerated ${snapshot.displays.length} display(s) with uniform ${uniformScaleFactor}x scale`
      : `enumerated ${snapshot.displays.length} display(s) with mixed scale factors`,
  }
}

export async function getMacOSDisplayInfo(config: ComputerUseConfig): Promise<DisplayInfo> {
  if (platform !== 'darwin') {
    return await probeDisplayInfo(config)
  }

  try {
    return buildDisplayInfoFromSnapshot(await enumerateDisplays(config))
  }
  catch {
    return await probeDisplayInfo(config)
  }
}

export function resolveRetinaScreenshotNormalization(
  displayInfo: DisplayInfo,
  screenshot: { width?: number, height?: number },
) {
  if (!displayInfo.available || !screenshot.width || !screenshot.height) {
    return undefined
  }

  if (!displayInfo.logicalWidth || !displayInfo.logicalHeight) {
    return undefined
  }

  if (displayInfo.logicalWidth === screenshot.width && displayInfo.logicalHeight === screenshot.height) {
    return undefined
  }

  if (displayInfo.pixelWidth === screenshot.width && displayInfo.pixelHeight === screenshot.height) {
    return {
      width: displayInfo.logicalWidth,
      height: displayInfo.logicalHeight,
      note: `normalized screenshot from ${screenshot.width}x${screenshot.height} physical pixels to ${displayInfo.logicalWidth}x${displayInfo.logicalHeight} logical points`,
    }
  }

  return undefined
}
