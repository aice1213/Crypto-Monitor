import type { MdBlock, MdInline } from '../../lib/markdown';

/** 行内渲染：只产出 React 文本节点与 <strong>，不注入 HTML */
function Inline({ inline }: { inline: MdInline[] }) {
  return (
    <>
      {inline.map((part, i) =>
        part.type === 'bold' ? (
          <strong key={i} className="font-semibold text-white">
            {part.value}
          </strong>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </>
  );
}

/**
 * AI 摘要的 Markdown 渲染。
 *
 * 只接收 `parseMarkdown` 产出的结构化块，全部通过 React children 渲染，
 * 不使用 `dangerouslySetInnerHTML`，因此模型输出中的 HTML 只会被当作纯文本显示。
 */
export function MarkdownView({ blocks }: { blocks: MdBlock[] }) {
  return (
    <div className="text-sm text-gray-300 space-y-1.5">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading':
            return (
              <div
                key={i}
                className={
                  block.level === 2
                    ? 'text-white font-semibold text-sm mt-3 first:mt-0'
                    : 'text-gray-200 font-medium text-sm mt-2 first:mt-0'
                }
              >
                <Inline inline={block.inline} />
              </div>
            );
          case 'listItem':
            return (
              <div key={i} className="flex gap-2 pl-1">
                <span className="text-gold shrink-0">•</span>
                <span>
                  <Inline inline={block.inline} />
                </span>
              </div>
            );
          case 'quote':
            return (
              <div key={i} className="border-l-2 border-gold/60 pl-2 text-gray-400 text-xs">
                <Inline inline={block.inline} />
              </div>
            );
          case 'paragraph':
          default:
            return (
              <p key={i}>
                <Inline inline={block.inline} />
              </p>
            );
        }
      })}
    </div>
  );
}
