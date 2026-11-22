/**
 * 门户模板画像器。
 *
 * 从快照原文生成**只看结构、不看取值**的画像：
 *  - 结构片段（标题 / 层级标题 / 标签行 / 段落 / 折叠栏 / 附件段）
 *  - 标题层级（一、 （一） 1. 等编号形态，数字掩码后归一）
 *  - 字段邻域指纹（字段标签 + 前后标签 + 取值形状 + 所在结构）
 *  - 聚合结构签名（标签序列、标题骨架、折叠/附件标志、段落长度与位置分布）
 *
 * 画像完全由快照原文推导，不信任导入时的文件扩展名线索：
 * 文件导入后才发现是打印版时，可在质量运行阶段重新画像识别出
 * “无原网页结构 / 打印版 / 离线缺页”，而不改写快照本身。
 *
 * 纯函数、确定性输出，便于在固定快照上回放。
 */
import type {
  FieldNeighborhood,
  HeadingNode,
  PageKind,
  PortalSourceRef,
  Snapshot,
  StructureFragment,
  TemplateProfile,
  TemplateSignature,
  FactType,
  SectionKind,
} from './types';
import { sha256HexFallback } from './sha256';
import { stableStringify } from './hash';

// ---------------- 来源登记 ----------------

export interface PortalSourceDef extends PortalSourceRef {
  aliases: string[];
}

export const PORTAL_SOURCES: PortalSourceDef[] = [
  { id: 'zj', province: '浙江', portalName: '浙江省政府采购网', aliases: ['浙江', '浙江省政府采购网'] },
  { id: 'js', province: '江苏', portalName: '江苏政府采购网', aliases: ['江苏', '江苏政府采购网'] },
  { id: 'hn', province: '湖南', portalName: '湖南省政府采购网', aliases: ['湖南', '湖南省政府采购网'] },
  { id: 'ah', province: '安徽', portalName: '安徽合肥公共资源交易中心', aliases: ['安徽', '合肥公共资源'] },
  { id: 'sc', province: '四川', portalName: '四川省政府采购网', aliases: ['四川', '四川省政府采购网'] },
];

/**
 * 推断快照归属的门户来源。先看文件名（归档方习惯用省份命名），
 * 再看正文中的门户名称；无法归属时返回 null（不猜测、不跨来源合并）。
 */
export function detectSourceId(fileName: string, text: string): string | null {
  const haystack = `${fileName}\n${text}`;
  for (const src of PORTAL_SOURCES) {
    if (src.aliases.some((a) => haystack.includes(a))) return src.id;
  }
  return null;
}

export function sourceMeta(sourceId: string | null): PortalSourceRef | null {
  if (!sourceId) return null;
  const src = PORTAL_SOURCES.find((s) => s.id === sourceId);
  return src ? { id: src.id, province: src.province, portalName: src.portalName } : null;
}

// ---------------- 文本归一 ----------------

const CN_NUM = '一二三四五六七八九十百零〇两';
const FULLWIDTH_DIGIT = /[０-９]/g;

/** 标签形状：隐藏具体编号/数字/字母，保留标签语义与单位 */
export function labelShape(label: string): string {
  return label
    .replace(FULLWIDTH_DIGIT, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(new RegExp(`第\\s*[${CN_NUM}0-9]+`, 'g'), '第#')
    .replace(new RegExp(`(包件|标包|包号|标段|合同包)\\s*[${CN_NUM}A-Za-z0-9]+`, 'g'), '$1#')
    .replace(/\d+/g, '#')
    .replace(/[A-Za-z]{2,}/g, 'A')
    .replace(/[\s　]+/g, '')
    .replace(/[：:]\s*$/, '')
    .trim();
}

/** 标题归一：数字/编号掩码，保留层级关键词 */
export function normalizeHeading(text: string): string {
  return labelShape(text.replace(/^[（(]?[一二三四五六七八九十0-9]+[)）、.]\s*/, ''))
    .replace(/（.*?）/g, '（…）')
    .slice(0, 48);
}

function lengthBucket(text: string): 'S' | 'M' | 'L' {
  if (text.length < 12) return 'S';
  if (text.length < 40) return 'M';
  return 'L';
}

function isNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  return /^(当前位置[:：]|【网站导航】|版权所有|Copyright|ICP备|公安备案号|技术支持[:：]|主办单位[:：]|友情链接[:：]|\[广告\]|广告位|扫[一码]扫|关注(微信|公众号)|点击下载|温馨提示[:：].*(浏览器|APP)|打印时间[:：]|第\s*\d+\s*页\s*共\s*\d+\s*页|—+\s*页[脚眉]\s*—+)/i.test(
    t,
  );
}

