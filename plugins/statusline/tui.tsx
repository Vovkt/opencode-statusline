/** @jsxImportSource @opentui/solid */
// Плагин статусбара для OpenCode V2:
// - Над полем ввода: связанные с сессией открытые PR (со статусом CI и ревью) и запущенные сборки TeamCity (через MCP).
// - В нижней строке: время работы ИИ (реальное и суммарное с сабагентами) и остаток бюджета LiteLLM.
// - Уведомления WezTerm (OSC 777), когда сессия закончила работу или ждёт ответа/разрешения.
import { Plugin } from "@opencode/plugin/tui"
import { execFile, execFileSync } from "node:child_process"
import { openSync, writeSync, closeSync } from "node:fs"
import { basename, resolve } from "node:path"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

const ESC = "\x1b"
const BEL = "\x07"

// Как в notify-wezterm.sh: внутри tmux последовательность заворачивается в DCS-passthrough
function osc(seq: string) {
  const data = process.env.TMUX ? `${ESC}Ptmux;${seq.replaceAll(ESC, ESC + ESC)}${ESC}\\` : seq
  try {
    const fd = openSync("/dev/tty", "w")
    writeSync(fd, data)
    closeSync(fd)
  } catch {}
}

function notify(title: string, body: string) {
  const clean = (s: string) => s.replace(/[;\x00-\x1f]/g, " ").trim()
  const text = clean(body)
  osc(`${ESC}]777;notify;${clean(title)};${text.length > 140 ? text.slice(0, 139) + "…" : text}${BEL}`)
}

type GitInfo = { branch: string; repoKey: string }
type PrChecksStatus = "success" | "pending" | "failure" | "none"
type PrReviewStatus = "approved" | "comments" | "pending" | "none"
type OpenPr = {
  number: number
  headRefName: string
  isDraft: boolean
  url: string
  checks: PrChecksStatus
  review: PrReviewStatus
}
type TcBuildInfo = {
  id: number
  label: string
  number?: string
  url: string
  state: "queued" | "running" | "finished"
  check: "success" | "pending" | "failure"
}
type Interval = [number, number]
type AiTime = { realSec: number; totalSec: number; busy: boolean }
type LiteLLMBudget = { left: number; max: number }

const TC_MCP_URL = "https://litellm.playrix.com/mcp/teamcity_readwrite"
const LITELLM_BUDGET_PROBE_URL = "https://litellm.playrix.com/v1/embeddings"

function formatUsdCompact(val: number): string {
  if (Number.isInteger(val) || val >= 100) return `$${Math.round(val)}`
  return `$${val.toFixed(1)}`
}

function shortTcBuildLabel(buildTypeId?: string, buildTypeName?: string, id?: number): string {
  if (typeof buildTypeId === "string" && buildTypeId.length > 0) {
    const parts = buildTypeId.split("_").filter(Boolean)
    if (parts.length >= 2 && /^(Prod|Stage|Dev|Test|Checks)$/i.test(parts[parts.length - 2])) {
      return `${parts[parts.length - 2]}_${parts[parts.length - 1]}`
    }
    return parts[parts.length - 1] ?? buildTypeId
  }
  if (typeof buildTypeName === "string" && buildTypeName.length > 0) return buildTypeName
  return id ? String(id) : "build"
}

