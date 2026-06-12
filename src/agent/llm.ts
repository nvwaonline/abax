/**
 * Minimal OpenAI-compatible chat client (LM Studio / any local endpoint).
 * Extracted from the validated fixture: retries, reasoning-channel
 * fallback (thinking models leave content empty), and a hard timeout so a
 * wedged backend fails loudly instead of freezing the REPL.
 *
 * Requests are STREAMING by default (SSE). Non-streaming requests sit
 * silently until the backend finishes the whole generation before sending
 * response headers - and Node's fetch (undici) kills headerless requests
 * at ~300s (headersTimeout), surfacing as `TypeError: fetch failed` long
 * before our own AbortSignal fires. Long local generations (minutes) are
 * normal here, so streaming is the only reliable transport: headers come
 * immediately, chunks keep the socket alive, and the overall wall-clock
 * budget stays enforced by AbortSignal.timeout. Found via the 2026-06-12
 * bench run where every hard baseline call died at ~305s x 3 retries.
 * Escape hatch: GALAXY_LLM_STREAM=0 or config { stream: false }.
 */

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export interface LlmConfig {
  baseUrl?: string
  model?: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  stream?: boolean
  /** Hard cap on accumulated streamed chars - runaway-generation fuse. */
  maxStreamChars?: number
  fetchImpl?: typeof fetch
}

export class LlmClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly maxTokens: number
  private readonly temperature: number
  private readonly timeoutMs: number
  private readonly stream: boolean
  private readonly maxStreamChars: number
  private readonly fetchImpl: typeof fetch

  constructor(config: LlmConfig = {}) {
    this.baseUrl = config.baseUrl ?? process.env.GALAXY_LLM_BASE_URL ?? 'http://127.0.0.1:1234'
    this.model = config.model ?? process.env.GALAXY_LLM_MODEL ?? 'local-model'
    this.maxTokens = config.maxTokens ?? Number(process.env.GALAXY_MAX_TOKENS ?? 8000)
    this.temperature = config.temperature ?? 0.2
    this.timeoutMs = config.timeoutMs ?? Number(process.env.GALAXY_LLM_TIMEOUT_MS ?? 180000)
    this.stream = config.stream ?? process.env.GALAXY_LLM_STREAM !== '0'
    this.maxStreamChars =
      config.maxStreamChars ?? Number(process.env.GALAXY_LLM_MAX_STREAM_CHARS ?? 8_000_000)
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.chatOnce(messages)
      } catch (error) {
        // Budget verdicts (our own timeout, the stream-volume fuse) are
        // final: a repetition loop retried is the same loop, three times
        // the wall clock. Only transient transport faults get retries.
        if (LlmClient.isBudgetVerdict(error)) throw error
        lastError = error
        // Narrate, or a dead backend looks exactly like a thinking model
        // from the outside (2026-06-12 wedged-server episode).
        console.error(
          `[llm] attempt ${attempt + 1}/3 failed (${String(error).slice(0, 100)}) - retrying`,
        )
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      }
    }
    throw lastError
  }

  private static isBudgetVerdict(error: unknown): boolean {
    if (error instanceof Error && /stream cap exceeded/i.test(error.message)) return true
    const name = (error as { name?: string } | null)?.name
    return name === 'TimeoutError' || name === 'AbortError'
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
        ...(this.stream ? { stream: true } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${await response.text()}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    // Servers that ignore `stream` answer with a plain JSON body.
    if (!this.stream || contentType.includes('application/json') || response.body === null) {
      const data = (await response.json()) as {
        choices: Array<{ message: { content?: string; reasoning_content?: string; reasoning?: string } }>
      }
      const message = data.choices[0]?.message
      const content = message?.content?.trim()
      return content && content.length > 0
        ? content
        : (message?.reasoning_content ?? message?.reasoning ?? '')
    }
    return this.readSse(response.body)
  }

  /**
   * Aggregate an OpenAI-style SSE stream into the final message text.
   *
   * Two hard-won rules (2026-06-12 bench OOM, 4GB heap of LIVE ropes):
   * - `delta` chunks are increments and get appended; `message` chunks
   *   are the message-so-far and REPLACE when they grew (appending
   *   cumulative snapshots retains O(n^2) chars). A shrinking `message`
   *   chunk is treated as an increment (some bridges stream per-token
   *   message objects).
   * - A total-volume fuse: past maxStreamChars the call FAILS loudly
   *   (DNF for a bench arm) instead of growing until the process dies.
   */
  private async readSse(body: ReadableStream<Uint8Array>): Promise<string> {
    let content = ''
    let reasoning = ''
    let buffer = ''
    let received = 0
    const decoder = new TextDecoder()
    const merge = (current: string, next: string): string =>
      next.length >= current.length ? next : current + next
    const consume = (rawLine: string): void => {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') return
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: string; reasoning_content?: string; reasoning?: string }
            message?: { content?: string; reasoning_content?: string; reasoning?: string }
          }>
        }
        const delta = chunk.choices?.[0]?.delta
        const message = chunk.choices?.[0]?.message
        if (delta?.content) content += delta.content
        else if (message?.content) content = merge(content, message.content)
        const dr = delta?.reasoning_content ?? delta?.reasoning
        const mr = message?.reasoning_content ?? message?.reasoning
        if (dr) reasoning += dr
        else if (mr) reasoning = merge(reasoning, mr)
      } catch {
        // keepalive / partial junk - ignore
      }
    }
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        if (received > this.maxStreamChars) {
          throw new Error(
            `LLM stream cap exceeded (${this.maxStreamChars} chars): runaway generation ` +
              `(repetition loop?). Raise GALAXY_LLM_MAX_STREAM_CHARS only if the output ` +
              `is legitimately this large.`,
          )
        }
        buffer += decoder.decode(value, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          consume(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    buffer += decoder.decode()
    if (buffer.length > 0) consume(buffer)
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : reasoning
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
