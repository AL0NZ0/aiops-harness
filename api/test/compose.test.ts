import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAgentLimits } from '../src/compose.ts'

test('provider 模式没有 model 配置时，环境变量提供步骤上限和输出截断', () => {
  assert.deepEqual(resolveAgentLimits({}, { AIOPS_MODEL_MAX_STEPS: '15', AIOPS_MODEL_TOOL_OUTPUT_CHARS: '20000' }), {
    maxSteps: 15,
    toolOutputChars: 20000,
  })
})

test('模型配置里的值优先于环境变量', () => {
  assert.deepEqual(
    resolveAgentLimits(
      { maxSteps: 6, toolOutputChars: 8_000 },
      { AIOPS_MODEL_MAX_STEPS: '15', AIOPS_MODEL_TOOL_OUTPUT_CHARS: '20000' },
    ),
    { maxSteps: 6, toolOutputChars: 8_000 },
  )
})

test('环境变量缺失或非法时不下发，由 Platform 用默认值', () => {
  assert.deepEqual(resolveAgentLimits({}, {}), {})
  assert.deepEqual(resolveAgentLimits({}, { AIOPS_MODEL_MAX_STEPS: '0', AIOPS_MODEL_TOOL_OUTPUT_CHARS: 'abc' }), {})
  assert.deepEqual(resolveAgentLimits({}, { AIOPS_MODEL_MAX_STEPS: '  ' }), {})
})