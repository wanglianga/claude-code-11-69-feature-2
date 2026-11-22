/**
 * 修复回放器。
 *
 * 在**固定快照水位**上，比较旧规则（当前提取器）与新规则（补丁集）的提取差异，
 * 产出 RepairReplayReport：
 *   - added    新规则补出的以前漏提的事实
 *   - removed  新规则不再产出的事实（规则收紧）
 *   - changed  同一字段/位置取值变化
 * 并调用影响定位器只标出依赖这些字段的项目与统计版本。
 *
 * 硬规则：回放**只产报告，不写回已发布事实**；快照、裁决、发布版本一概不动。
 */
import type {
  Fact,
  ImpactReport,
  Publication,
  RepairDiffEntry,
  RepairReplayReport,
  RepairRulePatch,
  Snapshot,
} from './types';
import { extractFacts, EXTRACTOR_VERSION } from './extractor';
import { deterministicId, stableStringify } from './hash';
import { locateImpact } from './impact';

function factKey(f: Fact): string {
  return `${f.type}|${f.value}|${f.evidence.start}|${f.lotCode ?? ''}`;
}

function fieldOf(f: Fact): string {
  return f.type;
}

/** 差异 → 每个受影响快照上真正发生变化的契约字段（字段级影响定位的依据） */
function groupFieldsBySnapshot(diffs: RepairDiffEntry[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const d of diffs) {
    if (!out.has(d.snapshotId)) out.set(d.snapshotId, new Set());
    out.get(d.snapshotId)!.add(d.field);
  }
  return out;
}

export interface ReplayInput {
  snapshots: Snapshot[];
  publications: Publication[];
  publishedFacts: Fact[];
  patches: RepairRulePatch[];
  /** 限定来源（可选，避免跨来源比较） */
  snapshotIds?: string[];
  now: number;
}

export function replayRepair(input: ReplayInput): RepairReplayReport {
  const scoped = input.snapshotIds
    ? input.snapshots.filter((s) => input.snapshotIds!.includes(s.id))
    : input.snapshots;
  const patchVersion = input.patches.map((p) => p.version).sort().join(',') || 'no-patch';

  const diffs: RepairDiffEntry[] = [];
  const addedByField: Record<string, number> = {};
  const affectedSnapshotIds = new Set<string>();
  const affectedFields = new Set<string>();

  for (const snap of scoped) {
    const baseFacts = extractFacts(snap);
    const patchedFacts = extractFacts(snap, { patches: input.patches, extractorVersion: `extractor+${patchVersion}` });

    const baseMap = new Map(baseFacts.map((f) => [factKey(f), f]));
    const patchedMap = new Map(patchedFacts.map((f) => [factKey(f), f]));

    for (const [key, f] of patchedMap) {
      const prev = baseMap.get(key);
      if (!prev) {
        diffs.push({
          snapshotId: snap.id,
          field: f.type,
          change: 'added',
          value: f.value,
          evidence: f.evidence,
          ruleId: f.ruleId,
        });
        addedByField[f.type] = (addedByField[f.type] ?? 0) + 1;
        affectedSnapshotIds.add(snap.id);
        affectedFields.add(fieldOf(f));
      } else if (prev.value !== f.value || prev.ruleId !== f.ruleId) {
        diffs.push({
          snapshotId: snap.id,
          field: f.type,
          change: 'changed',
          value: f.value,
          previousValue: prev.value,
          evidence: f.evidence,
          ruleId: f.ruleId,
        });
        affectedSnapshotIds.add(snap.id);
        affectedFields.add(fieldOf(f));
      }
    }
    for (const [key, f] of baseMap) {
      if (!patchedMap.has(key)) {
        diffs.push({
          snapshotId: snap.id,
          field: f.type,
          change: 'removed',
          value: f.value,
          evidence: f.evidence,
          ruleId: f.ruleId,
        });
        affectedSnapshotIds.add(snap.id);
        affectedFields.add(fieldOf(f));
      }
    }
  }

  const impact: ImpactReport = locateImpact({
    publications: input.publications,
    affectedBySnapshot: groupFieldsBySnapshot(diffs),
    kind: 'rule_repair',
    field: [...affectedFields][0],
    reason: `规则修复补丁 ${input.patches.map((p) => p.id).join('、')} 在固定快照上产生 ${diffs.length} 处提取差异。`,
    notes: ['修复回放只产出报告，不直接改写已发布事实；是否重发由人工决定。'],
    now: input.now,
  });

  return {
    id: deterministicId('replay', [
      stableStringify([...affectedSnapshotIds].sort()),
      stableStringify([...affectedFields].sort()),
      input.patches.map((p) => p.id).sort().join(','),
      input.now,
    ]),
    createdAt: input.now,
    patchIds: input.patches.map((p) => p.id).sort(),
    patchVersion,
    snapshotWatermark: scoped.map((s) => s.id).sort(),
    diffs,
    addedByField,
    affectedSnapshotIds: [...affectedSnapshotIds].sort(),
    affectedProjects: impact.affectedProjects,
    affectedPublications: impact.affectedPublications,
    publishedFactsUntouched: true,
  };
}

/** 校验回放不改写已发布事实：返回是否与当前发布事实一致（用于测试断言） */
export function publishedFactsUnchanged(before: Fact[], after: Fact[]): boolean {
  return stableStringify([...before].sort((a, b) => a.id.localeCompare(b.id))) ===
    stableStringify([...after].sort((a, b) => a.id.localeCompare(b.id)));
}

export const BASE_EXTRACTOR_VERSION = EXTRACTOR_VERSION;
