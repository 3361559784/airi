import type { ExecuteAction } from '../server/action-executor'
import type { ComputerUseServerRuntime } from '../server/runtime'
import type {
  ControlLeaseKind,
  DesktopActionPlan,
  DesktopActionPlanStep,
  DesktopSafeLoopRequest,
  DesktopSafeLoopRun,
  LayoutPresetId,
} from './types'

import { DesktopActionService } from './action-service'
import { ControlArbiter } from './control-arbiter'
import { GhostPointerService } from './ghost-pointer-service'
import { DesktopIntentService } from './intent-service'
import { DesktopSceneService } from './scene-service'

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

  private verifyLoopStep(params: {
    step: DesktopActionPlanStep
    sceneAfterAction: Awaited<ReturnType<DesktopControlRuntime['observeScene']>>
  }) {
    const { step, sceneAfterAction } = params

    if (step.kind === 'focus_window') {
      const focusedWindow = sceneAfterAction.windows.find(window => window.focused)
      const matched = sceneAfterAction.focusedWindowId === step.windowId || focusedWindow?.id === step.windowId
      if (!matched) {
        return {
          ok: false,
          reason: 'verify_focus_window_failed',
          details: {
            expectedWindowId: step.windowId,
            observedFocusedWindowId: sceneAfterAction.focusedWindowId,
            observedFocusedWindowFromList: focusedWindow?.id,
          },
        }
      }

      return {
        ok: true,
        reason: 'verify_focus_window_passed',
      }
    }

    if (step.kind === 'move_resize_window') {
      const target = sceneAfterAction.windows.find(window => window.id === step.windowId)
      if (!target) {
        return {
          ok: false,
          reason: 'verify_set_window_bounds_window_missing',
          details: {
            expectedWindowId: step.windowId,
          },
        }
      }

      const tolerance = 4
      const xMatched = Math.abs(target.bounds.x - step.bounds.x) <= tolerance
      const yMatched = Math.abs(target.bounds.y - step.bounds.y) <= tolerance
      const widthMatched = Math.abs(target.bounds.width - step.bounds.width) <= tolerance
      const heightMatched = Math.abs(target.bounds.height - step.bounds.height) <= tolerance
      const matched = xMatched && yMatched && widthMatched && heightMatched

      if (!matched) {
        return {
          ok: false,
          reason: 'verify_set_window_bounds_failed',
          details: {
            expectedBounds: step.bounds,
            observedBounds: target.bounds,
            tolerance,
          },
        }
      }

      return {
        ok: true,
        reason: 'verify_set_window_bounds_passed',
      }
    }

    if (step.kind === 'click') {
      const pointerMatched = Math.abs(sceneAfterAction.pointer.x - step.x) <= 3
        && Math.abs(sceneAfterAction.pointer.y - step.y) <= 3

      if (!pointerMatched) {
        return {
          ok: false,
          reason: 'verify_click_pointer_mismatch',
          details: {
            expectedPointer: { x: step.x, y: step.y },
            observedPointer: sceneAfterAction.pointer,
          },
        }
      }

      return {
        ok: true,
        reason: 'verify_click_pointer_passed',
      }
    }

    return {
      ok: true,
      reason: 'verify_wait_passed',
    }
  }

  async runSafeAgentLoop(request: DesktopSafeLoopRequest): Promise<DesktopSafeLoopRun> {
    const runId = `safe_loop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const startedAt = new Date().toISOString()
    const trace: DesktopSafeLoopRun['trace'] = []
    const errors: string[] = []
    const executedStepKinds: DesktopActionPlanStep['kind'][] = []

    const appendTrace = (entry: Omit<DesktopSafeLoopRun['trace'][number], 'at'>) => {
      trace.push({
        ...entry,
        at: new Date().toISOString(),
      })
    }

    const finish = (status: DesktopSafeLoopRun['status'], params: {
      executedSteps: number
      remainingBudget: number
      verificationPassed: number
      verificationFailed: number
    }) => {
      const finishedAt = new Date().toISOString()
      if (status === 'completed') {
        appendTrace({
          phase: 'completed',
          message: 'desktop_safe_agent_loop_completed',
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
            errors,
          },
        })
      }

      const run: DesktopSafeLoopRun = {
        runId,
        objective: request.objective,
        status,
        startedAt,
        finishedAt,
        executedSteps: params.executedSteps,
        remainingBudget: params.remainingBudget,
        verification: {
          passed: params.verificationPassed,
          failed: params.verificationFailed,
        },
        errors,
        trace,
        plan: {
          requestedSteps: request.plan.length,
          executedStepKinds,
        },
      }

      this.rememberSafeLoopRun(run)
      return run
    }

    if (!this.arbiter.hasActiveLease('act')) {
      errors.push('act_lease_required_before_safe_agent_loop')
      appendTrace({
        phase: 'interrupt',
        message: 'safe_loop_start_blocked_no_act_lease',
      })
      return finish('lease_required', {
        executedSteps: 0,
        remainingBudget: 0,
        verificationPassed: 0,
        verificationFailed: 0,
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

    for (const [stepIndex, step] of effectiveSteps.entries()) {
      if (!this.arbiter.hasActiveLease('act')) {
        errors.push('act_lease_lost_during_safe_agent_loop')
        appendTrace({
          phase: 'interrupt',
          stepIndex,
          stepKind: step.kind,
          message: 'safe_loop_interrupted_due_to_lease_loss',
        })
        return finish('interrupted', {
          executedSteps,
          remainingBudget,
          verificationPassed,
          verificationFailed,
        })
      }

      const stepCost = this.estimateLoopStepCost(step)
      if (stepCost > remainingBudget) {
        errors.push('safe_loop_action_budget_exhausted')
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
        return finish('budget_exhausted', {
          executedSteps,
          remainingBudget,
          verificationPassed,
          verificationFailed,
        })
      }

      const sceneBeforeAction = await this.observeScene()
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

      appendTrace({
        phase: 'decide',
        stepIndex,
        stepKind: step.kind,
        message: 'safe_loop_step_selected',
        details: {
          step,
          stepCost,
          remainingBudget,
        },
      })

      const actionResult = await this.actionService.runActionPlan(sceneBeforeAction, {
        id: `${runId}_step_${stepIndex}`,
        createdAt: new Date().toISOString(),
        steps: [step],
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
        errors.push('safe_loop_interrupted_while_executing_step')
        return finish('interrupted', {
          executedSteps,
          remainingBudget,
          verificationPassed,
          verificationFailed,
        })
      }

      if (actionResult.status !== 'completed') {
        errors.push(actionResult.errors[0] || `safe_loop_step_failed:${step.kind}`)
        return finish('failed', {
          executedSteps,
          remainingBudget,
          verificationPassed,
          verificationFailed,
        })
      }

      executedSteps += 1
      executedStepKinds.push(step.kind)

      const sceneAfterAction = await this.observeScene()
      const verification = this.verifyLoopStep({
        step,
        sceneAfterAction,
      })

      appendTrace({
        phase: 'verify',
        stepIndex,
        stepKind: step.kind,
        message: verification.reason,
        details: verification.details,
      })

      if (!verification.ok) {
        verificationFailed += 1
        errors.push(verification.reason)
        if (stopOnVerificationFailure) {
          return finish('failed', {
            executedSteps,
            remainingBudget,
            verificationPassed,
            verificationFailed,
          })
        }
      }
      else {
        verificationPassed += 1
      }
    }

    return finish('completed', {
      executedSteps,
      remainingBudget,
      verificationPassed,
      verificationFailed,
    })
  }
}

export function createDesktopControlRuntime(runtime: ComputerUseServerRuntime, executeAction: ExecuteAction) {
  return new DesktopControlRuntime(runtime, executeAction)
}
