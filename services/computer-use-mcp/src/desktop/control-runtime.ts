import type { ExecuteAction } from '../server/action-executor'
import type { ComputerUseServerRuntime } from '../server/runtime'
import type {
  ControlLeaseKind,
  DesktopActionPlan,
  DesktopActionPlanStep,
  DesktopSafeLoopFailureClassification,
  DesktopSafeLoopInterruptedBy,
  DesktopSafeLoopRequest,
  DesktopSafeLoopRun,
  DesktopSafeLoopSceneSummary,
  DesktopSafeLoopStepResult,
  LayoutPresetId,
} from './types'

import { DesktopActionService } from './action-service'
import { ControlArbiter } from './control-arbiter'
import { GhostPointerService } from './ghost-pointer-service'
import { DesktopIntentService } from './intent-service'
import { DesktopSceneService } from './scene-service'

interface DesktopSafeLoopVerifyResult {
  status: 'passed' | 'failed' | 'not_applicable'
  reason: string
  details?: Record<string, unknown>
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
  }): DesktopSafeLoopVerifyResult {
    const { step, sceneAfterAction } = params

    if (step.kind === 'focus_window') {
      const focusedWindow = sceneAfterAction.windows.find(window => window.focused)
      const matched = sceneAfterAction.focusedWindowId === step.windowId || focusedWindow?.id === step.windowId
      if (!matched) {
        return {
          status: 'failed',
          reason: 'verify_focus_window_failed',
          details: {
            expectedWindowId: step.windowId,
            observedFocusedWindowId: sceneAfterAction.focusedWindowId,
            observedFocusedWindowFromList: focusedWindow?.id,
          },
        }
      }

      return {
        status: 'passed',
        reason: 'verify_focus_window_passed',
      }
    }

    if (step.kind === 'move_resize_window') {
      const target = sceneAfterAction.windows.find(window => window.id === step.windowId)
      if (!target) {
        return {
          status: 'failed',
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
          status: 'failed',
          reason: 'verify_set_window_bounds_failed',
          details: {
            expectedBounds: step.bounds,
            observedBounds: target.bounds,
            tolerance,
          },
        }
      }

      return {
        status: 'passed',
        reason: 'verify_set_window_bounds_passed',
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
        const verification = this.verifyLoopStep({
          step,
          sceneAfterAction,
        })

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
        }
        stepResults.push(stepResult)

        appendTrace({
          phase: 'verify',
          stepIndex,
          stepKind: step.kind,
          message: verification.reason,
          details: verification.details,
        })

        if (verification.status === 'failed') {
          verificationFailed += 1
          errors.push(verification.reason)
          if (stopOnVerificationFailure) {
            return await finish('failed', {
              executedSteps,
              remainingBudget,
              verificationPassed,
              verificationFailed,
              cappedSteps: effectiveSteps.length,
              failureClassification: 'verification_failed',
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
          failureClassification: 'verification_failed',
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
