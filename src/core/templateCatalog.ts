/**
 * 内置模板目录与字段契约库（随产品发布、由人工审核）。
 *
 * 设计要点：
 *  - 模板指纹由**结构**推导：标签序列、标题骨架、折叠栏/附件结构；具体项目编号、
 *    金额、日期等取值不参与指纹（另由段落长度与字段位置分布供聚类使用）。
 *  - 契约按 **来源 + 模板版本** 分开登记。两个省份即使使用相同外观的模板
 *    （appearanceGroup 相同），字段含义也可能不同（如“包件”在江苏指投标文件分包，
 *    在浙江指采购标段），因此质量指标绝不跨来源共用。
 *  - 每个字段声明期望出现的位置、是否依赖网页结构、适用的采购阶段，
 *    以及允许缺失的条件（用于区分来源未披露 / 离线缺页 / 结构不可用 / 规则不识别）。
 *  - 新页面必须经人工确认后才登记为新模板版本（等待维护），不会自动改写契约。
 */
import type {
  ContractField,
  FieldContract,
  PortalSourceRef,
  ProcurementStage,
  RepairRulePatch,
  Snapshot,
  TemplateSignature,
} from './types';
import { parseDocument, inferSourceKind } from './parser';
import { fingerprintSignature, profileSnapshot, sourceMeta } from './templateProfile';
import { sha256HexFallback } from './sha256';
import { deterministicId } from './hash';

/** 已知模板判定阈值：结构相似度达到该值即视为已知版本（取值差异不影响） */
export const KNOWN_TEMPLATE_THRESHOLD = 0.8;
/** 未知页面聚类阈值：用于发现渐进式改版雏形 */
export const CLUSTER_THRESHOLD = 0.64;
/** “近似但未登记”观察带：相似度落入此区间即视为模板改版嫌疑 */
export const WATCH_BAND: [number, number] = [0.5, KNOWN_TEMPLATE_THRESHOLD];

const ALL_STAGES: ProcurementStage[] = ['intention', 'announcement', 'correction', 'extension', 'cancellation', 'result'];

export interface TemplateDefinition {
  id: string;
  sourceId: string;
  templateId: string;
  templateVersion: string;
  label: string;
  pageKind: 'intention' | 'announcement' | 'correction' | 'extension' | 'cancellation' | 'result';
  appearanceGroup?: string;
  semanticsNote?: string;
  /** 审核过的参考结构片段；仅结构参考，不代表任何真实项目 */
  referenceText: string;
  /** 字段契约（与模板一同审核） */
  fields: ContractField[];
  semanticsOverrides?: Partial<Record<string, string>>;
  notes?: string[];
}

const code = (stages: ProcurementStage[] = ALL_STAGES): ContractField => ({
  field: 'project_code',
  locality: 'body',
  labelPatterns: ['项目编号', '采购编号', '招标编号'],
  required: true,
  structural: false,
  applicableStages: stages,
  allowedMissingWhen: [],
});

const purchaser = (missing: FieldContract['fields'][number]['allowedMissingWhen'] = ['source_not_disclosed']): ContractField => ({
  field: 'purchaser',
  locality: 'body',
  labelPatterns: ['采购人', '招标人', '采购单位'],
  required: true,
  structural: false,
  applicableStages: ALL_STAGES,
  allowedMissingWhen: missing,
});

const stage = (): ContractField => ({
  field: 'stage',
  locality: 'any',
  labelPatterns: ['公告标题'],
  required: true,
  structural: false,
  applicableStages: ALL_STAGES,
  allowedMissingWhen: [],
});

const date = (patterns = ['公告发布日期', '发布日期', '公告日期', '投标截止时间']): ContractField => ({
  field: 'date',
  locality: 'body',
  labelPatterns: patterns,
  required: true,
  structural: false,
  applicableStages: ALL_STAGES,
  allowedMissingWhen: [],
});

const amount = (stages: ProcurementStage[], patterns = ['预算金额', '采购预算', '最高限价']): ContractField => ({
  field: 'amount',
  locality: 'body',
  labelPatterns: patterns,
  required: true,
  structural: true,
  applicableStages: stages,
  allowedMissingWhen: ['source_not_disclosed', 'source_incomplete', 'structural_unavailable'],
});