// ---------------- 折叠栏 / 打印版 / 缺页检测 ----------------

const FOLD_MARK = /^(?:【(?:展开|收起|更多)】|▸|▶|▼|►|▾|＋|\+\s|更多[>＞]|展开(?:查看|详情)?|收起(?:详情)?)[\s:：]*/;

export function stripFoldMark(line: string): string | null {
  const t = line.trim();
  if (!FOLD_MARK.test(t)) return null;
  return t.replace(FOLD_MARK, '').trim();
}

const PRINT_MARKERS: RegExp[] = [
  /打印时间[:：]/,
  /第\s*\d+\s*页\s*共\s*\d+\s*页/,
  /——+\s*打印(?:版|件)?\s*——+/,
  /^\d+\s*\/\s*\d+$/,
  /^Page\s*\d+\s*of\s*\d+$/i,
  /本页(?:内容)?(?:为)?打印版/,
  /（?打印件）?/,
];

const TRUNCATION_MARKERS: RegExp[] = [
  /（?下页续）?/, // 占位，见下方精确匹配
  /\(?下页续\)?/,
  /以下内容(?:缺失|截断)/,
  /本页(?:内容)?(?:截断|不完整)/,
  /内容截断/,
  /未完待续/,
  /详见下页/,
];

export function looksLikePrint(text: string, fileName: string): boolean {
  if (/打印|print/i.test(fileName)) return true;
  const hits = PRINT_MARKERS.filter((re) => re.test(text)).length;
  // 打印页脚组合（页码 + 打印时间）或显式“打印版”标记
  return hits >= 1 && (/打印时间|打印版|打印件|Page\s*\d+/i.test(text) || hits >= 2);
}

export function looksPageIncomplete(text: string): boolean {
  return TRUNCATION_MARKERS.some((re) => re.test(text)) || /（下页续）|\(下页续\)|详见下页/.test(text);
}

// ---------------- 片段 / 标题 / 邻域 ----------------

const HEADING_PATTERNS: { level: number; re: RegExp }[] = [
  { level: 1, re: /^[一二三四五六七八九十]+、\s*(.+)$/ },
  { level: 2, re: /^（[一二三四五六七八九十]+）\s*(.+)$/ },
  { level: 2, re: /^\([一二三四五六七八九十]+\)\s*(.+)$/ },
  { level: 3, re: /^\d+[.、]\s*(.+)$/ },
  { level: 1, re: /^第[一二三四五六七八九十]+章[\s:：]*(.+)$/ },
];

const LABEL_LINE = /^\s*([^：:，,。；;\n]{2,18})\s*[：:]\s*(.*)$/;

const FIELD_HINTS: { type: FactType; re: RegExp }[] = [
  { type: 'amount', re: /预算|金额|限价|报价|造价|投资估算|资金/ },
  { type: 'project_code', re: /编号|编码|项目号/ },
  { type: 'lot', re: /标段|标包|包件|分包|合同包/ },
  { type: 'date', re: /日期|时间|截止|期限/ },
  { type: 'purchaser', re: /采购人|招标人|采购单位|招标单位|建设单位/ },
  { type: 'result', re: /中标|成交|供应商|中标人/ },
  { type: 'stage', re: /阶段|公告类型/ },
];

