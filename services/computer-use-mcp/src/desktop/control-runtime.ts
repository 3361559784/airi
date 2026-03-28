import type { ExecuteAction } from '../server/action-executor'
import type { ComputerUseServerRuntime } from '../server/runtime'
import type {
  ControlLeaseKind,
  DesktopActionPlan,
  DesktopActionPlanStep,
  DesktopObservedWindowIdentity,
  DesktopSafeLoopFailureClassification,
  DesktopSafeLoopInterruptedBy,
  DesktopSafeLoopRequest,
  DesktopSafeLoopRun,
  DesktopSafeLoopSceneSummary,
  DesktopSafeLoopStepResult,
  DesktopWindowReacquireSelector,
  DesktopWindowReacquireStatus,
  LayoutPresetId,
} from './types'

import { DesktopActionService } from './action-service'
import { ControlArbiter } from './control-arbiter'
import { GhostPointerService } from './ghost-pointer-service'
import { DesktopIntentService } from './intent-service'
import {
  DesktopSceneService,
  reacquireWindowInScene,
  toObservedWindowIdentity,
  toReacquireSelector,
} from './scene-service'

const VERIFY_FOCUS_WINDOW_RESAMPLE_DELAY_MS = 120
const VERIFY_SET_BOUNDS_RESAMPLE_DELAY_MS = 150
const VERIFY_SET_BOUNDS_TOLERANCE_PX = 8
const VERIFY_OPEN_APP_RESAMPLE_DELAY_MS = 250
const VERIFY_OPEN_APP_FINAL_RESAMPLE_DELAY_MS = 750

interface DesktopSafeLoopVerifyResult {
  status: 'passed' | 'failed' | 'not_applicable' | 'interrupted'
  reason: string
  details?: Record<string, unknown>
  matchedWindowId?: string
  targetUnavailable?: boolean
  interruptedBy?: DesktopSafeLoopInterruptedBy
  failureClassification?: DesktopSafeLoopFailureClassification
}

export class DesktopControlRuntime {
  readonly arbiter = new ControlArbiter()
  readonly ghostPointer = new GhostPointerService()
  readonly sceneService: DesktopSceneService
  readonly intentService = new DesktopIntentService()
  readonly actionService: DesktopActionService
  private readonly safeLoopRuns: DesktopSafeLoopRun[] = []
  private readonly safeLoopRunLimit = 60

  constructor(
    private readonly runtime: ComputerUseServerRuntime,
    executeAction: ExecuteAction,
  ) {
    this.sceneService = new DesktopSceneService(
      runtime.executor,
      () => runtime.session.getPointerPosition(),
    )
    this.actionService = new DesktopActionService(executeAction)
  }

  getControlState() {
    const { mode, lease } = this.arbiter.getState()
    return {
      mode,
      lease,
      ghostPointer: this.ghostPointer.getState(),
      safeLoopRunCount: this.safeLoopRuns.length,
    }
  }

  getSafeLoopTrace(limit = 20) {
    const clampedLimit = Math.min(Math.max(Math.floor(limit) || 1, 1), this.safeLoopRunLimit)
    return this.safeLoopRuns.slice(-clampedLimit)
  }

  requestLease(kind: ControlLeaseKind, ttlMs?: number) {
    return this.arbiter.requestLease(kind, ttlMs)
  }

  cancelLease(reason?: string) {
    return this.arbiter.cancelLease(reason)
  }

  reportUserInput() {
    return this.arbiter.notifyUserInput()
  }

  async observeScene() {
    const scene = await this.sceneService.observeScene()
    this.ghostPointer.followPointer(scene.pointer)
    return scene
  }

  observePointer() {
    const pointer = this.sceneService.getPointer()
    return this.ghostPointer.followPointer(pointer)
  }

  previewPointerMove(target: { x: number, y: number }, label?: string) {
    return this.ghostPointer.previewPointerMove(target, label)
  }

  async previewLayout(layoutId: LayoutPresetId, windowIds?: string[]) {
    const scene = await this.observeScene()
    return this.intentService.previewLayout(scene, layoutId, windowIds)
  }

  async applyLayout(layoutId: LayoutPresetId, windowIds?: string[]) {
    if (!this.arbiter.hasActiveLease('act')) {
      return {
        status: 'lease_required' as const,
        reason: 'act_lease_required_before_apply_layout',
      }
    }

    const scene = await this.observeScene()
    const preview = this.intentService.previewLayout(scene, layoutId, windowIds)

    if (preview.targets.length === 0) {
      this.ghostPointer.markError('layout_preview_has_no_targets')
      return {
        status: 'failed' as const,
        reason: 'layout_preview_has_no_targets',
        preview,
      }
    }

    const plan = this.intentService.toActionPlan(preview)
    const result = await this.actionService.runActionPlan(scene, plan, {
      shouldContinue: () => this.arbiter.hasActiveLease('act'),
    })

    if (result.status !== 'completed') {
      this.ghostPointer.markError('layout_apply_failed')
    }

    return {
      status: result.status,
      preview,
      plan,
      result,
    }
  }

  async focusWindow(windowId: string) {
    if (!this.arbiter.hasActiveLease('act')) {
      return {
        status: 'lease_required' as const,
        reason: 'act_lease_required_before_focus_window',
      }
    }

    const scene = await this.observeScene()
    const result = await this.actionService.focusWindow(scene, windowId)
    return {
      status: result.status,
      result,
    }
  }

