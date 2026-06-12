/**
 * Minimal OpenAI-compatible chat client (LM Studio / any local endpoint).
 * Extracted from the validated fixture: retries, reasoning-channel
 * fallback (thinking models leave content empty), and a hard timeout so a
 * wedged backend fails loudly instead of freezing the REPL.
 */

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export interface LlmConfig {
  baseUrl?: string
  model?: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class LlmClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly maxTokens: number
  private readonly temperature: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(config: LlmConfig = {}) {
    this.baseUrl = config.baseUrl ?? process.env.GALAXY_LLM_BASE_URL ?? 'http://127.0.0.1:1234'
    this.model = config.model ?? process.env.GALAXY_LLM_MODEL ?? 'local-model'
    this.maxTokens = config.maxTokens ?? Number(process.env.GALAXY_MAX_TOKENS ?? 8000)
    this.temperature = config.temperature ?? 0.2
    this.timeoutMs = config.timeoutMs ?? Number(process.env.GALAXY_LLM_TIMEOUT_MS ?? 180000)
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.chatOnce(messages)
      } catch (error) {
        lastError = error
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      }
    }
    throw lastError
  }

  private async chatOnce(messages: ChatMessage[]): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${await response.text()}`)
    }
    const data = (await response.json()) as {
      choices: Array<{ message: { content?: string; reasoning_content?: string; reasoning?: string } }>
    }
    const message = data.choices[0]?.message
    const content = message?.content?.trim()
    return content && content.length > 0
      ? content
      : (message?.reasoning_content ?? message?.reasoning ?? '')
  }
}

/**
 * Extract the first balanced JSON object carrying a "tool" key, string-aware
 * so braces inside string values (regex patterns, code quotes) don't break
 * the scan. Lifted from the fixture (verification #11 fix).
 */
export function parseToolCall(
  reply: string,
): { tool: string; args?: Record<string, unknown>; note?: string } | undefined {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '')
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth += 1
      if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1)) as { tool?: unknown }
            if (typeof parsed.tool === 'string') {
              return parsed as { tool: string; args?: Record<string, unknown>; note?: string }
            }
          } catch {
            // keep scanning
          }
          break
        }
      }
    }
  }
  return undefined
}