function hintField(label: string): FactType | 'unknown' {
  for (const h of FIELD_HINTS) if (h.re.test(label)) return h.type;
  return 'unknown';
}

function valueShape(value: string): string {
  const v = value.trim();
  if (!v) return 'empty';
  if (/^[0-9][0-9,，.]*\s*(万元|万|元)$/.test(v)) return 'money';
  if (/^\d{4}\s*[年.-]\s*\d{1,2}/.test(v)) return 'date';
  if (/\d/.test(v) && /^[A-Za-z0-9\-_/（）()]+$/.test(v)) return 'code';
  if (/^\d+$/.test(v)) return 'number';
  return 'text';
}

function sectionKindAt(sections: { kind: SectionKind; start: number; end: number }[], pos: number): SectionKind {
  // 相邻结构段可能在边界处重叠（上一段 end == 下一段 start）；取“起点最靠后”的段，
  // 保证附件标题行归入附件段而非上一段正文。
  let best: { kind: SectionKind; start: number } | null = null;
  for (const s of sections) {
    if (pos < s.start || pos > s.end) continue;
    if (!best || s.start > best.start) best = { kind: s.kind, start: s.start };
  }
  return best?.kind ?? 'announcement';
}
interface LineInfo {
  text: string;
  start: number;
  end: number;
  sectionKind: SectionKind;
}

function splitLines(snapshot: Snapshot): LineInfo[] {
  const raw = snapshot.rawText;
  const out: LineInfo[] = [];
  let cursor = 0;
  const lines = raw.split('\n');
  lines.forEach((text, i) => {
    const start = cursor;
    const end = start + text.length;
    out.push({ text, start, end, sectionKind: sectionKindAt(snapshot.parsed.sections.map((s) => ({ kind: s.kind, start: s.span.start, end: s.span.end })), start) });
    cursor = end + (i < lines.length - 1 ? 1 : 0);
  });
  return out;
}

