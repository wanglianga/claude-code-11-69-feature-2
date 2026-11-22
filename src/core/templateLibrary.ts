/**
 * 模板目录与契约库的运行时视图。
 *
 * - 合并“内置审核模板”与“人工确认后登记”的模板版本；
 * - 识别已知模板：先按结构指纹精确匹配，再做结构相似度近似匹配；
 *   匹配在 **来源 + 页面类型** 内进行（同意向页不会被当成公告页模板）；
 *   取值差异不影响结构判定；
 * - 未登记页面一律标为 unknown，不做臆测；打印版单独标为 print；
 * - 未知页面按 (来源 + 页面类型) 聚类，并比较各期间与最近已知模板的结构相似度，
 *   相似度逐期下降即给出“渐进式改版”告警——仅作待人工确认的线索。
 */
import type {
  DriftAlert,
  FieldContract,
  PortalSourceRef,
  TemplateCluster,
  TemplateDiscovery,
  TemplateProfile,
  TemplateRegistryEntry,
  RegistryMatch,
  PageKind,
} from './types';
import {
  CLUSTER_THRESHOLD,
  KNOWN_TEMPLATE_THRESHOLD,
  WATCH_BAND,
  buildBuiltinContracts,
  buildBuiltinRegistry,
  sourceMetaOf,
  type BuiltinTemplateEntry,
} from './templateCatalog';
import { clusterSimilarity, signatureSimilarity } from './templateProfile';
import { deterministicId } from './hash';

export interface TemplateRuntime {
  entries: TemplateRegistryEntry[];
  contracts: FieldContract[];
}

/** 把内置定义 + 已确认登记项合并成运行时目录 */
export function buildRuntime(confirmed: TemplateRegistryEntry[], confirmedContracts: FieldContract[]): TemplateRuntime {
  const builtins = buildBuiltinRegistry();
  const entries: TemplateRegistryEntry[] = builtins.map((b: BuiltinTemplateEntry) => ({
    id: b.definition.id,
    sourceId: b.definition.sourceId,
    templateId: b.definition.templateId,
    templateVersion: b.definition.templateVersion,
    label: b.definition.label,
    pageKind: b.definition.pageKind,
    origin: 'builtin',
    fingerprints: [b.fingerprint],
    signature: b.signature,
    ...(b.definition.appearanceGroup ? { appearanceGroup: b.definition.appearanceGroup } : {}),
    ...(b.definition.semanticsNote ? { semanticsNote: b.definition.semanticsNote } : {}),
    createdAt: 1_700_000_000_000,
  }));
  const seen = new Set(entries.map((e) => `${e.sourceId}|${e.templateId}|${e.templateVersion}`));
  for (const c of confirmed) {
    const key = `${c.sourceId}|${c.templateId}|${c.templateVersion}`;
    if (seen.has(key)) {
      const existing = entries.find((e) => `${e.sourceId}|${e.templateId}|${e.templateVersion}` === key)!;
      for (const fp of c.fingerprints) if (!existing.fingerprints.includes(fp)) existing.fingerprints.push(fp);
      continue;
    }
    seen.add(key);
    entries.push(c);
  }

  const contracts = [...buildBuiltinContracts()];
  for (const c of confirmedContracts) {
    if (!contracts.some((x) => x.id === c.id)) contracts.push(c);
  }
  return { entries, contracts };
}

