import { describe, it, expect } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('解析加粗并保留其余文本', () => {
    expect(parseInline('前 **重点** 后')).toEqual([
      { type: 'text', value: '前 ' },
      { type: 'bold', value: '重点' },
      { type: 'text', value: ' 后' },
    ]);
  });

  it('无标记时返回单个文本节点', () => {
    expect(parseInline('纯文本')).toEqual([{ type: 'text', value: '纯文本' }]);
  });

  it('多个加粗段', () => {
    const r = parseInline('**A** 与 **B**');
    expect(r.filter((x) => x.type === 'bold').map((x) => x.value)).toEqual(['A', 'B']);
  });

  it('孤立星号原样保留', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ type: 'text', value: '2 * 3 = 6' }]);
  });

  it('空串安全', () => {
    expect(parseInline('')).toEqual([{ type: 'text', value: '' }]);
  });

  it('HTML 标签只作为文本，不被解析为标记', () => {
    const r = parseInline('<script>alert(1)</script>');
    expect(r).toEqual([{ type: 'text', value: '<script>alert(1)</script>' }]);
  });
});

describe('parseMarkdown', () => {
  it('识别二级/三级标题', () => {
    const blocks = parseMarkdown('## 结论\n### 细节');
    expect(blocks).toEqual([
      { type: 'heading', level: 2, inline: [{ type: 'text', value: '结论' }] },
      { type: 'heading', level: 3, inline: [{ type: 'text', value: '细节' }] },
    ]);
  });

  it('一级标题降级为二级，避免超大字号', () => {
    const blocks = parseMarkdown('# 大标题');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2 });
  });

  it('识别无序与有序列表', () => {
    const blocks = parseMarkdown('- 甲\n* 乙\n+ 丙\n1. 丁\n2) 戊');
    expect(blocks).toHaveLength(5);
    expect(blocks.every((b) => b.type === 'listItem')).toBe(true);
    expect(blocks.map((b) => (b.type === 'listItem' ? b.inline[0] : null))).toEqual([
      { type: 'text', value: '甲' },
      { type: 'text', value: '乙' },
      { type: 'text', value: '丙' },
      { type: 'text', value: '丁' },
      { type: 'text', value: '戊' },
    ]);
  });

  it('识别引用块', () => {
    const blocks = parseMarkdown('> AI 额度已用尽');
    expect(blocks[0]).toMatchObject({ type: 'quote' });
  });

  it('忽略空行与分隔线', () => {
    expect(parseMarkdown('\n\n正文\n\n---\n\n***\n')).toEqual([
      { type: 'paragraph', inline: [{ type: 'text', value: '正文' }] },
    ]);
  });

  it('去掉行尾硬换行空格', () => {
    expect(parseMarkdown('结论  \n')).toEqual([
      { type: 'paragraph', inline: [{ type: 'text', value: '结论' }] },
    ]);
  });

  it('真实 AI 摘要结构可被完整解析', () => {
    const src = `> AI 额度已用尽，今日展示规则引擎策略

**结论**：规则引擎判定当前偏多（评分 55）。顺势偏多，但需等关键位确认后再动手。  
**原因**：EMA 多头排列；RSI 58.5（中性）；MACD 柱线为正；OBV 流入。  
**关键位**：上方 83084.67、下方 82331.91 决定后续是延续还是转震荡。  
**会改变判断的条件**：价格站稳 83084.67 之上，或有效跌破 82331.91。`;

    const blocks = parseMarkdown(src);
    expect(blocks[0]!.type).toBe('quote');
    const headings = blocks.filter((b) => b.type === 'paragraph');
    // 每个 **xxx**：开头的行都应解析出加粗小节名
    const bolded = headings.map((b) =>
      b.type === 'paragraph' ? b.inline.find((x) => x.type === 'bold')?.value : undefined,
    );
    expect(bolded).toContain('结论');
    expect(bolded).toContain('原因');
    expect(bolded).toContain('关键位');
    expect(bolded).toContain('会改变判断的条件');
  });

  it('中文全角与多级标点不影响解析', () => {
    const blocks = parseMarkdown('**结论**：看多。');
    expect(blocks).toEqual([
      {
        type: 'paragraph',
        inline: [
          { type: 'bold', value: '结论' },
          { type: 'text', value: '：看多。' },
        ],
      },
    ]);
  });

  it('恶意 HTML 不会被当作结构（防 XSS 的关键前提）', () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)>\n## <script>bad</script>');
    expect(blocks[0]).toEqual({
      type: 'paragraph',
      inline: [{ type: 'text', value: '<img src=x onerror=alert(1)>' }],
    });
    expect(blocks[1]).toEqual({
      type: 'heading',
      level: 2,
      inline: [{ type: 'text', value: '<script>bad</script>' }],
    });
    // 解析结果里不含任何 "html" 类型的块，渲染层也没有 dangerouslySetInnerHTML
    expect(JSON.stringify(blocks)).not.toContain('"html"');
  });
});
