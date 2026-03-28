import type { DesktopExecutor } from '../types'
import type {
  DesktopAppReacquireStatus,
  DesktopObservedAppIdentity,
  DesktopObservedWindowIdentity,
  DesktopScene,
  DesktopAppReacquireSelector,
  DesktopWindowReacquireSelector,
  DesktopWindowReacquireStatus,
  WindowNode,
} from './types'

export interface DesktopWindowReacquireResult {
  status: Exclude<DesktopWindowReacquireStatus, 'not_needed'>
  matchedWindow?: WindowNode
}

export interface DesktopAppReacquireResult {
  status: Exclude<DesktopAppReacquireStatus, 'not_needed'>
  matchedAppName?: string
  matchedOwnerPid?: number
  windowCountForApp: number
}

function fallbackBounds() {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  }
}

function findScreenId(
  screens: DesktopScene['screens'],
  bounds: WindowNode['bounds'],
) {
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }

  const matched = screens.find((screen) => {
    const area = screen.bounds
    return center.x >= area.x
      && center.x < area.x + area.width
      && center.y >= area.y
      && center.y < area.y + area.height
  })

  return matched?.id || screens[0]?.id || 'screen:unknown'
}

function hasNonEmptyTitle(title: string | undefined) {
  return Boolean(title && title.trim().length > 0)
}

function normalizeAppName(appName: string | undefined) {
  return (appName || '').trim().toLowerCase()
}

function getAppWindowsByName(scene: DesktopScene, appName: string) {
  const normalized = normalizeAppName(appName)
  if (!normalized) {
    return []
  }

  return scene.windows.filter(window => normalizeAppName(window.appName) === normalized)
}

function pickSingleOwnerPid(windows: WindowNode[]) {
  const ownerPidSet = new Set(
    windows
      .map(window => window.ownerPid)
      .filter(ownerPid => Number.isFinite(ownerPid)) as number[],
  )

  if (ownerPidSet.size !== 1) {
    return undefined
  }

  return [...ownerPidSet][0]
}

export function toObservedWindowIdentity(window: WindowNode): DesktopObservedWindowIdentity {
  return {
    windowId: window.id,
    windowNumber: window.windowNumber,
    ownerPid: window.ownerPid,
    appName: window.appName,
    title: window.title,
    bounds: window.bounds,
  }
}

export function toReacquireSelector(identity: DesktopObservedWindowIdentity): DesktopWindowReacquireSelector {
  const hasFallbackAppTitle = hasNonEmptyTitle(identity.title)
  return {
    windowId: identity.windowId,
    windowNumber: identity.windowNumber,
    ownerPid: identity.ownerPid,
    appName: hasFallbackAppTitle ? identity.appName : undefined,
    title: hasFallbackAppTitle ? identity.title : undefined,
  }
}

export function toObservedAppIdentity(scene: DesktopScene, appName: string): DesktopObservedAppIdentity | undefined {
  const windows = getAppWindowsByName(scene, appName)
  if (windows.length === 0) {
    return undefined
  }

  const ownerPid = pickSingleOwnerPid(windows)
  const canonicalAppName = windows.find(window => window.focused)?.appName || windows[0]?.appName || appName

  return {
    appName: canonicalAppName,
    ownerPid,
    windowCount: windows.length,
  }
}

export function toAppReacquireSelector(identity: DesktopObservedAppIdentity): DesktopAppReacquireSelector {
  return {
    appName: identity.appName,
    ownerPid: identity.ownerPid,
  }
}

export function reacquireAppInScene(scene: DesktopScene, selector: DesktopAppReacquireSelector): DesktopAppReacquireResult {
  if (Number.isFinite(selector.ownerPid)) {
    const ownerPid = Number(selector.ownerPid)
    const pidMatches = scene.windows.filter(window => window.ownerPid === ownerPid)

    if (pidMatches.length > 0) {
      const names = new Set(pidMatches.map(window => normalizeAppName(window.appName)).filter(Boolean))
      if (names.size !== 1) {
        return {
          status: 'ambiguous',
          windowCountForApp: pidMatches.length,
        }
      }

      const matchedAppName = pidMatches.find(window => window.focused)?.appName || pidMatches[0]?.appName
      return {
        status: 'matched_by_owner_pid',
        matchedAppName,
        matchedOwnerPid: ownerPid,
        windowCountForApp: pidMatches.length,
      }
    }
  }

  if (!selector.appName || !normalizeAppName(selector.appName)) {
    return {
      status: 'not_found',
      windowCountForApp: 0,
    }
  }

  const nameMatches = getAppWindowsByName(scene, selector.appName)
  if (nameMatches.length === 0) {
    return {
      status: 'not_found',
      windowCountForApp: 0,
    }
  }

  return {
    status: 'matched_by_app_name',
    matchedAppName: nameMatches.find(window => window.focused)?.appName || nameMatches[0]?.appName,
    matchedOwnerPid: pickSingleOwnerPid(nameMatches),
    windowCountForApp: nameMatches.length,
  }
}

