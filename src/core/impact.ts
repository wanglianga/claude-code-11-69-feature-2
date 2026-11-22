/**
 * 影响定位器。
 *
 * 输入“受影响的快照 → 受影响的契约字段”映射，输出：
 *  - 受影响的项目（按已发布版本逐版本列出）
 *  - 受影响的发布版本（需复核）
 *  - 受影响的统计口径（预算合计 / 项目计数 / 结果计数）
 *
 * 硬规则：
 *  - **字段级**判定：只有当某项目在受影响快照上的溯源字段，恰好落在该快照受影响的
 *    契约字段集合内，才列入影响范围。规则修复补出“预算”时，只标出依赖预算的项目，
 *    仅依赖编号/日期的项目不列入。
 *  - 只读已发布版本，不修改任何已发布事实。
 */
import type {
  Fact,
  ImpactReport,
  ImpactedProject,
  ImpactedPublication,
  Publication,
  PublishedProject,
  TemplateProfile,
} from './types';
import { deterministicId, stableStringify } from './hash';

type ProjField = 'projectCode' | 'purchaser' | 'currentBudgetCny' | 'lot.budget' | 'lot.winner' | 'lot.code' | 'stage';

/** 发布字段 → 契约字段 */
const FIELD_TO_CONTRACT: Record<ProjField, string> = {
  projectCode: 'project_code',
  purchaser: 'purchaser',
  currentBudgetCny: 'amount',
  'lot.budget': 'amount',
  'lot.winner': 'result',
  'lot.code': 'lot',
  stage: 'stage',
};

export function contractFieldForProjectField(f: string): string | null {
  return (FIELD_TO_CONTRACT as Record<string, string>)[f] ?? null;
}

const STATS_FIELDS: ProjField[] = ['currentBudgetCny', 'lot.budget', 'lot.winner', 'stage'];

function projectDependencies(project: PublishedProject): Map<string, Set<ProjField>> {
  const bySnapshot = new Map<string, Set<ProjField>>();
  const add = (snapshotId: string, field: ProjField) => {
    if (!bySnapshot.has(snapshotId)) bySnapshot.set(snapshotId, new Set());
    bySnapshot.get(snapshotId)!.add(field);
  };
  for (const [field, prov] of Object.entries(project.fieldProvenance)) {
    add(prov.snapshotId, field as ProjField);
  }
  for (const lot of project.lots) {
    for (const [field, prov] of Object.entries(lot.fieldProvenance)) {
      add(prov.snapshotId, field === 'winner' ? 'lot.winner' : field === 'budgetCny' ? 'lot.budget' : 'lot.code');
    }
  }
  for (const h of project.BudgetHistory) add(h.snapshotId, 'currentBudgetCny');
  return bySnapshot;
}

export interface LocateInput {
  publications: Publication[];
  /** 受影响快照 → 受影响契约字段（如 amount/lot/date） */
  affectedBySnapshot: Map<string, Set<string>>;
  kind: 'template_change' | 'rule_repair';
  sourceId?: string;
  fromTemplateId?: string;
  toTemplateId?: string;
  field?: string;
  reason: string;
  notes?: string[];
  now: number;
  extraStats?: string[];
}

