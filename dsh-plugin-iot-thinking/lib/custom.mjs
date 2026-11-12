// 自定义预设：一份文本，来自用户显式指定的目录，或直接贴进来。
// 目录不设默认值 —— 留空就是"没有目录"，需要在设置里自己填。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { homedir } from "node:os";

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".markdown"]);

export const MAX_PRESET_BYTES = 64 * 1024;

const fileCache = new Map();

/** 配置里的目录 → 绝对路径。留空返回 null：没有默认值。 */
export function resolvePresetDir(dir) {
  const raw = typeof dir === "string" ? dir.trim() : "";
  if (!raw) return null;
  const expanded = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
    ? join(homedir(), raw.slice(1))
    : raw;
  return resolve(expanded);
}

export function listPresets(dir) {
  const root = resolvePresetDir(dir);
  if (!root) return { configured: false, presets: [] };
  if (!existsSync(root)) return { configured: true, presets: [] };
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { configured: true, presets: [] };
  }
  const presets = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    let stat = null;
    try {
      stat = statSync(join(root, entry.name));
    } catch {
      continue;
    }
    if (stat.size > MAX_PRESET_BYTES) continue;
    presets.push({
      // 名字带扩展名：`.md` / `.txt` 都在列表里，用户自己挑。
      name: entry.name,
      stem: basename(entry.name, ext),
      ext,
      bytes: stat.size,
      mtime: stat.mtimeMs,
    });
  }
  presets.sort((a, b) => a.name.localeCompare(b.name));
  return { configured: true, presets };
}

export function readPreset(dir, name) {
  const root = resolvePresetDir(dir);
  const wanted = String(name ?? "").trim();
  if (!root) return { text: null, error: "preset-dir-not-set" };
  if (!wanted) return { text: null, error: "empty-preset-name" };
  // 只认目录内的文件名：文本框不该变成任意文件读取。
  if (wanted.includes("/") || wanted.includes("\\") || wanted.includes("..")) {
    return { text: null, error: `invalid-preset-name: ${wanted}` };
  }
  const candidates = TEXT_EXTENSIONS.has(extname(wanted).toLowerCase())
    ? [wanted]
    : [...TEXT_EXTENSIONS].map((ext) => `${wanted}${ext}`);
  for (const file of candidates) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const cached = fileCache.get(path);
    if (cached && cached.mtime === stat.mtimeMs) return { text: cached.text, error: cached.error };
    try {
      const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
      if (text.length > MAX_PRESET_BYTES) {
        const error = `preset 太大（${text.length} > ${MAX_PRESET_BYTES} 字节）`;
        fileCache.set(path, { mtime: stat.mtimeMs, text: null, error });
        return { text: null, error };
      }
      fileCache.set(path, { mtime: stat.mtimeMs, text, error: null });
      return { text, error: null };
    } catch (cause) {
      const error = `读不出来：${String(cause?.message ?? cause)}`;
      fileCache.set(path, { mtime: stat.mtimeMs, text: null, error });
      return { text: null, error };
    }
  }
  return { text: null, error: `preset 不存在：${wanted}` };
}

export function writePreset(dir, filename, text) {
  const root = resolvePresetDir(dir);
  if (!root) return { ok: false, error: "preset-dir-not-set" };
  const clean = String(filename ?? "").trim();
  if (!clean) return { ok: false, error: "文件名不能为空" };
  if (clean.includes("/") || clean.includes("\\") || clean.includes("..")) {
    return { ok: false, error: `非法的文件名：${clean}` };
  }
  const body = String(text ?? "");
  if (!body.trim()) return { ok: false, error: "内容为空，不写文件" };
  if (body.length > MAX_PRESET_BYTES) return { ok: false, error: `内容太大（${body.length} > ${MAX_PRESET_BYTES} 字节）` };
  // 没写后缀就补 .md；写了 .md/.txt/.markdown 就照原样保存。
  const name = TEXT_EXTENSIONS.has(extname(clean).toLowerCase()) ? clean : `${clean}.md`;
  try {
    mkdirSync(root, { recursive: true });
    const path = join(root, name);
    writeFileSync(path, body, "utf8");
    fileCache.delete(path);
    return { ok: true, name };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export function resetPresetCache() {
  fileCache.clear();
}

/**
 * 预设文本 → 提示词。
 * 不含 `{{draft}}` 时按"指令体"处理（引擎包 `<thinking>`）；含它则整段当模板。
 */
export function buildCustomPrompt(presetText, draft, { strict = false, reason = null, detail = null, limits = null } = {}) {
  const body = String(presetText ?? "").trim();
  const text = String(draft ?? "");
  if (!body) return "";
  const retry = strict ? strictDirective(reason, detail) : "";
  const discipline = outputDiscipline(limits);
  if (body.includes("{{draft}}")) {
    return `${body.split("{{draft}}").join(text)}${discipline ? `\n\n${discipline}` : ""}${retry ? `\n\n${retry}` : ""}`;
  }
  return [
    body,
    "",
    "<thinking>",
    text || "（草稿为空或只有重复填充）",
    "</thinking>",
    "",
    "现在只输出改写后的内容，不要解释、不要前言、不要重复这段指令。",
    discipline,
    retry,
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n")
    .trim();
}

/**
 * 输出纪律：把"写多少、写什么、不许写什么"放在预设正文之后。
 *
 * 为什么不只依赖预设文本：预设是用户写的自由文本，模型可能忽略其中的预算；
 * 而超预算的后果是**截断**（max-tokens），截断后重试只会再截一次。所以这里
 * 用一段固定的、可机检的约束把边界说死：条数、字数、禁止思考标签。
 */
export function outputDiscipline(limits = null) {
  const maxOut = Number.isFinite(limits?.maxOut) ? Math.max(0, Math.floor(limits.maxOut)) : 0;
  const noThink = limits?.noThink === true;
  const rules = [
    "输出纪律（优先于上文任何风格要求）：",
    "1. 只输出最终结果本身，不要解释你的过程，不要复述指令，不要开场白/结束语。",
    "2. 直接按标签分行输出；不要 JSON、不要代码块、不要编号。",
  ];
  if (maxOut > 0) {
    rules.push(`3. 总长度不超过 ${maxOut} 个字符；超了就删次要条目，不要靠换行凑长度。`);
  }
  if (noThink) {
    rules.push("4. 输出里**不要出现** `<thinking>` / `<think>` / `[思考]` 这类标签——你不是在思考，你是在给结论。");
  }
  return rules.join("\n");
}

function strictDirective(reason, detail) {
  switch (reason) {
    case "degenerate":
      return "上一版退化成重复内容了。整段重写，不要复用上一版任何一句。";
    case "too-thin":
      return "上一版太薄了，信息丢了。按预设给出完整的一小段。";
    case "unchanged":
      return "上一版和草稿一模一样。按预设真的改写它。";
    case "not-shorter":
      return "上一版不比原文短。压到预设要求的长度以内。";
    case "empty":
      return "上一版是空的。草稿里有内容，写出来。";
    case "over-budget":
      return `上一版写超了（超过 ${detail ?? "预算"} 个字符）。删掉次要条目与解释，只留结论；不要靠换行凑长度。`;
    case "has-think-tag":
      return "上一版里出现了 `<thinking>` / `<think>` / `[思考]` 标签。不要输出思考过程，只输出最终结论。";
    default:
      return `上一版不合格${detail ? `（${detail}）` : ""}。重写。`;
  }
}