/** 文档日期：优先“发布日期/公告日期/发布时间”，否则取正文首个日期 */
export function extractDocumentDate(text: string): string | null {
  const labeled = /(?:公告发布日期|发布日期|公告日期|发布时间|信息发布时间|日期)[：:]\s*(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/.exec(text);
  const any = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text);
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const m = labeled ?? any ?? iso;
  if (!m) return null;
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

function periodOf(docDate: string | null): string | null {
  return docDate ? docDate.slice(0, 7) : null;
}

/** 页面类型：根据标题/正文的阶段关键词判定（用于按页面类型隔离模板） */
export function detectPageKind(text: string): PageKind {
  const head = text.slice(0, Math.min(text.length, 600));
  const ordered: { kind: PageKind; re: RegExp }[] = [
    { kind: 'intention', re: /采购意向|意向公开|意向公告/ },
    { kind: 'correction', re: /更正公告|澄清(?:公告|修改)|修改公告|变更公告/ },
    { kind: 'extension', re: /延期公告|延长(?:投标|响应|报名|递交)/ },
    { kind: 'cancellation', re: /撤销公告|终止公告|废标公告|采购终止|项目撤销/ },
    { kind: 'result', re: /中标公告|成交公告|结果公告|中标结果|成交结果/ },
    { kind: 'announcement', re: /招标公告|采购公告|竞争性|公开招标|询价公告|单一来源/ },
  ];
  for (const o of ordered) if (o.re.test(head)) return o.kind;
  // 正文任意位置兜底
  for (const o of ordered) if (o.re.test(text)) return o.kind;
  return 'announcement';
}

/** 结构签名：仅保留结构信息，忽略具体取值 */
export function buildSignature(profile: Pick<TemplateProfile, 'fragments' | 'headings' | 'neighborhoods' | 'printLikely'>): TemplateSignature {
  const labelSequence: string[] = [];
  for (const f of profile.fragments) {
    if (f.kind !== 'label' && f.kind !== 'fold') continue;
    const shape = f.labelShape;
    if (shape && labelSequence[labelSequence.length - 1] !== shape) labelSequence.push(shape);
  }
  const headingSkeleton = profile.headings
    .filter((h) => h.level > 0) // 公告大标题（level 0）含项目名，属取值噪声，不参与结构签名
    .map((h) => `${h.level}:${h.normalized}`);
  const neighborhoodHashes = [...new Set(profile.neighborhoods.map((n) => n.fingerprint))].sort();

  const paragraphs = profile.fragments.filter((f) => f.kind === 'paragraph');
  const meanParagraphLen = paragraphs.length
    ? Math.round(paragraphs.reduce((n, f) => n + (f.end - f.start), 0) / paragraphs.length)
    : 0;
  const positionHist = { top: 0, middle: 0, bottom: 0 };
  for (const n of profile.neighborhoods) positionHist[n.positionBucket] += 1;
  const lengthHist = { S: 0, M: 0, L: 0 };
  for (const f of profile.fragments) if (f.kind === 'paragraph' || f.kind === 'attachment') lengthHist[f.lengthBucket] += 1;

  return {
    labelSequence,
    headingSkeleton,
    neighborhoodHashes,
    hasFold: profile.fragments.some((f) => f.kind === 'fold'),
    hasAttachment: profile.fragments.some((f) => f.kind === 'attachment' || f.kind === 'attachment_heading'),
    structuralUnavailable: profile.printLikely,
    stats: {
      labelCount: labelSequence.length,
      paragraphCount: paragraphs.length,
      meanParagraphLen,
      positionHist,
      lengthHist,
    },
  };
}

/** 结构指纹：只用“与取值长度无关”的结构要素，保证同一模板的不同公告可精确命中 */
export function fingerprintSignature(signature: TemplateSignature): string {
  return sha256HexFallback(
    stableStringify({
      labels: signature.labelSequence,
      fold: signature.hasFold,
      attachment: signature.hasAttachment,
    }),
  );
}

/**
 * 对单个快照生成模板画像。
 * 结构片段、标题层级、字段邻域、签名、指纹一次性产出，
 * 后续模板匹配、契约评估、聚类与修复回放都消费同一份画像。
 */
export function profileSnapshot(snapshot: Snapshot, sourceId: string): TemplateProfile {
  const lines = splitLines(snapshot);
  const fragments: StructureFragment[] = [];
  const headings: HeadingNode[] = [];
  const neighborhoods: FieldNeighborhood[] = [];
  const labels: { shape: string; index: number; sectionKind: SectionKind; start: number; valueShape: string; hasValue: boolean }[] = [];

  let firstTitleDone = false;
  let index = 0;

  for (const line of lines) {
    const trimmed = line.text.trim();
    if (isNoiseLine(trimmed)) continue;

    // 折叠栏：剥掉折叠标记后仍按标签行解析
    let folded = false;
    let content = trimmed;
    const stripped = stripFoldMark(trimmed);
    if (stripped !== null) {
      folded = true;
      content = stripped;
      fragments.push({
        index: index++,
        kind: 'fold',
        labelShape: labelShape(stripped.split(/[：:]/)[0] ?? stripped),
        lengthBucket: lengthBucket(stripped),
        hasValue: /[：:]\s*\S/.test(stripped),
        sectionKind: line.sectionKind,
        start: line.start,
        end: line.end,
      });
    }

    // 附件标题（结构段起点）
    if (line.sectionKind === 'attachment' && /^(附件|附录)\s*[0-9一二三四五六七八九十]*[：:.、\s]/.test(trimmed)) {
      fragments.push({
        index: index++,
        kind: 'attachment_heading',
        labelShape: labelShape(trimmed),
        lengthBucket: lengthBucket(trimmed),
        hasValue: false,
        sectionKind: line.sectionKind,
        start: line.start,
        end: line.end,
      });
      headings.push({ level: 2, text: trimmed, normalized: normalizeHeading(trimmed), start: line.start, end: line.end });
      continue;
    }

    // 层级标题
    let headingHit: { level: number; text: string } | null = null;
    for (const h of HEADING_PATTERNS) {
      const m = h.re.exec(trimmed);
      if (m) {
        headingHit = { level: h.level, text: m[1] ?? trimmed };
        break;
      }
    }

    // 公告大标题：正文中首个较长且带阶段/公告关键词的行
    if (!headingHit && !firstTitleDone && line.sectionKind === 'announcement' && trimmed.length >= 8 &&
        /(公告|通知|结果|意向|公示|更正|延期|终止|撤销)/.test(trimmed) && !LABEL_LINE.test(trimmed)) {
      headingHit = { level: 0, text: trimmed };
      firstTitleDone = true;
      fragments.push({
        index: index++,
        kind: 'title',
        labelShape: labelShape(trimmed),
        lengthBucket: lengthBucket(trimmed),
        hasValue: false,
        sectionKind: line.sectionKind,
        start: line.start,
        end: line.end,
      });
    }

    if (headingHit) {
      const node: HeadingNode = {
        level: headingHit.level,
        text: trimmed,
        normalized: normalizeHeading(headingHit.text),
        start: line.start,
        end: line.end,
      };
      headings.push(node);
      if (headingHit.level > 0) {
        fragments.push({
          index: index++,
          kind: 'heading',
          labelShape: node.normalized,
          lengthBucket: lengthBucket(trimmed),
          hasValue: false,
          sectionKind: line.sectionKind,
          start: line.start,
          end: line.end,
        });
      }
    }

    // 标签行
    const labelMatch = LABEL_LINE.exec(content);
    if (labelMatch) {
      const label = labelMatch[1].trim();
      const value = (labelMatch[2] ?? '').trim();
      const shape = labelShape(label);
      const frag: StructureFragment = {
        index: index++,
        kind: 'label',
        labelShape: shape,
        lengthBucket: lengthBucket(trimmed),
        hasValue: value.length > 0,
        sectionKind: line.sectionKind,
        start: line.start,
        end: line.end,
      };
      fragments.push(frag);
      labels.push({
        shape,
        index: frag.index,
        sectionKind: line.sectionKind,
        start: line.start,
        valueShape: valueShape(value),
        hasValue: value.length > 0,
      });
    } else if (!folded && !headingHit && trimmed.length > 0) {
      fragments.push({
        index: index++,
        kind: line.sectionKind === 'attachment' ? 'attachment' : 'paragraph',
        labelShape: labelShape(trimmed.slice(0, 24)),
        lengthBucket: lengthBucket(trimmed),
        hasValue: false,
        sectionKind: line.sectionKind,
        start: line.start,
        end: line.end,
      });
    }
  }

  // 字段邻域指纹
  const docLen = Math.max(1, snapshot.rawText.length);
  labels.forEach((lab, i) => {
    const before = labels.slice(Math.max(0, i - 2), i).map((l) => l.shape);
    const after = labels.slice(i + 1, i + 3).map((l) => l.shape);
    const ratio = lab.start / docLen;
    const positionBucket: FieldNeighborhood['positionBucket'] = ratio < 1 / 3 ? 'top' : ratio < 2 / 3 ? 'middle' : 'bottom';
    const fingerprint = sha256HexFallback(
      stableStringify({
        shape: lab.shape,
        sectionKind: lab.sectionKind,
        positionBucket,
        before,
        after,
        valueShape: lab.valueShape,
      }),
    );
    neighborhoods.push({
      fieldHint: hintField(lab.shape),
      labelShape: lab.shape,
      sectionKind: lab.sectionKind,
      positionBucket,
      beforeLabels: before,
      afterLabels: after,
      valueShape: lab.valueShape,
      fingerprint,
    });
  });

  const printLikely = looksLikePrint(snapshot.rawText, snapshot.sources[0]?.fileName ?? '');
  const pageIncomplete = looksPageIncomplete(snapshot.rawText);
  const noHeadingStructure = headings.filter((h) => h.level > 0).length === 0 && !fragments.some((f) => f.kind === 'fold');

  const signature = buildSignature({ fragments, headings, neighborhoods, printLikely });
  const docDate = extractDocumentDate(snapshot.rawText);

  return {
    snapshotId: snapshot.id,
    sourceId,
    period: periodOf(docDate),
    documentDate: docDate,
    pageKind: detectPageKind(snapshot.rawText),
    parserVersion: snapshot.parsed.parserVersion,
    signature,
    fingerprint: fingerprintSignature(signature),
    fragments,
    headings,
    neighborhoods,
    // 仅打印版视为“结构不可用”；普通网页即使没有编号标题，结构仍可用
    structuralUnavailable: printLikely,
    printLikely,
    pageIncomplete,
    noHeadingStructure,
  };
}

// ---------------- 签名相似度 ----------------

function lcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1).fill(0);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[n];
}