const lot = (stages: ProcurementStage[], patterns = ['第#标段', '第#标包']): ContractField => ({
  field: 'lot',
  locality: 'body',
  labelPatterns: patterns,
  required: true,
  structural: true,
  applicableStages: stages,
  allowedMissingWhen: ['source_incomplete', 'structural_unavailable'],
});

const result = (stages: ProcurementStage[] = ['result']): ContractField => ({
  field: 'result',
  locality: 'body',
  labelPatterns: ['中标供应商', '成交供应商'],
  required: true,
  structural: false,
  applicableStages: stages,
  allowedMissingWhen: [],
});

/**
 * 内置模板。referenceText 是“结构样板”，画像器对它生成的签名即审核过的结构指纹。
 */
export const BUILTIN_TEMPLATES: TemplateDefinition[] = [
  {
    id: 'tpl_zj_web_v1',
    sourceId: 'zj',
    templateId: 'zj-web-v1',
    templateVersion: 'v1.0',
    label: '浙江省政府采购网 · 公告网页 v1',
    pageKind: 'announcement',
    appearanceGroup: 'gov-standard-web-v1',
    semanticsNote: '“第一标段/第二标段”表示采购标段，金额标签为“预算金额”。',
    referenceText: [
      '浙江省政府采购网 · 结构样板',
      '当前位置：首页 > 招标公告 > 详情',
      '',
      '示例区智慧校园建设项目招标公告',
      '',
      '项目名称：示例项目名称',
      '项目编号：ZJ2024-000',
      '采购人：示例采购单位',
      '采购方式：公开招标',
      '第一标段：示例标段一',
      '第二标段：示例标段二',
      '预算金额：100.00万元',
      '投标截止时间：2024年1月1日 09:30',
      '公告发布日期：2024年1月1日',
      '联系人：示例联系人',
    ].join('\n'),
    fields: [code(), purchaser(), amount(['intention', 'announcement', 'correction', 'result']), lot(['announcement', 'correction', 'result']), date(), stage(), result()],
    notes: [
      '金额、标段、日期位置依赖网页结构；打印件/缺页样本缺失时不得计为门户漏报。',
      '已知模板的取值差异不影响匹配；新模板必须人工确认后登记。',
    ],
  },
  {
    id: 'tpl_js_web_v1',
    sourceId: 'js',
    templateId: 'js-web-v1',
    templateVersion: 'v1.0',
    label: '江苏政府采购网 · 公告网页 v1',
    pageKind: 'announcement',
    appearanceGroup: 'gov-standard-web-v1',
    semanticsNote: '外观与浙江 v1 相同，但“包件01/02”指投标文件分包（文档包），不是采购标段；金额为含税采购预算。',
    referenceText: [
      '江苏政府采购网 · 结构样板',
      '当前位置：首页 > 采购公告 > 详情',
      '',
      '示例市政务云扩容项目采购公告',
      '',
      '项目名称：示例项目名称',
      '项目编号：JS2024-000',
      '采购人：示例采购单位',
      '采购方式：公开招标',
      '包件01：投标文件包',
      '包件02：图纸文件包',
      '预算金额：100.00万元',
      '投标截止时间：2024年1月1日 09:30',
      '公告发布日期：2024年1月1日',
      '联系人：示例联系人',
    ].join('\n'),
    fields: [code(), purchaser(), amount(['intention', 'announcement', 'correction']), date(), stage(), result(['result'])],
    semanticsOverrides: {
      lot: '本来源“包件01/02”指投标文件分包（文档包），不是采购标段；因此契约不声明 lot 字段，提取器若产出“包件”事实只作观察值，不计入标段提取率。',
      amount: '预算金额为含税采购预算，仅在公告/更正/意向阶段披露。',
    },
    notes: [
      '与浙江 v1 外观相同（appearanceGroup=gov-standard-web-v1），但字段语义不同，质量指标必须按来源分开计算。',
    ],
  },
  {
    id: 'tpl_zj_intention_v1',
    sourceId: 'zj',
    templateId: 'zj-intention-v1',
    templateVersion: 'v1.0',
    label: '浙江门户 · 采购意向页 v1',
    pageKind: 'intention',
    semanticsNote: '采购意向页只披露预算与预计采购时间，不披露标段与结果。',
    referenceText: [
      '浙江省政府采购网 · 结构样板',
      '当前位置：首页 > 采购意向 > 详情',
      '',
      '示例区道路照明改造项目采购意向',
      '',
      '项目名称：示例项目名称',
      '项目编号：ZJ2024-000',
      '采购人：示例采购单位',
      '采购意向内容：示例内容说明',
      '预算金额：100.00万元',
      '预计采购时间：2024年1月',
      '公告日期：2024年1月1日',
    ].join('\n'),
    fields: [code(), purchaser(), amount(['intention']), date(['公告日期', '发布日期', '公告发布日期']), stage()],
  },
  {
    id: 'tpl_zj_correction_v1',
    sourceId: 'zj',
    templateId: 'zj-correction-v1',
    templateVersion: 'v1.0',
    label: '浙江门户 · 更正公告页 v1',
    pageKind: 'correction',
    semanticsNote: '更正公告可能补充或调整预算；预算以“采购预算（含税）”等新写法出现。',
    referenceText: [
      '浙江省政府采购网 · 结构样板',
      '当前位置：首页 > 更正公告 > 详情',
      '',
      '示例区道路照明改造项目更正公告',
      '',
      '项目名称：示例项目名称',
      '项目编号：ZJ2024-000',
      '采购人：示例采购单位',
      '更正事项：示例更正内容',
      '投标截止时间：2024年1月1日 09:30',
      '公告发布日期：2024年1月1日',
    ].join('\n'),
    fields: [
      code(),
      purchaser(),
      amount(['correction', 'announcement'], ['预算金额', '采购预算']),
      date(['公告发布日期', '发布日期', '投标截止时间']),
      stage(),
    ],
  },
  {
    id: 'tpl_zj_result_v1',
    sourceId: 'zj',
    templateId: 'zj-result-v1',
    templateVersion: 'v1.0',
    label: '浙江门户 · 中标结果页 v1',
    pageKind: 'result',
    semanticsNote: '结果页按标段列出中标供应商与中标金额。',
    referenceText: [
      '浙江省政府采购网 · 结构样板',
      '当前位置：首页 > 结果公告 > 详情',
      '',
      '示例区道路照明改造项目中标公告',
      '',
      '项目编号：ZJ2024-000',
      '项目名称：示例项目名称',
      '采购人：示例采购单位',
      '第一标段：示例标段一',
      '中标供应商：示例中标单位',
      '中标金额：100.00万元',
      '公告发布日期：2024年1月1日',
    ].join('\n'),
    fields: [
      code(),
      purchaser(),
      lot(['result']),
      amount(['result'], ['中标金额', '成交金额']),
      result(['result']),
      date(['公告发布日期', '发布日期']),
      stage(),
    ],
  },
  {
    id: 'tpl_js_result_v1',
    sourceId: 'js',
    templateId: 'js-result-v1',
    templateVersion: 'v1.0',
    label: '江苏门户 · 中标结果页 v1',
    pageKind: 'result',
    semanticsNote: '结果页按包件列出中标供应商；“包件”仍指投标文件分包，不作为采购标段。',
    referenceText: [
      '江苏政府采购网 · 结构样板',
      '当前位置：首页 > 结果公告 > 详情',
      '',
      '示例市政务云扩容项目中标公告',
      '',
      '项目名称：示例项目名称',
      '项目编号：JS2024-000',
      '采购人：示例采购单位',
      '包件01：计算资源池',
      '中标供应商：示例中标单位',
      '中标金额：100.00万元',
      '包件02：存储资源池',
      '中标供应商：示例中标单位二',
      '中标金额：50.00万元',
      '公告发布日期：2024年1月1日',
    ].join('\n'),
    fields: [
      code(),
      purchaser(),
      amount(['result'], ['中标金额', '成交金额']),
      result(['result']),
      date(['公告发布日期', '发布日期']),
      stage(),
    ],
    semanticsOverrides: {
      lot: '结果页的“包件”仍指投标文件分包，不作为采购标段；契约不声明 lot。',
    },
  },
];

