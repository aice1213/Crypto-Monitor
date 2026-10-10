import type { AiStrategyDto } from '@crypto-monitor/shared';
import { parseMarkdown } from '../../lib/markdown';
import { MarkdownView } from './MarkdownView';

/**
 * 去掉摘要开头的结构化方向行（`方向: 看多`）。
 * 该行是给 worker 解析用的机器可读字段，上方已有"AI 方向"标签展示，留在正文里属于重复。
 */
function stripDirectionLine(summary: string): string {
  return summary.replace(/^\s*方向\s*[:：][^\n]*\n?/, '');
}

const TREND_LABEL: Record<string, string> = {
  BULLISH: '看多',
  BEARISH: '看空',
  RANGING: '观望',
};

interface Props {
  ai: AiStrategyDto | null;
  loading: boolean;
  error: string;
  canRegen: boolean;
  regenRemainMs: number;
  onRegenerate: () => void;
  /** 已格式化好的生成时间标签 */
  generatedAtLabel?: string;
}

/**
 * AI 策略面板（dev.md 5.3）。
 *
 * 从 `pages/Detail` 抽出：一是让详情页从 900+ 行降下来，
 * 二是让面板可以脱离 Worker 独立渲染、做视觉验证。
 *
 * 关键约束：
 * - Markdown 通过 `MarkdownView` 以 React children 渲染，**不使用 dangerouslySetInnerHTML**，防 XSS。
 * - AI 方向与规则引擎方向都展示；分歧时必须标注并以规则引擎为准（dev.md 6.2）。
 * - 降级（额度用尽 / AI 不可用 / 功能关闭）必须显式标注，不能让兜底文本冒充模型输出。
 */
export function AiPanel({
  ai,
  loading,
  error,
  canRegen,
  regenRemainMs,
  onRegenerate,
  generatedAtLabel,
}: Props) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-gray-500 text-xs">
          AI 策略分析
          {ai && (
            <span className="ml-2 text-gray-600">
              {ai.model}
              {generatedAtLabel ? ` · ${generatedAtLabel}` : ''}
            </span>
          )}
        </div>
        <button
          onClick={onRegenerate}
          disabled={!canRegen}
          className={`px-2 py-0.5 text-xs rounded border ${
            canRegen
              ? 'border-gold/60 text-gold hover:bg-gold/10'
              : 'border-gray-700 text-gray-600 cursor-not-allowed'
          }`}
        >
          {loading
            ? '生成中…'
            : regenRemainMs > 0
              ? `冷却 ${Math.ceil(regenRemainMs / 1000)}s`
              : '重新生成'}
        </button>
      </div>

      <div className="rounded-lg border border-cardborder bg-black/10 p-3">
        {error && <div className="text-down text-xs mb-2">AI 获取失败：{error}</div>}

        {!ai && !error && (
          <div className="text-gray-500 text-sm">{loading ? 'AI 分析生成中…' : '等待生成…'}</div>
        )}

        {ai && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-xs">
              <span>
                <span className="text-gray-500">AI 方向 </span>
                <span className="text-white font-medium">{TREND_LABEL[ai.signals.trend]}</span>
              </span>
              <span>
                <span className="text-gray-500">规则引擎 </span>
                <span className="text-white font-medium">{TREND_LABEL[ai.signals.engineTrend]}</span>
              </span>
              <span className="text-gray-500">信心 {ai.signals.confidence}</span>
              {ai.degraded && (
                <span className="px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">
                  规则引擎兜底
                  {ai.degradedReason === 'QUOTA_EXHAUSTED'
                    ? '（配额用尽）'
                    : ai.degradedReason === 'AI_DISABLED'
                      ? '（AI 已关闭）'
                      : ai.degradedReason === 'AI_UNAVAILABLE'
                        ? '（AI 不可用）'
                        : ''}
                </span>
              )}
            </div>

            {ai.signals.consensus === 'DIVERGED' && (
              <div className="mb-2 rounded border border-warn/50 bg-warn-bg px-2 py-1 text-warn text-xs">
                ⚠ AI 观点与规则引擎存在分歧，请以规则引擎方向为准
              </div>
            )}
            {ai.signals.consensus === 'UNKNOWN' && (
              <div className="mb-2 text-gray-500 text-xs">
                AI 输出未给出可解析的方向，已回退显示规则引擎方向
              </div>
            )}

            <MarkdownView blocks={parseMarkdown(stripDirectionLine(ai.summary))} />

            <div className="mt-3 text-[10px] text-gray-600">{ai.disclaimer}</div>
          </>
        )}
      </div>
    </div>
  );
}
