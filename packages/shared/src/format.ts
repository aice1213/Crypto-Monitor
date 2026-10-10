export function fmtPrice(value: number): string {
  const abs = Math.abs(value);
  const digits = abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return value.toFixed(digits);
}

/** 北京时间偏移（秒） */
const BEIJING_OFFSET_SECONDS = 8 * 60 * 60;

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * 把时间戳归一为**秒**。
 * 同一份代码里既有 Unix 秒（K 线 / 交易所接口），也有毫秒（`Date.now()`），
 * 之前三个页面各写一套判断；这里统一按 `> 1e12 视为毫秒` 处理。
 */
export function toUnixSeconds(ts: number): number {
  return ts > 1e12 ? Math.floor(ts / 1000) : ts;
}

/**
 * 统一按北京时间（UTC+8）格式化，`YYYY-MM-DD HH:mm:ss`。
 *
 * 不使用 `toLocaleString`：其输出依赖运行环境的 locale/时区数据，
 * 在 Worker 与浏览器之间可能出现差异；这里用固定偏移保证各处一致。
 */
export function formatBeijingTime(ts: number): string {
  const d = new Date((toUnixSeconds(ts) + BEIJING_OFFSET_SECONDS) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours(),
  )}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** 北京时间短格式 `MM-DD HH:mm`，用于图表坐标轴 */
export function formatBeijingShort(ts: number): string {
  const d = new Date((toUnixSeconds(ts) + BEIJING_OFFSET_SECONDS) * 1000);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(
    d.getUTCMinutes(),
  )}`;
}

/** 把 ISO 字符串或时间戳统一按北京时间格式化为 `MM-DD HH:mm`（宏观日历用） */
export function formatBeijingFromIso(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return formatBeijingShort(Math.floor(ms / 1000));
}