function histCosine(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 结构相似度 ∈ [0,1]。
 * 主要看标签序列（顺序敏感 LCS），折叠/附件标志、标题骨架、
 * 段落长度与字段位置分布作为辅助权重——既识别“同模板不同取值”，
 * 也识别“外观相同但结构改版”。
 */
export function signatureSimilarity(a: TemplateSignature, b: TemplateSignature): number {
  const seqDen = Math.max(1, Math.max(a.labelSequence.length, b.labelSequence.length));
  const seq = lcsLength(a.labelSequence, b.labelSequence) / seqDen;

  const headingA = a.headingSkeleton.map((h) => h.split(':')[1]);
  const headingB = b.headingSkeleton.map((h) => h.split(':')[1]);
  const heading = headingA.length === 0 && headingB.length === 0
    ? 1
    : lcsLength(headingA, headingB) / Math.max(1, Math.max(headingA.length, headingB.length));

  const foldMatch = a.hasFold === b.hasFold ? 1 : 0;
  const attachMatch = a.hasAttachment === b.hasAttachment ? 1 : 0;
  const lengthSim = histCosine(a.stats.lengthHist, b.stats.lengthHist);
  const positionSim = histCosine(a.stats.positionHist, b.stats.positionHist);

  return Number(
    (
      0.55 * seq +
      0.12 * heading +
      0.12 * foldMatch +
      0.09 * attachMatch +
      0.06 * lengthSim +
      0.06 * positionSim
    ).toFixed(4),
  );
}

/**
 * 聚类相似度：更看重字段位置、段落长度与标签分布统计，
 * 用于在未登记页面中发现“渐进式改版”的雏形。
 */
export function clusterSimilarity(a: TemplateSignature, b: TemplateSignature): number {
  const seqDen = Math.max(1, Math.max(a.labelSequence.length, b.labelSequence.length));
  const seq = lcsLength(a.labelSequence, b.labelSequence) / seqDen;
  const lengthSim = histCosine(a.stats.lengthHist, b.stats.lengthHist);
  const positionSim = histCosine(a.stats.positionHist, b.stats.positionHist);
  const foldMatch = a.hasFold === b.hasFold ? 1 : 0;
  const attachMatch = a.hasAttachment === b.hasAttachment ? 1 : 0;
  const meanLenClose = 1 - Math.min(1, Math.abs(a.stats.meanParagraphLen - b.stats.meanParagraphLen) / Math.max(20, a.stats.meanParagraphLen, b.stats.meanParagraphLen));
  return Number((0.4 * seq + 0.2 * lengthSim + 0.15 * positionSim + 0.1 * foldMatch + 0.1 * attachMatch + 0.05 * meanLenClose).toFixed(4));
}
