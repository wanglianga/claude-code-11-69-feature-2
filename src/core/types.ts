/**
 * 全局领域类型定义。
 * 所有持久化对象均带版本字段，结构解析器/提取器升级时可区分解析版本。
 */

// ---------- 计算模式 ----------
export type ComputeMode = 'full' | 'incremental';

// ---------- 文档结构 ----------
export type SectionKind =
  | 'announcement' // 公告正文
  | 'attachment' // 附件摘要
  | 'noise'; // 站点噪声（导航、页脚、版权、广告等）

export interface TextSpan {
  /** 相对原文的字符偏移（基于规范化前原文） */
  start: number;
  end: number;
  /** 片段原文，可直接在界面高亮定位 */
  text: string;
}

export interface StructuredSection {
  kind: SectionKind;
  heading: string;
  span: TextSpan;
}

export interface StructuredDocument {
  parserVersion: string;
  /** 去掉站点噪声后、用于事实提取的正文纯文本 */
  bodyText: string;
  sections: StructuredSection[];
  noiseSpans: TextSpan[];
  /** 原始文件名中的扩展名/来源线索 */
  sourceKind: 'webpage' | 'print' | 'copytext' | 'attachment';
}

// ---------- 快照仓 ----------
export interface FileSource {
  /** 导入时的文件名 */
  fileName: string;
  /** 导入批次 id */
  batchId: string;
  /** 导入时间戳（由调用方传入，保证可复跑） */
  importedAt: number;
  /** 文件大小（字节） */
  size: number;
  /** 可选的来源 URL（网页归档） */
  originUrl?: string;
}

export interface Snapshot {
  id: string;
  /** 内容指纹 SHA-256（十六进制），相同内容不同文件名合并的依据 */
  contentHash: string;
  /** 规范化文本哈希，用于识别空白/排版差异导致的“同件副本” */
  normalizedHash: string;
  /** 原始文本内容 */
  rawText: string;
  /** 合并保存的全部来源记录（同一内容可有多条来源） */
  sources: FileSource[];
  /** 解析结果（首次导入时生成并冻结） */
  parsed: StructuredDocument;
  createdAt: number;
}

export interface ImportBatch {
  id: string;
  label: string;
  createdAt: number;
  /** 本批尝试导入的文件数 */
  inputCount: number;
  /** 新建快照数 */
  newSnapshotCount: number;
  /** 因内容指纹相同而合并来源的文件数 */
  mergedCount: number;
  /** 启动时快照冻结后到达、被推迟到后续批次的文件数 */
  deferredCount: number;
  snapshotIds: string[];
}

// ---------- 事实提取 ----------
export type FactType =
  | 'project_code'
  | 'purchaser'
  | 'lot'
  | 'amount'
  | 'date'
  | 'stage'
  | 'result';

export type ProcurementStage =
  | 'intention' // 意向
  | 'announcement' // 招标/采购公告
  | 'correction' // 更正
  | 'extension' // 延期
  | 'cancellation' // 撤销
  | 'result'; // 中标/成交结果

export interface ExtractionRule {
  id: string;
  ruleVersion: string;
  /** 规则可读描述，发布字段回溯用 */
  description: string;
}

export interface Fact {
  id: string;
  snapshotId: string;
  sectionKind: SectionKind;
  type: FactType;
  /** 规范化值（编号去空格、金额统一为元数值等） */
  value: string;
  /** 金额事实的数值（单位：元），其余类型为 undefined */
  amountCny?: number;
  /** 标段事实携带的标段号 */
  lotCode?: string;
  /** 日期事实携带的 ISO 日期 */
  isoDate?: string;
  /** 阶段事实携带的阶段枚举 */
  stage?: ProcurementStage;
  /** 结果事实携带的中标人 */
  winner?: string;
  evidence: TextSpan;
  /** 由哪条提取规则产生 */
  ruleId: string;
  ruleVersion: string;
  extractorVersion: string;
}

// ---------- 关系求值 ----------
export type EdgeType =
  | 'duplicate' // 同件副本
  | 'stage_chain' // 同一项目阶段演进
  | 'suspected_correction' // 疑似更正
  | 'suspected_restart' // 疑似重启
  | 'conflict'; // 互斥冲突（只能待裁决，禁止自动合并）

export type EdgeStatus = 'pending' | 'confirmed' | 'rejected';

export interface RelationEdge {
  id: string;
  type: EdgeType;
  status: EdgeStatus;
  fromSnapshotId: string;
  toSnapshotId: string;
  /** 求值器给出的可读理由（命中了哪些事实/指纹） */
  reasons: string[];
  /** 共享/冲突的事实键，便于人工复核 */
  evidenceFactIds: string[];
  /** 求值器版本与输入快照水位，保证可复算 */
  evaluatorVersion: string;
  /** 参与计算的全部快照 id（固定快照集） */
  inputSnapshotIds: string[];
  createdAt: number;
}

