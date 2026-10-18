/** 产物（Artifact）相关的纯函数工具：Markdown 导出、下载 */
import type { Artifact } from '../types';

const TYPE_LABEL: Record<Artifact['type'], string> = {
  itinerary: '行程卡',
  report: '报告',
  checklist: '清单',
  note: '笔记',
};

export function artifactTypeLabel(t: Artifact['type']): string {
  return TYPE_LABEL[t] || t;
}

function formatValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

/** 把产物内容转成可读 Markdown（JSON 结构会被展开为列表/标题） */
export function artifactToMarkdown(art: Artifact): string {
  const lines: string[] = [`# ${art.title}`, ''];
  const body = art.content || '';
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed)) {
      parsed.forEach((item, i) => lines.push(`${i + 1}. ${formatValue(item)}`));
    } else {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        lines.push(`- **${k}**：${formatValue(v)}`);
      }
    }
  } else {
    lines.push(body);
  }
  lines.push('');
  lines.push('---');
  lines.push(`*由栖光 AI 生活管家生成 · ${new Date(art.updated_at).toLocaleString('zh-CN')}*`);
  return lines.join('\n');
}

/** 触发浏览器下载纯文本（Markdown） */
export function downloadText(filename: string, text: string): void {
  try {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* 下载失败静默 */
  }
}
