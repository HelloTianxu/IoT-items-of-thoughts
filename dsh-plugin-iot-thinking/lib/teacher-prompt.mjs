// 教师能力的**上下文注入**：把"这是什么、能干什么、现在能不能用"写进系统提示，
// 而不是在 thinking 末尾塞一行 `[教师] 可用（深度 undefined-undefined…）`。
//
// 为什么换位置：thinking 里那行是给模型看的，但模型看到它时已经写完了这一块 ——
// 它更像"事后通知"，而且没有解释这个标签是什么东西。系统提示是每轮开头就在的，
// 那里才适合写"你有这么一个外援"。
//
// 长度纪律：这段会进每一轮的 system prompt，必须短。默认上限 160 字，
// 只写三件事 —— 身份、触发条件、当前状态。

import { normalizeTeacherLimits, teacherStatus } from "./teacher.mjs";

/** 注入段的名字：固定，便于在 system prompt 里定位与覆盖。 */
export const TEACHER_CONTEXT_NAME = "iot-thinking.teacher";

/** 注入段的排序：放在工具说明附近，不要抢人格段的位置。 */
export const TEACHER_CONTEXT_ORDER = 620;

/** 状态说明的字数上限：超过就说明写多了。 */
export const TEACHER_CONTEXT_MAX_CHARS = 160;

/**
 * 生成注入文本。`limits` 与状态行共用同一份归一化 —— 两处各写一遍必然分叉。
 *
 * 返回空串表示"这次不注入"（未启用 / 总闸关掉）。调用方据此决定是否挂 context。
 */
export function teacherContextText({ enabled, sessionId, limits }) {
  if (!enabled) return "";
  const normalized = normalizeTeacherLimits(limits ?? {});
  const status = teacherStatus(sessionId, normalized);
  const state = status.available
    ? `现在可用（可要 ${normalized.minDepth}-${normalized.maxDepth} 轮上下文）。`
    : `冷却中，还要 ${status.remainingBlocks} 个思考块才能再用。`;
  return [
    "【外援技能】iot_consult_teacher：请一个更强的模型就当前任务给一次限时咨询。",
    "插件按你要的轮次抽取会话正文给它，你只需说清需求与进展。",
    "适合：方案定型前、执行不可逆动作前、宣布完成前、或你确实卡住时。",
    state,
  ].join("");
}

/**
 * 截断到字数上限：宁可少说，也不要让这段挤占主提示词。
 * 按句号切，不切半个句子 —— 半句话比没有更糟。
 */
export function clampContext(text, maxChars = TEACHER_CONTEXT_MAX_CHARS) {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  if (raw.length <= maxChars) return raw;
  const cut = raw.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"));
  return lastStop > maxChars * 0.6 ? cut.slice(0, lastStop + 1) : cut;
}
