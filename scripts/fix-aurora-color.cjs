// 对齐原型配色：大范围背景光晕从薄荷绿(--brand-2)换成原型的蓝紫(#a78bfa)
// 每个替换都校验命中次数，未命中即整体失败（防半途状态）
const fs = require('fs');
const p = 'src/components/xinglan.css';
let s = fs.readFileSync(p, 'utf8');
let n = 0;
const rep = (from, to, expect = 1) => {
  const c = s.split(from).length - 1;
  if (c !== expect) { console.error(`MISS: "${from.slice(0, 60)}..." expect=${expect} got=${c}`); process.exit(1); }
  s = s.split(from).join(to);
  n += c;
};

// 1) :root 定义大背景专用紫（注释说明不随 brand-2 漂绿）
rep(
  '  --gradient: linear-gradient(135deg, #5fe1ff 0%, #7af0d4 100%);\n  --core: #6fd6ff;\n',
  '  --gradient: linear-gradient(135deg, #5fe1ff 0%, #7af0d4 100%);\n  --core: #6fd6ff;\n\n  /* 大范围背景光晕专用：对齐原型（蓝紫基调），不随 --brand-2 漂绿 */\n  --aurora-2: #a78bfa;\n'
);

// 2) 极光第二层：绿 → 紫
rep(
  'radial-gradient(900px 680px at 102% 4%, color-mix(in srgb, var(--brand-2) 11%, transparent), transparent 58%)',
  'radial-gradient(900px 680px at 102% 4%, color-mix(in srgb, var(--aurora-2) 11%, transparent), transparent 58%)'
);

// 3) 星云 blob b2：38% 绿 → 34% 紫
rep(
  '.neb-blob.b2 { width: 40vw; height: 40vw; right: -8vw; top: -6vw; background: radial-gradient(circle, color-mix(in srgb, var(--brand-2) 38%, transparent), transparent 70%); }',
  '.neb-blob.b2 { width: 40vw; height: 40vw; right: -8vw; top: -6vw; background: radial-gradient(circle, color-mix(in srgb, var(--aurora-2) 34%, transparent), transparent 70%); }'
);

// 4) warm 主题光晕跟随暖金
rep(
  'html.warm {\n  --brand: #f6c062;\n  --brand-2: #ffce86;',
  'html.warm {\n  --brand: #f6c062;\n  --brand-2: #ffce86;\n  --aurora-2: #ffce86;'
);

fs.writeFileSync(p, s);
console.log(`OK: ${n} replacements applied`);
