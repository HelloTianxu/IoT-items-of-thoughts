// 改写引擎：只负责调用、失败分类、重试、记账；怎么改写全在 lib/strategies.mjs。
// 这次调用是手工构造的，不会被标成 agent-loop 请求，所以不会递归改写自己。

import {
  AUTO_EFFORT,
  isUnsupportedEffortFailure,
  knownEffortPlan,
  normalizeEffort,
  pickLowEffort,
  planKey,
  rememberEffortPlan,
} from "./effort.mjs";
import { DEFAULT_STRATEGY, limitsOf, strategyById } from "./strategies.mjs";
import { isOffloaded, normalizeRouteTarget, resolveRewriteRoute } from "./route.mjs";

/** 改写结果 + 账本载荷。是否真的替换由 stream.mjs 判定后写进 replaced。 */
function rewritten(text, payload) {
  return { text, event: payload };
}

/** 目录查询只是建议，不能卡住响应；测试会调小它。 */
export const EFFORT_PROBE = { timeoutMs: 3000 };

/** 超时即拒，且不留下挂住的 timer。 */
function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** cfg 是 resolveConfig 的结果（strategy / limits / route 已就位）。返回 null 表示保留原文。 */
export async function compressThinking({ Llm, ctx, text, options, cfg, index, extra, archive, mark }) {
  const started = Date.now();
  const strategy = strategyById(cfg.strategy) ?? strategyById(DEFAULT_STRATEGY);
  const limits = cfg.limits ?? limitsOf(strategy.id, cfg.strategies?.[strategy.id]);
  const recent = Array.isArray(extra?.recent) ? extra.recent : [];

  // 改写器路由：档位覆盖 > rewrite 块 > 跟随当前请求。必须在钩子内部解析，
  // 因为档位是按会话/preset 选出来的，路由得跟着档位走。
  const sessionRoute = normalizeRouteTarget({ provider: options.provider, model: options.model });
  const route = resolveRewriteRoute(cfg, strategy.id, sessionRoute);
  if (!route.provider || !route.model) {
    mark("thinking-skipped", { index, strategy: strategy.id, reason: "no-route", routeSource: route.source });
    return null;
  }

  let offloaded = isOffloaded(route);
  mark("rewrite-route", {
    index,
    strategy: strategy.id,
    provider: route.provider,
    model: route.model,
    source: route.source,
    offloaded,
  });

  // 卸载路由失败时是否回退到会话路由。只回退一次，且只在两条路由确实不同时回退 ——
  // 否则同一路由会被连打两次，把一次网络抖动变成两次计费。
  const canFallback =
    cfg.rewrite?.fallback === "session" &&
    sessionRoute !== null &&
    offloaded &&
    (sessionRoute.provider !== route.provider || sessionRoute.model !== route.model);

  /** 当前实际使用的路由；回退后会被替换。 */
  let active = route;

  const maxChars = Number.isFinite(limits.maxChars) ? Math.max(1, limits.maxChars) : 24000;
  if (text.length > maxChars) {
    mark("thinking-skipped", { index, strategy: strategy.id, reason: "above-max-chars", chars: text.length, maxChars });
    return null;
  }

  // 策略准备失败就保留原文并记账，不降级去跑别的档位。
  const prepared = strategy.prepare(limits);
  if (prepared?.error) {
    mark("thinking-skipped", { index, strategy: strategy.id, reason: "strategy-unusable", detail: prepared.error });
    return null;
  }
  const state = prepared?.state ?? null;

  const archived =
    cfg.archive === false
      ? null
      : archive({
          sessionId: options.sessionId,
          index,
          text,
          provider: route.provider,
          model: route.model,
          strategy: strategy.id,
          // 预设文件路径也进归档头，便于事后区分"改写坏了"还是"预设不对"。
          ...(state?.path ? { style: state.path } : {}),
        });

  const maxTokens = Number.isFinite(limits.maxTokens) ? Math.max(1, limits.maxTokens) : 2000;
  const temperature = Number.isFinite(limits.temperature) ? limits.temperature : 0.2;

  // auto：先试 off，被拒则按路由公开的档位降级。改写器自己的档位可以单独配
  // （rewrite.effort），不必跟着会话走。
  const mode = normalizeEffort(cfg.rewrite?.effort ?? cfg.reasoningEffort) ?? AUTO_EFFORT;
  /** 最后一次实际发出的档位；null = 没发这个字段。 */
  let effortSent = null;
  let effortFallback = false;
  let called = false;

  const run = async (instruction, temperatureForCall, effort, target) => {
    const assembler = new Llm.BlockAssembler();
    effortSent = effort;
    called = true;
    try {
      const stream = ctx.llm.stream({
        provider: target.provider,
        model: target.model,
        // 不发字段 = 交给适配器默认值；off 仍是快路径（不花预算在自己的思考上）。
        ...(effort === null ? {} : { reasoningEffort: effort }),
        temperature: temperatureForCall,
        messages: [
          Llm.createUserMessage({
            content: [{ type: "text", text: instruction }],
            source: { kind: "plugin", plugin: "iot-thinking" },
          }),
        ],
        maxTokens,
        sessionId: options.sessionId,
        // 辅助调用：合法的 purpose，且不是 agent-loop 请求，所以自己的钩子会忽略它。
        purpose: "compaction",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      for await (const chunk of stream) assembler.push(chunk);
    } catch (error) {
      return {
        error: String(error?.message ?? error),
        code: typeof error?.code === "string" ? error.code : undefined,
        finish: assembler.finish,
      };
    }
    const finish = assembler.finish;
    if (finish && finish.kind === "error") {
      return { error: finish.failure?.message ?? "unknown", code: finish.failure?.code, finish };
    }
    // 中断不是成功：当成"空输出"会把好块换成兜底内容。
    if (finish && finish.kind === "aborted") {
      return {
        error: finish.failure?.message ?? "rewriter call aborted",
        code: finish.failure?.code ?? "ABORTED",
        finish,
      };
    }
    const output = assembler
      .blocks()
      .filter((block) => block && block.type === "text" && typeof block.text === "string" && block.text.trim())
      .map((block) => block.text)
      .join("\n");
    return { output, finish };
  };

  /**
   * Ask the exact route which effort levels it advertises, so the rewriter can
   * keep thinking off (or nearly off) on routes that simply do not accept `off`.
   * Purely advisory: an unavailable or slow catalog never fails the block, and a
   * failed probe is reported as *unknown* rather than as "this route has no low
   * level" — caching the latter would cost a native DeepSeek route its `off` fast
   * path for the rest of the process after one catalog hiccup.
   *
   * @returns {Promise<{ answered: boolean, effort: string|null }>}
   */
  const probeLowEffort = async (target) => {
    const llm = (typeof ctx.get === "function" ? ctx.get("llm") : undefined) ?? ctx?.llm;
    if (typeof llm?.resolveModelInfo !== "function") return { answered: false, effort: null };
    try {
      const info = await withTimeout(llm.resolveModelInfo(target.provider, target.model, options.signal), EFFORT_PROBE.timeoutMs, "resolveModelInfo");
      return { answered: true, effort: pickLowEffort((info?.reasoning?.efforts ?? []).map((effort) => effort?.id)) };
    } catch (error) {
      mark("thinking-effort-probe-failed", {
        index,
        provider: target.provider,
        model: target.model,
        message: String(error?.message ?? error),
      });
      return { answered: false, effort: null };
    }
  };

  /**
   * One rewriter attempt, including the effort-level recovery. The recovery is
   * not a retry of a failed rewrite: the request never reached the provider,
   * so it costs one local round-trip, and an answered route decision is cached.
   *
   * `target` is the route this attempt goes to; the effort decision is cached
   * per route+mode, so an offloaded route never inherits the session route's
   * verdict.
   */
  const attempt = async (instruction, temperatureForCall, stage, target) => {
    const key = planKey(target.provider, target.model, mode);
    const known = knownEffortPlan(key);
    const send = known !== undefined ? known : mode === AUTO_EFFORT ? "off" : mode;
    let result = await run(instruction, temperatureForCall, send, target);
    if (!result.error || !isUnsupportedEffortFailure(result)) return result;

    // `null` means "send no effort at all". If even that is refused, the adapter's
    // own default level is missing from its advertised list: nothing this plugin
    // can send will work, so name that cause instead of retrying.
    if (send === null) {
      mark("thinking-effort-unsupported", {
        index,
        provider: target.provider,
        model: target.model,
        stage,
        requested: null,
        reason: "adapter-default-unsupported",
        message: result.error,
      });
      return result;
    }

    mark("thinking-effort-fallback", {
      index,
      provider: target.provider,
      model: target.model,
      stage,
      requested: send,
      reason: "unsupported",
      message: result.error,
    });
    // Only auto mode goes looking for a cheap supported level. An explicit
    // choice that the route refuses is a configuration signal, not a hint to
    // pick some other level: send nothing and let the provider decide.
    const probe = mode === AUTO_EFFORT && send === "off" ? await probeLowEffort(target) : { answered: true, effort: null };
    let chosen = probe.effort;
    result = await run(instruction, temperatureForCall, chosen, target);
    effortFallback = true;
    // An adapter can advertise a level the host then refuses anyway (stale or
    // optimistic catalog). Omitting the field is the remaining option, so try it
    // once instead of leaving the route pinned on a level that fails every block.
    if (probe.answered && chosen !== null && isUnsupportedEffortFailure(result)) {
      chosen = null;
      result = await run(instruction, temperatureForCall, chosen, target);
    }
    // "No field at all" refused is the adapter's own default being unadvertised —
    // nothing this plugin can send will work. Name it, and do not cache it: the
    // adapter can be fixed, and a cache entry would pin the route for the process.
    if (chosen === null && isUnsupportedEffortFailure(result)) {
      mark("thinking-effort-unsupported", {
        index,
        provider: target.provider,
        model: target.model,
        stage,
        requested: null,
        reason: "adapter-default-unsupported",
        message: result.error,
      });
      return result;
    }
    if (probe.answered) rememberEffortPlan(key, chosen);
    return result;
  };

  const payload = (fields) => ({
    index,
    provider: active.provider,
    model: active.model,
    routeSource: active.source,
    offloaded,
    strategy: strategy.id,
    // `effort: null` is meaningful only after a call went out (the field was
    // omitted); a draft skipped before the model has no effort.
    ...(called ? { effort: effortSent } : {}),
    ...(effortFallback ? { effortFallback: true } : {}),
    charsIn: text.length,
    ms: Date.now() - started,
    archived,
    ...fields,
  });

  const finishFields = (finish, fields) => ({
    finish: finish?.kind,
    truncated: finish?.kind === "max-tokens",
    ...fields,
  });

  /**
   * 一次「调用 + 判定」。返回 `{ done: true, value }` 表示已有结论（成功或不重试的失败），
   * `{ done: false, reason, detail }` 表示"不合格，可以按原因重试一次"。
   */
  const pass = async ({ strict, reason, detail, stage, temperatureForCall }) => {
    const instruction = strategy.buildPrompt(text, { strict, reason, detail, limits, state });
    if (!instruction) {
      mark("thinking-skipped", { index, strategy: strategy.id, reason: "no-prompt", stage });
      return { done: true, value: null };
    }
    let result = await attempt(instruction, temperatureForCall, stage, active);

    // 卸载路由失败（网络、鉴权、模型不存在、供应商 5xx）时，按配置回退到会话路由
    // 再试一次。只回退一次，且用户按 Esc 中断不重试 —— 中断是用户的决定，不是路由的错。
    if (result.error && canFallback && result.code !== "ABORTED") {
      const from = { provider: active.provider, model: active.model };
      active = { ...sessionRoute, source: "session" };
      offloaded = false;
      mark("rewrite-route-fallback", {
        index,
        strategy: strategy.id,
        stage,
        from,
        to: { provider: active.provider, model: active.model },
        reason: result.error,
        code: result.code,
      });
      result = await attempt(instruction, temperatureForCall, `${stage}:fallback`, active);
    }

    if (result.error) {
      // Esc/超时记 skipped，不算失败。
      if (result.code === "ABORTED") {
        mark("thinking-skipped", { index, strategy: strategy.id, reason: "aborted", stage, chars: text.length });
        return { done: true, value: null };
      }
      mark("thinking-failed", {
        index,
        provider: active.provider,
        model: active.model,
        strategy: strategy.id,
        ms: Date.now() - started,
        message: result.error,
        code: result.code,
        stage,
      });
      return { done: true, value: null };
    }

    const verdict = strategy.finalize(result.output, { original: text, limits, state, recent });
    if (verdict.ok) {
      // 防御：档位没回 text 时（自定义预设早期版本就这样）退回原始输出，不在这里抛。
      const out = typeof verdict.text === "string" ? verdict.text : String(result.output ?? "").trim();
      return {
        done: true,
        value: rewritten(out, payload(finishFields(result.finish, { charsOut: out.length, retried: strict, ...strategy.metrics?.(out) }))),
      };
    }
    return { done: false, reason: verdict.reason ?? "rejected", detail: verdict.detail ?? null, finish: result.finish };
  };

  // 这段草稿值不值得跑 —— 由策略说。items 说"已经在重复的草稿不值得一次模型调用"，
  // voice 说"空草稿不值得"，off 永远说"不值得"。
  const skip = strategy.skipInput(text);
  if (skip) {
    // `degenerate-input` 是既有账本词汇（设置卡与审计脚本都在认它），
    // 其余跳过原因走 thinking-skipped，别把两种性质混进同一个事件。
    const skipEvent = skip === "degenerate-input" ? "thinking-degenerate" : "thinking-skipped";
    const fallbackText = strategy.fallback?.(text) ?? null;
    if (fallbackText) {
      mark(skipEvent, {
        index,
        strategy: strategy.id,
        stage: "input",
        chars: text.length,
        charsOut: fallbackText.length,
        action: "fallback",
      });
      return rewritten(
        fallbackText,
        payload({
          charsOut: fallbackText.length,
          ...finishFields(null, { finish: skip, truncated: false, retried: false, fallback: true }),
        }),
      );
    }
    mark(skipEvent, { index, strategy: strategy.id, reason: skip, stage: "input", chars: text.length, action: "skip" });
    return null;
  }

  const first = await pass({ strict: false, reason: null, detail: null, stage: "first", temperatureForCall: temperature });
  if (first.done) return first.value;

  // 不合格：按策略给的原因重试一次（更低温、带针对性指令）。
  // 事件名由策略决定：items 沿用 thinking-degenerate（历史账本与审计脚本认它），
  // prose 用 thinking-rejected（被拒的原因不止退化）。
  const retryEvent = strategy.retryEvent ?? "thinking-rejected";
  mark(retryEvent, {
    index,
    strategy: strategy.id,
    reason: first.reason,
    detail: first.detail,
    stage: "output",
    action: "retry",
    charsIn: text.length,
  });
  const second = await pass({
    strict: true,
    reason: first.reason,
    detail: first.detail,
    stage: "retry",
    temperatureForCall: Math.max(0.05, temperature / 2),
  });
  if (second.done) {
    // 重试本身没拿到结果（报错/中止）：回原文。改写器没给出结果时拿兜底内容
    // 替换正文，等于把"没改好"降级成"内容被砍成两句"——那比不改糟。
    return second.value;
  }

  // 两次都不过：items 家族有确定性兜底（宁可给两条真节点，也不把循环写回会话）；
  // prose 家族没有兜底 —— 一段编造的内心比不转写糟得多。
  const fallbackText = strategy.fallback?.(text) ?? null;
  if (fallbackText) {
    mark("thinking-degenerate", {
      index,
      strategy: strategy.id,
      stage: "output",
      charsIn: text.length,
      charsOut: fallbackText.length,
      action: "fallback",
      reason: second.reason,
      detail: second.detail,
      retried: true,
    });
    return rewritten(
      fallbackText,
      payload({
        charsOut: fallbackText.length,
        ...finishFields(second.finish, { retried: true, fallback: true }),
      }),
    );
  }
  mark(retryEvent, {
    index,
    strategy: strategy.id,
    reason: second.reason,
    detail: second.detail,
    stage: "output",
    action: "skip",
    retried: true,
    charsIn: text.length,
  });
  mark("block-kept", { index, strategy: strategy.id, charsIn: text.length, reason: second.reason ?? "rejected" });
  return null;
}