// ---------- 裁决 ----------
export interface Adjudication {
  id: string;
  edgeId: string;
  decision: 'confirm' | 'reject' | 'split';
  /** 审核结论说明 */
  note: string;
  /** 审核员（本地工作台默认 default-reviewer） */
  reviewer: string;
  /** 裁决适用的证据（事实 id 列表） */
  appliedFactIds: string[];
  createdAt: number;
  /** 被本裁决撤回的旧裁决 id（重新裁决时） */
  supersedesAdjudicationId?: string;
}

export interface WithdrawnEdgeRecord {
  edgeId: string;
  reason: string;
  adjudicationId: string;
  withdrawnAt: number;
}

// ---------- 发布 ----------
export interface PublishedLot {
  lotCode: string;
  lotName: string;
  budgetCny: number | null;
  winner: string | null;
  /** 每个字段都能回溯到事实 → 快照 */
  fieldProvenance: Record<string, { factId: string; snapshotId: string }>;
}

export interface PublishedProject {
  projectCode: string;
  purchaser: string;
  /** 项目链：按日期排序的阶段快照序列 */
  stageChain: { stage: ProcurementStage; snapshotId: string; isoDate: string | null }[];
  lots: PublishedLot[];
  /** 当前适用预算（元），取最新已确认阶段证据 */
  currentBudgetCny: number | null;
  /** 预算变动轨迹（含被更正覆盖的历史值及其依据） */
 BudgetHistory: { amountCny: number; snapshotId: string; isoDate: string | null; ruleId: string }[];
  /** 项目分组合法性依据：确认边与裁决 id */
  supportingEdgeIds: string[];
  supportingAdjudicationIds: string[];
  /** 组内被驳回/拆分的冲突边，留痕说明为何没有自动合并 */
  conflictEdgeIds: string[];
  fieldProvenance: Record<string, { factId: string; snapshotId: string }>;
}

export interface PublicationStats {
  projectCount: number;
  lotCount: number;
  totalBudgetCny: number;
  resultCount: number;
  /** 按省份/采购人维度的简单统计 */
  byPurchaser: Record<string, { projects: number; budgetCny: number }>;
}

export interface Publication {
  id: string;
  version: number;
  createdAt: number;
  /** 发布时的裁决水位（裁决 id 排序集） */
  adjudicationWatermark: string[];
  /** 参与计算的快照水位 */
  snapshotWatermark: string[];
  computeMode: ComputeMode;
  /** 全量：null；增量：实际重算的连通分量 id 与跳过分量数 */
  computeScope: {
    recomputedComponents: string[];
    skippedComponents: number;
    dependencyHash: string;
  };
  evaluatorVersion: string;
  extractorVersion: string;
  parserVersion: string;
  projects: PublishedProject[];
  stats: PublicationStats;
}

// ---------- 运行状态 ----------
export interface PipelineProgress {
  phase: 'idle' | 'parsing' | 'extracting' | 'evaluating' | 'publishing' | 'profiling' | 'quality';
  current: number;
  total: number;
  message: string;
}

// ============================================================
// 门户模板演变与抽取质量监测
// ============================================================

/** 采购门户来源（模板契约、质量指标都按来源隔离，绝不跨来源共用） */
export interface PortalSourceRef {
  id: string;
  province: string;
  portalName: string;
}

/** 从快照文本抽取出的结构片段（不包含具体取值，仅结构） */
export interface StructureFragment {
  index: number;
  kind: 'title' | 'heading' | 'label' | 'paragraph' | 'fold' | 'attachment' | 'attachment_heading';
  /** 标签形状（数字/字母已掩码，例如“第#标段”“投资估算（万元）”） */
  labelShape: string;
  lengthBucket: 'S' | 'M' | 'L';
  hasValue: boolean;
  sectionKind: SectionKind;
  start: number;
  end: number;
}

export interface HeadingNode {
  level: number;
  text: string;
  /** 归一化标题（数字/编号掩码），用于跨实例结构比对 */
  normalized: string;
  start: number;
  end: number;
}

/** 字段邻域指纹：字段标签 + 前后标签 + 局部取值形状，用于诊断与聚类 */
export interface FieldNeighborhood {
  fieldHint: FactType | 'unknown';
  labelShape: string;
  sectionKind: SectionKind;
  positionBucket: 'top' | 'middle' | 'bottom';
  beforeLabels: string[];
  afterLabels: string[];
  valueShape: string;
  fingerprint: string;
}

