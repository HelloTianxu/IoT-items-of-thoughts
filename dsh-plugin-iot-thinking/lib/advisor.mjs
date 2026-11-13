// 指导层：压缩之后，让另一个（通常更强的）模型看一遍推理骨架，给出下一步建议。
//
// 为什么是"压缩之后再指导"：压缩把上下文从几万字降到几百字，指导模型只需读
// 这几百字 + 最近的动作结果。这比"把整段对话喂给强模型"便宜一个数量级，
// 同时保住了强模型对方向的判断力。
//
// 指导与压缩是两件事，不要合并成一个档位：
//   - 压缩是"减 token"，档位越高留得越多；
//   - 指导是"加信息"，它不改压缩结果，只在后面追加一段外部评审。
// 把两者塞进一个档位会让"想少留一点但又要指导"变得没法表达。

import { normalizeRouteTarget } from "./route.mjs";

/** 指导输出的标签：独立于压缩节点，不参与节点预算与优先级排序。 */
export const ADVISOR_LABEL = "[指导]";

/** 指导条数与长度的默认上限：宁少勿多，泛泛而谈的建议不如不给。 */
export const ADVISOR_LIMITS = Object.freeze({
  maxAdvice: 3,
  maxChars: 600,
  // 中文短建议很常见（"先补测试。"只有 5 个字），门槛太高会把它们全滤掉。
  minChars: 4,
});

/**
 * 解析指导路由：`advisor.route` 优先；没配就复用压缩器路由（同一台强模型）。
 * 与压缩路由一样，必须在钩子内部解析 —— 档位是按会话/preset 选出来的。
 */
export function resolveAdvisorRoute(cfg, strategyId, sessionRoute) {
  const advisor = cfg?.advisor;
  if (!advisor || advisor.enabled !== true) return null;
  const explicit = normalizeRouteTarget(advisor.route);
  const fallback = cfg?.rewrite ? normalizeRouteTarget(cfg.rewrite) : null;
  const target = explicit ?? fallback ?? sessionRoute ?? null;
  if (!target?.provider || !target?.model) return null;
  return {
    ...target,
    source: explicit ? "advisor" : cfg?.rewrite ? "rewrite" : "session",
    // 卸载 = 指导模型与当前会话模型不是同一条路由。
    offloaded: sessionRoute
      ? target.provider !== sessionRoute.provider || target.model !== sessionRoute.model
      : true,
    strategyId,
  };
}

/**
 * 指导提示词。
 *
 * 刻意把"只给可执行的下一步"写死：强模型最容易犯的错是复述已知信息、
 * 或者给一堆"可以考虑…"的空话。这些注入回去只会浪费上下文。
 */
export function buildAdvisorPrompt({ draft, nodes, goal, recent, limits }) {
  const maxAdvice = Math.min(ADVISOR_LIMITS.maxAdvice, Math.max(1, Number(limits?.maxAdvice) || ADVISOR_LIMITS.maxAdvice));
  const maxChars = Math.min(ADVISOR_LIMITS.maxChars, Math.max(80, Number(limits?.maxChars) || ADVISOR_LIMITS.maxChars));
  const recentLines = Array.isArray(recent) && recent.length
    ? recent.slice(-6).map((entry) => `- ${String(entry).slice(0, 200)}`).join("\n")
    : "（还没有工具结果）";
  return [
    "你是一位资深工程师，正在审阅另一个模型刚刚写下的推理骨架。",
    "你只能看到它的 thinking 草稿和最近的几个动作结果 —— 看不到完整对话。这是刻意的：只根据这些判断方向。",
    "",
    "任务目标：",
    String(goal ?? "（未提供）").slice(0, 400),
    "",
    // 模式二看**原始思考**（不是压缩后的骨架）：信息更全，代价是这一段更长。
    // 仍然只发 thinking，不发完整对话，所以比"整段上下文喂强模型"便宜得多。
    "它刚刚的原始思考草稿：",
    String(draft ?? nodes ?? "").slice(0, 12000),
    "",
    "最近的动作结果：",
    recentLines,
    "",
    `请只给出最多 ${maxAdvice} 条、合计不超过 ${maxChars} 字的建议，每条一行，以 ${ADVISOR_LABEL} 开头。`,
    "要求：",
    "1. 每条必须是可执行的下一步、需要补的检查、或已经走偏的方向；不要复述它已经写下的内容。",
    "2. 没有值得说的就少说，甚至只说一条；不要凑数。",
    "3. 不要输出解释、开场白、总结，只输出建议行。",
  ].join("\n");
}

