import { useMemo, useState } from 'react';
import type {
  Fact,
  FactType,
  FieldQualityMetric,
  ImpactReport,
  Publication,
  QualityRun,
  RepairReplayReport,
  Snapshot,
  TemplateCluster,
  TemplateProfile,
  TemplateRegistryEntry,
  FieldContract,
} from '../core/types';
import type { SnapshotQualitySummary } from '../core/quality';
import { Badge, Empty, Drawer, KeyVal } from '../components/ui';
import { FACT_TYPE_LABELS, formatTime, shortHash } from '../state/labels';
import { BUILTIN_REPAIR_PATCHES, builtinSourceRefs } from '../core/templateCatalog';
import { PORTAL_SOURCES } from '../core/templateProfile';

export interface QualityPageProps {
  state: {
    snapshots: Snapshot[];
    facts: Fact[];
    publications: Publication[];
    qualityRuns: QualityRun[];
    templateRegistry: TemplateRegistryEntry[];
    contracts: FieldContract[];
  };
  busy: boolean;
  lastAnalysis: QualityAnalysisView | null;
  onRunQuality: (scope: 'all' | 'quality-samples') => Promise<QualityAnalysisView | undefined>;
  onConfirmCluster: (cluster: TemplateCluster, meta: { templateId: string; templateVersion: string; label: string; reviewer: string; note: string }) => Promise<void>;
  onDismissCluster: (cluster: TemplateCluster, meta: { reviewer: string; note: string }) => Promise<void>;
  onLocateImpact: (input: { sourceId: string; fromTemplateId?: string }) => Promise<ImpactReport | undefined>;
  onReplayRepair: (patchIds: string[], sourceId?: string) => Promise<RepairReplayReport | undefined>;
}

export interface QualityAnalysisView {
  run: QualityRun;
  profiles: TemplateProfile[];
  summaries: SnapshotQualitySummary[];
  matches: {
    snapshotId: string;
    status: 'known' | 'print' | 'unknown';
    matchKind: string;
    templateId: string | null;
    templateVersion: string | null;
    nearestKnown?: { templateId: string; similarity: number };
    note?: string;
  }[];
}

function RateCell({ value, sample, kind }: { value: number | null; sample: number; kind: 'good' | 'bad' }) {
  if (value === null || sample === 0) return <span className="muted">—</span>;
  const pct = Math.round(value * 100);
  const cls = kind === 'bad' ? (pct > 0 ? 'bad-value' : '') : pct < 100 ? 'warn-value' : 'good-value';
  return <span className={cls}>{pct}%</span>;
}

const SOURCE_LABEL = new Map(PORTAL_SOURCES.map((s) => [s.id, `${s.province}·${s.portalName}`]));
function sourceLabel(id: string): string {
  return SOURCE_LABEL.get(id) ?? id ?? '未识别';
}

