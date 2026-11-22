/**
 * 抽取质量监测。
 *
 * 按 (来源 · 模板版本 · 期间 · 解析器版本 · 提取器版本) 分组，对每个契约字段判定：
 *   extracted              正常提取
 *   not_disclosed          门户公告本身未披露（真实缺失）
 *   source_incomplete      离线归档文件缺页/截断（离线文件的问题）
 *   structural_unavailable 打印版/无原网页结构，结构字段不可判（打印件的问题）
 *   not_applicable         该阶段本就不应出现该字段
 *   extraction_failed      页面有该标签/结构，但当前规则没识别（解析规则的问题）
 *   unknown_template       未登记模板，全部字段无法按契约判定（等待维护）
 *
 * 指标：
 *   字段提取率 = extracted / (extracted + extraction_failed)
 *   来源缺失率 = not_disclosed / (extracted + extraction_failed + not_disclosed)
 *   解析失败率 = extraction_failed / 同一分母
 *   离线缺页率 = source_incomplete / (同一分母 + source_incomplete)
 *
 * 硬规则：
 *  - 绝不跨来源合并：契约、分组、指标都按 sourceId 隔离。
 *  - 打印版/缺页样本的**结构字段**缺失不计入门户漏报。
 *  - 未知模板不进入分母，只登记样本量与未知页面清单，等待人工维护。
 *  - 契约按来源声明字段语义；同外观不同来源时，未在契约声明的字段只作观察值。
 */
import type {
  ContractField,
  Fact,
  FactType,
  FieldContract,
  FieldOutcome,
  FieldQualityMetric,
  PageKind,
  ProcurementStage,
  QualityGroup,
  QualityRun,
  RegistryMatch,
  Snapshot,
  SnapshotFieldAssessment,
  TemplateProfile,
  TemplateRegistryEntry,
} from './types';
import { primaryStage } from './extractor';
import { EXTRACTOR_VERSION } from './extractor';
import { PARSER_VERSION } from './parser';
import { deterministicId, stableStringify, sha256Hex } from './hash';
import { detectSourceId, profileSnapshot } from './templateProfile';
import { buildRuntime, discoverTemplates, matchProfile, type TemplateRuntime } from './templateLibrary';