/** 匹配单个画像到已知模板（来源 + 页面类型内） */
export function matchProfile(profile: TemplateProfile, runtime: TemplateRuntime): RegistryMatch {
  const sameSource = runtime.entries.filter((e) => e.sourceId === profile.sourceId);

  // 打印版没有原网页结构：不做结构比对（避免把打印件缺失当作门户漏报）
  if (profile.printLikely) {
    return {
      snapshotId: profile.snapshotId,
      sourceId: profile.sourceId,
      fingerprint: profile.fingerprint,
      templateId: null,
      templateVersion: null,
      status: 'print',
      matchKind: 'print',
      note: '快照为打印版，缺少原网页结构，结构指纹不参与已知模板匹配。',
    };
  }

  // 只在同页面类型内比对：不同意向/公告/结果页不可互相兜底，
  // 否则会把“本来源尚未登记该页面类型”误报成“模板改版”。
  const candidates = sameSource.filter((e) => e.pageKind === profile.pageKind);
  if (candidates.length === 0) {
    return {
      snapshotId: profile.snapshotId,
      sourceId: profile.sourceId,
      fingerprint: profile.fingerprint,
      templateId: null,
      templateVersion: null,
      status: 'unknown',
      matchKind: 'unknown',
      note: `本来源尚未登记页面类型 ${profile.pageKind} 的模板，标记为未知并等待维护。`,
    };
  }

  // 1) 精确指纹
  for (const e of candidates) {
    if (e.fingerprints.includes(profile.fingerprint)) {
      return {
        snapshotId: profile.snapshotId,
        sourceId: profile.sourceId,
        fingerprint: profile.fingerprint,
        templateId: e.templateId,
        templateVersion: e.templateVersion,
        status: 'known',
        matchKind: 'exact',
        nearestKnown: { templateId: e.templateId, similarity: 1 },
      };
    }
  }

  // 2) 近似结构相似
  let best: { entry: TemplateRegistryEntry; sim: number } | null = null;
  for (const e of candidates) {
    const sim = signatureSimilarity(profile.signature, e.signature);
    if (!best || sim > best.sim) best = { entry: e, sim };
  }
  if (best && best.sim >= KNOWN_TEMPLATE_THRESHOLD) {
    return {
      snapshotId: profile.snapshotId,
      sourceId: profile.sourceId,
      fingerprint: profile.fingerprint,
      templateId: best.entry.templateId,
      templateVersion: best.entry.templateVersion,
      status: 'known',
      matchKind: 'approximate',
      nearestKnown: { templateId: best.entry.templateId, similarity: best.sim },
      note: `近似匹配已知模板（相似度 ${best.sim}），取值差异不影响结构判定。`,
    };
  }

  return {
    snapshotId: profile.snapshotId,
    sourceId: profile.sourceId,
    fingerprint: profile.fingerprint,
    templateId: null,
    templateVersion: null,
    status: 'unknown',
    matchKind: 'unknown',
    ...(best ? { nearestKnown: { templateId: best.entry.templateId, similarity: best.sim } } : {}),
    note: best
      ? `与最近已知模板 ${best.entry.templateId} 相似度仅 ${best.sim}，低于已知阈值 ${KNOWN_TEMPLATE_THRESHOLD}，标记为未知页面（同页面类型内比对）。`
      : '本来源尚无已登记模板，标记为未知页面。',
  };
}

interface UnknownItem {
  profile: TemplateProfile;
  match: RegistryMatch;
}