export function QualityPage(props: QualityPageProps) {
  const { state, busy, lastAnalysis } = props;
  const [profileDrawerSnapshot, setProfileDrawerSnapshot] = useState<string | null>(null);
  const [confirmCluster, setConfirmCluster] = useState<TemplateCluster | null>(null);
  const [confirmForm, setConfirmForm] = useState({ templateId: '', templateVersion: 'v1.0', label: '', reviewer: 'default-reviewer', note: '' });
  const [impactSource, setImpactSource] = useState('js');
  const [impactFrom, setImpactFrom] = useState('js-web-v1');
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [replaySource, setReplaySource] = useState('zj');
  const [patchIds, setPatchIds] = useState<string[]>(BUILTIN_REPAIR_PATCHES.map((p) => p.id));
  const [replay, setReplay] = useState<RepairReplayReport | null>(null);

  const run = lastAnalysis?.run ?? (state.qualityRuns.length ? [...state.qualityRuns].sort((a, b) => b.createdAt - a.createdAt)[0] : null);
  const summaries = lastAnalysis?.summaries ?? [];
  const profiles = lastAnalysis?.profiles ?? [];

  const totals = run?.totals;
  const activeProfile = profiles.find((p) => p.snapshotId === profileDrawerSnapshot) ?? null;
  const activeSnapshot = state.snapshots.find((s) => s.id === profileDrawerSnapshot) ?? null;

  const groupsBySource = useMemo(() => {
    const map = new Map<string, QualityRun['groups']>();
    for (const g of run?.groups ?? []) {
      if (!map.has(g.sourceId)) map.set(g.sourceId, []);
      map.get(g.sourceId)!.push(g);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [run]);

  const sourceContracts = useMemo(() => {
    const map = new Map<string, FieldContract[]>();
    for (const c of state.contracts) {
      if (!map.has(c.sourceId)) map.set(c.sourceId, []);
      map.get(c.sourceId)!.push(c);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [state.contracts]);

  // 已登记模板从契约/登记项里汇总（内置模板不在 state 里，从运行结果分组补齐）
  const registeredTemplates = useMemo(() => {
    const key = (s: string, t: string, v: string) => `${s}|${t}|${v}`;
    const map = new Map<string, { sourceId: string; templateId: string; templateVersion: string; label: string; origin: string; pageKind: string; appearanceGroup?: string }>();
    for (const c of state.contracts) {
      map.set(key(c.sourceId, c.templateId, c.templateVersion), {
        sourceId: c.sourceId,
        templateId: c.templateId,
        templateVersion: c.templateVersion,
        label: c.label,
        origin: c.origin,
        pageKind: c.pageKind,
        ...(c.appearanceGroup ? { appearanceGroup: c.appearanceGroup } : {}),
      });
    }
    // 运行结果中出现的模板也可能来自内置目录（没有持久化契约）
    for (const g of run?.groups ?? []) {
      if (g.templateStatus !== 'known') continue;
      const k = key(g.sourceId, g.templateId, g.templateVersion);
      if (!map.has(k)) {
        map.set(k, {
          sourceId: g.sourceId,
          templateId: g.templateId,
          templateVersion: g.templateVersion,
          label: `${g.sourceId}/${g.templateId}@${g.templateVersion}`,
          origin: 'builtin',
          pageKind: g.pageKind,
        });
      }
    }
    return [...map.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.templateId.localeCompare(b.templateId));
  }, [state.contracts, run]);

  async function submitConfirm() {
    if (!confirmCluster) return;
    if (!confirmForm.templateId.trim()) return;
    await props.onConfirmCluster(confirmCluster, confirmForm);
    setConfirmCluster(null);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>门户模板演变与抽取质量监测</h2>
          <div className="desc">
            从快照生成结构画像与字段邻域指纹；按来源 · 模板 · 期间 · 解析器版本计算字段提取率、来源缺失率、解析失败率与样本量；
            未知页面只标为 unknown 等待人工确认，绝不把打印版缺页当作门户漏报。所有指标按来源隔离，同外观不同语义不共用分母。
          </div>
        </div>
        <div className="flex">
          <button className="primary" disabled={busy || state.snapshots.length === 0} onClick={() => props.onRunQuality('quality-samples')}>
            运行质量检查（仅质量样例）
          </button>
          <button disabled={busy || state.snapshots.length === 0} onClick={() => props.onRunQuality('all')}>
            运行质量检查（全部快照）
          </button>
        </div>
      </div>

      {!run ? (
        <div className="panel"><Empty text="尚未运行质量检查。请先导入示例归档，再运行质量检查。" /></div>
      ) : (
        <>
          <div className="tiles">
            <div className="tile"><div className="label">快照样本</div><div className="num">{totals?.snapshotCount ?? 0}</div></div>
            <div className="tile"><div className="label">已知模板快照</div><div className="num" style={{ color: 'var(--green)' }}>{totals?.knownTemplateCount ?? 0}</div></div>
            <div className="tile"><div className="label">打印版（结构不可用）</div><div className="num" style={{ color: 'var(--amber)' }}>{totals?.printSnapshotCount ?? 0}</div></div>
            <div className="tile"><div className="label">未知页面（待维护）</div><div className="num" style={{ color: 'var(--red)' }}>{totals?.unknownTemplateCount ?? 0}</div></div>
            <div className="tile"><div className="label">字段契约</div><div className="num">{totals?.contractCount ?? 0}</div></div>
          </div>

          <div className="panel">
            <h3>① 模板画像与已知模板匹配（{summaries.length} 个快照）</h3>
            {summaries.length === 0 ? (
              <div className="muted small-text">当前显示的是历史运行结果摘要。重新点击“运行质量检查”可获取逐快照画像。</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>来源文件</th><th>来源</th><th>页面类型</th><th>期间</th><th>结构指纹</th><th>匹配结果</th><th>相似度</th><th>需关注的字段</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaries.map((s) => (
                      <tr key={s.snapshotId}>
                        <td className="small-text">{s.fileName}</td>
                        <td className="small-text">{sourceLabel(s.sourceId)}</td>
                        <td className="small-text">{s.pageKind}</td>
                        <td className="small-text">{s.period ?? '—'}</td>
                        <td className="hash">{shortHash(s.fingerprint || '')}</td>
                        <td>
                          {s.status === 'known' && <Badge className="confirmed">已知 {s.templateId}@{s.templateVersion}</Badge>}
                          {s.status === 'print' && <Badge className="pending">打印版 · 结构不可用</Badge>}
                          {s.status === 'unknown' && <Badge className="rejected">未知页面</Badge>}
                          <div className="small-text muted">{s.matchKind}</div>
                        </td>
                        <td className="small-text">{s.similarity !== undefined ? s.similarity.toFixed(3) : '—'}</td>
                        <td className="small-text">
                          {s.extractionFailedFields.length > 0 && <div className="bad-value">解析失败：{s.extractionFailedFields.map((f) => FACT_TYPE_LABELS[f]).join('、')}</div>}
                          {s.structuralUnavailableFields.length > 0 && <div className="warn-value">结构不可用：{s.structuralUnavailableFields.map((f) => FACT_TYPE_LABELS[f]).join('、')}</div>}
                          {s.sourceIncompleteFields.length > 0 && <div className="warn-value">离线缺页：{s.sourceIncompleteFields.map((f) => FACT_TYPE_LABELS[f]).join('、')}</div>}
                          {s.notDisclosedFields.length > 0 && <div className="muted">来源未披露：{s.notDisclosedFields.map((f) => FACT_TYPE_LABELS[f]).join('、')}</div>}
                          {s.templateChangeSuspectedFields.length > 0 && <div className="bad-value">未知页疑似改版（有标签未提取）：{s.templateChangeSuspectedFields.map((f) => FACT_TYPE_LABELS[f]).join('、')}</div>}
                          {s.extractionFailedFields.length + s.structuralUnavailableFields.length + s.notDisclosedFields.length + s.sourceIncompleteFields.length + s.templateChangeSuspectedFields.length === 0 && <span className="muted">—</span>}
                        </td>
                        <td>
                          <button className="small" onClick={() => setProfileDrawerSnapshot(s.snapshotId)}>画像</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <h3>② 质量指标（按来源 · 模板 · 期间 · 解析器版本分组，绝不跨来源共用分母）</h3>
            {groupsBySource.length === 0 ? (
              <Empty text="本次运行没有已知模板样本；请先确认未知模板或调整样例范围。" />
            ) : (
              groupsBySource.map(([sourceId, groups]) => (
                <div key={sourceId} style={{ marginBottom: 18 }}>
                  <div className="flex" style={{ marginBottom: 6 }}>
                    <strong>{sourceLabel(sourceId)}</strong>
                    <Badge className="neutral">来源隔离</Badge>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>模板版本</th><th>状态</th><th>期间</th><th>样本量</th><th>字段</th><th>提取率</th><th>来源缺失率</th><th>解析失败率</th><th>离线缺页率</th><th>计数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map((g) =>
                          g.fields.filter((f) => f.expected > 0).map((f, i) => (
                            <tr key={`${g.id}-${f.field}`}>
                              {i === 0 && <td rowSpan={g.fields.filter((x) => x.expected > 0).length} className="small-text"><span className="mono">{g.templateId}@{g.templateVersion}</span><div className="muted">{g.pageKind}</div></td>}
                              {i === 0 && <td rowSpan={g.fields.filter((x) => x.expected > 0).length}>{g.templateStatus === 'print' ? <Badge className="pending">打印版</Badge> : <Badge className="confirmed">已知</Badge>}</td>}
                              {i === 0 && <td rowSpan={g.fields.filter((x) => x.expected > 0).length} className="small-text">{g.period}</td>}
                              {i === 0 && <td rowSpan={g.fields.filter((x) => x.expected > 0).length}>{g.sampleSize}</td>}
                              <td>{FACT_TYPE_LABELS[f.field]}</td>
                              <td><RateCell value={f.extractionRate} sample={f.expected} kind="good" /></td>
                              <td><RateCell value={f.sourceMissingRate} sample={f.expected - f.structuralUnavailable - f.notApplicable} kind="bad" /></td>
                              <td><RateCell value={f.parseFailureRate} sample={f.expected - f.structuralUnavailable - f.notApplicable} kind="bad" /></td>
                              <td><RateCell value={f.offlineIncompleteRate} sample={f.expected - f.structuralUnavailable - f.notApplicable + f.sourceIncomplete} kind="bad" /></td>
                              <td className="small-text muted">{outcomeBreakdown(f)}</td>
                            </tr>
                          )),
                        )}
                        {groups.flatMap((g) => Object.entries(g.offContractCounts).map(([k, v]) => ({ g, k, v }))).map(({ g, k, v }) => (
                          <tr key={`${g.id}-off-${k}`}>
                            <td className="small-text" colSpan={4}><span className="muted">契约外观察值</span></td>
                            <td><span className="muted">{FACT_TYPE_LABELS[k as FactType] ?? k}</span></td>
                            <td colSpan={4} className="small-text muted">不作为提取率分子/分母（{v} 条）</td>
                            <td className="small-text muted">仅作观察</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {groups.some((g) => g.notes.length > 0) && (
                    <ul className="reason-list small-text" style={{ marginTop: 6 }}>
                      {[...new Set(groups.flatMap((g) => g.notes))].map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="panel">
            <h3>③ 未知页面与渐进式改版线索（{run.discoveries.clusters.length} 个聚类，{run.discoveries.driftAlerts.length} 条告警）</h3>
            {run.discoveries.clusters.length === 0 && run.unknownSnapshotIds.length === 0 ? (
              <div className="muted small-text">没有未知页面。</div>
            ) : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>来源</th><th>页面类型</th><th>成员快照</th><th>样本</th><th>期间</th><th>最近已知模板</th><th>相似度</th><th>渐进式</th><th>操作</th></tr>
                    </thead>
                    <tbody>
                      {run.discoveries.clusters.map((c) => (
                        <tr key={c.id}>
                          <td className="small-text">{sourceLabel(c.sourceId)}</td>
                          <td className="small-text">{c.pageKind}</td>
                          <td className="small-text">{c.memberSnapshotIds.length} 个</td>
                          <td>{c.memberCount}</td>
                          <td className="small-text">{c.periods.join('、') || '—'}</td>
                          <td className="small-text">{c.nearestKnown?.templateId ?? '—'}</td>
                          <td className="small-text">{c.nearestKnown?.similarity ?? '—'}</td>
                          <td>{c.progressiveDrift ? <Badge className="pending">是</Badge> : <span className="muted">否</span>}</td>
                          <td>
                            <div className="flex">
                              <button className="small" onClick={() => { setConfirmCluster(c); setConfirmForm((f) => ({ ...f, label: `${c.sourceId} 新模板 ${c.periods[0] ?? ''}`, templateId: `${c.sourceId}-new-${c.pageKind}-${c.periods[0] ?? 'v'}` })); }}>登记为新模板…</button>
                              <button className="small" onClick={() => void props.onDismissCluster(c, { reviewer: 'default-reviewer', note: '人工确认非模板改版' })}>驳回</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {run.discoveries.driftAlerts.length > 0 && (
                  <ul className="reason-list" style={{ marginTop: 10 }}>
                    {run.discoveries.driftAlerts.map((a, i) => <li key={i} className={a.progressive ? 'warn-value' : ''}>{a.progressive ? '【渐进式改版】' : '【未知模板】'}{a.message}</li>)}
                  </ul>
                )}
                {run.unknownSnapshotIds.length > 0 && (
                  <div className="small-text muted" style={{ marginTop: 8 }}>
                    未知页面共 {run.unknownSnapshotIds.length} 个：这些样本未进入任何提取率分母，需人工确认后才能按已知模板统计。
                  </div>
                )}
              </>
            )}
          </div>

          <div className="panel">
            <h3>④ 已登记模板与字段契约（按来源分开维护）</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th>来源</th><th>模板版本</th><th>页面类型</th><th>来源</th><th>同形组</th><th>说明</th></tr></thead>
                <tbody>
                  {registeredTemplates.map((t) => (
                    <tr key={`${t.sourceId}-${t.templateId}-${t.templateVersion}`}>
                      <td className="small-text">{sourceLabel(t.sourceId)}</td>
                      <td className="mono small-text">{t.templateId}@{t.templateVersion}</td>
                      <td className="small-text">{t.pageKind}</td>
                      <td className="small-text">{t.origin === 'builtin' ? '内置审核' : '人工确认'}</td>
                      <td className="small-text">{t.appearanceGroup ?? '—'}</td>
                      <td className="small-text muted">{t.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 14 }}>
              {sourceContracts.map(([sourceId, contracts]) => (
                <div key={sourceId} style={{ marginBottom: 12 }}>
                  <strong className="small-text">{sourceLabel(sourceId)}</strong>
                  {contracts.map((c) => (
                    <div key={c.id} className="panel" style={{ margin: '6px 0', padding: 12 }}>
                      <div className="flex">
                        <span className="mono small-text">{c.templateId}@{c.templateVersion}</span>
                        <Badge className={c.origin === 'builtin' ? 'neutral' : 'confirmed'}>{c.origin === 'builtin' ? '内置' : '人工确认'}</Badge>
                        <span className="spacer" />
                        <span className="small-text muted">字段 {c.fields.length} 个</span>
                      </div>
                      <div className="table-wrap" style={{ marginTop: 8, maxHeight: 260 }}>
                        <table>
                          <thead><tr><th>字段</th><th>标签模式</th><th>位置</th><th>结构依赖</th><th>适用阶段</th><th>语义</th></tr></thead>
                          <tbody>
                            {c.fields.map((f) => (
                              <tr key={f.field}>
                                <td className="small-text">{FACT_TYPE_LABELS[f.field]}</td>
                                <td className="small-text">{f.labelPatterns.join('、')}</td>
                                <td className="small-text">{f.locality}</td>
                                <td className="small-text">{f.structural ? '是' : '否'}</td>
                                <td className="small-text">{f.applicableStages.join('/')}</td>
                                <td className="small-text muted">{f.semantics ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {c.semanticsOverrides && (
                        <ul className="reason-list small-text" style={{ marginTop: 6 }}>
                          {Object.entries(c.semanticsOverrides).map(([k, v]) => <li key={k}>【{k}】{v}</li>)}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3>⑤ 影响定位：模板变化后受影响的项目字段与需复核的发布版本</h3>
            <div className="flex">
              <label style={{ margin: 0 }}>来源
                <select
                  value={impactSource}
                  onChange={(e) => {
                    const next = e.target.value;
                    setImpactSource(next);
                    // 切换来源时把基准模板切到该来源的第一项，避免用其它来源的模板做基准
                    const first = registeredTemplates.find((t) => t.sourceId === next);
                    setImpactFrom(first?.templateId ?? '');
                    setImpact(null);
                  }}
                  style={{ width: 180 }}
                >
                  {builtinSourceRefs().map((s) => <option key={s.id} value={s.id}>{s.province}·{s.portalName}</option>)}
                </select>
              </label>
              <label style={{ margin: 0 }}>基准模板
                <select value={impactFrom} onChange={(e) => setImpactFrom(e.target.value)} style={{ width: 200 }}>
                  {registeredTemplates.filter((t) => t.sourceId === impactSource).map((t) => (
                    <option key={`${t.templateId}@${t.templateVersion}`} value={t.templateId}>{t.templateId}@{t.templateVersion}</option>
                  ))}
                </select>
              </label>
              <button disabled={busy || state.publications.length === 0} onClick={async () => setImpact((await props.onLocateImpact({ sourceId: impactSource, fromTemplateId: impactFrom })) ?? null)}>
                计算影响范围
              </button>
            </div>
            {state.publications.length === 0 && <div className="small-text muted" style={{ marginTop: 6 }}>尚无发布版本；影响定位需要至少一次发布。</div>}
            {impact && (
              <div style={{ marginTop: 12 }}>
                <div className="field-grid">
                  <KeyVal k="受影响快照">{impact.affectedSnapshotIds.length} 个</KeyVal>
                  <KeyVal k="受影响发布版本">{impact.affectedPublications.map((p) => `v${p.version}`).join('、') || '—'}</KeyVal>
                  <KeyVal k="受影响统计口径">{impact.affectedStats.join('、') || '—'}</KeyVal>
                  <KeyVal k="受影响项目（按字段）">{impact.affectedProjects.length} 条</KeyVal>
                </div>
                <div className="table-wrap" style={{ marginTop: 8 }}>
                  <table>
                    <thead><tr><th>发布版本</th><th>项目编号</th><th>受影响字段</th><th>快照数</th><th>统计口径</th></tr></thead>
                    <tbody>
                      {impact.affectedProjects.map((p, i) => (
                        <tr key={i}>
                          <td>v{p.publicationVersion}</td>
                          <td className="mono small-text">{p.projectCode}</td>
                          <td className="small-text">{p.fields.join('、')}</td>
                          <td className="small-text">{p.snapshotIds.length}</td>
                          <td className="small-text">{p.statsAffected ? '含统计字段' : '仅字段'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="reason-list small-text" style={{ marginTop: 8 }}>
                  {impact.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
          </div>

          <div className="panel">
            <h3>⑥ 修复回放（固定快照上比较新旧规则，不改写已发布事实）</h3>
            <div className="flex" style={{ alignItems: 'flex-start' }}>
              <label style={{ margin: 0 }}>来源
                <select value={replaySource} onChange={(e) => setReplaySource(e.target.value)} style={{ width: 180 }}>
                  {builtinSourceRefs().map((s) => <option key={s.id} value={s.id}>{s.province}·{s.portalName}</option>)}
                </select>
              </label>
              <div>
                <label style={{ margin: '0 0 4px' }}>修复补丁</label>
                {BUILTIN_REPAIR_PATCHES.map((p) => (
                  <label key={p.id} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, color: 'var(--text)' }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={patchIds.includes(p.id)}
                      onChange={(e) => setPatchIds((ids) => (e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id)))}
                    />
                    <span className="small-text">{p.id} · {p.description}</span>
                  </label>
                ))}
              </div>
              <button className="primary" disabled={busy || patchIds.length === 0} onClick={async () => setReplay((await props.onReplayRepair(patchIds, replaySource)) ?? null)}>
                执行修复回放
              </button>
            </div>
            <div className="small-text muted" style={{ marginTop: 6 }}>回放只在固定快照水位上重算差异并产出报告；已发布事实、快照与裁决均不修改。</div>
            {replay && (
              <div style={{ marginTop: 12 }}>
                <div className="flex">
                  <Badge className="confirmed">已发布事实未改动</Badge>
                  <span className="small-text">补丁版本 {replay.patchVersion}</span>
                  <span className="small-text muted">快照水位 {replay.snapshotWatermark.length} 个</span>
                </div>
                <div className="table-wrap" style={{ marginTop: 8 }}>
                  <table>
                    <thead><tr><th>变化</th><th>字段</th><th>新值</th><th>原值</th><th>规则</th><th>证据</th></tr></thead>
                    <tbody>
                      {replay.diffs.map((d, i) => (
                        <tr key={i}>
                          <td>{d.change === 'added' ? <Badge className="confirmed">新增</Badge> : d.change === 'removed' ? <Badge className="rejected">移除</Badge> : <Badge className="pending">变更</Badge>}</td>
                          <td className="small-text">{FACT_TYPE_LABELS[d.field]}</td>
                          <td className="mono small-text">{d.value}</td>
                          <td className="mono small-text">{d.previousValue ?? '—'}</td>
                          <td className="small-text">{d.ruleId}</td>
                          <td className="small-text">{d.evidence.text}</td>
                        </tr>
                      ))}
                      {replay.diffs.length === 0 && <tr><td colSpan={6} className="muted">所选补丁在该来源未产生提取差异。</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div className="small-text" style={{ marginTop: 8 }}>
                  影响定位：受影响项目 {replay.affectedProjects.length} 条（{replay.affectedProjects.map((p) => `v${p.publicationVersion}/${p.projectCode}〔${p.fields.join('、')}〕`).join('；') || '无'}）；
                  需复核发布版本 {replay.affectedPublications.map((p) => `v${p.version}`).join('、') || '无'}。
                </div>
              </div>
            )}
          </div>

          <div className="panel">
            <h3>⑦ 历史质量运行</h3>
            {state.qualityRuns.length === 0 ? <div className="muted small-text">无</div> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>时间</th><th>范围</th><th>样本</th><th>已知</th><th>打印版</th><th>未知</th><th>未知聚类</th><th>渐进告警</th></tr></thead>
                  <tbody>
                    {[...state.qualityRuns].sort((a, b) => b.createdAt - a.createdAt).map((r) => (
                      <tr key={r.id}>
                        <td className="small-text">{formatTime(r.createdAt)}</td>
                        <td className="small-text">{r.datasetScope === 'all' ? '全部' : '仅质量样例'}</td>
                        <td>{r.totals.snapshotCount}</td>
                        <td>{r.totals.knownTemplateCount}</td>
                        <td>{r.totals.printSnapshotCount}</td>
                        <td>{r.totals.unknownTemplateCount}</td>
                        <td>{r.discoveries.clusters.length}</td>
                        <td>{r.discoveries.driftAlerts.filter((a) => a.progressive).length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {activeProfile && activeSnapshot && (
        <Drawer title={`模板画像 · ${activeSnapshot.sources[0]?.fileName ?? activeSnapshot.id}`} onClose={() => setProfileDrawerSnapshot(null)}>
          <div className="field-grid">
            <KeyVal k="来源">{sourceLabel(activeProfile.sourceId)}</KeyVal>
            <KeyVal k="页面类型">{activeProfile.pageKind}</KeyVal>
            <KeyVal k="期间">{activeProfile.period ?? '—'}</KeyVal>
            <KeyVal k="文档日期">{activeProfile.documentDate ?? '—'}</KeyVal>
            <KeyVal k="结构指纹"><span className="hash">{activeProfile.fingerprint}</span></KeyVal>
            <KeyVal k="打印版 / 缺页">{activeProfile.printLikely ? '打印版' : '否'} / {activeProfile.pageIncomplete ? '缺页' : '否'}</KeyVal>
            <KeyVal k="折叠栏 / 附件">{activeProfile.signature.hasFold ? '有折叠' : '无折叠'} / {activeProfile.signature.hasAttachment ? '有附件' : '无附件'}</KeyVal>
            <KeyVal k="标题层级数">{activeProfile.headings.filter((h) => h.level > 0).length}</KeyVal>
          </div>
          <hr className="sep" />
          <h3>标签序列（结构指纹输入，已掩码取值）</h3>
          <pre>{activeProfile.signature.labelSequence.join('\n')}</pre>
          <hr className="sep" />
          <h3>标题层级</h3>
          {activeProfile.headings.length === 0 ? <span className="muted small-text">无</span> : (
            <ul className="reason-list small-text">
              {activeProfile.headings.map((h, i) => <li key={i}>L{h.level} · {h.text}</li>)}
            </ul>
          )}
          <hr className="sep" />
          <h3>字段邻域指纹（前 {Math.min(12, activeProfile.neighborhoods.length)} 条，共 {activeProfile.neighborhoods.length}）</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>字段提示</th><th>标签</th><th>结构</th><th>位置</th><th>前标签</th><th>后标签</th><th>取值形状</th><th>邻域指纹</th></tr></thead>
              <tbody>
                {activeProfile.neighborhoods.slice(0, 12).map((n, i) => (
                  <tr key={i}>
                    <td className="small-text">{n.fieldHint === 'unknown' ? '—' : FACT_TYPE_LABELS[n.fieldHint as FactType]}</td>
                    <td className="small-text">{n.labelShape}</td>
                    <td className="small-text">{n.sectionKind}</td>
                    <td className="small-text">{n.positionBucket}</td>
                    <td className="small-text">{n.beforeLabels.join(' / ')}</td>
                    <td className="small-text">{n.afterLabels.join(' / ')}</td>
                    <td className="small-text">{n.valueShape}</td>
                    <td className="hash">{shortHash(n.fingerprint)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <hr className="sep" />
          <h3>结构片段（{activeProfile.fragments.length}）</h3>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table>
              <thead><tr><th>#</th><th>类型</th><th>标签形状</th><th>长度</th><th>有值</th></tr></thead>
              <tbody>
                {activeProfile.fragments.map((f) => (
                  <tr key={f.index}>
                    <td>{f.index}</td>
                    <td className="small-text">{f.kind}</td>
                    <td className="small-text">{f.labelShape}</td>
                    <td className="small-text">{f.lengthBucket}</td>
                    <td className="small-text">{f.hasValue ? '是' : '否'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Drawer>
      )}

      {confirmCluster && (
        <Drawer title={`登记新模板版本 · ${sourceLabel(confirmCluster.sourceId)} / ${confirmCluster.pageKind}`} onClose={() => setConfirmCluster(null)}>
          <div className="small-text muted" style={{ marginBottom: 8 }}>
            确认后：登记该聚类的结构指纹为新模板版本，并从**同来源**基准模板派生字段契约（需人工校对）。
            未确认前这些页面保持 unknown，不进入任何提取率。
          </div>
          <label>模板 id</label>
          <input value={confirmForm.templateId} onChange={(e) => setConfirmForm((f) => ({ ...f, templateId: e.target.value }))} />
          <label>模板版本</label>
          <input value={confirmForm.templateVersion} onChange={(e) => setConfirmForm((f) => ({ ...f, templateVersion: e.target.value }))} />
          <label>标签</label>
          <input value={confirmForm.label} onChange={(e) => setConfirmForm((f) => ({ ...f, label: e.target.value }))} />
          <label>审核员</label>
          <input value={confirmForm.reviewer} onChange={(e) => setConfirmForm((f) => ({ ...f, reviewer: e.target.value }))} />
          <label>审核结论说明</label>
          <textarea value={confirmForm.note} onChange={(e) => setConfirmForm((f) => ({ ...f, note: e.target.value }))} placeholder="记录为何确认这是新模板版本" />
          <div className="small-text muted" style={{ marginTop: 8 }}>
            成员快照：{confirmCluster.memberSnapshotIds.length} 个；期间：{confirmCluster.periods.join('、') || '—'}；最近已知模板相似度：{confirmCluster.nearestKnown?.similarity ?? '—'}
          </div>
          <div className="flex" style={{ marginTop: 12 }}>
            <button className="primary" disabled={props.busy || !confirmForm.templateId.trim()} onClick={submitConfirm}>确认并登记</button>
            <button onClick={() => setConfirmCluster(null)}>取消</button>
          </div>
        </Drawer>
      )}
    </div>
  );
}

function outcomeBreakdown(f: FieldQualityMetric): string {
  const parts: string[] = [];
  if (f.extracted) parts.push(`已提取 ${f.extracted}`);
  if (f.extractionFailed) parts.push(`失败 ${f.extractionFailed}`);
  if (f.notDisclosed) parts.push(`未披露 ${f.notDisclosed}`);
  if (f.sourceIncomplete) parts.push(`缺页 ${f.sourceIncomplete}`);
  if (f.structuralUnavailable) parts.push(`结构不可用 ${f.structuralUnavailable}`);
  if (f.notApplicable) parts.push(`不适用 ${f.notApplicable}`);
  return parts.join(' · ');
}

