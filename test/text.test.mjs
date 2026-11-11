/**
 * Text: language detection and the continuation instruction.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  continuationText, detectLanguage, errorText, languageFromSession, messageText, planLanguage, restartNote,
} from '../lib/text.js'

test('detectLanguage follows Han characters and falls back when empty', () => {
  assert.equal(detectLanguage(['你好，继续']), 'zh')
  assert.equal(detectLanguage(['please continue']), 'en')
  assert.equal(detectLanguage([]), 'zh')
  assert.equal(detectLanguage(['   ']), 'zh')
  assert.equal(detectLanguage(['']), 'zh')
  assert.equal(detectLanguage(['12345']), 'zh')
  assert.equal(detectLanguage([], 'en'), 'en')
})

test('planLanguage honors the profile override and otherwise detects', () => {
  assert.equal(planLanguage({ continuationLanguage: 'zh' }, ['hello']), 'zh')
  assert.equal(planLanguage({ continuationLanguage: 'en' }, ['你好']), 'en')
  assert.equal(planLanguage({ continuationLanguage: 'auto' }, ['你好']), 'zh')
  assert.equal(planLanguage({ continuationLanguage: 'auto' }, ['hello']), 'en')
})

test('messageText joins only text blocks', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(messageText(undefined), '')
})

test('languageFromSession reads the latest user message in the tail', () => {
  const session = {
    seq: 3,
    snapshotEvents: () => [
      { type: 'turn/start', data: {} },
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: '继续修这个问题' }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
    ],
  }
  assert.equal(languageFromSession(session), 'zh')
  assert.equal(languageFromSession({ seq: 0 }), 'zh')
  assert.equal(languageFromSession({ seq: 1, snapshotEvents: () => { throw new Error('gone') } }), 'zh')
  assert.equal(languageFromSession(session, 'en'), 'zh')
})

test('continuationText states the restart, forbids redoing work, and forbids a loop', () => {
  const plan = {
    planId: 'rst-1',
    createdAt: 1762660872000,
    reason: '加载插件新代码',
    origin: 'tool',
    tasks: [{ id: 'task-1', prompt: '跑一遍测试', target: 'new' }],
  }
  const text = continuationText({ plan, entry: { sessionId: 'session-a', continuationHint: '先从测试失败处继续' }, language: 'zh' })
  assert.match(text, /^\[harness-restart\] 宿主刚完成一次重启/u)
  assert.match(text, /原因：加载插件新代码/u)
  assert.match(text, /不要重做/u)
  assert.match(text, /额外提示：先从测试失败处继续/u)
  assert.match(text, /1 个重启后任务/u)
  assert.match(text, /不要再次调用 harness_restart/u)
})

test('continuationText speaks to an interrupted subagent and tells its parent', () => {
  const plan = {
    planId: 'rst-1',
    createdAt: 1762660872000,
    reason: '',
    tasks: [],
    resume: [
      { sessionId: 'session-root', kind: 'root' },
      { sessionId: 'session-child', kind: 'subagent', parentSession: 'session-root' },
    ],
  }
  const child = continuationText({ plan, entry: plan.resume[1], language: 'zh' })
  assert.match(child, /子智能体会话/u)
  assert.match(child, /send_message/u)
  assert.match(child, /session-root/u)
  assert.match(child, /不要再次调用 harness_restart/u)

  const root = continuationText({ plan, entry: plan.resume[0], language: 'zh' })
  assert.match(root, /1 个子智能体/u)
  assert.match(root, /session-child/u)
  assert.match(root, /不要重复派同样的活/u)

  const en = continuationText({ plan, entry: plan.resume[1], language: 'en' })
  assert.match(en, /^\[harness-restart\] The Host just restarted/u)
  assert.match(en, /subagent Session/u)
  assert.match(en, /send_message/u)
})

test('continuationText has an English form', () => {
  const text = continuationText({
    plan: { planId: 'rst-1', createdAt: Date.now(), reason: 'load new code', tasks: [] },
    entry: { sessionId: 'session-a' },
    language: 'en',
  })
  assert.match(text, /^\[harness-restart\] The Host just restarted/u)
  assert.match(text, /reason: load new code/u)
  assert.match(text, /Do not redo finished work/u)
  assert.match(text, /Do not call harness_restart again/u)
})

test('restartNote distinguishes a dry run from an armed restart', () => {
  assert.match(restartNote({ restartInMs: 1500, resumeCount: 2, taskCount: 1, language: 'zh' }), /约 2 秒后重启/u)
  assert.match(restartNote({ restartInMs: 1500, resumeCount: 2, taskCount: 1, language: 'zh' }), /恢复 2 个会话/u)
  assert.match(restartNote({ dryRun: true, resumeCount: 0, taskCount: 0, language: 'zh' }), /演练完成：没有重启/u)
  assert.match(restartNote({ restartInMs: 3000, resumeCount: 1, taskCount: 0, language: 'en' }), /Restarting in about 3s/u)
})

test('restartNote promises a continuation only to a Session that is resumed', () => {
  const zh = restartNote({ restartInMs: 1500, resumeCount: 1, taskCount: 0, language: 'zh', selfResumed: false })
  assert.match(zh, /不会自动续作/u)
  assert.match(zh, /恢复 1 个会话/u)
  assert.doesNotMatch(zh, /自动收到一条续作指令/u)
  const en = restartNote({ restartInMs: 1500, resumeCount: 1, taskCount: 0, language: 'en', selfResumed: false })
  assert.match(en, /not continue automatically/u)
})

test('restartNote counts the subagents inside the resumed sessions', () => {
  const note = restartNote({ restartInMs: 1500, resumeCount: 3, subagentCount: 2, taskCount: 1, language: 'zh' })
  assert.match(note, /恢复 3 个会话（含 2 个子智能体）/u)
  const en = restartNote({ restartInMs: 1500, resumeCount: 3, subagentCount: 2, taskCount: 1, language: 'en' })
  assert.match(en, /3 session\(s\) \(2 subagent\(s\)\)/u)
})

test('errorText explains a continuation whose own Session is not resumed', () => {
  assert.match(errorText('continuation-without-self', 'zh'), /只作用于发起重启的会话/u)
  assert.match(errorText('continuation-without-self', 'en'), /applies only to the Session/u)
})

test('errorText covers every stable code and degrades for unknown ones', () => {
  assert.match(errorText('desktop-only', 'zh'), /只有 Windows 桌面端/u)
  assert.match(errorText('plan-busy', 'en'), /already in flight/u)
  assert.match(errorText('internal', 'zh'), /内部出错/u)
  assert.match(errorText('mystery-code', 'en'), /mystery-code/u)
})
