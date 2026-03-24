import type { Bounds } from '../types'

export type DesktopMode
  = | 'idle'
    | 'observing'
    | 'suggesting'
    | 'acting'
    | 'interrupted'
    | 'recovering'

export type ControlLeaseKind = 'observe' | 'suggest' | 'act'

export interface ControlLease {
  holder: 'user' | 'airi'
  kind: ControlLeaseKind
  startedAt: number
  expiresAt: number
  interruptOnUserInput: boolean
}

export interface GhostPointerState {
  visible: boolean
  x: number
  y: number
  targetX: number
  targetY: number
  label?: string
  style: 'follow' | 'preview' | 'acting' | 'error'
}

export interface WindowNode {
  id: string
  windowNumber?: number
  appName: string
  title: string
  bounds: Bounds
  ownerPid?: number
  focused: boolean
  zIndex: number
  screenId: string
  axRole?: string
}

export interface DesktopScene {
  capturedAt: string
  screens: Array<{ id: string, bounds: Bounds }>
  windows: WindowNode[]
  pointer: { x: number, y: number }
  focusedApp?: string
  focusedWindowId?: string
}

export type LayoutPresetId = 'coding-dual-pane' | 'review-mode' | 'agent-watch'

export interface LayoutTarget {
  windowId: string
  bounds: Bounds
  reason: string
}

export interface LayoutPreview {
  layoutId: LayoutPresetId
  targets: LayoutTarget[]
  focusOrder: string[]
  unresolvedWindowIds: string[]
  notes: string[]
}

export type DesktopActionPlanStep
  = | {
    kind: 'focus_window'
    windowId: string
  }
  | {
    kind: 'move_resize_window'
    windowId: string
    bounds: Bounds
  }
  | {
    kind: 'click'
    x: number
    y: number
    button?: 'left' | 'right' | 'middle'
    clickCount?: number
  }
  | {
    kind: 'wait'
    durationMs: number
  }

export interface DesktopActionPlan {
  id: string
  createdAt: string
  steps: DesktopActionPlanStep[]
}

export interface DesktopActionPlanResult {
  status: 'completed' | 'interrupted' | 'failed' | 'unsupported'
  executedSteps: number
  errors: string[]
  details: Record<string, unknown>[]
}

export type DesktopSafeLoopPhase
  = | 'observe'
    | 'decide'
    | 'act'
    | 'verify'
    | 'interrupt'
    | 'budget'
    | 'completed'
    | 'failed'

export interface DesktopSafeLoopTraceEntry {
  at: string
  phase: DesktopSafeLoopPhase
  stepIndex?: number
  stepKind?: DesktopActionPlanStep['kind']
  message: string
  details?: Record<string, unknown>
}

export interface DesktopSafeLoopVerificationSummary {
  attempted: number
  passed: number
  failed: number
  notApplicable: number
  skipped: number
}

export type DesktopSafeLoopStatus
  = | 'succeeded'
    | 'failed'
    | 'interrupted'

export type DesktopSafeLoopFailureClassification
  = | 'lease_required'
    | 'lease_lost'
    | 'budget_exhausted'
    | 'action_failed'
    | 'verification_failed'
    | 'runtime_error'

export type DesktopSafeLoopInterruptedBy
  = | 'user_input'
    | 'lease_lost'
    | 'unknown'

export interface DesktopSafeLoopSceneSummary {
  windowCount: number
  focusedApp?: string
  focusedWindowId?: string
  pointer: { x: number, y: number }
}

export type DesktopSafeLoopStepActionStatus
  = | 'completed'
    | 'failed'
    | 'interrupted'
    | 'skipped'

export type DesktopSafeLoopStepVerificationStatus
  = | 'passed'
    | 'failed'
    | 'not_applicable'
    | 'verification_skipped'

export interface DesktopSafeLoopStepResult {
  stepIndex: number
  stepKind: DesktopActionPlanStep['kind']
  startedAt: string
  finishedAt: string
  actionStatus: DesktopSafeLoopStepActionStatus
  verificationStatus: DesktopSafeLoopStepVerificationStatus
  stepCost: number
  remainingBudgetBeforeStep: number
  remainingBudgetAfterStep: number
  reason: string
  sceneBefore?: DesktopSafeLoopSceneSummary
  sceneAfter?: DesktopSafeLoopSceneSummary
  verificationDetails?: Record<string, unknown>
}

export interface DesktopSafeLoopRequest {
  objective: string
  plan: DesktopActionPlanStep[]
  maxSteps?: number
  actionBudget?: number
  stopOnVerificationFailure?: boolean
}

export interface DesktopSafeLoopRun {
  runId: string
  objective: string
  status: DesktopSafeLoopStatus
  failureClassification?: DesktopSafeLoopFailureClassification
  interruptedBy?: DesktopSafeLoopInterruptedBy
  startedAt: string
  finishedAt: string
  executedSteps: number
  remainingBudget: number
  verification: DesktopSafeLoopVerificationSummary
  stepResults: DesktopSafeLoopStepResult[]
  errors: string[]
  trace: DesktopSafeLoopTraceEntry[]
  plan: {
    requestedSteps: number
    cappedSteps: number
    executedStepKinds: DesktopActionPlanStep['kind'][]
  }
}