/** 审核过的模板结构签名：忽略取值、保留标签顺序/标题层级/折叠与附件结构 */
export interface TemplateSignature {
  labelSequence: string[];
  headingSkeleton: string[];
  neighborhoodHashes: string[];
  hasFold: boolean;
  hasAttachment: boolean;
  structuralUnavailable: boolean;
  /** 段落长度与字段位置/长度分布，供聚类发现渐进式改版 */
  stats: {
    labelCount: number;
    paragraphCount: number;
    meanParagraphLen: number;
    positionHist: { top: number; middle: number; bottom: number };
    lengthHist: { S: number; M: number; L: number };
  };
}

/** 页面类型：同一来源下不同页面类型使用不同模板，匹配时不得跨类型 */
export type PageKind = 'intention' | 'announcement' | 'correction' | 'extension' | 'cancellation' | 'result';

/** 单个快照的模板画像 */
export interface TemplateProfile {
  snapshotId: string;
  sourceId: string;
  period: string | null;
  documentDate: string | null;
  pageKind: PageKind;
  parserVersion: string;
  signature: TemplateSignature;
  fingerprint: string;
  fragments: StructureFragment[];
  headings: HeadingNode[];
  neighborhoods: FieldNeighborhood[];
  structuralUnavailable: boolean;
  printLikely: boolean;
  pageIncomplete: boolean;
  noHeadingStructure: boolean;
}

export interface TemplateRegistryEntry {
  id: string;
  sourceId: string;
  templateId: string;
  templateVersion: string;
  label: string;
  pageKind: PageKind;
  origin: 'builtin' | 'confirmed';
  /** 同一模板版本可登记多个结构指纹（渐进式改版确认后合并维护） */
  fingerprints: string[];
  signature: TemplateSignature;
  /** 跨来源同外观时用于说明“同形”关系，但契约仍按来源分开 */
  appearanceGroup?: string;
  semanticsNote?: string;
  confirmedBy?: string;
  createdAt: number;
}

/** 字段允许缺失的条件（必须可区分“门户未披露 / 离线缺页 / 结构不可用 / 规则不识别”） */
export type MissingReason =
  | 'stage_not_applicable'
  | 'source_not_disclosed'
  | 'source_incomplete'
  | 'structural_unavailable'
  | 'semantics_differs'
  | 'template_version_mismatch';

export interface ContractField {
  field: FactType;
  /** 期望出现的结构位置 */
  locality: 'body' | 'attachment' | 'fold' | 'any';
  /** 标签模式（'#' 代表任意编号/数字段） */
  labelPatterns: string[];
  required: boolean;
  /** 是否依赖网页结构（打印件/无结构文件缺失时不得当作门户漏报） */
  structural: boolean;
  /** 该字段在哪些阶段应当披露；其它阶段记为“阶段不适用” */
  applicableStages: ProcurementStage[];
  allowedMissingWhen: MissingReason[];
  semantics?: string;
}

export interface FieldContract {
  id: string;
  sourceId: string;
  templateId: string;
  templateVersion: string;
  label: string;
  pageKind: PageKind;
  appearanceGroup?: string;
  fields: ContractField[];
  /** 本来源字段语义覆盖，例如“包件”在湖南代表文档包而非采购标段 */
  semanticsOverrides?: Partial<Record<FactType, string>>;
  notes: string[];
  origin: 'builtin' | 'confirmed';
  createdAt: number;
}

export type FieldOutcome =
  | 'extracted'
  | 'not_disclosed'
  | 'source_incomplete'
  | 'structural_unavailable'
  | 'not_applicable'
  | 'extraction_failed'
  | 'unknown_template';

export interface SnapshotFieldAssessment {
  snapshotId: string;
  sourceId: string;
  templateId: string | null;
  templateStatus: 'known' | 'print' | 'unknown';
  field: FactType;
  outcome: FieldOutcome;
  reason: string;
  evidence?: string;
}

export interface FieldQualityMetric {
  field: FactType;
  expected: number;
  extracted: number;
  notDisclosed: number;
  sourceIncomplete: number;
  structuralUnavailable: number;
  notApplicable: number;
  extractionFailed: number;
  unknownTemplate: number;
  /** 提取率 = extracted / (extracted + extractionFailed)，剔除不可用样本 */
  extractionRate: number | null;
  /** 来源缺失率 = notDisclosed / 可披露样本 */
  sourceMissingRate: number | null;
  /** 解析失败率 = extractionFailed / 可披露样本 */
  parseFailureRate: number | null;
  /** 离线缺页率 = sourceIncomplete / 可披露样本 */
  offlineIncompleteRate: number | null;
}

