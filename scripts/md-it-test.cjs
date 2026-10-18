// 隔离验证 markdown-it 配置（与 ConversationView 中一致）：html:false / linkify / breaks + 链接新标签
const MarkdownIt = require('markdown-it');

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const sample = [
  '# 出行草案',
  '',
  '好的，我来帮你**规划**行程。先列重点：',
  '',
  '- 第一天：抵达 + 慢游',
  '- 第二天：核心景点 + 美食',
  '',
  '参考链接 https://example.com/guide',
  '',
  '```',
  'Day1 09:00 出发',
  '```',
  '',
  '> 提示：出门前看实时天气最稳。',
].join('\n');

const html = md.render(sample);
console.log(html);

const checks = {
  hasH1: /<h1>出行草案<\/h1>/.test(html),
  hasStrong: /<strong>规划<\/strong>/.test(html),
  hasList: /<ul>[\s\S]*<li>第一天/.test(html),
  hasLinkNewTab: /<a href="https:\/\/example\.com\/guide" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\/guide<\/a>/.test(html),
  escapesRawHtml: !/<script>/.test(md.render('<script>alert(1)</script>')),
  breaksPreserved: /<br>/.test(md.render('line1\nline2')),
};

console.log('\nCHECKS:', JSON.stringify(checks, null, 2));
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length ? 'FAILED: ' + failed.join(', ') : 'ALL PASS');
process.exit(failed.length ? 1 : 0);