function collectTriggeredTcBuildsFromMessages(messages: readonly any[]): Map<number, Partial<TcBuildInfo>> {
  const byLabel = new Map<string, { id: number; info: Partial<TcBuildInfo> }>()
  for (const msg of messages) {
    if (msg?.type !== "assistant" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part?.type !== "tool") continue
      const isShellTrigger =
        part.name === "shell" &&
        typeof part.state?.input?.command === "string" &&
        (/\bteamcity\s+trigger\b/i.test(part.state.input.command) ||
          /\/app\/rest\/buildQueue\b/i.test(part.state.input.command))
      const isMcpTrigger =
        (part.name === "execute" &&
          typeof part.state?.input?.code === "string" &&
          (/teamcity_rest_post/.test(part.state.input.code) || /\/app\/rest\/buildQueue/.test(part.state.input.code))) ||
        (typeof part.name === "string" && part.name.includes("teamcity_rest_post"))

      if (!isShellTrigger && !isMcpTrigger) continue
      const outputs = Array.isArray(part.state?.content) ? part.state.content : []
      for (const out of outputs) {
        const text = typeof out?.text === "string" ? out.text : ""
        if (!text) continue

        // Отрезаем snapshot-dependencies, чтобы не подхватывать дочерние сборки цепочки
        const rootSection = text.split('"snapshot-dependencies"')[0] ?? text
        const queueMatch =
          rootSection.match(/\/app\/rest\/buildQueue\/id:(\d+)/) ??
          rootSection.match(/https?:\/\/teamcity\.(?:local\.)?playrix\.com\/build\/(\d+)/)
        if (!queueMatch?.[1]) continue

        const id = Number(queueMatch[1])
        if (!Number.isInteger(id) || id <= 0) continue

        const beforeQueue = rootSection.slice(0, queueMatch.index ?? rootSection.length)
        const btMatches = [...beforeQueue.matchAll(/"buildTypeId"\s*:\s*"([^"]+)"/g)]
        const buildTypeId = btMatches[btMatches.length - 1]?.[1]
        const label = shortTcBuildLabel(buildTypeId, undefined, id)

        const prev = byLabel.get(label)
        if (!prev || id >= prev.id) {
          byLabel.set(label, {
            id,
            info: {
              id,
              label,
              url: `https://teamcity.playrix.com/build/${id}`,
            },
          })
        }
      }
    }
  }
  const triggered = new Map<number, Partial<TcBuildInfo>>()
  for (const { id, info } of byLabel.values()) {
    triggered.set(id, info)
  }
  return triggered
}

function isAiReviewCheck(item: any): boolean {
  const name = typeof item?.name === "string" ? item.name : ""
  const wf = typeof item?.workflowName === "string" ? item.workflowName : ""
  return wf === "AI Code Review" || name === "AI Code Review Gate" || name === "review / review" || name === "review"
}

function summarizePrStatus(
  rollup: unknown,
  reviewDecision: unknown,
  isDraft: boolean,
): { checks: PrChecksStatus; review: PrReviewStatus } {
  const items = Array.isArray(rollup) ? (rollup as any[]) : []

  let ciPending = false
  let ciSuccess = false
  let ciFailed = false

  let aiReviewPending = false
  let aiGateFailed = false
  let aiGatePassed = false

  for (const item of items) {
    if (!item || typeof item !== "object") continue
    if (isAiReviewCheck(item)) {
      if (item.status !== "COMPLETED") {
        aiReviewPending = true
      } else if (item.name === "AI Code Review Gate") {
        if (item.conclusion === "FAILURE" && !isDraft) aiGateFailed = true
        else if (item.conclusion === "SUCCESS") aiGatePassed = true
      }
      continue
    }

    if (item.__typename === "CheckRun") {
      if (item.status !== "COMPLETED") {
        ciPending = true
      } else if (
        item.conclusion === "FAILURE" ||
        item.conclusion === "TIMED_OUT" ||
        item.conclusion === "CANCELLED" ||
        item.conclusion === "ACTION_REQUIRED" ||
        item.conclusion === "STARTUP_FAILURE"
      ) {
        ciFailed = true
      } else if (item.conclusion === "SUCCESS" || item.conclusion === "NEUTRAL" || item.conclusion === "SKIPPED") {
        ciSuccess = true
      }
    } else if (item.__typename === "StatusContext") {
      if (item.state === "FAILURE" || item.state === "ERROR") {
        ciFailed = true
      } else if (item.state === "PENDING" || item.state === "EXPECTED") {
        ciPending = true
      } else if (item.state === "SUCCESS") {
        ciSuccess = true
      }
    }
  }

  const checks: PrChecksStatus = ciFailed ? "failure" : ciPending ? "pending" : ciSuccess ? "success" : "none"

  let review: PrReviewStatus = "none"
  if (reviewDecision === "CHANGES_REQUESTED" || aiGateFailed) {
    review = "comments"
  } else if (aiReviewPending) {
    review = "pending"
  } else if (reviewDecision === "APPROVED" || aiGatePassed) {
    review = "approved"
  }

  return { checks, review }
}

function openUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) return
  const cmd = process.platform === "darwin" ? "open" : "xdg-open"
  execFile(cmd, [url], { timeout: 5000 }, () => {})
}

const PR_TEXT_PATTERNS = [
  /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/gi,
  /\b(?:PR|ПР)\s*#?(\d+)\b/gi,
  /\bgh\s+pr\s+(?:view|checks|edit|diff|merge|ready|comment|close|reopen|checkout)\s+#?(\d+)\b/gi,
  /\/pulls\/(\d+)\b/gi,
]

function collectPrNumbersFromText(text: string | undefined, target: Set<number>) {
  if (!text) return
  for (const pattern of PR_TEXT_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const n = Number(match[1])
      if (Number.isInteger(n) && n > 0) target.add(n)
    }
  }
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const valid = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])
  const merged: Interval[] = []
  for (const [s, e] of valid) {
    const last = merged[merged.length - 1]
    if (!last || s > last[1]) merged.push([s, e])
    else if (e > last[1]) last[1] = e
  }
  return merged
}

function sumIntervals(intervals: Interval[]): number {
  let sum = 0
  for (const [s, e] of intervals) {
    if (e > s) sum += e - s
  }
  return sum
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${s}s`
}

function git(dir: string, args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { timeout: 1000, encoding: "utf8" })
}

function gitInfo(dir: string): GitInfo | undefined {
  try {
    const [commonDir, ref] = git(dir, ["rev-parse", "--git-common-dir", "--abbrev-ref", "HEAD"])
      .trim()
      .split("\n")
    const branch = ref === "HEAD" ? "detached" : ref
    const repoKey = resolve(dir, commonDir)
    return { branch, repoKey }
  } catch {
    return undefined
  }
}

export default Plugin.define({
  id: "local.statusline",
  setup(context) {
    const { data, theme } = context

    const dir = (sessionID?: string) =>
      (sessionID && data.session.get(sessionID)?.location.directory) || context.location?.directory || process.cwd()

    const [openPrsByRepo, setOpenPrsByRepo] = createSignal<Record<string, OpenPr[]>>({})
    const inflightRepos = new Set<string>()
    const [tcBuildsById, setTcBuildsById] = createSignal<Record<number, TcBuildInfo>>({})
    const inflightTcBuilds = new Set<number>()
    const [litellmBudget, setLiteLLMBudget] = createSignal<LiteLLMBudget>()
    let budgetInflight = false

    const refreshLiteLLMBudget = async () => {
      const apiKey = process.env.LITELLM_API_KEY
      if (!apiKey || budgetInflight) return
      budgetInflight = true
      try {
        const res = await fetch(LITELLM_BUDGET_PROBE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "__budget_check__", input: "" }),
          signal: AbortSignal.timeout(5000),
        })
        const maxRaw = res.headers.get("x-litellm-key-max-budget")
        const spendRaw = res.headers.get("x-litellm-key-spend")
        const max = maxRaw !== null ? Number(maxRaw) : NaN
        const spend = spendRaw !== null ? Number(spendRaw) : NaN
        if (Number.isFinite(max) && max > 0 && Number.isFinite(spend)) {
          setLiteLLMBudget({ left: Math.max(0, max - spend), max })
        }
      } catch {
      } finally {
        budgetInflight = false
      }
    }

    void refreshLiteLLMBudget()
    const budgetTimer = setInterval(() => void refreshLiteLLMBudget(), 60000)
    let mcpSessionId: string | null = null
    let mcpInitPromise: Promise<string | null> | null = null

    const ensureTcMcpSession = async (apiKey: string): Promise<string | null> => {
      if (mcpSessionId) return mcpSessionId
      if (mcpInitPromise) return mcpInitPromise
      mcpInitPromise = (async () => {
        try {
          const headers = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "x-litellm-api-key": `Bearer ${apiKey}`,
          }
          const initRes = await fetch(TC_MCP_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "opencode-statusline", version: "1.0" },
              },
            }),
            signal: AbortSignal.timeout(5000),
          })
          if (!initRes.ok) return null
          const sid = initRes.headers.get("mcp-session-id")
          await initRes.text()
          if (sid) {
            await fetch(TC_MCP_URL, {
              method: "POST",
              headers: { ...headers, "mcp-session-id": sid },
              body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {})
            mcpSessionId = sid
          }
          return sid
        } catch {
          return null
        } finally {
          mcpInitPromise = null
        }
      })()
      return mcpInitPromise
    }

    const fetchTcBuildViaMcp = async (buildId: number): Promise<void> => {
      const apiKey = process.env.LITELLM_API_KEY
      if (!apiKey || inflightTcBuilds.has(buildId)) return
      const existing = tcBuildsById()[buildId]
      if (existing?.state === "finished") return

      inflightTcBuilds.add(buildId)
      try {
        let sid = await ensureTcMcpSession(apiKey)
        const doCall = (sessionHeader: string | null) =>
          fetch(TC_MCP_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "x-litellm-api-key": `Bearer ${apiKey}`,
              ...(sessionHeader ? { "mcp-session-id": sessionHeader } : {}),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: buildId,
              method: "tools/call",
              params: {
                name: "teamcity_readwrite-teamcity_rest_get",
                arguments: {
                  path: `/app/rest/builds/id:${buildId}`,
                  query: "fields=id,number,status,state,webUrl,buildTypeId,buildType(id,name),canceledInfo(text)",
                },
              },
            }),
            signal: AbortSignal.timeout(5000),
          })

        let res = await doCall(sid)
        if (!res.ok && sid) {
          mcpSessionId = null
          sid = await ensureTcMcpSession(apiKey)
          res = await doCall(sid)
        }
        if (!res.ok) return

        const raw = await res.text()
        const dataLine = raw
          .split(/\r?\n/)
          .find((l) => l.startsWith("data: "))
          ?.slice(6)
        const rpc = JSON.parse(dataLine ?? raw)
        const textContent = rpc?.result?.content?.find((c: any) => c?.type === "text")?.text
        if (!textContent) return
        const envelope = JSON.parse(textContent)
        const b = envelope?.body
        if (!b || typeof b.id !== "number") return

        const state: TcBuildInfo["state"] =
          b.state === "finished" ? "finished" : b.state === "running" ? "running" : "queued"
        const failed = b.status === "FAILURE" || b.status === "ERROR" || Boolean(b.canceledInfo)
        const check: TcBuildInfo["check"] = failed ? "failure" : state === "finished" ? "success" : "pending"

        const info: TcBuildInfo = {
          id: b.id,
          label: shortTcBuildLabel(b.buildTypeId ?? b.buildType?.id, b.buildType?.name, b.id),
          number: typeof b.number === "string" && b.number ? b.number : undefined,
          url: typeof b.webUrl === "string" && b.webUrl ? b.webUrl : `https://teamcity.playrix.com/build/${b.id}`,
          state,
          check,
        }
        setTcBuildsById((prev) => ({ ...prev, [b.id]: info }))
      } catch {
      } finally {
        inflightTcBuilds.delete(buildId)
      }
    }

    const refreshOpenPrs = (cwd: string, repoKey: string) => {
      if (inflightRepos.has(repoKey)) return
      inflightRepos.add(repoKey)
      execFile(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          "--json",
          "number,headRefName,isDraft,url,reviewDecision,statusCheckRollup",
        ],
        { cwd, timeout: 5000, encoding: "utf8" },
        (err, stdout) => {
          inflightRepos.delete(repoKey)
          if (err || !stdout) return
          try {
            const parsed = JSON.parse(stdout)
            if (!Array.isArray(parsed)) return
            const list: OpenPr[] = parsed
              .filter(
                (item) =>
                  typeof item?.number === "number" &&
                  typeof item?.headRefName === "string" &&
                  typeof item?.url === "string",
              )
              .map((item) => {
                const isDraft = Boolean(item.isDraft)
                const { checks, review } = summarizePrStatus(item.statusCheckRollup, item.reviewDecision, isDraft)
                return {
                  number: item.number,
                  headRefName: item.headRefName,
                  isDraft,
                  url: item.url,
                  checks,
                  review,
                }
              })
            setOpenPrsByRepo((prev) => ({ ...prev, [repoKey]: list }))
          } catch {}
        },
      )
    }

    const computeSessionOpenPrs = (sessionID: string | undefined, gitState: GitInfo | undefined): OpenPr[] => {
      if (!sessionID || !gitState) return []
      const openPrs = openPrsByRepo()[gitState.repoKey]
      if (!openPrs || openPrs.length === 0) return []

      const rootID = data.session.root(sessionID)
      const familyRaw = data.session.family(rootID)
      const familyIDs = familyRaw.includes(rootID) ? familyRaw : [rootID, ...familyRaw]

      const mentioned = new Set<number>()
      for (const id of familyIDs) {
        collectPrNumbersFromText(data.session.get(id)?.title, mentioned)
        const messages = data.session.message.list(id)
        for (const msg of messages as any[]) {
          if (msg?.type === "user") {
            collectPrNumbersFromText(msg.text, mentioned)
          } else if (msg?.type === "assistant" && Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part?.type === "text") {
                collectPrNumbersFromText(part.text, mentioned)
              } else if (part?.type === "tool" && part.name === "subagent" && Array.isArray(part.state?.content)) {
                for (const out of part.state.content) {
                  if (out?.type === "text") collectPrNumbersFromText(out.text, mentioned)
                }
              } else if (part?.type === "tool" && part.name === "shell") {
                const cmd = typeof part.state?.input?.command === "string" ? part.state.input.command : ""
                collectPrNumbersFromText(cmd, mentioned)
                if (/\bgh\s+pr\s+create\b/i.test(cmd) && Array.isArray(part.state?.content)) {
                  for (const out of part.state.content) {
                    if (out?.type === "text") collectPrNumbersFromText(out.text, mentioned)
                  }
                }
              }
            }
          }
        }
      }

      const branch = gitState.branch
      const isFeatureBranch = branch !== "master" && branch !== "main" && !branch.startsWith("detached")

      return openPrs
        .filter((pr) => (isFeatureBranch && pr.headRefName === branch) || mentioned.has(pr.number))
        .sort((a, b) => a.number - b.number)
    }

    const computeAiTime = (sessionID: string | undefined, now: number): AiTime | undefined => {
      if (!sessionID) return undefined
      const rootID = data.session.root(sessionID)
      const familyRaw = data.session.family(rootID)
      const familyIDs = familyRaw.includes(rootID) ? familyRaw : [rootID, ...familyRaw]

      const rootRunning = data.session.status(rootID) === "running"
      const parentIntervals: Interval[] = []
      const subagentIntervals: Interval[] = []
      const foregroundSubSessions = new Set<string>()
      let activelyWorking = false

      const messages = data.session.message.list(rootID)
      for (const msg of messages as any[]) {
        if (msg?.type !== "assistant" || !msg.time?.created) continue
        const msgRunning = rootRunning && !msg.time.completed
        const tools = Array.isArray(msg.content) ? msg.content.filter((c: any) => c?.type === "tool") : []

        const streamEnd = msg.time.streamed ?? msg.time.completed ?? (msgRunning ? now : msg.time.created)
        if (streamEnd > msg.time.created) {
          parentIntervals.push([msg.time.created, streamEnd])
          if (msgRunning && !msg.time.streamed) activelyWorking = true
        }
        if (tools.length === 0 && msg.time.completed && msg.time.completed > streamEnd) {
          parentIntervals.push([streamEnd, msg.time.completed])
        }

        for (const t of tools) {
          if (t.name === "question") continue
          const isBgSubagent = t.name === "subagent" && t.state?.input?.background === true
          if (isBgSubagent) continue

          const subID = t.name === "subagent" ? t.state?.metadata?.sessionID : undefined
          if (typeof subID === "string") foregroundSubSessions.add(subID)

          const toolRunning = msgRunning && t.state?.status === "running"
          const start = t.time?.ran ?? (t.name === "subagent" ? undefined : t.time?.created)
          const end = t.time?.completed ?? (toolRunning ? now : undefined)
          if (!start || !end || end <= start) continue

          if (toolRunning) activelyWorking = true
          if (t.name === "subagent") {
            subagentIntervals.push([start, end])
          } else {
            parentIntervals.push([start, end])
          }
        }
      }

      // Фоновые сабагенты (или если открыта сама подсессия, а сообщения корня ещё не загружены)
      for (const id of familyIDs) {
        if (id === rootID || foregroundSubSessions.has(id)) continue
        const info = data.session.get(id)
        if (!info?.time?.created) continue
        const running = data.session.status(id) === "running"
        if (running) activelyWorking = true
        const end = running ? now : (info.time.idle ?? info.time.updated)
        if (end && end > info.time.created) {
          subagentIntervals.push([info.time.created, end])
        }
      }

      const mergedParent = mergeIntervals(parentIntervals)
      const realMs = sumIntervals(mergeIntervals([...mergedParent, ...subagentIntervals]))
      const totalMs = sumIntervals(mergedParent) + sumIntervals(subagentIntervals)
      const realSec = Math.floor(realMs / 1000)
      const totalSec = Math.floor(totalMs / 1000)

      if (realSec === 0 && !activelyWorking) return undefined
      return { realSec, totalSec: Math.max(realSec, totalSec), busy: activelyWorking }
    }

    const computeSessionTcBuilds = (sessionID: string | undefined): { visible: TcBuildInfo[]; toPoll: number[] } => {
      if (!sessionID) return { visible: [], toPoll: [] }
      const rootID = data.session.root(sessionID)
      const messages = data.session.message.list(rootID)
      const triggered = collectTriggeredTcBuildsFromMessages(messages as any[])
      if (triggered.size === 0) return { visible: [], toPoll: [] }

      const cache = tcBuildsById()
      const ids = [...triggered.keys()].sort((a, b) => a - b)
      const latestId = ids[ids.length - 1]!
      const toPoll = ids.filter((id) => cache[id]?.state !== "finished")

      const all: TcBuildInfo[] = ids.map((id) => {
        const cached = cache[id]
        if (cached) return cached
        const fallback = triggered.get(id)!
        return {
          id,
          label: fallback.label ?? String(id),
          url: fallback.url ?? `https://teamcity.playrix.com/build/${id}`,
          state: "queued",
          check: "pending",
        }
      })

      // Показываем только подтверждённо активные сборки (или самую последнюю, пока она ещё опрашивается);
      // если все завершились — оставляем только 1 самую свежую верхнеуровневую сборку.
      const active = all.filter((b) => {
        const cached = cache[b.id]
        if (cached) return cached.state !== "finished"
        return b.id === latestId
      })
      const visible = active.length > 0 ? active.slice(-2) : all.slice(-1)
      return { visible, toPoll }
    }

    const Line = (props: { sessionID?: string }) => {
      // git — внешний процесс, поэтому не в рендере: сразу при смене каталога и дальше раз в 3 секунды
      const [info, setInfo] = createSignal<GitInfo>()
      const tcState = createMemo(() => computeSessionTcBuilds(props.sessionID))
      const sessionTcBuilds = () => tcState().visible

      const refreshActiveTcBuilds = () => {
        for (const id of tcState().toPoll) {
          void fetchTcBuildViaMcp(id)
        }
      }

      createEffect(() => {
        const cwd = dir(props.sessionID)
        const next = gitInfo(cwd)
        setInfo(next)
        if (next) refreshOpenPrs(cwd, next.repoKey)
      })
      createEffect(() => {
        refreshActiveTcBuilds()
      })
      const gitTimer = setInterval(() => setInfo(gitInfo(dir(props.sessionID))), 3000)
      const prTimer = setInterval(() => {
        const current = info()
        if (current) refreshOpenPrs(dir(props.sessionID), current.repoKey)
        refreshActiveTcBuilds()
      }, 15000)
      onCleanup(() => {
        clearInterval(gitTimer)
        clearInterval(prTimer)
      })

      const sessionPrs = createMemo(() => computeSessionOpenPrs(props.sessionID, info()))

      return (
        <Show when={sessionPrs().length > 0 || sessionTcBuilds().length > 0}>
          <box flexDirection="row">
            <Show when={sessionPrs().length > 0}>
              <text fg={theme.text.feedback.info.base}>PR </text>
              <For each={sessionPrs()}>
                {(pr, idx) => (
                  <>
                    <Show when={idx() > 0}>
                      <text fg={theme.text.faint}>, </text>
                    </Show>
                    <text fg={theme.text.feedback.info.base} onMouseUp={() => openUrl(pr.url)}>
                      <a href={pr.url}>{`#${pr.number}${pr.isDraft ? " (draft)" : ""}`}</a>
                    </text>
                    <Show when={pr.checks === "success"}>
                      <text fg={theme.text.feedback.success.base}>{" ✓"}</text>
                    </Show>
                    <Show when={pr.checks === "pending"}>
                      <text fg={theme.text.feedback.warning.base}>{" ◌"}</text>
                    </Show>
                    <Show when={pr.checks === "failure"}>
                      <text fg={theme.text.feedback.error.base}>{" ✗"}</text>
                    </Show>
                    <Show when={pr.review === "approved"}>
                      <text fg={theme.text.feedback.success.base}>{" 👍"}</text>
                    </Show>
                    <Show when={pr.review === "pending"}>
                      <text fg={theme.text.feedback.warning.base}>{" 👀"}</text>
                    </Show>
                    <Show when={pr.review === "comments"}>
                      <text fg={theme.text.feedback.warning.base}>{" 💬"}</text>
                    </Show>
                  </>
                )}
              </For>
            </Show>
            <Show when={sessionPrs().length > 0 && sessionTcBuilds().length > 0}>
              <text fg={theme.text.faint}> │ </text>
            </Show>
            <Show when={sessionTcBuilds().length > 0}>
              <text fg={theme.text.feedback.info.base}>TC </text>
              <For each={sessionTcBuilds()}>
                {(b, idx) => (
                  <>
                    <Show when={idx() > 0}>
                      <text fg={theme.text.faint}>, </text>
                    </Show>
                    <text fg={theme.text.feedback.info.base} onMouseUp={() => openUrl(b.url)}>
                      <a href={b.url}>{b.number ? `${b.label}#${b.number}` : b.label}</a>
                    </text>
                    <Show when={b.check === "success"}>
                      <text fg={theme.text.feedback.success.base}>{" ✓"}</text>
                    </Show>
                    <Show when={b.check === "pending"}>
                      <text fg={theme.text.feedback.warning.base}>{" ◌"}</text>
                    </Show>
                    <Show when={b.check === "failure"}>
                      <text fg={theme.text.feedback.error.base}>{" ✗"}</text>
                    </Show>
                  </>
                )}
              </For>
            </Show>
          </box>
        </Show>
      )
    }

    const FooterTime = (props: { sessionID?: string }) => {
      const [now, setNow] = createSignal(Date.now())
      const clockTimer = setInterval(() => setNow(Date.now()), 1000)
      onCleanup(() => clearInterval(clockTimer))

      const aiTime = createMemo(() => computeAiTime(props.sessionID, now()))

      return (
        <Show when={aiTime()}>
          {(t) => (
            <box flexShrink={0}>
              <text wrapMode="none" fg={t().busy ? theme.text.feedback.info.base : theme.text.muted}>
                {t().totalSec > t().realSec
                  ? `⏱ ${formatDuration(t().realSec)} (∑ ${formatDuration(t().totalSec)})`
                  : `⏱ ${formatDuration(t().realSec)}`}
              </text>
            </box>
          )}
        </Show>
      )
    }

    const FooterBudget = () => {
      const budgetColor = (b: LiteLLMBudget) => {
        const ratio = b.max > 0 ? b.left / b.max : 1
        if (ratio <= 0.05) return theme.text.feedback.error.base
        if (ratio <= 0.2) return theme.text.feedback.warning.base
        return theme.text.muted
      }

      let boxRef: any
      const placeBeforeShortcuts = () => {
        queueMicrotask(() => {
          const parent = boxRef?.parent
          const children: any[] | undefined = parent?._childrenInLayoutOrder
          if (!parent || !Array.isArray(children)) return
          const myIdx = children.indexOf(boxRef)
          if (myIdx <= 0) return
          // Ищем первый элемент хоткеев ("... agents" или "... commands") левее нас и встаём перед ним, сразу после "$стоимость"
          for (let i = 0; i < myIdx; i++) {
            const c = children[i]
            const txt = typeof c?.plainText === "string" ? c.plainText : ""
            if (txt.endsWith("commands") || txt.endsWith("agents")) {
              parent.insertBefore?.(boxRef, c)
              break
            }
          }
        })
      }

      createEffect(() => {
        if (litellmBudget()) placeBeforeShortcuts()
      })

      return (
        <Show when={litellmBudget()}>
          {(b) => (
            <box
              ref={(el: any) => {
                boxRef = el
                placeBeforeShortcuts()
              }}
              flexShrink={0}
            >
              <text wrapMode="none" fg={budgetColor(b())}>
                {`${formatUsdCompact(b().left)}/${formatUsdCompact(b().max)}`}
              </text>
            </box>
          )}
        </Show>
      )
    }

    const unslot = context.ui.slot({
      append: "session.composer.top",
      render: (input) => <Line sessionID={input.sessionID} />,
    })

    const unslotFooterTime = context.ui.slot({
      append: "prompt.footer.file",
      render: (input) => <FooterTime sessionID={input.sessionID} />,
    })

    const unslotFooterBudget = context.ui.slot({
      append: "prompt.footer",
      render: () => <FooterBudget />,
    })

    const title = (sessionID: string) => {
      const s = data.session.get(sessionID)
      const project = basename(dir(sessionID))
      return s?.title ? `${project}: ${s.title}` : project
    }
    // Подсессии субагентов не уведомляют: о них скажет корневая
    const isRoot = (sessionID: string) => data.session.root(sessionID) === sessionID
    const sessionOf = (e: any): string | undefined => e?.data?.sessionID

    const offs = [
      data.on("session.execution.succeeded", (e) => {
        if (isRoot(e.data.sessionID)) {
          notify(title(e.data.sessionID), "Готово")
          const cwd = dir(e.data.sessionID)
          const g = gitInfo(cwd)
          if (g) refreshOpenPrs(cwd, g.repoKey)
          void refreshLiteLLMBudget()
        }
      }),
      data.on("session.execution.failed", (e) => {
        if (isRoot(e.data.sessionID)) notify(title(e.data.sessionID), "Ошибка")
      }),
      data.on("permission.asked", (e) => {
        const id = sessionOf(e)
        notify(id ? title(id) : "opencode", "Нужно разрешение")
      }),
      data.on("form.created", (e) => {
        const id = sessionOf(e)
        notify(id ? title(id) : "opencode", "Нужен ответ")
      }),
    ]

    return () => {
      clearInterval(budgetTimer)
      unslot()
      unslotFooterTime()
      unslotFooterBudget()
      offs.forEach((off) => off())
    }
  },
})
