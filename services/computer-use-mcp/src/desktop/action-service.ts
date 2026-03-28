import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ExecuteAction } from '../server/action-executor'
import type {
  DesktopActionPlan,
  DesktopActionPlanResult,
  DesktopScene,
} from './types'

export type MoveResizeWindowResult
  = | {
    status: 'completed'
    reason: string
    windowId: string
  }
  | {
    status: 'failed'
    reason: string
    detail?: CallToolResult
  }
  | {
    status: 'unsupported'
    reason: string
    notice: string
  }

export type OpenAppResult
  = | {
    status: 'completed'
    reason: string
    app: string
  }
  | {
    status: 'failed'
    reason: string
    detail?: CallToolResult
  }

const SEMANTIC_ACTION_RETRY_DELAY_MS = 120
const SEMANTIC_ACTION_MAX_ATTEMPTS = 2

function actionFailed(result: CallToolResult) {
  return result.isError === true
}

function errorText(result: CallToolResult) {
  const text = result.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join(' ')

  const structured = result.structuredContent
  const structuredReason = structured && typeof structured === 'object' && 'reason' in structured
    ? String((structured as Record<string, unknown>).reason ?? '')
    : ''

  return `${text} ${structuredReason}`.toLowerCase()
}

function isUnsupportedSemanticError(text: string) {
  return text.includes('unsupported') || text.includes('not implement')
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => {
    const timer = (globalThis as { setTimeout?: (callback: () => void, timeout?: number) => unknown }).setTimeout
    if (typeof timer !== 'function') {
      resolve()
      return
    }

    timer(resolve, Math.max(0, ms))
  })
}

export class DesktopActionService {
  constructor(private readonly executeAction: ExecuteAction) {}

  private async executeSemanticActionWithRetry(action: Parameters<ExecuteAction>[0], toolName: string) {
    let attempt = 0
    let lastResult: CallToolResult | undefined
    let lastError = ''

    while (attempt < SEMANTIC_ACTION_MAX_ATTEMPTS) {
      attempt += 1

      const result = await this.executeAction(action, toolName, {
        skipApprovalQueue: true,
      })
      const currentError = errorText(result)

      if (!actionFailed(result)) {
        return {
          ok: true as const,
          result,
          attempts: attempt,
          errorText: currentError,
        }
      }

      lastResult = result
      lastError = currentError

      if (isUnsupportedSemanticError(currentError) || attempt >= SEMANTIC_ACTION_MAX_ATTEMPTS) {
        break
      }

      await sleep(SEMANTIC_ACTION_RETRY_DELAY_MS)
    }

    return {
      ok: false as const,
      result: lastResult,
      attempts: attempt,
      errorText: lastError,
    }
  }

  async focusWindow(scene: DesktopScene, windowId: string) {
    const target = scene.windows.find(window => window.id === windowId)
    if (!target) {
      return {
        status: 'failed' as const,
        reason: `window_not_found:${windowId}`,
      }
    }

    const focusAttempt = await this.executeSemanticActionWithRetry({
      kind: 'focus_window',
      input: {
        windowId: target.id,
        windowNumber: target.windowNumber,
        ownerPid: target.ownerPid,
        appName: target.appName,
        title: target.title,
        bounds: target.bounds,
        observedBounds: target.bounds,
      },
    }, 'desktop_focus_window')

    const focusResult = focusAttempt.result
    const focusErrorText = focusAttempt.errorText

    if (!focusAttempt.ok) {
      return {
        status: 'failed' as const,
        reason: isUnsupportedSemanticError(focusErrorText)
          ? `focus_window_unsupported:${target.id}`
          : `focus_window_failed:${target.id}`,
        detail: focusResult,
      }
    }

    return {
      status: 'completed' as const,
      reason: 'focused_window_via_semantic_action',
      appName: target.appName,
      windowId,
    }
  }

  async focusApp(app: string) {
    const focusAttempt = await this.executeSemanticActionWithRetry({
      kind: 'focus_app',
      input: { app },
    }, 'desktop_focus_app')

    const focusResult = focusAttempt.result
    const focusErrorText = focusAttempt.errorText

    if (!focusAttempt.ok) {
      return {
        status: 'failed' as const,
        reason: isUnsupportedSemanticError(focusErrorText)
          ? `focus_app_unsupported:${app}`
          : `focus_app_failed:${app}`,
        detail: focusResult,
      }
    }

    return {
      status: 'completed' as const,
      reason: 'focused_app_via_semantic_action',
      app,
    }
  }

  async openApp(app: string): Promise<OpenAppResult> {
    const openAttempt = await this.executeSemanticActionWithRetry({
      kind: 'open_app',
      input: { app },
    }, 'desktop_open_app')

    const openResult = openAttempt.result
    const openErrorText = openAttempt.errorText

    if (!openAttempt.ok) {
      return {
        status: 'failed' as const,
        reason: isUnsupportedSemanticError(openErrorText)
          ? `open_app_unsupported:${app}`
          : `open_app_failed:${app}`,
        detail: openResult,
      }
    }

    return {
      status: 'completed' as const,
      reason: 'open_app_requested',
      app,
    }
  }