export interface QualityGroup {
  id: string;
  sourceId: string;
  templateId: string;
  templateVersion: string;
  pageKind: PageKind;
  templateStatus: 'known' | 'print';
  period: string;
  parserVersion: string;
  extractorVersion: string;
  sampleSize: number;
  snapshotIds: string[];
  fields: FieldQualityMetric[];
  /** 契约未声明、但提取器产出的事实（如跨来源同形异义中的“包件”） */
  offContractCounts: Record<string, number>;
  notes: string[];
}

export interface RegistryMatch {
  snapshotId: string;
  sourceId: string;
  fingerprint: string;
  templateId: string | null;
  templateVersion: string | null;
  status: 'known' | 'print' | 'unknown';
  matchKind: 'exact' | 'approximate' | 'print' | 'unknown';
  nearestKnown?: { templateId: string; similarity: number };
  note?: string;
}

export interface TemplateCluster {
  id: string;
  sourceId: string;
  pageKind: PageKind;
  memberSnapshotIds: string[];
  memberCount: number;
  fingerprints: string[];
  labelSamples: string[];
  meanSimilarity: number;
  periods: string[];
  nearestKnown?: { templateId: string; similarity: number };
  /** 渐进式改版信号：后一期间与已知模板的相似度低于前一期间 */
  progressiveDrift: boolean;
  status: 'candidate';
}

export interface DriftAlert {
  sourceId: string;
  pageKind: PageKind;
  clusterId?: string;
  snapshotId?: string;
  nearestKnownTemplateId: string;
  similarity: number;
  periods: string[];
  progressive: boolean;
  message: string;
}

export interface TemplateDiscovery {
  matches: RegistryMatch[];
  unknowns: RegistryMatch[];
  clusters: TemplateCluster[];
  driftAlerts: DriftAlert[];
}

export interface TemplateAnnotation {
  id: string;
  sourceId: string;
  fingerprint: string;
  memberSnapshotIds: string[];
  decision: 'confirmed' | 'dismissed';
  reviewer: string;
  note: string;
  createdAt: number;
  resultingTemplateId?: string;
}

export interface QualityRun {
  id: string;
  createdAt: number;
  datasetScope: 'all' | 'quality-samples';
  parserVersion: string;
  extractorVersion: string;
  groups: QualityGroup[];
  assessments: SnapshotFieldAssessment[];
  unknownSnapshotIds: string[];
  printSnapshotIds: string[];
  incompleteSnapshotIds: string[];
  totals: {
    snapshotCount: number;
    knownTemplateCount: number;
    printSnapshotCount: number;
    unknownTemplateCount: number;
    contractCount: number;
  };
  discoveries: TemplateDiscovery;
}

// ---------- 影响定位 ----------
export interface ImpactedProject {
  publicationId: string;
  publicationVersion: number;
  projectCode: string;
  sourceId: string;
  fields: string[];
  snapshotIds: string[];
  statsAffected: boolean;
}

export interface ImpactedPublication {
  id: string;
  version: number;
  createdAt: number;
  fields: string[];
  projectCount: number;
  statsAffected: boolean;
  reason: string;
}

export interface ImpactReport {
  id: string;
  createdAt: number;
  kind: 'template_change' | 'rule_repair';
  sourceId?: string;
  fromTemplateId?: string;
  toTemplateId?: string;
  field?: FactType;
  affectedSnapshotIds: string[];
  affectedProjects: ImpactedProject[];
  affectedPublications: ImpactedPublication[];
  affectedStats: string[];
  notes: string[];
}

// ---------- 修复回放 ----------
export interface RepairRulePatch {
  id: string;
  version: string;
  description: string;
  field: FactType;
  /** 完整正则源码；捕获组按 valueGroup/unitGroup/lotCodeGroup 取值 */
  pattern: string;
  valueGroup: number;
  unitGroup?: number;
  /** lot 字段：捕获组给出标段编号（如“标段一”） */
  lotCodeGroup?: number;
  section?: SectionKind | 'any';
}

export interface RepairDiffEntry {
  snapshotId: string;
  field: FactType;
  change: 'added' | 'removed' | 'changed';
  value: string;
  previousValue?: string;
  evidence: TextSpan;
  ruleId: string;
}

export interface RepairReplayReport {
  id: string;
  createdAt: number;
  patchIds: string[];
  patchVersion: string;
  snapshotWatermark: string[];
  diffs: RepairDiffEntry[];
  addedByField: Record<string, number>;
  affectedSnapshotIds: string[];
  affectedProjects: ImpactedProject[];
  affectedPublications: ImpactedPublication[];
  /** 固定快照回放只产出报告，不改写已发布事实 */
  publishedFactsUntouched: true;
}