  async moveResizeWindow(windowId: string, bounds: { x: number, y: number, width: number, height: number }) {
    if (!this.arbiter.hasActiveLease('act')) {
      return {
        status: 'lease_required' as const,
        reason: 'act_lease_required_before_move_resize',
      }
    }

    const scene = await this.observeScene()
    const result = await this.actionService.moveResizeWindow(scene, windowId, bounds)
    return {
      status: result.status,
      result,
    }
  }

  async runActionPlan(plan: DesktopActionPlan) {
    if (!this.arbiter.hasActiveLease('act')) {
      return {
        status: 'lease_required' as const,
        reason: 'act_lease_required_before_run_action_plan',
      }
    }

    const scene = await this.observeScene()
    const result = await this.actionService.runActionPlan(scene, plan, {
      shouldContinue: () => this.arbiter.hasActiveLease('act'),
    })

    return {
      status: result.status,
      result,
    }
  }

  private estimateLoopStepCost(step: DesktopActionPlanStep) {
    switch (step.kind) {
      case 'open_app':
      case 'focus_app':
      case 'focus_window':
      case 'move_resize_window':
        return 2
      case 'click':
      case 'wait':
        return 1
      default:
        return 1
    }
  }

  private rememberSafeLoopRun(run: DesktopSafeLoopRun) {
    this.safeLoopRuns.push(run)
    if (this.safeLoopRuns.length > this.safeLoopRunLimit) {
      this.safeLoopRuns.splice(0, this.safeLoopRuns.length - this.safeLoopRunLimit)
    }
  }

  private isWindowTargetStep(step: DesktopActionPlanStep): step is Extract<DesktopActionPlanStep, { kind: 'focus_window' | 'move_resize_window' }> {
    return step.kind === 'focus_window' || step.kind === 'move_resize_window'
  }

  private toStepWithWindowId(
    step: Extract<DesktopActionPlanStep, { kind: 'focus_window' | 'move_resize_window' }>,
    windowId: string,
  ): Extract<DesktopActionPlanStep, { kind: 'focus_window' | 'move_resize_window' }> {
    if (step.kind === 'focus_window') {
      return {
        kind: 'focus_window',
        windowId,
      }
    }

    return {
      kind: 'move_resize_window',
      windowId,
      bounds: step.bounds,
    }
  }

  private resolveObservedIdentityForStep(params: {
    step: Extract<DesktopActionPlanStep, { kind: 'focus_window' | 'move_resize_window' }>
    sceneBeforeAction: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>
    selectorCache: Map<string, DesktopWindowReacquireSelector>
  }): {
    observedIdentity?: DesktopObservedWindowIdentity
    reacquireSelector: DesktopWindowReacquireSelector
    reacquireStatus: Exclude<DesktopWindowReacquireStatus, 'not_needed'>
    matchedWindowId?: string
    resolvedStep?: Extract<DesktopActionPlanStep, { kind: 'focus_window' | 'move_resize_window' }>
  } {
    const { step, sceneBeforeAction, selectorCache } = params

    const directWindow = sceneBeforeAction.windows.find(window => window.id === step.windowId)
    const observedIdentity = directWindow ? toObservedWindowIdentity(directWindow) : undefined

    const cachedSelector = selectorCache.get(step.windowId)
    const reacquireSelector = observedIdentity
      ? toReacquireSelector(observedIdentity)
      : cachedSelector || { windowId: step.windowId }

    const reacquire = reacquireWindowInScene(sceneBeforeAction, reacquireSelector)
    if (!reacquire.matchedWindow) {
      return {
        observedIdentity,
        reacquireSelector,
        reacquireStatus: reacquire.status,
      }
    }

    const matchedIdentity = toObservedWindowIdentity(reacquire.matchedWindow)
    const refreshedSelector = toReacquireSelector(matchedIdentity)
    selectorCache.set(step.windowId, refreshedSelector)

    return {
      observedIdentity: matchedIdentity,
      reacquireSelector: refreshedSelector,
      reacquireStatus: reacquire.status,
      matchedWindowId: reacquire.matchedWindow.id,
      resolvedStep: this.toStepWithWindowId(step, reacquire.matchedWindow.id),
    }
  }

  private resolveVerificationWindow(params: {
    scene: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>
    fallbackWindowId: string
    reacquireSelector?: DesktopWindowReacquireSelector
  }): {
    ok: boolean
    matchedWindowId?: string
    reacquireStatus?: Exclude<DesktopWindowReacquireStatus, 'not_needed'>
  } {
    const { scene, fallbackWindowId, reacquireSelector } = params

    if (!reacquireSelector) {
      return {
        ok: true,
        matchedWindowId: fallbackWindowId,
      }
    }

    const reacquire = reacquireWindowInScene(scene, reacquireSelector)
    if (!reacquire.matchedWindow) {
      return {
        ok: false,
        reacquireStatus: reacquire.status,
      }
    }

    return {
      ok: true,
      matchedWindowId: reacquire.matchedWindow.id,
      reacquireStatus: reacquire.status,
    }
  }

  private verifyFocusWindowOnce(params: {
    scene: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>
    expectedWindowId: string
  }) {
    const focusedWindow = params.scene.windows.find(window => window.focused)
    const matched = params.scene.focusedWindowId === params.expectedWindowId || focusedWindow?.id === params.expectedWindowId

    return {
      matched,
      details: {
        expectedWindowId: params.expectedWindowId,
        observedFocusedWindowId: params.scene.focusedWindowId,
        observedFocusedWindowFromList: focusedWindow?.id,
      },
    }
  }

