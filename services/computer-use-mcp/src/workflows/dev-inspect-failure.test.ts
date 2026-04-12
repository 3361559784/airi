import { describe, expect, it } from 'vitest'

import { createDevInspectFailureWorkflow } from './dev-inspect-failure'

describe('dev-inspect-failure workflow', () => {
  it('creates workflow with default parameters', () => {
    const workflow = createDevInspectFailureWorkflow()
    expect(workflow.id).toBe('dev_inspect_failure')

    const ensureAppStep = workflow.steps[0]
    expect(ensureAppStep?.kind).toBe('ensure_app')
    expect(ensureAppStep?.params?.app).toBe('Cursor')

    const runCommandStep = workflow.steps.find(s => s.kind === 'run_command' && s.label === 'Re-run diagnostic command')
    expect(runCommandStep).toBeUndefined()
  })

  it('creates workflow with custom ideApp and diagnosticCommand', () => {
    const workflow = createDevInspectFailureWorkflow({
      ideApp: 'VSCode',
      diagnosticCommand: 'npm run build',
    })

    const ensureAppStep = workflow.steps[0]
    expect(ensureAppStep?.params?.app).toBe('VSCode')
    expect(workflow.name).toContain('VSCode')

    const runCommandStep = workflow.steps.find(s => s.kind === 'run_command' && s.label === 'Re-run diagnostic command')
    expect(runCommandStep).toBeDefined()
    expect(runCommandStep?.params?.command).toBe('npm run build')
  })
})