/** 把审核过的参考结构片段画像为结构签名（忽略取值） */
export function signatureFromReference(refText: string, sourceId: string): TemplateSignature {
  const text = refText.trim();
  const snapshot: Snapshot = {
    id: deterministicId('ref', [sha256HexFallback(text).slice(0, 16)]),
    contentHash: sha256HexFallback(text),
    normalizedHash: sha256HexFallback(text),
    rawText: text,
    sources: [{ fileName: `${sourceId}-reference.txt`, batchId: 'builtin', importedAt: 0, size: text.length }],
    parsed: parseDocument(text, inferSourceKind(`${sourceId}-reference.txt`)),
    createdAt: 0,
  };
  return profileSnapshot(snapshot, sourceId).signature;
}

export interface BuiltinTemplateEntry {
  definition: TemplateDefinition;
  signature: TemplateSignature;
  fingerprint: string;
}

export function buildBuiltinRegistry(): BuiltinTemplateEntry[] {
  return BUILTIN_TEMPLATES.map((definition) => {
    const signature = signatureFromReference(definition.referenceText, definition.sourceId);
    return { definition, signature, fingerprint: fingerprintSignature(signature) };
  });
}

/** 内置字段契约：按来源 + 模板版本分开登记 */
export function buildBuiltinContracts(): FieldContract[] {
  const createdAt = 1_700_000_000_000;
  return BUILTIN_TEMPLATES.map((t) => ({
    id: `contract_${t.templateId.replace(/-/g, '_')}`,
    sourceId: t.sourceId,
    templateId: t.templateId,
    templateVersion: t.templateVersion,
    label: `${t.label} · 字段契约`,
    pageKind: t.pageKind,
    ...(t.appearanceGroup ? { appearanceGroup: t.appearanceGroup } : {}),
    fields: t.fields.map((f) => ({ ...f })),
    ...(t.semanticsOverrides ? { semanticsOverrides: { ...t.semanticsOverrides } } : {}),
    notes: t.notes ?? [],
    origin: 'builtin' as const,
    createdAt,
  }));
}