  private verifyFocusAppOnce(params: {
    scene: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>
    expectedApp: string
  }) {
    const matched = params.scene.focusedApp === params.expectedApp

    return {
      matched,
      details: {
        expectedApp: params.expectedApp,
        observedFocusedApp: params.scene.focusedApp,
      },
    }
  }

  private verifyOpenAppOnce(params: {
    scene: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>
    expectedApp: string
  }) {
    const windowCountForApp = params.scene.windows.filter(window => window.appName === params.expectedApp).length
    const matchedBy = params.scene.focusedApp === params.expectedApp
      ? 'focused_app'
      : windowCountForApp > 0
        ? 'visible_window'
        : 'none'

    return {
      matched: matchedBy !== 'none',
      details: {
        expectedApp: params.expectedApp,
        matchedBy,
        windowCountForApp,
        observedFocusedApp: params.scene.focusedApp,
      },
    }
  }

  private verifySetBoundsOnce(params: {
    scene: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>
    step: Extract<DesktopActionPlanStep, { kind: 'move_resize_window' }>
    expectedWindowId: string
  }) {
    const target = params.scene.windows.find(window => window.id === params.expectedWindowId)
    if (!target) {
      return {
        matched: false,
        windowMissing: true,
        details: {
          expectedWindowId: params.expectedWindowId,
        },
      }
    }

    const tolerance = VERIFY_SET_BOUNDS_TOLERANCE_PX
    const xMatched = Math.abs(target.bounds.x - params.step.bounds.x) <= tolerance
    const yMatched = Math.abs(target.bounds.y - params.step.bounds.y) <= tolerance
    const widthMatched = Math.abs(target.bounds.width - params.step.bounds.width) <= tolerance
    const heightMatched = Math.abs(target.bounds.height - params.step.bounds.height) <= tolerance
    const matched = xMatched && yMatched && widthMatched && heightMatched

    return {
      matched,
      windowMissing: false,
      details: {
        expectedBounds: params.step.bounds,
        observedBounds: target.bounds,
        tolerance,
      },
    }
  }

