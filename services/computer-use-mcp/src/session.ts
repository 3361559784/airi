import type {
  ComputerUseConfig,
  LastScreenshotInfo,
  PendingActionRecord,
  ScreenshotArtifact,
  SessionTraceEntry,
  TerminalState,
} from './types'
import type { DesktopSafeLoopRun } from './desktop/types'

import process from 'node:process'
import { resolve } from 'node:path'

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'

export class ComputerUseSession {
  private initialized = false
  private pendingActions = new Map<string, PendingActionRecord>()
  private pendingApprovalTokens = new Map<string, string>()
  private traceEntries: SessionTraceEntry[] = []
  private safeLoopRuns: DesktopSafeLoopRun[] = []
  private readonly safeLoopRunLimit = 120
  private readonly safeLoopRunsLogPath: string
  private pointerPosition?: { x: number, y: number }
  private operationsExecuted = 0
  private operationUnitsConsumed = 0
  private lastScreenshot?: LastScreenshotInfo
  private terminalState: TerminalState

  constructor(private readonly config: ComputerUseConfig) {
    this.safeLoopRunsLogPath = resolve(config.sessionRoot, 'safe-loop-runs.jsonl')
    this.terminalState = {
      effectiveCwd: process.cwd(),
    }
  }

  async init() {
    if (this.initialized)
      return

    await mkdir(this.config.sessionRoot, { recursive: true })
    await mkdir(this.config.screenshotsDir, { recursive: true })
    await this.loadSafeLoopRunsFromDisk()
    this.initialized = true
  }

  private upsertSafeLoopRun(run: DesktopSafeLoopRun) {
    const index = this.safeLoopRuns.findIndex(item => item.runId === run.runId)
    if (index >= 0) {
      this.safeLoopRuns[index] = run
    }
    else {
      this.safeLoopRuns.push(run)
    }

    if (this.safeLoopRuns.length > this.safeLoopRunLimit) {
      this.safeLoopRuns.splice(0, this.safeLoopRuns.length - this.safeLoopRunLimit)
    }
  }

  private async loadSafeLoopRunsFromDisk() {
    try {
      const raw = await readFile(this.safeLoopRunsLogPath, 'utf-8')
      const lines = raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line)
          if (!parsed || typeof parsed !== 'object' || typeof (parsed as { runId?: unknown }).runId !== 'string') {
            continue
          }
          this.upsertSafeLoopRun(parsed as DesktopSafeLoopRun)
        }
        catch {
          // Ignore malformed lines and continue loading subsequent records.
        }
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  getSnapshot() {
    return {
      operationsExecuted: this.operationsExecuted,
      operationUnitsConsumed: this.operationUnitsConsumed,
      pendingActions: this.pendingActions.size,
      pointerPosition: this.pointerPosition,
      lastScreenshot: this.lastScreenshot,
      safeLoopRunArtifacts: this.safeLoopRuns.length,
      auditLogPath: this.config.auditLogPath,
      screenshotsDir: this.config.screenshotsDir,
      terminalState: this.terminalState,
    }
  }

  getPointerPosition() {
    return this.pointerPosition
  }

  setPointerPosition(point: { x: number, y: number }) {
    this.pointerPosition = point
  }

  setLastScreenshot(screenshot: ScreenshotArtifact) {
    this.lastScreenshot = {
      path: screenshot.path,
      width: screenshot.width,
      height: screenshot.height,
      capturedAt: screenshot.capturedAt,
      placeholder: screenshot.placeholder ?? false,
      note: screenshot.note,
      executionTargetMode: screenshot.executionTargetMode,
      sourceHostName: screenshot.sourceHostName,
      sourceDisplayId: screenshot.sourceDisplayId,
      sourceSessionTag: screenshot.sourceSessionTag,
    }
  }

  getLastScreenshot() {
    return this.lastScreenshot
  }

  consumeOperation(units: number) {
    this.operationsExecuted += 1
    this.operationUnitsConsumed += units
  }

  getBudgetState() {
    return {
      operationsExecuted: this.operationsExecuted,
      operationUnitsConsumed: this.operationUnitsConsumed,
    }
  }

  createPendingAction(record: Omit<PendingActionRecord, 'id' | 'createdAt'>) {
    if (this.pendingActions.size >= this.config.maxPendingActions) {
      throw new Error(`too many pending actions: ${this.config.maxPendingActions}`)
    }

    const pending: PendingActionRecord = {
      ...record,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    }
    this.pendingActions.set(pending.id, pending)
    this.pendingApprovalTokens.set(pending.id, randomUUID())
    return pending
  }

  getPendingAction(id: string) {
    return this.pendingActions.get(id)
  }

  listPendingActions() {
    return [...this.pendingActions.values()]
  }

  getPendingActionApprovalToken(id: string) {
    return this.pendingApprovalTokens.get(id)
  }

  hasPendingActionApprovalToken(id: string, token: string | undefined) {
    if (!token) {
      return false
    }

    return this.pendingApprovalTokens.get(id) === token
  }

  removePendingAction(id: string) {
    this.pendingActions.delete(id)
    this.pendingApprovalTokens.delete(id)
  }

  setTerminalState(nextState: TerminalState) {
    this.terminalState = { ...nextState }
  }

  getTerminalState() {
    return { ...this.terminalState }
  }

  async record(entry: Omit<SessionTraceEntry, 'id' | 'at'>) {
    const fullEntry: SessionTraceEntry = {
      ...entry,
      id: randomUUID(),
      at: new Date().toISOString(),
    }

    this.traceEntries.push(fullEntry)
    if (this.traceEntries.length > 500) {
      this.traceEntries.splice(0, this.traceEntries.length - 500)
    }

    await appendFile(this.config.auditLogPath, `${JSON.stringify(fullEntry)}\n`, 'utf-8')

    return fullEntry
  }

  getRecentTrace(limit = 50) {
    return this.traceEntries.slice(-Math.max(limit, 1))
  }

  async recordSafeLoopRun(run: DesktopSafeLoopRun) {
    this.upsertSafeLoopRun(run)
    await appendFile(this.safeLoopRunsLogPath, `${JSON.stringify(run)}\n`, 'utf-8')
  }

  getRecentSafeLoopRuns(limit = 20) {
    return this.safeLoopRuns.slice(-Math.max(limit, 1))
  }
}
