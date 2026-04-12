import { describe, expect, it } from 'vitest'

import { createDevRunTestsWorkflow } from './dev-run-tests'

describe('dev-run-tests workflow', () => {
  it('creates workflow with default parameters', () => {
    const workflow = createDevRunTestsWorkflow()
    expect(workflow.id).toBe('dev_run_tests')
    expect(workflow.steps.length).toBe(5)

    const cdStep = workflow.steps.find(s => s.kind === 'change_directory')
    expect(cdStep?.params?.path).toBe('{projectPath}')

    const runStep = workflow.steps.find(s => s.kind === 'run_command')
    expect(runStep?.params?.command).toBe('pnpm test:run')
  })

  it('creates workflow with custom parameters', () => {
    const workflow = createDevRunTestsWorkflow({
      projectPath: '/test/path',
      testCommand: 'npm run jest',
    })

    const cdStep = workflow.steps.find(s => s.kind === 'change_directory')
    expect(cdStep?.params?.path).toBe('/test/path')

    const runStep = workflow.steps.find(s => s.kind === 'run_command')
    expect(runStep?.params?.command).toBe('npm run jest')
    expect(workflow.description).toContain('/test/path')
    expect(workflow.description).toContain('npm run jest')
  })
})