export function reacquireWindowInScene(scene: DesktopScene, selector: DesktopWindowReacquireSelector): DesktopWindowReacquireResult {
  if (selector.windowId) {
    const matches = scene.windows.filter(window => window.id === selector.windowId)
    if (matches.length === 1) {
      return {
        status: 'matched_by_window_id',
        matchedWindow: matches[0],
      }
    }
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
      }
    }
  }

  if (Number.isFinite(selector.windowNumber) && Number.isFinite(selector.ownerPid)) {
    const windowNumber = Number(selector.windowNumber)
    const ownerPid = Number(selector.ownerPid)
    const matches = scene.windows.filter(window => window.windowNumber === windowNumber && window.ownerPid === ownerPid)
    if (matches.length === 1) {
      return {
        status: 'matched_by_window_number_pid',
        matchedWindow: matches[0],
      }
    }
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
      }
    }
  }

  const appName = selector.appName
  const title = selector.title
  if (!appName || !hasNonEmptyTitle(title)) {
    return {
      status: 'not_found',
    }
  }

  const matches = scene.windows.filter(window => window.appName === appName && window.title === title)
  if (matches.length === 0) {
    return {
      status: 'not_found',
    }
  }

  if (matches.length === 1) {
    return {
      status: 'matched_by_app_title',
      matchedWindow: matches[0],
    }
  }

  return {
    status: 'ambiguous',
  }
}

export class DesktopSceneService {
  private lastPointer = { x: 0, y: 0 }
  private lastScene?: DesktopScene

  constructor(
    private readonly executor: Pick<DesktopExecutor, 'getDisplayInfo' | 'observeWindows'>,
    private readonly getPointerPosition: () => { x: number, y: number } | undefined,
  ) {}

  getLastScene() {
    return this.lastScene
  }

  getPointer() {
    const pointer = this.getPointerPosition()
    if (pointer) {
      this.lastPointer = pointer
    }
    return this.lastPointer
  }

  async observeScene(): Promise<DesktopScene> {
    const [displayInfo, observation] = await Promise.all([
      this.executor.getDisplayInfo(),
      this.executor.observeWindows({ limit: 64 }),
    ])

    const screens: DesktopScene['screens'] = displayInfo.displays?.map(display => ({
      id: `screen:${display.displayId}`,
      bounds: display.bounds,
    }))
    || (displayInfo.available && displayInfo.logicalWidth && displayInfo.logicalHeight
      ? [{
          id: 'screen:main',
          bounds: {
            x: 0,
            y: 0,
            width: displayInfo.logicalWidth,
            height: displayInfo.logicalHeight,
          },
        }]
      : [])

    const windows = observation.windows.map((windowInfo, index): WindowNode => {
      const bounds = windowInfo.bounds || fallbackBounds()
      return {
        id: windowInfo.id,
        windowNumber: windowInfo.windowNumber,
        appName: windowInfo.appName,
        title: windowInfo.title || '',
        bounds,
        ownerPid: windowInfo.ownerPid,
        focused: Boolean(
          observation.frontmostAppName
          && windowInfo.appName === observation.frontmostAppName
          && observation.frontmostWindowTitle
          && windowInfo.title === observation.frontmostWindowTitle,
        ),
        zIndex: typeof windowInfo.layer === 'number' ? windowInfo.layer : index,
        screenId: findScreenId(screens, bounds),
      }
    })

    const pointer = this.getPointerPosition() || this.lastPointer
    this.lastPointer = pointer

    const focusedWindow = windows.find(window => window.focused)

    const scene: DesktopScene = {
      capturedAt: observation.observedAt,
      screens,
      windows,
      pointer,
      focusedApp: observation.frontmostAppName,
      focusedWindowId: focusedWindow?.id,
    }

    this.lastScene = scene
    return scene
  }
}
