/**
 * 极简 Markdown 解析（AI 摘要渲染专用）。
 *
 * 为什么不用现成的 Markdown 库：
 * 1. 少一个依赖；AI 输出只用到"标题 / 加粗 / 列表 / 引用 / 段落"这几种子集。
 * 2. **XSS 安全是结构性保证**：解析结果只携带纯文本，由 React 作为 children 渲染，
 *    全程不使用 `dangerouslySetInnerHTML`，因此模型输出里即使带 `<script>` 也只会显示为文字。
 *    （dev.md 5.3 明确要求"Markdown 渲染（禁用 HTML 防 XSS）"。）
 */

export type MdInline =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string };

export type MdBlock =
  | { type: 'heading'; level: 2 | 3; inline: MdInline[] }
  | { type: 'paragraph'; inline: MdInline[] }
  | { type: 'listItem'; inline: MdInline[] }
  | { type: 'quote'; inline: MdInline[] };

/** 解析行内加粗；不解析任何 HTML 标签 */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push({ type: 'bold', value: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out.length > 0 ? out : [{ type: 'text', value: '' }];
}

/** 解析块级结构 */
export function parseMarkdown(source: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  // 统一换行；按空行分段
  const lines = source.replace(/\r\n?/g, '\n').split('\n');

  for (const raw of lines) {
    // 去掉行尾两个空格（Markdown 硬换行）与首尾空白
    const line = raw.replace(/\s+$/, '').trim();
    if (line === '') continue;
    if (line === '---' || line === '***') continue;

    if (line.startsWith('### ')) {
      blocks.push({ type: 'heading', level: 3, inline: parseInline(line.slice(4)) });
      continue;
    }
    if (line.startsWith('## ')) {
      blocks.push({ type: 'heading', level: 2, inline: parseInline(line.slice(3)) });
      continue;
    }
    if (line.startsWith('# ')) {
      // 一级标题也按二级渲染，避免摘要里出现超大字号
      blocks.push({ type: 'heading', level: 2, inline: parseInline(line.slice(2)) });
      continue;
    }
    if (/^>\s?/.test(line)) {
      blocks.push({ type: 'quote', inline: parseInline(line.replace(/^>\s?/, '')) });
      continue;
    }
    const listMatch = line.match(/^[-*+]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)$/);
    if (listMatch) {
      blocks.push({ type: 'listItem', inline: parseInline(listMatch[1]!) });
      continue;
    }
    blocks.push({ type: 'paragraph', inline: parseInline(line) });
  }

  return blocks;
}
