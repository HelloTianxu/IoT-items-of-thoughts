// lib/config-store.mjs — live config for the IoT thinking rewriter.
//
// Two layers:
//   1. row config from cordis.patch.yml (deployment defaults)
//   2. $DSH_HOME/plugin-data/iot-thinking/config.json (user switch + limits)
//
// The stream hook reads this on every request (mtime cache), so the Settings
// toggle and any per-session switch take effect immediately — no dsh restart,
// no profile reload.
//
// 配置形状（v0.2 起）：
//   strategy     全局默认策略 id（"iot-full" 保持旧行为）
//   strategies   { "<档位 id>": { minChars, maxNodes, … } } 逐策略覆盖
//   agentPresets { "<agent preset id>": "<策略 id>" }  按 preset 映射
//   sessions     { "<sessionId>": "<策略 id>" }        会话级覆盖（会话内切换写这里）
//
// 旧文件里只有 `profile` + 几个平铺数值字段。load() 会**一次性迁移**成上面的形状
// （见 lib/route.mjs 的 migrateLegacyConfig），迁移语义是"行为不变"。

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { migrateLegacyConfig, migrateRewriteConfig, normalizeRouteEntry } from "./route.mjs";
import { normalizeEffort } from "./effort.mjs";
import { DEFAULT_STRATEGY, strategyById } from "./strategies.mjs";
import { builtinPresetById } from "./builtin-presets.mjs";

export const DEFAULTS = Object.freeze({
  enabled: true,
  // 默认保持旧 IoT 行为：8 标签全量。
  strategy: DEFAULT_STRATEGY,
  /** 逐策略限制覆盖；键是策略 id。 */
  strategies: {},
  /** agent preset id → 策略 id。 */
  agentPresets: {},
  /** sessionId → 策略 id。会话内切换只写这一层。 */
  sessions: {},
  /**
   * 改写器路由（算力卸载）：显式给出 provider/model 时，压缩调用走这条路，
   * 与主会话路由无关；null 表示跟随当前请求。
   * `effort` 是改写器自己那一次调用的推理档位；`fallback` 决定卸载路由失败时
   * 是保留原文（keep）还是回退到会话路由再试一次（session）。
   */
  rewrite: { provider: null, model: null, effort: "auto", fallback: "keep" },
  /**
   * 全局默认的"自定义预设"：`builtin:<id>` / `custom:<文件名>` / `custom`（贴入的文本）。
   * 只在 custom 档位且没有会话/映射覆盖时使用；null = 沿用旧行为（贴入文本）。
   */
  defaultPreset: null,
  /** 用户改过的内置预设正文：`{ "<id>": "文本" }`；没改的键不出现。 */
  builtinOverrides: {},
  /** 单块改写调用的硬超时（毫秒）与总调用预算；不填用 lib/compress.mjs 的默认值。 */
  rewriteTimeoutMs: undefined,
  /** custom 档位的输出预算（字符数）与"输出里不许出现 think 标签"开关。 */
  maxOut: undefined,
  noThink: true,
  rewriteBudget: undefined,
  // 旧形状，只读兼容：load() 会把它们搬进 rewrite 并删键。
  provider: undefined,
  model: undefined,
  reasoningEffort: undefined,
  archive: true,
  // 会话级档位下拉（对话头部）：默认关。多数人用不到 per-session 覆盖，
  // 那行控件反而让人以为"档位要被它管"；/iot 命令始终可用。
  sessionSwitch: false,
  // 自定义预设：目录必须显式配置（空 = 没有目录，文件类预设不可用）。
  presetDir: "",
  customText: "",
  presetAccept: "different",
  // 旧字段，只读兼容：迁移后不再写回，但保留在主键集合里，避免旧文件被"清空"。
  // 只对 items 家族兜底，别让旧档位的数字盖掉当前档位自己的默认值。
  profile: undefined,
  minChars: undefined,
  maxChars: undefined,
  maxTokens: undefined,
  maxNodes: undefined,
  maxNeutral: undefined,
});

export function defaultConfigPath() {
  if (process.env.IOT_THINKING_CONFIG_PATH) return process.env.IOT_THINKING_CONFIG_PATH;
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "plugin-data", "iot-thinking", "config.json");
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    let text = readFileSync(path, "utf8");
    // Windows PowerShell's `Set-Content -Encoding utf8` writes a BOM. JSON.parse
    // rejects it, which used to fall back to DEFAULTS and silently overwrite the
    // user's profile with `full`. Strip the BOM before parsing.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 一个手写的 `sessions` 表里混进一个不存在的策略名，正解是**丢掉那一项**，
 * 而不是整张表作废 —— 后者会让用户下次打开设置卡时看到"配置没了"。
 *
 * 值可以是字符串（`"iot-full"`）或 `custom[:预设名]` 形态：后者指向 presetDir 里的
 * 一份文本（或贴进来的那段）。
 */
function strategyMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== "string" || !key) continue;
    const normalized = normalizeRouteEntry(entry);
    if (!normalized) continue;
    // 自定义预设：`custom:名字` 要保住名字（那是 presetDir 里的文件名）；
    // 会话级 prompt 是对象形态 `{ strategy: "custom", preset }`，也原样保留 ——
    // 否则"选了 prompt"会在下一次 load 时被归一成字符串丢掉。
    if (normalized.id === "custom") {
      if (normalized.builtin) {
        out[key] = { strategy: "custom", preset: `builtin:${normalized.builtin}` };
        continue;
      }
      out[key] = normalized.custom ? `custom:${normalized.custom}` : "custom";
      continue;
    }
    out[key] = normalized.id;
  }
  return out;
}

/** 内置预设覆盖：键必须是存在的内置 id，值是字符串；空串等于恢复默认（删键）。 */
function builtinOverridesMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [id, text] of Object.entries(value)) {
    if (!builtinPresetById(id)) continue;
    if (typeof text !== "string" || !text.trim()) continue;
    out[id] = text;
  }
  return out;
}

/** 逐策略覆盖：只收对象值，非法策略 id 丢弃。 */
function strategiesMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [id, overrides] of Object.entries(value)) {
    if (!strategyById(id)) continue;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) continue;
    out[id] = { ...overrides };
  }
  return out;
}

/**
 * 改写器路由块的归一化：只认已知键，provider/model 只收非空字符串，
 * effort 走 normalizeEffort（未知值落回 auto），fallback 只认 keep/session。
 * 坏值一律降级而不是整块丢弃 —— 一块坏字段不该让插件停摆。
 */
function rewriteConfig(value) {
  const out = { provider: null, model: null, effort: "auto", fallback: "keep" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const key of ["provider", "model"]) {
    if (value[key] === null) out[key] = null;
    else if (typeof value[key] === "string") out[key] = value[key].trim() || null;
  }
  const effort = normalizeEffort(value.effort);
  out.effort = effort ?? "auto";
  out.fallback = value.fallback === "session" ? "session" : "keep";
  return out;
}

function merge(base, overlay) {
  const out = { ...base };
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return out;
  for (const key of Object.keys(DEFAULTS)) {
    if (overlay[key] !== undefined) out[key] = overlay[key];
  }
  out.strategies = strategiesMap(out.strategies);
  out.agentPresets = strategyMap(out.agentPresets);
  out.sessions = strategyMap(out.sessions);
  out.rewrite = rewriteConfig(out.rewrite);
  out.builtinOverrides = builtinOverridesMap(out.builtinOverrides);
  return out;
}

export class ConfigStore {
  /**
   * @param {string} path - JSON file edited by the Settings card.
   * @param {object} rowConfig - defaults from the cordis row; the file wins.
   */
  constructor(path = defaultConfigPath(), rowConfig = {}) {
    this.path = path;
    this.rowDefaults = merge(DEFAULTS, rowConfig);
    this._cache = null;
    this._mtimeMs = null;
    /** @type {{from: string, to: string}|null} 最近一次迁移的记录，账本要能查到。 */
    this.migrated = null;
  }

  load() {
    const stat = existsSync(this.path) ? statSync(this.path) : null;
    const mtime = stat ? stat.mtimeMs : null;
    if (this._cache !== null && mtime === this._mtimeMs) return this._cache;

    const raw = readJson(this.path);
    // 旧文件 → 新形状。迁移只在"文件里有旧 `profile`、却没有新 `strategy`"时发生，
    // 且立刻落盘：否则每次 load 都要重算，而 user 在设置卡里存的任何值都会覆盖它。
    const strategyMigrated = raw === null ? null : migrateLegacyConfig(raw);
    // 旧形状的 provider/model/reasoningEffort 也搬进 rewrite 块：迁移是行为不变的，
    // 原来"填了就卸载、留空就跟随会话"，迁移后完全一样。
    const migrated = strategyMigrated === null ? null : migrateRewriteConfig(strategyMigrated);
    if (strategyMigrated !== null && strategyMigrated !== raw) {
      this.migrated = { from: String(raw.profile ?? ""), to: String(strategyMigrated.strategy ?? "") };
    }

    const cfg = merge(this.rowDefaults, migrated ?? raw);
    if (raw === null) this.save(cfg); // seed the file so the user can see it
    else if (migrated !== null && migrated !== raw) this.save(migrated);

    this._cache = cfg;
    this._mtimeMs = existsSync(this.path) ? statSync(this.path).mtimeMs : null;
    return cfg;
  }

  save(next) {
    const current = this._cache ?? readJson(this.path) ?? this.rowDefaults;
    const overlay = { ...current, ...(next || {}) };
    // rewrite 是嵌套块：增量写入（只改 model / 只改 fallback）必须和当前值合并，
    // 否则浅合并会把没提到的字段一起抹掉 —— 用户会看到"保存完 provider 没了"。
    if (current?.rewrite && typeof current.rewrite === "object" && next?.rewrite && typeof next.rewrite === "object") {
      overlay.rewrite = { ...current.rewrite, ...next.rewrite };
    }
    const merged = merge(this.rowDefaults, overlay);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
    this._cache = merged;
    this._mtimeMs = existsSync(this.path) ? statSync(this.path).mtimeMs : null;
    return merged;
  }
}