  async moveResizeWindow(scene: DesktopScene, windowId: string, bounds: { x: number, y: number, width: number, height: number }): Promise<MoveResizeWindowResult> {
    const target = scene.windows.find(window => window.id === windowId)
    if (!target) {
      return {
        status: 'failed',
        reason: `window_not_found:${windowId}`,
      }
    }

    const setBoundsAttempt = await this.executeSemanticActionWithRetry({
      kind: 'set_window_bounds',
      input: {
        windowId: target.id,
        windowNumber: target.windowNumber,
        ownerPid: target.ownerPid,
        bounds,
        observedBounds: target.bounds,
        appName: target.appName,
        title: target.title,
      },
    }, 'desktop_move_resize_window')

    const setBoundsResult = setBoundsAttempt.result

    const setBoundsErrorText = setBoundsAttempt.errorText
    if (!setBoundsAttempt.ok) {
      if (isUnsupportedSemanticError(setBoundsErrorText)) {
        return {
          status: 'unsupported',
          reason: `set_window_bounds_unsupported:${windowId}`,
          notice: 'semantic_set_window_bounds_unavailable',
        }
      }

      return {
        status: 'failed',
        reason: `set_window_bounds_failed:${windowId}`,
        detail: setBoundsResult,
      }
    }

    return {
      status: 'completed',
      reason: 'set_window_bounds_completed',
      windowId,
    }
  }

  async runActionPlan(
    scene: DesktopScene,
    plan: DesktopActionPlan,
    options: {
      shouldContinue?: () => boolean
    } = {},
  ): Promise<DesktopActionPlanResult> {
    const details: Record<string, unknown>[] = []
    const errors: string[] = []

    let executedSteps = 0

    for (const step of plan.steps) {
      if (options.shouldContinue && !options.shouldContinue()) {
        return {
          status: 'interrupted',
          executedSteps,
          errors,
          details,
        }
      }

      switch (step.kind) {
        case 'open_app': {
          const result = await this.openApp(step.app)
          details.push({
            step,
            result,
          })
          if (result.status !== 'completed') {
            errors.push(result.reason)
            return {
              status: 'failed',
              executedSteps,
              errors,
              details,
            }
          }
          executedSteps += 1
          break
        }
        case 'focus_app': {
          const result = await this.focusApp(step.app)
          details.push({
            step,
            result,
          })
          if (result.status !== 'completed') {
            errors.push(result.reason)
            return {
              status: 'failed',
              executedSteps,
              errors,
              details,
            }
          }
          executedSteps += 1
          break
        }
        case 'focus_window': {
          const result = await this.focusWindow(scene, step.windowId)
          details.push({
            step,
            result,
          })
          if (result.status !== 'completed') {
            errors.push(result.reason)
            return {
              status: 'failed',
              executedSteps,
              errors,
              details,
            }
          }
          executedSteps += 1
          break
        }
        case 'move_resize_window': {
          const result = await this.moveResizeWindow(scene, step.windowId, step.bounds)
          details.push({
            step,
            result,
          })
          if (result.status === 'unsupported') {
            errors.push(result.reason)
            return {
              status: 'unsupported',
              executedSteps,
              errors,
              details,
            }
          }
          if (result.status !== 'completed') {
            errors.push(result.reason)
            return {
              status: 'failed',
              executedSteps,
              errors,
              details,
            }
          }
          executedSteps += 1
          break
        }
        case 'click': {
          const clickResult = await this.executeAction({
            kind: 'click',
            input: {
              x: step.x,
              y: step.y,
              button: step.button,
              clickCount: step.clickCount,
              captureAfter: false,
            },
          }, 'desktop_run_action_plan', {
            skipApprovalQueue: true,
          })

          details.push({
            step,
            result: clickResult,
          })

          if (actionFailed(clickResult)) {
            errors.push('click_step_failed')
            return {
              status: 'failed',
              executedSteps,
              errors,
              details,
            }
          }

          executedSteps += 1
          break
        }
        case 'wait': {
          const waitResult = await this.executeAction({
            kind: 'wait',
            input: {
              durationMs: step.durationMs,
              captureAfter: false,
            },
          }, 'desktop_run_action_plan', {
            skipApprovalQueue: true,
          })

          details.push({
            step,
            result: waitResult,
          })

          if (actionFailed(waitResult)) {
            errors.push('wait_step_failed')
            return {
              status: 'failed',
              executedSteps,
              errors,
              details,
            }
          }

          executedSteps += 1
          break
        }
      }
    }

    return {
      status: 'completed',
      executedSteps,
      errors,
      details,
    }
  }
}