  private async waitBeforeVerifyResample(
    durationMs: number,
    scene: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>,
  ) {
    await this.actionService.runActionPlan(scene, {
      id: `safe_loop_verify_wait_${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      steps: [{
        kind: 'wait',
        durationMs,
      }],
    })
  }

  private resolveVerifyInterruption(): DesktopSafeLoopVerifyResult | undefined {
    if (this.arbiter.hasActiveLease('act')) {
      return undefined
    }

    // NOTICE: verify resampling still runs inside the safe-loop critical section.
    // If the act lease is preempted here, we must surface an interruption instead
    // of quietly completing verification against a stale post-action scene.
    const interruptionContext = this.resolveLeaseInterruptionContext()
    return {
      status: 'interrupted',
      reason: interruptionContext.traceMessage,
      details: {
        interruptedBy: interruptionContext.interruptedBy,
        failureClassification: interruptionContext.failureClassification,
      },
      interruptedBy: interruptionContext.interruptedBy,
      failureClassification: interruptionContext.failureClassification,
    }
  }

  private async verifyLoopStep(params: {
    step: DesktopActionPlanStep
    sceneAfterAction: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>
    reacquireSelector?: DesktopWindowReacquireSelector
  }): Promise<DesktopSafeLoopVerifyResult> {
    const { step, sceneAfterAction } = params

    if (step.kind === 'open_app') {
      const initialInterruption = this.resolveVerifyInterruption()
      if (initialInterruption) {
        return initialInterruption
      }

      const firstAttempt = this.verifyOpenAppOnce({
        scene: sceneAfterAction,
        expectedApp: step.app,
      })
      if (firstAttempt.matched) {
        return {
          status: 'passed',
          reason: 'verify_open_app_passed',
          details: {
            expectedApp: step.app,
            attempts: 1,
            matchedBy: firstAttempt.details.matchedBy,
            windowCountForApp: firstAttempt.details.windowCountForApp,
            firstAttempt: firstAttempt.details,
          },
        }
      }

      await this.waitBeforeVerifyResample(VERIFY_OPEN_APP_RESAMPLE_DELAY_MS, sceneAfterAction)
      const interruptionAfterFirstWait = this.resolveVerifyInterruption()
      if (interruptionAfterFirstWait) {
        return interruptionAfterFirstWait
      }

      const secondScene = await this.observeScene()
      const secondAttempt = this.verifyOpenAppOnce({
        scene: secondScene,
        expectedApp: step.app,
      })
      if (secondAttempt.matched) {
        return {
          status: 'passed',
          reason: 'verify_open_app_passed',
          details: {
            expectedApp: step.app,
            attempts: 2,
            matchedBy: secondAttempt.details.matchedBy,
            windowCountForApp: secondAttempt.details.windowCountForApp,
            firstAttempt: firstAttempt.details,
            secondAttempt: secondAttempt.details,
          },
        }
      }

      await this.waitBeforeVerifyResample(VERIFY_OPEN_APP_FINAL_RESAMPLE_DELAY_MS, secondScene)
      const interruptionAfterSecondWait = this.resolveVerifyInterruption()
      if (interruptionAfterSecondWait) {
        return interruptionAfterSecondWait
      }

      const thirdScene = await this.observeScene()
      const thirdAttempt = this.verifyOpenAppOnce({
        scene: thirdScene,
        expectedApp: step.app,
      })
      if (thirdAttempt.matched) {
        return {
          status: 'passed',
          reason: 'verify_open_app_passed',
          details: {
            expectedApp: step.app,
            attempts: 3,
            matchedBy: thirdAttempt.details.matchedBy,
            windowCountForApp: thirdAttempt.details.windowCountForApp,
            firstAttempt: firstAttempt.details,
            secondAttempt: secondAttempt.details,
            thirdAttempt: thirdAttempt.details,
          },
        }
      }

      return {
        status: 'failed',
        reason: 'verify_open_app_failed',
        details: {
          expectedApp: step.app,
          attempts: 3,
          matchedBy: 'none',
          windowCountForApp: thirdAttempt.details.windowCountForApp,
          firstAttempt: firstAttempt.details,
          secondAttempt: secondAttempt.details,
          thirdAttempt: thirdAttempt.details,
        },
      }
    }

    if (step.kind === 'focus_app') {
      const initialInterruption = this.resolveVerifyInterruption()
      if (initialInterruption) {
        return initialInterruption
      }

      const firstAttempt = this.verifyFocusAppOnce({
        scene: sceneAfterAction,
        expectedApp: step.app,
      })
      if (firstAttempt.matched) {
        return {
          status: 'passed',
          reason: 'verify_focus_app_passed',
          details: {
            attempts: 1,
            ...firstAttempt.details,
          },
        }
      }

      await this.waitBeforeVerifyResample(VERIFY_FOCUS_WINDOW_RESAMPLE_DELAY_MS, sceneAfterAction)
      const interruptionAfterWait = this.resolveVerifyInterruption()
      if (interruptionAfterWait) {
        return interruptionAfterWait
      }

      const resampledScene = await this.observeScene()
      const secondAttempt = this.verifyFocusAppOnce({
        scene: resampledScene,
        expectedApp: step.app,
      })
      if (secondAttempt.matched) {
        return {
          status: 'passed',
          reason: 'verify_focus_app_passed',
          details: {
            attempts: 2,
            firstAttempt: firstAttempt.details,
            secondAttempt: secondAttempt.details,
          },
        }
      }

      return {
        status: 'failed',
        reason: 'verify_focus_app_failed',
        details: {
          expectedApp: step.app,
          attempts: 2,
          firstAttempt: firstAttempt.details,
          secondAttempt: secondAttempt.details,
        },
      }
    }

    if (step.kind === 'focus_window') {
      const initialInterruption = this.resolveVerifyInterruption()
      if (initialInterruption) {
        return initialInterruption
      }

      const verifyAttempt = async (scene: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>) => {
        const resolved = this.resolveVerificationWindow({
          scene,
          fallbackWindowId: step.windowId,
          reacquireSelector: params.reacquireSelector,
        })

        if (!resolved.ok || !resolved.matchedWindowId) {
          return {
            matched: false,
            targetUnavailable: true,
            details: {
              expectedWindowId: step.windowId,
              reacquireStatus: resolved.reacquireStatus,
            },
          }
        }

        const focusCheck = this.verifyFocusWindowOnce({
          scene,
          expectedWindowId: resolved.matchedWindowId,
        })

        return {
          matched: focusCheck.matched,
          targetUnavailable: false,
          matchedWindowId: resolved.matchedWindowId,
          details: {
            ...focusCheck.details,
            verifyReacquireStatus: resolved.reacquireStatus,
          },
        }
      }

      const firstAttempt = await verifyAttempt(sceneAfterAction)
      if (firstAttempt.matched) {
        return {
          status: 'passed',
          reason: 'verify_focus_window_passed',
          details: {
            attempts: 1,
            ...firstAttempt.details,
          },
          matchedWindowId: firstAttempt.matchedWindowId,
        }
      }

      await this.waitBeforeVerifyResample(VERIFY_FOCUS_WINDOW_RESAMPLE_DELAY_MS, sceneAfterAction)
      const interruptionAfterWait = this.resolveVerifyInterruption()
      if (interruptionAfterWait) {
        return interruptionAfterWait
      }
      const resampledScene = await this.observeScene()
      const secondAttempt = await verifyAttempt(resampledScene)
      if (secondAttempt.matched) {
        return {
          status: 'passed',
          reason: 'verify_focus_window_passed',
          details: {
            attempts: 2,
            firstAttempt: firstAttempt.details,
            secondAttempt: secondAttempt.details,
          },
          matchedWindowId: secondAttempt.matchedWindowId,
        }
      }

      if (firstAttempt.targetUnavailable && secondAttempt.targetUnavailable) {
        return {
          status: 'failed',
          reason: 'verify_target_unavailable',
          details: {
            expectedWindowId: step.windowId,
            attempts: 2,
            firstAttempt: firstAttempt.details,
            secondAttempt: secondAttempt.details,
          },
          targetUnavailable: true,
        }
      }

      return {
        status: 'failed',
        reason: 'verify_focus_window_failed',
        details: {
          expectedWindowId: step.windowId,
          attempts: 2,
          firstAttempt: firstAttempt.details,
          secondAttempt: secondAttempt.details,
        },
        matchedWindowId: secondAttempt.matchedWindowId || firstAttempt.matchedWindowId,
      }
    }

    if (step.kind === 'move_resize_window') {
      const initialInterruption = this.resolveVerifyInterruption()
      if (initialInterruption) {
        return initialInterruption
      }

      const verifyAttempt = async (scene: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>) => {
        const resolved = this.resolveVerificationWindow({
          scene,
          fallbackWindowId: step.windowId,
          reacquireSelector: params.reacquireSelector,
        })

        if (!resolved.ok || !resolved.matchedWindowId) {
          return {
            matched: false,
            targetUnavailable: true,
            details: {
              expectedWindowId: step.windowId,
              reacquireStatus: resolved.reacquireStatus,
            },
          }
        }

        const boundsCheck = this.verifySetBoundsOnce({
          scene,
          step,
          expectedWindowId: resolved.matchedWindowId,
        })

        return {
          matched: boundsCheck.matched,
          targetUnavailable: false,
          windowMissing: boundsCheck.windowMissing,
          matchedWindowId: resolved.matchedWindowId,
          details: {
            ...boundsCheck.details,
            verifyReacquireStatus: resolved.reacquireStatus,
          },
        }
      }

      const firstAttempt = await verifyAttempt(sceneAfterAction)
      if (firstAttempt.matched) {
        return {
          status: 'passed',
          reason: 'verify_set_window_bounds_passed',
          details: {
            attempts: 1,
            ...firstAttempt.details,
          },
          matchedWindowId: firstAttempt.matchedWindowId,
        }
      }

      await this.waitBeforeVerifyResample(VERIFY_SET_BOUNDS_RESAMPLE_DELAY_MS, sceneAfterAction)
      const interruptionAfterWait = this.resolveVerifyInterruption()
      if (interruptionAfterWait) {
        return interruptionAfterWait
      }
      const resampledScene = await this.observeScene()
      const secondAttempt = await verifyAttempt(resampledScene)

      if (secondAttempt.matched) {
        return {
          status: 'passed',
          reason: 'verify_set_window_bounds_passed',
          details: {
            attempts: 2,
            firstAttempt: firstAttempt.details,
            secondAttempt: secondAttempt.details,
          },
          matchedWindowId: secondAttempt.matchedWindowId,
        }
      }

      if (firstAttempt.targetUnavailable && secondAttempt.targetUnavailable) {
        return {
          status: 'failed',
          reason: 'verify_target_unavailable',
          details: {
            expectedWindowId: step.windowId,
            attempts: 2,
            firstAttempt: firstAttempt.details,
            secondAttempt: secondAttempt.details,
          },
          targetUnavailable: true,
        }
      }

      if (secondAttempt.windowMissing) {
        return {
          status: 'failed',
          reason: 'verify_set_window_bounds_window_missing',
          details: {
            expectedWindowId: step.windowId,
            attempts: 2,
            firstAttempt: firstAttempt.details,
            secondAttempt: secondAttempt.details,
          },
          matchedWindowId: secondAttempt.matchedWindowId || firstAttempt.matchedWindowId,
        }
      }

      return {
        status: 'failed',
        reason: 'verify_set_window_bounds_failed',
        details: {
          expectedWindowId: step.windowId,
          attempts: 2,
          firstAttempt: firstAttempt.details,
          secondAttempt: secondAttempt.details,
        },
        matchedWindowId: secondAttempt.matchedWindowId || firstAttempt.matchedWindowId,
      }
    }

    if (step.kind === 'click') {
      const pointerMatched = Math.abs(sceneAfterAction.pointer.x - step.x) <= 3
        && Math.abs(sceneAfterAction.pointer.y - step.y) <= 3

      if (!pointerMatched) {
        return {
          status: 'failed',
          reason: 'verify_click_pointer_mismatch',
          details: {
            expectedPointer: { x: step.x, y: step.y },
            observedPointer: sceneAfterAction.pointer,
          },
        }
      }

      return {
        status: 'passed',
        reason: 'verify_click_pointer_passed',
      }
    }

    return {
      status: 'not_applicable',
      reason: 'verify_not_applicable_for_wait',
    }
  }

  private toSafeLoopSceneSummary(scene: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>): DesktopSafeLoopSceneSummary {
    return {
      windowCount: scene.windows.length,
      focusedApp: scene.focusedApp,
      focusedWindowId: scene.focusedWindowId,
      pointer: {
        x: scene.pointer.x,
        y: scene.pointer.y,
      },
    }
  }

  private resolveLeaseInterruptionContext(): {
    failureClassification?: DesktopSafeLoopFailureClassification
    interruptedBy: DesktopSafeLoopInterruptedBy
    error: string
    traceMessage: string
  } {
    const { mode } = this.arbiter.getState()
    if (mode === 'interrupted') {
      return {
        interruptedBy: 'user_input',
        error: 'safe_loop_user_input_preempted_airi_lease',
        traceMessage: 'safe_loop_interrupted_due_to_user_input_preemption',
      }
    }

    return {
      failureClassification: 'lease_lost',
      interruptedBy: 'lease_lost',
      error: 'act_lease_lost_during_safe_agent_loop',
      traceMessage: 'safe_loop_interrupted_due_to_lease_loss',
    }
  }

  private async persistSafeLoopRunArtifact(run: DesktopSafeLoopRun) {
    this.rememberSafeLoopRun(run)

    try {
      await this.runtime.session.recordSafeLoopRun?.(run)
    }
    catch {
      // NOTICE: durable artifact write failures are side-channel only and
      // must never override the main safe-loop execution status.
    }

    try {
      this.runtime.stateManager.updateSafeLoopRun?.(run)
    }
    catch {
      // NOTICE: run-state projection failure should not affect safe-loop
      // runtime result semantics.
    }
  }

  async runSafeAgentLoop(request: DesktopSafeLoopRequest): Promise<DesktopSafeLoopRun> {
    const runId = `safe_loop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const startedAt = new Date().toISOString()
    const trace: DesktopSafeLoopRun['trace'] = []
    const errors: string[] = []
    const executedStepKinds: DesktopActionPlanStep['kind'][] = []
    const stepResults: DesktopSafeLoopStepResult[] = []

    const appendTrace = (entry: Omit<DesktopSafeLoopRun['trace'][number], 'at'>) => {
      trace.push({
        ...entry,
        at: new Date().toISOString(),
      })
    }

    const finish = async (status: DesktopSafeLoopRun['status'], params: {
      executedSteps: number
      remainingBudget: number
      verificationPassed: number
      verificationFailed: number
      cappedSteps: number
      failureClassification?: DesktopSafeLoopFailureClassification
      interruptedBy?: DesktopSafeLoopInterruptedBy
    }) => {
      const finishedAt = new Date().toISOString()
      if (status === 'succeeded') {
        appendTrace({
          phase: 'completed',
          message: 'desktop_safe_agent_loop_succeeded',
          details: {
            executedSteps: params.executedSteps,
            remainingBudget: params.remainingBudget,
          },
        })
      }
      else {
        appendTrace({
          phase: 'failed',
          message: `desktop_safe_agent_loop_${status}`,
          details: {
            executedSteps: params.executedSteps,
            remainingBudget: params.remainingBudget,
            failureClassification: params.failureClassification,
            interruptedBy: params.interruptedBy,
            errors,
          },
        })
      }

      const verificationNotApplicable = stepResults.filter(step => step.verificationStatus === 'not_applicable').length
      const verificationSkipped = stepResults.filter(step => step.verificationStatus === 'verification_skipped').length

      const run: DesktopSafeLoopRun = {
        runId,
        objective: request.objective,
        status,
        failureClassification: params.failureClassification,
        interruptedBy: params.interruptedBy,
        startedAt,
        finishedAt,
        executedSteps: params.executedSteps,
        remainingBudget: params.remainingBudget,
        verification: {
          attempted: params.verificationPassed + params.verificationFailed,
          passed: params.verificationPassed,
          failed: params.verificationFailed,
          notApplicable: verificationNotApplicable,
          skipped: verificationSkipped,
        },
        stepResults,
        errors,
        trace,
        plan: {
          requestedSteps: request.plan.length,
          cappedSteps: params.cappedSteps,
          executedStepKinds,
        },
      }

      await this.persistSafeLoopRunArtifact(run)
      return run
    }

    try {
      if (!this.arbiter.hasActiveLease('act')) {
        errors.push('act_lease_required_before_safe_agent_loop')
        appendTrace({
          phase: 'interrupt',
          message: 'safe_loop_start_blocked_no_act_lease',
        })
        return await finish('failed', {
          executedSteps: 0,
          remainingBudget: 0,
          verificationPassed: 0,
          verificationFailed: 0,
          cappedSteps: 0,
          failureClassification: 'lease_required',
        })
      }

      const requestedMaxSteps = Number.isFinite(request.maxSteps) ? Number(request.maxSteps) : 6
      const maxSteps = Math.min(Math.max(Math.floor(requestedMaxSteps), 1), 20)
      const effectiveSteps = request.plan.slice(0, maxSteps)

      const defaultBudget = Math.max(1, effectiveSteps.reduce((sum, step) => sum + this.estimateLoopStepCost(step), 0))
      const requestedBudget = Number.isFinite(request.actionBudget) ? Number(request.actionBudget) : defaultBudget
      let remainingBudget = Math.min(Math.max(Math.floor(requestedBudget), 1), 40)
      const stopOnVerificationFailure = request.stopOnVerificationFailure !== false

      let executedSteps = 0
      let verificationPassed = 0
      let verificationFailed = 0
      let verificationTargetUnavailable = false
      const windowSelectorByPlanWindowId = new Map<string, DesktopWindowReacquireSelector>()

      for (const [stepIndex, step] of effectiveSteps.entries()) {
        const stepCost = this.estimateLoopStepCost(step)
        const stepStartedAt = new Date().toISOString()
        const remainingBudgetBeforeStep = remainingBudget

        if (!this.arbiter.hasActiveLease('act')) {
          const interruptionContext = this.resolveLeaseInterruptionContext()
          errors.push(interruptionContext.error)
          const stepResult: DesktopSafeLoopStepResult = {
            stepIndex,
            stepKind: step.kind,
            startedAt: stepStartedAt,
            finishedAt: new Date().toISOString(),
            actionStatus: 'interrupted',
            verificationStatus: 'verification_skipped',
            stepCost,
            remainingBudgetBeforeStep,
            remainingBudgetAfterStep: remainingBudget,
            reason: interruptionContext.traceMessage,
          }
          stepResults.push(stepResult)

          appendTrace({
            phase: 'interrupt',
            stepIndex,
            stepKind: step.kind,
            message: interruptionContext.traceMessage,
            details: {
              interruptedBy: interruptionContext.interruptedBy,
              failureClassification: interruptionContext.failureClassification,
            },
          })

          return await finish('interrupted', {
            executedSteps,
            remainingBudget,
            verificationPassed,
            verificationFailed,
            cappedSteps: effectiveSteps.length,
            failureClassification: interruptionContext.failureClassification,
            interruptedBy: interruptionContext.interruptedBy,
          })
        }

        if (stepCost > remainingBudget) {
          const budgetError = 'safe_loop_action_budget_exhausted'
          errors.push(budgetError)

          const stepResult: DesktopSafeLoopStepResult = {
            stepIndex,
            stepKind: step.kind,
            startedAt: stepStartedAt,
            finishedAt: new Date().toISOString(),
            actionStatus: 'skipped',
            verificationStatus: 'verification_skipped',
            stepCost,
            remainingBudgetBeforeStep,
            remainingBudgetAfterStep: remainingBudget,
            reason: budgetError,
          }
          stepResults.push(stepResult)

          appendTrace({
            phase: 'budget',
            stepIndex,
            stepKind: step.kind,
            message: 'safe_loop_budget_exhausted_before_step',
            details: {
              requiredCost: stepCost,
              remainingBudget,
            },
          })

          return await finish('failed', {
            executedSteps,
            remainingBudget,
            verificationPassed,
            verificationFailed,
            cappedSteps: effectiveSteps.length,
            failureClassification: 'budget_exhausted',
          })
        }

        const sceneBeforeAction = await this.observeScene()
        const sceneBefore = this.toSafeLoopSceneSummary(sceneBeforeAction)
        let observedIdentity: DesktopObservedWindowIdentity | undefined
        let reacquireSelector: DesktopWindowReacquireSelector | undefined
        let reacquireStatus: DesktopWindowReacquireStatus = 'not_needed'
        let matchedWindowId: string | undefined
        let stepForAction = step

        appendTrace({
          phase: 'observe',
          stepIndex,
          stepKind: step.kind,
          message: 'safe_loop_scene_observed_before_action',
          details: {
            windowCount: sceneBeforeAction.windows.length,
            focusedWindowId: sceneBeforeAction.focusedWindowId,
          },
        })

        if (this.isWindowTargetStep(step)) {
          const targetResolution = this.resolveObservedIdentityForStep({
            step,
            sceneBeforeAction,
            selectorCache: windowSelectorByPlanWindowId,
          })

          observedIdentity = targetResolution.observedIdentity
          reacquireSelector = targetResolution.reacquireSelector
          reacquireStatus = targetResolution.reacquireStatus
          matchedWindowId = targetResolution.matchedWindowId
          stepForAction = targetResolution.resolvedStep || step

          appendTrace({
            phase: 'selector_recorded',
            stepIndex,
            stepKind: step.kind,
            message: 'safe_loop_selector_recorded_for_window_step',
            details: {
              selector: reacquireSelector,
              observedIdentity,
            },
          })

          if (!targetResolution.resolvedStep) {
            const targetUnavailableReason = `safe_loop_target_reacquire_${reacquireStatus}:${step.windowId}`
            errors.push(targetUnavailableReason)

            const stepResult: DesktopSafeLoopStepResult = {
              stepIndex,
              stepKind: step.kind,
              startedAt: stepStartedAt,
              finishedAt: new Date().toISOString(),
              actionStatus: 'failed',
              verificationStatus: 'verification_skipped',
              stepCost,
              remainingBudgetBeforeStep,
              remainingBudgetAfterStep: remainingBudget,
              reason: targetUnavailableReason,
              sceneBefore,
              observedIdentity,
              reacquireSelector,
              reacquireStatus,
              matchedWindowId,
            }
            stepResults.push(stepResult)

            appendTrace({
              phase: 'target_reacquire_failed',
              stepIndex,
              stepKind: step.kind,
              message: 'safe_loop_target_reacquire_failed_before_action',
              details: {
                selector: reacquireSelector,
                reacquireStatus,
                requestedWindowId: step.windowId,
              },
            })

            return await finish('failed', {
              executedSteps,
              remainingBudget,
              verificationPassed,
              verificationFailed,
              cappedSteps: effectiveSteps.length,
              failureClassification: 'target_unavailable',
            })
          }

          appendTrace({
            phase: 'target_reacquired',
            stepIndex,
            stepKind: step.kind,
            message: 'safe_loop_target_reacquired_for_window_step',
            details: {
              reacquireStatus,
              matchedWindowId,
              requestedWindowId: step.windowId,
            },
          })
        }

        appendTrace({
          phase: 'decide',
          stepIndex,
          stepKind: step.kind,
          message: 'safe_loop_step_selected',
          details: {
            step: stepForAction,
            stepCost,
            remainingBudget,
          },
        })

        const actionResult = await this.actionService.runActionPlan(sceneBeforeAction, {
          id: `${runId}_step_${stepIndex}`,
          createdAt: new Date().toISOString(),
          steps: [stepForAction],
        }, {
          shouldContinue: () => this.arbiter.hasActiveLease('act'),
        })
        remainingBudget -= stepCost

        appendTrace({
          phase: 'act',
          stepIndex,
          stepKind: step.kind,
          message: `safe_loop_step_act_${actionResult.status}`,
          details: {
            actionResult,
            remainingBudget,
          },
        })

        if (actionResult.status === 'interrupted') {
          const interruptionContext = this.resolveLeaseInterruptionContext()
          errors.push(interruptionContext.error)

          const stepResult: DesktopSafeLoopStepResult = {
            stepIndex,
            stepKind: step.kind,
            startedAt: stepStartedAt,
            finishedAt: new Date().toISOString(),
            actionStatus: 'interrupted',
            verificationStatus: 'verification_skipped',
            stepCost,
            remainingBudgetBeforeStep,
            remainingBudgetAfterStep: remainingBudget,
            reason: interruptionContext.traceMessage,
            sceneBefore,
            observedIdentity,
            reacquireSelector,
            reacquireStatus,
            matchedWindowId,
          }
          stepResults.push(stepResult)

          return await finish('interrupted', {
            executedSteps,
            remainingBudget,
            verificationPassed,
            verificationFailed,
            cappedSteps: effectiveSteps.length,
            failureClassification: interruptionContext.failureClassification,
            interruptedBy: interruptionContext.interruptedBy,
          })
        }

        if (actionResult.status !== 'completed') {
          const failureReason = actionResult.errors[0] || `safe_loop_step_failed:${step.kind}`
          errors.push(failureReason)

          const stepResult: DesktopSafeLoopStepResult = {
            stepIndex,
            stepKind: step.kind,
            startedAt: stepStartedAt,
            finishedAt: new Date().toISOString(),
            actionStatus: 'failed',
            verificationStatus: 'verification_skipped',
            stepCost,
            remainingBudgetBeforeStep,
            remainingBudgetAfterStep: remainingBudget,
            reason: failureReason,
            sceneBefore,
            observedIdentity,
            reacquireSelector,
            reacquireStatus,
            matchedWindowId,
          }
          stepResults.push(stepResult)

          return await finish('failed', {
            executedSteps,
            remainingBudget,
            verificationPassed,
            verificationFailed,
            cappedSteps: effectiveSteps.length,
            failureClassification: 'action_failed',
          })
        }

        executedSteps += 1
        executedStepKinds.push(step.kind)

        const sceneAfterAction = await this.observeScene()
        const sceneAfter = this.toSafeLoopSceneSummary(sceneAfterAction)
        appendTrace({
          phase: 'verify_started',
          stepIndex,
          stepKind: step.kind,
          message: 'safe_loop_step_verify_started',
          details: {
            requestedApp: step.kind === 'focus_app' || step.kind === 'open_app' ? step.app : undefined,
            requestedWindowId: this.isWindowTargetStep(step) ? step.windowId : undefined,
            matchedWindowId,
            reacquireStatus,
          },
        })

        const verification = await this.verifyLoopStep({
          step: stepForAction,
          sceneAfterAction,
          reacquireSelector,
        })

        if (verification.status === 'interrupted') {
          errors.push(verification.reason)

          const stepResult: DesktopSafeLoopStepResult = {
            stepIndex,
            stepKind: step.kind,
            startedAt: stepStartedAt,
            finishedAt: new Date().toISOString(),
            actionStatus: 'completed',
            verificationStatus: 'verification_skipped',
            stepCost,
            remainingBudgetBeforeStep,
            remainingBudgetAfterStep: remainingBudget,
            reason: verification.reason,
            sceneBefore,
            sceneAfter,
            verificationDetails: verification.details,
            observedIdentity,
            reacquireSelector,
            reacquireStatus,
            matchedWindowId: verification.matchedWindowId || matchedWindowId,
          }
          stepResults.push(stepResult)

          appendTrace({
            phase: 'interrupt',
            stepIndex,
            stepKind: step.kind,
            message: verification.reason,
            details: verification.details,
          })

          return await finish('interrupted', {
            executedSteps,
            remainingBudget,
            verificationPassed,
            verificationFailed,
            cappedSteps: effectiveSteps.length,
            failureClassification: verification.failureClassification,
            interruptedBy: verification.interruptedBy,
          })
        }

        const stepResult: DesktopSafeLoopStepResult = {
          stepIndex,
          stepKind: step.kind,
          startedAt: stepStartedAt,
          finishedAt: new Date().toISOString(),
          actionStatus: 'completed',
          verificationStatus: verification.status,
          stepCost,
          remainingBudgetBeforeStep,
          remainingBudgetAfterStep: remainingBudget,
          reason: verification.reason,
          sceneBefore,
          sceneAfter,
          verificationDetails: verification.details,
          observedIdentity,
          reacquireSelector,
          reacquireStatus,
          matchedWindowId: verification.matchedWindowId || matchedWindowId,
        }
        stepResults.push(stepResult)

        appendTrace({
          phase: 'verify',
          stepIndex,
          stepKind: step.kind,
          message: verification.reason,
          details: verification.details,
        })

        appendTrace({
          phase: verification.status === 'passed'
            ? 'verify_passed'
            : verification.status === 'failed'
              ? 'verify_failed'
              : 'verify',
          stepIndex,
          stepKind: step.kind,
          message: verification.reason,
          details: verification.details,
        })

        if (verification.status === 'failed') {
          verificationFailed += 1
          errors.push(verification.reason)
          verificationTargetUnavailable = verificationTargetUnavailable || verification.targetUnavailable === true
          if (stopOnVerificationFailure) {
            return await finish('failed', {
              executedSteps,
              remainingBudget,
              verificationPassed,
              verificationFailed,
              cappedSteps: effectiveSteps.length,
              failureClassification: verification.targetUnavailable ? 'target_unavailable' : 'verification_failed',
            })
          }
        }
        else if (verification.status === 'passed') {
          verificationPassed += 1
        }
      }

      if (verificationFailed > 0) {
        return await finish('failed', {
          executedSteps,
          remainingBudget,
          verificationPassed,
          verificationFailed,
          cappedSteps: effectiveSteps.length,
          failureClassification: verificationTargetUnavailable ? 'target_unavailable' : 'verification_failed',
        })
      }

      return await finish('succeeded', {
        executedSteps,
        remainingBudget,
        verificationPassed,
        verificationFailed,
        cappedSteps: effectiveSteps.length,
      })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`safe_loop_runtime_error:${message}`)

      appendTrace({
        phase: 'failed',
        message: 'safe_loop_runtime_exception',
        details: {
          error: message,
        },
      })

      return await finish('failed', {
        executedSteps: executedStepKinds.length,
        remainingBudget: 0,
        verificationPassed: 0,
        verificationFailed: 0,
        cappedSteps: request.plan.length,
        failureClassification: 'runtime_error',
      })
    }
  }
}

export function createDesktopControlRuntime(runtime: ComputerUseServerRuntime, executeAction: ExecuteAction) {
  return new DesktopControlRuntime(runtime, executeAction)
}