/** 计算影响报告（字段级精确） */
export function locateImpact(input: LocateInput): ImpactReport {
  const affectedProjects: ImpactedProject[] = [];
  const affectedStats = new Set<string>();
  const publicationsById = new Map<string, ImpactedPublication>();

  for (const pub of [...input.publications].sort((a, b) => b.version - a.version)) {
    const pubFields = new Set<string>();
    let pubProjectCount = 0;

    for (const project of pub.projects) {
      const deps = projectDependencies(project);
      const touchedFields = new Set<ProjField>();
      const touchedSnapshots = new Set<string>();

      for (const [snapshotId, fields] of deps) {
        const affectedFieldsHere = input.affectedBySnapshot.get(snapshotId);
        if (!affectedFieldsHere) continue;
        for (const field of fields) {
          if (affectedFieldsHere.has(FIELD_TO_CONTRACT[field])) {
            touchedFields.add(field);
            touchedSnapshots.add(snapshotId);
          }
        }
      }

      // 规则修复：新补出的字段此前没有溯源。若受影响快照在该项目的阶段链上，
      // 且该字段会改变项目语义位置（如补出预算 → 当前预算），则按字段语义标出。
      if (input.kind === 'rule_repair') {
        const chainSnapshots = new Set(project.stageChain.map((n) => n.snapshotId));
        for (const [snapshotId, affectedFieldsHere] of input.affectedBySnapshot) {
          if (!chainSnapshots.has(snapshotId)) continue;
          for (const cf of affectedFieldsHere) {
            const mapped = semanticProjectFields(cf, project);
            for (const f of mapped) touchedFields.add(f);
            if (mapped.length > 0) touchedSnapshots.add(snapshotId);
          }
        }
      }

      if (touchedFields.size === 0) continue;
      const fields = [...touchedFields].sort();
      const statsAffected = fields.some((f) => STATS_FIELDS.includes(f));
      // 同一发布版本内的同一项目编号（互斥拆分可能生成多条项目链）在影响报告中合并展示，
      // 字段与快照取并集，避免同一编号重复出现多行。
      const existing = affectedProjects.find(
        (p) => p.publicationId === pub.id && p.projectCode === project.projectCode,
      );
      if (existing) {
        for (const f of fields) if (!existing.fields.includes(f)) existing.fields.push(f);
        existing.fields.sort();
        for (const sid of touchedSnapshots) if (!existing.snapshotIds.includes(sid)) existing.snapshotIds.push(sid);
        existing.snapshotIds.sort();
        existing.statsAffected = existing.statsAffected || statsAffected;
      } else {
        affectedProjects.push({
          publicationId: pub.id,
          publicationVersion: pub.version,
          projectCode: project.projectCode,
          sourceId: input.sourceId ?? '',
          fields,
          snapshotIds: [...touchedSnapshots].sort(),
          statsAffected,
        });
        pubProjectCount += 1;
      }
      fields.forEach((f) => {
        pubFields.add(f);
        if (STATS_FIELDS.includes(f)) affectedStats.add('byPurchaser.budgetCny');
      });
    }

    if (pubProjectCount > 0) {
      const statsAffected = [...pubFields].some((f) => STATS_FIELDS.includes(f as ProjField));
      publicationsById.set(pub.id, {
        id: pub.id,
        version: pub.version,
        createdAt: pub.createdAt,
        fields: [...pubFields].sort(),
        projectCount: pubProjectCount,
        statsAffected,
        reason: `${pubProjectCount} 个项目依赖受影响字段（${[...pubFields].sort().join('、')}）`,
      });
      if (statsAffected) {
        affectedStats.add('stats.totalBudgetCny');
        if ([...pubFields].some((f) => f === 'lot.winner' || f === 'stage')) affectedStats.add('stats.resultCount');
        if ([...pubFields].some((f) => f === 'lot.code')) affectedStats.add('stats.lotCount');
      }
    }
  }

  for (const s of input.extraStats ?? []) affectedStats.add(s);

  const notes = [...(input.notes ?? [])];
  notes.push('影响定位只读已发布版本，不修改任何已发布事实。');
  const fieldUnion = [...new Set([...input.affectedBySnapshot.values()].flatMap((s) => [...s]))].sort();
  if (fieldUnion.length > 0) {
    notes.push(`只标出依赖契约字段 ${fieldUnion.join('、')} 的项目与统计口径。`);
  }

  return {
    id: deterministicId('impact', [
      input.kind,
      [...input.affectedBySnapshot.keys()].sort().join(','),
      stableStringify([...input.affectedBySnapshot.entries()].sort()),
      input.now,
    ]),
    createdAt: input.now,
    kind: input.kind,
    sourceId: input.sourceId,
    ...(input.fromTemplateId ? { fromTemplateId: input.fromTemplateId } : {}),
    ...(input.toTemplateId ? { toTemplateId: input.toTemplateId } : {}),
    ...(input.field ? { field: input.field as never } : {}),
    affectedSnapshotIds: [...input.affectedBySnapshot.keys()].sort(),
    affectedProjects: affectedProjects.sort(
      (a, b) => b.publicationVersion - a.publicationVersion || a.projectCode.localeCompare(b.projectCode),
    ),
    affectedPublications: [...publicationsById.values()].sort((a, b) => b.version - a.version),
    affectedStats: [...affectedStats].sort(),
    notes,
  };
}

/**
 * 规则修复时，某契约字段在一项目中的“语义落点”。
 * 只有项目确实会展示该字段时才映射，避免误标：
 *  - amount → 当前预算（项目含预算语义：有标段或非纯延期公告）
 *  - lot    → 标段编号（项目有标段或阶段为公告/结果）
 *  - result → 中标人（项目有标段）
 *  - date/project_code/purchaser/stage 属非结构字段，修复规则不针对，故不映射。
 */
function semanticProjectFields(contractField: string, project: PublishedProject): ProjField[] {
  const hasLots = project.lots.length > 0;
  const stages = new Set(project.stageChain.map((n) => n.stage));
  const onlyExtension = [...stages].every((s) => s === 'extension');
  switch (contractField) {
    case 'amount':
      return hasLots || !onlyExtension ? ['currentBudgetCny'] : [];
    case 'lot':
      return hasLots || stages.has('announcement') || stages.has('result') || stages.has('correction') ? ['lot.code'] : [];
    case 'result':
      return hasLots || stages.has('result') ? ['lot.winner'] : [];
    default:
      return [];
  }
}

export interface TemplateImpactInput {
  publications: Publication[];
  profiles: TemplateProfile[];
  sourceId: string;
  /** 受影响的已知模板版本（结构变化前的版本） */
  fromTemplateId?: string;
  toTemplateId?: string;
  /** 旧模板契约中声明为结构依赖的字段 */
  structuralFields: string[];
  affectedSnapshotIds?: string[];
  now: number;
}

/** 模板变化影响：受影响快照由调用方（模板匹配结果）给出，字段取结构依赖字段 */
export function locateTemplateImpact(input: TemplateImpactInput): ImpactReport {
  const affectedIds =
    input.affectedSnapshotIds ??
    input.profiles.filter((p) => p.sourceId === input.sourceId && !p.printLikely).map((p) => p.snapshotId);
  const fields = new Set(input.structuralFields.length ? input.structuralFields : ['amount', 'lot', 'date']);
  const affectedBySnapshot = new Map<string, Set<string>>();
  for (const id of affectedIds) affectedBySnapshot.set(id, new Set(fields));

  return locateImpact({
    publications: input.publications,
    affectedBySnapshot,
    kind: 'template_change',
    sourceId: input.sourceId,
    fromTemplateId: input.fromTemplateId,
    toTemplateId: input.toTemplateId,
    reason: `来源 ${input.sourceId} 模板 ${input.fromTemplateId ?? '(任意)'} → ${input.toTemplateId ?? '(未知新模板)'} 变化，复核结构依赖字段。`,
    now: input.now,
  });
}

/** 依据事实回溯发布项目的辅助（供 UI 显示依据） */
export function provenanceOf(facts: Fact[], factId: string): Fact | undefined {
  return facts.find((f) => f.id === factId);
}

export function impactSummaryKey(r: ImpactReport): string {
  return stableStringify({ v: r.kind, s: r.affectedSnapshotIds });
}