const NON_DISCLOSURE = /(暂不(?:公开|披露)|以财政批复为准|未(?:予)?公开|不再单独公布|金额待定|另行公布|详见附件)/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 契约标签模式 → 正则（'#' 匹配任意编号/数字段） */
export function labelPatternToRegExp(pattern: string): RegExp {
  const body = escapeRegExp(pattern).replace(/#/g, '[一二三四五六七八九十百0-9A-Za-z]+');
  return new RegExp(body);
}

function hasLabel(text: string, field: ContractField): boolean {
  return field.labelPatterns.some((p) => labelPatternToRegExp(p).test(text));
}

function factsOf(facts: Fact[], snapshotId: string, type: FactType): Fact[] {
  return facts.filter((f) => f.snapshotId === snapshotId && f.type === type);
}

function docStage(facts: Fact[], snapshotId: string): ProcurementStage | null {
  return primaryStage(factsOf(facts, snapshotId, 'stage').map((f) => f.stage!).filter(Boolean));
}

function isApplicable(field: ContractField, stage: ProcurementStage | null): boolean {
  if (!stage) return true;
  return field.applicableStages.includes(stage);
}

export interface QualityRunOptions {
  /** 只统计文件名含该前缀的归档（如 'quality/'） */
  pathPrefix?: string;
  /** 只统计指定来源 */
  sourceIds?: string[];
}

export interface QualityInput {
  snapshots: Snapshot[];
  facts: Fact[];
  confirmedTemplates: TemplateRegistryEntry[];
  confirmedContracts: FieldContract[];
  /** 'quality-samples' 只统计文件名以 quality/ 开头的归档 */
  scope: 'all' | 'quality-samples';
  runOptions?: QualityRunOptions;
  now: number;
}

export interface QualityAnalysis {
  run: QualityRun;
  profiles: TemplateProfile[];
  runtime: TemplateRuntime;
  matches: RegistryMatch[];
  /** 供 UI 直接使用的逐快照摘要（文件名、状态、期间、模板、失败字段） */
  snapshotSummaries: SnapshotQualitySummary[];
}

export interface SnapshotQualitySummary {
  snapshotId: string;
  fileName: string;
  sourceId: string;
  pageKind: PageKind;
  period: string | null;
  fingerprint: string;
  templateId: string | null;
  templateVersion: string | null;
  status: 'known' | 'print' | 'unknown';
  matchKind: RegistryMatch['matchKind'];
  similarity?: number;
  printLikely: boolean;
  pageIncomplete: boolean;
  extractionFailedFields: FactType[];
  structuralUnavailableFields: FactType[];
  notDisclosedFields: FactType[];
  sourceIncompleteFields: FactType[];
  /** 未登记页面上出现了契约期望的标签、但提取器未产出：疑似规则不识别新模板 */
  templateChangeSuspectedFields: FactType[];
}

export async function runQuality(input: QualityInput): Promise<QualityAnalysis> {
  const runtime = buildRuntime(input.confirmedTemplates, input.confirmedContracts);
  const prefix = input.runOptions?.pathPrefix;
  // 范围过滤在画像之前完成：不参与本次统计的快照不会产生任何指标分母
  const scopedAll = input.snapshots.filter(
    (s) =>
      (input.scope === 'all' ||
        s.sources.some((src) => src.fileName.startsWith('quality/') || src.fileName.includes('/quality/'))) &&
      (!prefix || s.sources.some((src) => src.fileName.startsWith(prefix))),
  );

  // 画像 + 匹配（先对全部候选画像以定位来源，再按 sourceIds 过滤）
  const profiles: TemplateProfile[] = [];
  const matches: RegistryMatch[] = [];
  const scoped: Snapshot[] = [];
  for (const s of scopedAll) {
    const fileName = s.sources[0]?.fileName ?? '';
    const sourceId = detectSourceId(fileName, s.rawText);
    if (!sourceId) {
      if (input.runOptions?.sourceIds && input.runOptions.sourceIds.length > 0) continue;
      // 无法归属来源：标为未知，不做跨来源猜测
      matches.push({
        snapshotId: s.id,
        sourceId: 'unknown',
        fingerprint: '',
        templateId: null,
        templateVersion: null,
        status: 'unknown',
        matchKind: 'unknown',
        note: '无法从文件名或正文识别门户来源，标记为未知并等待维护。',
      });
      profiles.push({ ...profileSnapshot(s, 'unknown') });
      scoped.push(s);
      continue;
    }
    if (input.runOptions?.sourceIds && input.runOptions.sourceIds.length > 0 && !input.runOptions.sourceIds.includes(sourceId)) {
      continue;
    }
    const profile = profileSnapshot(s, sourceId);
    profiles.push(profile);
    matches.push(matchProfile(profile, runtime));
    scoped.push(s);
  }

  const discoveries = discoverTemplates(profiles, matches);

  // 逐字段评估
  const assessments: SnapshotFieldAssessment[] = [];
  const unknownSnapshotIds: string[] = [];
  const printSnapshotIds: string[] = [];
  const incompleteSnapshotIds: string[] = [];

  for (const s of scoped) {
    const profile = profiles.find((p) => p.snapshotId === s.id)!;
    const match = matches.find((m) => m.snapshotId === s.id)!;
    const sourceId = profile.sourceId;
    const raw = s.rawText;

    if (profile.pageIncomplete) incompleteSnapshotIds.push(s.id);
    if (profile.printLikely) printSnapshotIds.push(s.id);
    if (match.status === 'unknown') unknownSnapshotIds.push(s.id);

    let contract: FieldContract | undefined;
    if (match.templateId) {
      contract =
        runtime.contracts.find(
          (c) => c.sourceId === sourceId && c.templateId === match.templateId && c.templateVersion === match.templateVersion,
        ) ?? runtime.contracts.find((c) => c.sourceId === sourceId && c.templateId === match.templateId);
    }

    const stage = docStage(input.facts, s.id);

    if (match.status === 'unknown') {
      // 未知页面的字段集合限定在**本来源**已登记契约的字段并集，绝不并入其它来源字段
      const sourceFieldUnion = allContractFields(runtime.contracts.filter((c) => c.sourceId === sourceId));
      const fields = sourceFieldUnion.length ? sourceFieldUnion : allContractFields(runtime.contracts);
      for (const field of fields) {
        assessments.push({
          snapshotId: s.id,
          sourceId,
          templateId: null,
          templateStatus: 'unknown',
          field,
          outcome: 'unknown_template',
          reason: '未登记模板，无法按字段契约判定，需人工确认后登记新模板版本。',
        });
      }
      continue;
    }

    // 打印版：沿用本来源的既有契约解释字段语义，但模板状态记为 print，
    // 结构字段缺失归因“结构不可用”，绝不作为门户漏报。
    if (!contract && match.status === 'print') {
      contract = runtime.contracts
        .filter((c) => c.sourceId === sourceId)
        .sort((a, b) => b.templateVersion.localeCompare(a.templateVersion))[0];
    }

    if (!contract) {
      // 已知模板缺契约（理论上不应发生）：同样标 unknown，避免臆测
      for (const field of allContractFields(runtime.contracts)) {
        assessments.push({
          snapshotId: s.id,
          sourceId,
          templateId: match.templateId,
          templateStatus: 'unknown',
          field,
          outcome: 'unknown_template',
          reason: '模板已登记但缺少对应字段契约，等待维护。',
        });
      }
      continue;
    }

    const templateStatus: 'known' | 'print' = match.status === 'print' ? 'print' : 'known';
    const hintFields = new Set(profile.neighborhoods.map((n) => n.fieldHint));
    for (const cf of contract.fields) {
      const produced = factsOf(input.facts, s.id, cf.field);
      const applicable = isApplicable(cf, stage);

      let outcome: FieldOutcome;
      let reason: string;

      if (produced.length > 0) {
        // 只要页面确实出现了可提取值就算提取成功；阶段不适用时额外披露不算失败
        outcome = 'extracted';
        reason = `由规则 ${produced[0].ruleId} 提取 ${produced.length} 条${!applicable ? `（阶段 ${stage} 非该字段必披露阶段，属额外披露）` : ''}。`;
      } else if (!applicable) {
        outcome = 'not_applicable';
        reason = `阶段 ${stage ?? '未知'} 不属于该字段可披露阶段（${cf.applicableStages.join('/')}）。`;
      } else if (templateStatus === 'print' && cf.structural) {
        outcome = 'structural_unavailable';
        reason = '快照为打印版，缺少原网页结构；结构字段缺失不得计为门户漏报。';
      } else if (profile.pageIncomplete && cf.structural) {
        outcome = 'source_incomplete';
        reason = '离线文件缺页/截断（含“下页续”等标记），字段缺失源于离线归档不完整。';
      } else if (NON_DISCLOSURE.test(raw) && (hasLabel(raw, cf) || expectedLocalityPresent(profile, cf))) {
        outcome = 'not_disclosed';
        reason = '公告本身声明暂不公开/以批复为准，属于真实未披露。';
      } else if (hasLabel(raw, cf) || expectedLocalityPresent(profile, cf) || hintFields.has(cf.field)) {
        outcome = 'extraction_failed';
        reason = `页面存在“${cf.labelPatterns.join('、')}”结构（含附件/折叠栏内的字段标签），但当前规则未识别（疑似模板改版或规则缺失）。`;
      } else {
        outcome = 'not_disclosed';
        reason = '契约期望该字段，但公告正文未出现对应标签，判定为门户未披露。';
      }

      assessments.push({
        snapshotId: s.id,
        sourceId,
        templateId: match.templateId ?? contract.templateId,
        templateStatus,
        field: cf.field,
        outcome,
        reason,
        ...(produced[0] ? { evidence: produced[0].evidence.text } : {}),
      });
    }
  }

  // 分组
  const groups = buildGroups(scoped, profiles, matches, assessments, runtime, input.facts);
  const run: QualityRun = {
    id: '',
    createdAt: input.now,
    datasetScope: input.scope,
    parserVersion: PARSER_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    groups,
    assessments,
    unknownSnapshotIds: [...new Set(unknownSnapshotIds)].sort(),
    printSnapshotIds: [...new Set(printSnapshotIds)].sort(),
    incompleteSnapshotIds: [...new Set(incompleteSnapshotIds)].sort(),
    totals: {
      snapshotCount: scoped.length,
      knownTemplateCount: matches.filter((m) => m.status === 'known').length,
      printSnapshotCount: new Set(printSnapshotIds).size,
      unknownTemplateCount: new Set(unknownSnapshotIds).size,
      contractCount: runtime.contracts.length,
    },
    discoveries,
  };
  const runId = deterministicId('qr', [
    await sha256Hex(stableStringify({ ids: scoped.map((s) => s.id).sort(), scope: input.scope, prefix: prefix ?? '' })),
    input.now,
  ]);
  run.id = runId;

  // 逐快照摘要（供 UI 展示画像、匹配结果与各字段归因）
  const snapshotSummaries: SnapshotQualitySummary[] = scoped.map((s) => {
    const p = profiles.find((x) => x.snapshotId === s.id)!;
    const m = matches.find((x) => x.snapshotId === s.id)!;
    const mine = assessments.filter((a) => a.snapshotId === s.id);
    // 未知页面：不进入任何提取率，但仍诊断“页面存在该标签却未提取”，
    // 让研究者能区分“门户未披露”和“解析规则不再识别新模板”。
    const suspected = new Set<FactType>();
    if (m.status === 'unknown') {
      const pageText = s.rawText;
      const producedTypes = new Set(input.facts.filter((f) => f.snapshotId === s.id).map((f) => f.type));
      const contractPool = runtime.contracts.filter((c) => c.sourceId === p.sourceId);
      const seenField = new Set<FactType>();
      for (const c of contractPool) {
        for (const cf of c.fields) {
          if (seenField.has(cf.field)) continue;
          seenField.add(cf.field);
          if (cf.field === 'stage') continue;
          if (producedTypes.has(cf.field)) continue;
          if (cf.labelPatterns.some((pat) => labelPatternToRegExp(pat).test(pageText))) suspected.add(cf.field);
        }
      }
      for (const n of p.neighborhoods) {
        if (n.fieldHint !== 'unknown' && !producedTypes.has(n.fieldHint)) suspected.add(n.fieldHint as FactType);
      }
    }
    return {
      snapshotId: s.id,
      fileName: s.sources[0]?.fileName ?? s.id,
      sourceId: p.sourceId,
      pageKind: p.pageKind,
      period: p.period,
      fingerprint: p.fingerprint || m.fingerprint,
      templateId: m.templateId,
      templateVersion: m.templateVersion,
      status: m.status,
      matchKind: m.matchKind,
      ...(m.nearestKnown ? { similarity: m.nearestKnown.similarity } : {}),
      printLikely: p.printLikely,
      pageIncomplete: p.pageIncomplete,
      extractionFailedFields: mine.filter((a) => a.outcome === 'extraction_failed').map((a) => a.field),
      structuralUnavailableFields: mine.filter((a) => a.outcome === 'structural_unavailable').map((a) => a.field),
      notDisclosedFields: mine.filter((a) => a.outcome === 'not_disclosed').map((a) => a.field),
      sourceIncompleteFields: mine.filter((a) => a.outcome === 'source_incomplete').map((a) => a.field),
      templateChangeSuspectedFields: [...suspected],
    };
  });

  return { run, profiles, runtime, matches, snapshotSummaries };
}

function expectedLocalityPresent(profile: TemplateProfile, cf: ContractField): boolean {
  if (cf.locality === 'attachment') return profile.fragments.some((f) => f.kind === 'attachment' || f.kind === 'attachment_heading');
  if (cf.locality === 'fold') return profile.fragments.some((f) => f.kind === 'fold');
  return false;
}

function allContractFields(contracts: FieldContract[]): FactType[] {
  const set = new Set<FactType>();
  for (const c of contracts) for (const f of c.fields) set.add(f.field);
  return [...set].sort();
}

function outcomeCounter() {
  return {
    extracted: 0,
    notDisclosed: 0,
    sourceIncomplete: 0,
    structuralUnavailable: 0,
    notApplicable: 0,
    extractionFailed: 0,
    unknownTemplate: 0,
  };
}

function ratio(a: number, b: number): number | null {
  return b > 0 ? Number((a / b).toFixed(4)) : null;
}

function buildGroups(
  scoped: Snapshot[],
  profiles: TemplateProfile[],
  matches: RegistryMatch[],
  assessments: SnapshotFieldAssessment[],
  runtime: TemplateRuntime,
  facts: Fact[],
): QualityGroup[] {
  // key = source|templateId|version|period|parser|extractor|status
  const groups = new Map<string, { snapshotIds: string[]; sourceId: string; templateId: string; templateVersion: string; pageKind: PageKind; status: 'known' | 'print'; period: string; parserVersion: string; extractorVersion: string }>();

  for (const s of scoped) {
    const p = profiles.find((x) => x.snapshotId === s.id)!;
    const m = matches.find((x) => x.snapshotId === s.id)!;
    if (m.status === 'unknown') continue; // 未知模板单独处理，不进分组率
    const status: 'known' | 'print' = m.status === 'print' ? 'print' : 'known';
    const templateId = m.templateId ?? 'print';
    const templateVersion = m.templateVersion ?? '—';
    const period = p.period ?? 'unknown';
    const key = [p.sourceId, templateId, templateVersion, period, s.parsed.parserVersion, EXTRACTOR_VERSION, status].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        snapshotIds: [],
        sourceId: p.sourceId,
        templateId,
        templateVersion,
        pageKind: p.pageKind,
        status,
        period,
        parserVersion: s.parsed.parserVersion,
        extractorVersion: EXTRACTOR_VERSION,
      });
    }
    groups.get(key)!.snapshotIds.push(s.id);
  }

  const out: QualityGroup[] = [];
  for (const [key, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const contract = runtime.contracts.find(
      (c) => c.sourceId === g.sourceId && c.templateId === g.templateId && c.templateVersion === g.templateVersion,
    ) ?? runtime.contracts.find((c) => c.sourceId === g.sourceId && c.templateId === g.templateId);

    const fieldTypes: FactType[] = contract
      ? contract.fields.map((f) => f.field)
      : allContractFields(runtime.contracts);

    const fields: FieldQualityMetric[] = fieldTypes.map((field) => {
      const c = outcomeCounter();
      for (const sid of g.snapshotIds) {
        const a = assessments.find(
          (x) => x.snapshotId === sid && x.field === field && (x.templateStatus === 'known' || x.templateStatus === 'print'),
        );
        if (!a) continue;
        if (a.outcome === 'extracted') c.extracted += 1;
        else if (a.outcome === 'not_disclosed') c.notDisclosed += 1;
        else if (a.outcome === 'source_incomplete') c.sourceIncomplete += 1;
        else if (a.outcome === 'structural_unavailable') c.structuralUnavailable += 1;
        else if (a.outcome === 'not_applicable') c.notApplicable += 1;
        else if (a.outcome === 'extraction_failed') c.extractionFailed += 1;
        else if (a.outcome === 'unknown_template') c.unknownTemplate += 1;
      }
      const informative = c.extracted + c.extractionFailed + c.notDisclosed;
      const expected = c.extracted + c.extractionFailed + c.notDisclosed + c.sourceIncomplete + c.structuralUnavailable + c.notApplicable;
      return {
        field,
        expected,
        extracted: c.extracted,
        notDisclosed: c.notDisclosed,
        sourceIncomplete: c.sourceIncomplete,
        structuralUnavailable: c.structuralUnavailable,
        notApplicable: c.notApplicable,
        extractionFailed: c.extractionFailed,
        unknownTemplate: c.unknownTemplate,
        extractionRate: ratio(c.extracted, c.extracted + c.extractionFailed),
        sourceMissingRate: ratio(c.notDisclosed, informative),
        parseFailureRate: ratio(c.extractionFailed, informative),
        offlineIncompleteRate: ratio(c.sourceIncomplete, informative + c.sourceIncomplete),
      };
    });

    // 契约外字段（如江苏“包件”不是采购标段）：仅作观察值，不进入任何提取率
    const offContractCounts: Record<string, number> = {};
    if (contract) {
      const declared = new Set(contract.fields.map((f) => f.field));
      for (const sid of g.snapshotIds) {
        for (const f of facts.filter((x) => x.snapshotId === sid)) {
          if (!declared.has(f.type)) offContractCounts[f.type] = (offContractCounts[f.type] ?? 0) + 1;
        }
      }
    }

    const notes: string[] = [];
    if (contract?.semanticsOverrides) {
      for (const [k, v] of Object.entries(contract.semanticsOverrides)) notes.push(`【语义】${k}：${v}`);
    }
    if (g.status === 'print') {
      notes.push('打印版分组：结构字段缺失记为“结构不可用”，不计入门户漏报率。');
    }

    out.push({
      id: deterministicId('qg', [key]),
      sourceId: g.sourceId,
      templateId: g.templateId,
      templateVersion: g.templateVersion,
      pageKind: g.pageKind,
      templateStatus: g.status,
      period: g.period,
      parserVersion: g.parserVersion,
      extractorVersion: g.extractorVersion,
      sampleSize: g.snapshotIds.length,
      snapshotIds: [...g.snapshotIds].sort(),
      fields,
      offContractCounts,
      notes,
    });
  }
  return out;
}

/** 已知模板条目按来源的摘要，供 UI */
export function summarizeRegistry(entries: TemplateRegistryEntry[]) {
  const bySource = new Map<string, TemplateRegistryEntry[]>();
  for (const e of entries) {
    if (!bySource.has(e.sourceId)) bySource.set(e.sourceId, []);
    bySource.get(e.sourceId)!.push(e);
  }
  return [...bySource.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sourceId, list]) => ({
      sourceId,
      templates: list.sort((a, b) => a.templateId.localeCompare(b.templateId)),
    }));
}
