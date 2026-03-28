import type { DesktopExecutor } from '../types'
import type {
  DesktopObservedWindowIdentity,
  DesktopScene,
  DesktopWindowReacquireSelector,
  DesktopWindowReacquireStatus,
  WindowNode,
} from './types'

export interface DesktopWindowReacquireResult {
  status: Exclude<DesktopWindowReacquireStatus, 'not_needed'>
  matchedWindow?: WindowNode
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
