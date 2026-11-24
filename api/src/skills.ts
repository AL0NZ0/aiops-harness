import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { PlatformError } from './errors.ts'

export interface PlaybookStep {
  tool: string
  args: Record<string, unknown>
  when?: { promptIncludes?: string[] }
}

export interface Skill {
  name: string
  description: string
  body: string
  priority: number
  keywords: string[]
  steps: PlaybookStep[]
}

export async function loadSkills(dir: string): Promise<Skill[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const skills: Skill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillPath = path.join(dir, entry.name, 'SKILL.md')
    const playbookPath = path.join(dir, entry.name, 'playbook.json')
    const parsed = parseSkillMarkdown(await readFile(skillPath, 'utf8'), skillPath)
    if (parsed.name !== entry.name) {
      throw new Error(`技能目录 ${entry.name} 与 frontmatter name ${parsed.name} 不一致`)
    }
    const playbook = parsePlaybook(await readFile(playbookPath, 'utf8'), playbookPath)
    skills.push({ ...parsed, ...playbook })
  }
  if (skills.length === 0) throw new Error(`没有找到技能: ${dir}`)
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

export function selectSkill(skills: Skill[], prompt: string, requested?: string): Skill {
  if (requested) {
    const found = skills.find((skill) => skill.name === requested)
    if (!found) throw new PlatformError(`未知技能 ${requested}`, 400, 'unknown_skill')
    return found
  }
  const ranked = skills
    .map((skill) => ({
      skill,
      score: skill.keywords.filter((keyword) => prompt.toLowerCase().includes(keyword.toLowerCase())).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.priority - b.skill.priority)
  if (ranked[0]) return ranked[0].skill
  return skills.find((skill) => skill.name === 'k8s-troubleshooting') ?? skills[0]!
}

export function stepMatches(step: PlaybookStep, prompt: string): boolean {
  const needles = step.when?.promptIncludes ?? []
  if (needles.length === 0) return true
  const lower = prompt.toLowerCase()
  return needles.some((needle) => prompt.includes(needle) || lower.includes(needle.toLowerCase()))
}

export function renderArgs(args: Record<string, unknown>, prompt: string): Record<string, unknown> {
  const rendered = renderValue(args, prompt)
  if (!rendered || typeof rendered !== 'object' || Array.isArray(rendered)) return {}
  const record = rendered as Record<string, unknown>
  const namespace = prompt.match(/namespace[=:\s]+([a-z0-9-]+)/i)?.[1]
  if (namespace && typeof record.namespace === 'string') record.namespace = namespace
  return record
}

function parseSkillMarkdown(raw: string, file: string): Pick<Skill, 'name' | 'description' | 'body'> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error(`${file} 缺少 frontmatter`)
  const frontmatter = match[1] ?? ''
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ''
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`${file} 的 name 必须是 kebab-case`)
  if (!description) throw new Error(`${file} 缺少 description`)
  return { name, description, body: (match[2] ?? '').trim() }
}

function parsePlaybook(raw: string, file: string): Pick<Skill, 'priority' | 'keywords' | 'steps'> {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} 不是对象`)
  const record = parsed as Record<string, unknown>
  const priority = typeof record.priority === 'number' ? record.priority : 100
  const keywords = stringList(record.keywords)
  if (!Array.isArray(record.steps)) throw new Error(`${file} 缺少 steps`)
  const steps = record.steps.map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${file} 的步骤不合法`)
    const item = step as Record<string, unknown>
    if (typeof item.tool !== 'string' || !item.tool) throw new Error(`${file} 的步骤缺少 tool`)
    const args = item.args
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${file} 的 ${item.tool} 缺少 args`)
    const whenRecord = item.when && typeof item.when === 'object' && !Array.isArray(item.when) ? (item.when as Record<string, unknown>) : undefined
    const when = whenRecord ? { promptIncludes: stringList(whenRecord.promptIncludes) } : undefined
    return { tool: item.tool, args: args as Record<string, unknown>, when }
  })
  return { priority, keywords, steps }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function renderValue(value: unknown, prompt: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{{prompt}}', prompt)
  if (Array.isArray(value)) return value.map((item) => renderValue(item, prompt))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = renderValue(item, prompt)
    return out
  }
  return value
}