/**
 * 内置修复补丁：用于“修复回放”。补丁只在固定快照上重算差异，不写回已发布事实。
 * 每个补丁只针对**新写法**，不与基础规则重叠，避免把已提取字段重复计为新增。
 */
export const BUILTIN_REPAIR_PATCHES: RepairRulePatch[] = [
  {
    id: 'patch-amount-tax-inclusive',
    version: 'extractor-patch-1.1.0',
    description: '识别更正公告新写法“采购预算（含税）/预算金额（含税）”后的金额',
    field: 'amount',
    pattern: '(?:采购预算|预算金额)[（(]含税[）)][：:]\\s*([0-9][0-9,，.]*)\\s*(万元|万|元)?',
    valueGroup: 1,
    unitGroup: 2,
    section: 'any',
  },
  {
    id: 'patch-lot-attachment',
    version: 'extractor-patch-1.1.0',
    description: '识别附件化后的标段写法“标段一：……/标段二：……”（缺少“第”字前缀）',
    field: 'lot',
    pattern: '^\\s*(标段[一二三四五六七八九十0-9]+)[：:]\\s*([^\\n，,。；;]{1,40})$',
    valueGroup: 2,
    lotCodeGroup: 1,
    section: 'any',
  },
];

export function patchById(id: string): RepairRulePatch | undefined {
  return BUILTIN_REPAIR_PATCHES.find((p) => p.id === id);
}

/** 同 templateProfile.sourceMeta，供模板库复用，避免重复实现 */
export const sourceMetaOf = sourceMeta;

/** 供 UI 展示：来源元数据 */
export function builtinSourceRefs(): PortalSourceRef[] {
  const ids = [...new Set(BUILTIN_TEMPLATES.map((t) => t.sourceId))];
  return ids
    .map((id) => sourceMeta(id))
    .filter((x): x is PortalSourceRef => !!x);
}