/** 对未知页面做结构聚类，并给出渐进式改版告警 */
export function discoverTemplates(profiles: TemplateProfile[], matches: RegistryMatch[]): TemplateDiscovery {
  const unknowns: UnknownItem[] = [];
  for (const p of profiles) {
    const m = matches.find((x) => x.snapshotId === p.snapshotId)!;
    if (m.status === 'unknown') unknowns.push({ profile: p, match: m });
  }

  const clusters: TemplateCluster[] = [];
  const assigned = new Set<string>();
  const bucketKey = (p: TemplateProfile) => `${p.sourceId}|${p.pageKind}`;
  const byBucket = new Map<string, UnknownItem[]>();
  for (const u of unknowns) {
    const k = bucketKey(u.profile);
    if (!byBucket.has(k)) byBucket.set(k, []);
    byBucket.get(k)!.push(u);
  }

  for (const [bucket, items] of byBucket) {
    const [sourceId, pageKind] = bucket.split('|') as [string, PageKind];
    for (const seed of items) {
      if (assigned.has(seed.profile.snapshotId)) continue;
      const group: UnknownItem[] = [seed];
      assigned.add(seed.profile.snapshotId);
      let changed = true;
      while (changed) {
        changed = false;
        for (const cand of items) {
          if (assigned.has(cand.profile.snapshotId)) continue;
          if (group.some((g) => clusterSimilarity(g.profile.signature, cand.profile.signature) >= CLUSTER_THRESHOLD)) {
            group.push(cand);
            assigned.add(cand.profile.snapshotId);
            changed = true;
          }
        }
      }
      const sims: number[] = [];
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          sims.push(clusterSimilarity(group[i].profile.signature, group[j].profile.signature));
        }
      }
      const meanSimilarity = sims.length ? Number((sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(4)) : 1;
      const periods = [...new Set(group.map((g) => g.profile.period).filter((p): p is string => !!p))].sort();
      const labelSamples = [...new Set(group.flatMap((g) => g.profile.signature.labelSequence))].slice(0, 12);
      // 最近已知模板取组内平均（而非单点最大），避免个别样本误导
      const nearestByTemplate = new Map<string, number[]>();
      for (const g of group) {
        const n = g.match.nearestKnown;
        if (!n) continue;
        if (!nearestByTemplate.has(n.templateId)) nearestByTemplate.set(n.templateId, []);
        nearestByTemplate.get(n.templateId)!.push(n.similarity);
      }
      const nearest = [...nearestByTemplate.entries()]
        .map(([templateId, arr]) => ({ templateId, similarity: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(4)) }))
        .sort((a, b) => b.similarity - a.similarity)[0];

      // 渐进式改版：把每个期间的平均相似度按时间排列，后期低于前期（>0.02）即视为渐进
      const simByPeriod = new Map<string, number[]>();
      for (const g of group) {
        if (!g.profile.period || !g.match.nearestKnown) continue;
        if (!simByPeriod.has(g.profile.period)) simByPeriod.set(g.profile.period, []);
        simByPeriod.get(g.profile.period)!.push(g.match.nearestKnown.similarity);
      }
      const orderedPeriods = [...simByPeriod.keys()].sort();
      const periodMeans = orderedPeriods.map((p) => {
        const arr = simByPeriod.get(p)!;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
      });
      let progressive = false;
      for (let i = 1; i < periodMeans.length; i++) {
        if (periodMeans[i] < periodMeans[i - 1] - 0.02) progressive = true;
      }
      clusters.push({
        id: deterministicId('cluster', [bucket, group.map((g) => g.profile.snapshotId).sort().join(',')]),
        sourceId,
        pageKind,
        memberSnapshotIds: group.map((g) => g.profile.snapshotId).sort(),
        memberCount: group.length,
        fingerprints: [...new Set(group.map((g) => g.profile.fingerprint))],
        labelSamples,
        meanSimilarity,
        periods,
        ...(nearest ? { nearestKnown: nearest } : {}),
        progressiveDrift: progressive,
        status: 'candidate',
      });
    }
  }

  // 告警
  const driftAlerts: DriftAlert[] = [];
  for (const cluster of clusters) {
    const nearest = cluster.nearestKnown;
    if (!nearest) continue;
    const inWatchBand = nearest.similarity >= WATCH_BAND[0] && nearest.similarity < WATCH_BAND[1];
    if (cluster.memberCount > 1 || inWatchBand) {
      driftAlerts.push({
        sourceId: cluster.sourceId,
        pageKind: cluster.pageKind,
        clusterId: cluster.id,
        nearestKnownTemplateId: nearest.templateId,
        similarity: nearest.similarity,
        periods: cluster.periods,
        progressive: cluster.progressiveDrift,
        message: `来源 ${cluster.sourceId}（${cluster.pageKind}）发现未登记页面${cluster.memberCount > 1 ? `聚类（${cluster.memberCount} 份）` : ''}，最近已知模板 ${nearest.templateId} 相似度 ${nearest.similarity}，低于登记阈值，需人工确认。`,
      });
    }
  }

  // 来源 + 页面类型级别的“渐进式改版”序列：
  // 把该组全部未知样本按期间排序，比较最早与最近期间与已知模板的平均相似度；
  // 即使各期结构差异大到不成同一簇，只要相似度整体随时间下降，也提示渐进式改版。
  const seriesByBucket = new Map<string, DriftAlert>();
  for (const [bucket, items] of byBucket) {
    const [sourceId, pageKind] = bucket.split('|') as [string, PageKind];
    const byPeriod = new Map<string, { sims: number[]; tpl: string }>();
    for (const it of items) {
      const n = it.match.nearestKnown;
      if (!it.profile.period || !n) continue;
      if (!byPeriod.has(it.profile.period)) byPeriod.set(it.profile.period, { sims: [], tpl: n.templateId });
      byPeriod.get(it.profile.period)!.sims.push(n.similarity);
    }
    const periods = [...byPeriod.keys()].sort();
    if (periods.length < 2) continue;
    const mean = (p: string) => {
      const arr = byPeriod.get(p)!.sims;
      return arr.reduce((a, b) => a + b, 0) / arr.length;
    };
    const first = mean(periods[0]);
    const last = mean(periods[periods.length - 1]);
    // 允许中间起伏，只要首尾下降达到阈值即视为渐进式改版
    if (first - last > 0.03) {
      // 标记该 bucket 内的候选簇为渐进式
      for (const c of clusters) {
        if (c.sourceId === sourceId && c.pageKind === pageKind && c.periods.length > 0) c.progressiveDrift = true;
      }
      const tpl = byPeriod.get(periods[0])!.tpl;
      seriesByBucket.set(bucket, {
        sourceId,
        pageKind,
        nearestKnownTemplateId: tpl,
        similarity: Number(last.toFixed(4)),
        periods,
        progressive: true,
        message: `来源 ${sourceId}（${pageKind}）出现渐进式改版：期间 ${periods.join('、')} 与已知模板 ${tpl} 的结构相似度由 ${first.toFixed(3)} 降至 ${last.toFixed(3)}，逐期偏离，需人工确认新模板。`,
      });
    }
  }
  for (const alert of seriesByBucket.values()) {
    // 用序列级告警替换同 bucket 的非渐进单簇告警，避免重复
    for (let i = driftAlerts.length - 1; i >= 0; i--) {
      if (driftAlerts[i].sourceId === alert.sourceId && driftAlerts[i].pageKind === alert.pageKind) driftAlerts.splice(i, 1);
    }
    driftAlerts.push(alert);
  }

  // 簇自身的逐期下降也应产生告警（簇内多期间时）
  for (const cluster of clusters) {
    if (!cluster.progressiveDrift) continue;
    if (driftAlerts.some((a) => a.sourceId === cluster.sourceId && a.pageKind === cluster.pageKind && a.progressive)) continue;
    const nearest = cluster.nearestKnown;
    if (!nearest) continue;
    driftAlerts.push({
      sourceId: cluster.sourceId,
      pageKind: cluster.pageKind,
      clusterId: cluster.id,
      nearestKnownTemplateId: nearest.templateId,
      similarity: nearest.similarity,
      periods: cluster.periods,
      progressive: true,
      message: `来源 ${cluster.sourceId}（${cluster.pageKind}）出现渐进式改版：期间 ${cluster.periods.join('、')} 与已知模板 ${nearest.templateId} 的结构相似度逐期下降（最近均值 ${nearest.similarity}），需人工确认新模板。`,
    });
  }

  return {
    matches,
    unknowns: matches.filter((m) => m.status === 'unknown'),
    clusters: clusters.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.pageKind.localeCompare(b.pageKind)),
    driftAlerts: driftAlerts.sort((a, b) => Number(b.progressive) - Number(a.progressive)),
  };
}

export function contractKey(sourceId: string, templateId: string, templateVersion: string): string {
  return `${sourceId}|${templateId}|${templateVersion}`;
}

export function findContract(
  contracts: FieldContract[],
  sourceId: string,
  templateId: string,
  templateVersion: string,
): FieldContract | undefined {
  const exact = contracts.find(
    (c) => c.sourceId === sourceId && c.templateId === templateId && c.templateVersion === templateVersion,
  );
  if (exact) return exact;
  return contracts
    .filter((c) => c.sourceId === sourceId && c.templateId === templateId)
    .sort((a, b) => b.templateVersion.localeCompare(a.templateVersion))[0];
}

/** 同形异义：同 appearanceGroup 但来源不同的契约列表 */
export function sameAppearanceContracts(contracts: FieldContract[], contract: FieldContract): FieldContract[] {
  if (!contract.appearanceGroup) return [];
  return contracts.filter((c) => c.id !== contract.id && c.appearanceGroup === contract.appearanceGroup);
}

export function sourceRef(sourceId: string): PortalSourceRef | null {
  return sourceMetaOf(sourceId);
}