/** 把模型输出整理成指导节点：只保留带标签或能归入标签的行，去重，限条数。 */
export function formatAdvice(raw, limits = {}) {
  const maxAdvice = Math.min(ADVISOR_LIMITS.maxAdvice, Math.max(1, Number(limits?.maxAdvice) || ADVISOR_LIMITS.maxAdvice));
  const maxChars = Math.min(ADVISOR_LIMITS.maxChars, Math.max(80, Number(limits?.maxChars) || ADVISOR_LIMITS.maxChars));
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // 模型有时会把标签写成 `指导：` 或 `【指导】`，统一成方括号。
    .map((line) => line.replace(/^[\[【]?(?:指导|建议|advisor)[\]】]?\s*[:：]?\s*/iu, `${ADVISOR_LABEL} `))
    .filter((line) => line.startsWith(ADVISOR_LABEL) && line.slice(ADVISOR_LABEL.length).trim().length >= ADVISOR_LIMITS.minChars);

  const seen = new Set();
  const out = [];
  let used = 0;
  for (const line of lines) {
    const body = line.slice(ADVISOR_LABEL.length).trim();
    if (seen.has(body)) continue;
    seen.add(body);
    if (out.length >= maxAdvice) break;
    if (used + line.length > maxChars && out.length > 0) break;
    out.push(line);
    used += line.length + 2;
  }
  return out.join("\n\n");
}

/**
 * 一次指导调用。失败一律返回 null —— 指导是**增强**，不是必需；
 * 它挂了不该影响这一块的压缩结果，也不该阻塞主流程。
 */
export async function advise({ ctx, Llm, route, prompt, options, timeoutMs, onEvent }) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const signal = controller?.signal ?? options?.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller?.abort?.();
  }, timeoutMs);
  timer.unref?.();

  const assembler = new Llm.BlockAssembler();
  try {
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [Llm.createUserMessage(prompt)],
      maxTokens: 800,
      temperature: 0.3,
      purpose: "compaction",
      ...(signal === undefined ? {} : { signal }),
    });
    for await (const chunk of stream) assembler.push(chunk);
  } catch (error) {
    clearTimeout(timer);
    onEvent?.("advisor-failed", {
      provider: route.provider,
      model: route.model,
      message: timedOut ? `指导调用超时（${timeoutMs} ms）` : String(error?.message ?? error),
      code: timedOut ? "ADVISOR_TIMEOUT" : error?.code,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    onEvent?.("advisor-failed", { provider: route.provider, model: route.model, message: `指导调用超时（${timeoutMs} ms）`, code: "ADVISOR_TIMEOUT" });
    return null;
  }
  const finish = assembler.finish;
  if (finish && finish.kind === "error") {
    onEvent?.("advisor-failed", { provider: route.provider, model: route.model, message: finish.failure?.message ?? "unknown", code: finish.failure?.code });
    return null;
  }
  const raw = assembler
    .blocks()
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return raw.trim() ? raw : null;
}

/**
 * 把指导追加到压缩结果后面。
 *
 * 追加而不是替换：压缩结果是模型"自己的想法"，指导是外部评审。
 * 用独立标签隔开，主模型能分清哪部分是自己推出来的、哪部分是别人给的。
 * 指导**不参与**节点预算与截断 —— 否则它会挤掉 [决定] 这类关键节点。
 */
export function appendAdvice(nodes, advice) {
  const text = String(nodes ?? "").trim();
  const extra = String(advice ?? "").trim();
  if (!extra) return text;
  return text ? `${text}\n\n${extra}` : extra;
}
