/**
 * 门户模板演变与抽取质量监测验收测试。
 *
 * 覆盖题面要求的样例与验证点：
 *  - 页面改版：预算移入折叠栏 → 已知模板识别 / 未识别进入未知并聚类；
 *  - 附件化字段：标段表移入附件；
 *  - 打印版：导入后才发现是打印件 → 结构字段缺失记为“结构不可用”，不计门户漏报；
 *  - 规则修复：修复补丁在固定快照回放的差异，只标出依赖该字段的项目与统计版本，
 *    且不改写已发布事实；
 *  - 跨来源同形异义：外观相同但“包件”语义不同，质量指标按来源分开、不共用分母；
 *  - 质量指标：提取率 / 来源缺失率 / 解析失败率 / 样本量；
 *  - 来源未披露 vs 抽取失败 vs 离线缺页 vs 结构不可用 的区分；
 *  - 未知页面只标 unknown，人工确认后进入分母。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkbenchEngine, type ImportFileInput } from './engine';
import { MemoryRepository } from './memoryRepository';
import { parseDocument, inferSourceKind } from './parser';
import { detectPageKind, detectSourceId, profileSnapshot, signatureSimilarity } from './templateProfile';
import { buildBuiltinRegistry, BUILTIN_REPAIR_PATCHES } from './templateCatalog';
import { buildRuntime, matchProfile } from './templateLibrary';
import type { Snapshot, TemplateProfile } from './types';

const QUALITY_DIR = join(process.cwd(), 'sample-archive', 'quality');
const SAMPLE_DIR = join(process.cwd(), 'sample-archive');

function loadQualityFiles(): ImportFileInput[] {
  return readdirSync(QUALITY_DIR)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((fileName) => ({ fileName: `quality/${fileName}`, text: readFileSync(join(QUALITY_DIR, fileName), 'utf-8') }));
}

let clockValue = 1_700_000_000_000;
const clock = () => (clockValue += 1000);

async function newEngine() {
  const repo = new MemoryRepository();
  const engine = new WorkbenchEngine(repo, undefined, clock);
  return { repo, engine };
}

/** 依据给定文件名前缀取样例文本并构造快照（不落库），用于纯画像测试 */
function syntheticSnapshot(fileName: string, sourceDir = QUALITY_DIR): Snapshot {
  const text = readFileSync(join(sourceDir, fileName), 'utf-8');
  return {
    id: `snap_${fileName}`,
    contentHash: `c_${fileName}`,
    normalizedHash: `n_${fileName}`,
    rawText: text,
    sources: [{ fileName, batchId: 'b', importedAt: 1, size: text.length }],
    parsed: parseDocument(text, inferSourceKind(fileName)),
    createdAt: 1,
  };
}

/** 建立完整的导入 + 发布 + 质量基线：导入 12 份示例 + 17 份质量样例 */
async function importAllAndPublish() {
  const { repo, engine } = await newEngine();
  const base = readdirSync(SAMPLE_DIR)
    .filter((f) => f.endsWith('.txt'))
    .map((fileName) => ({ fileName, text: readFileSync(join(SAMPLE_DIR, fileName), 'utf-8') }));
  await engine.importBatch('基础示例', [...base, ...loadQualityFiles()]);
  // 确认所有非冲突候选边，让项目链完整
  for (const e of await repo.getAllEdges()) {
    if (e.status === 'pending' && e.type !== 'conflict') {
      await engine.adjudicate({ edgeId: e.id, decision: 'confirm', note: '测试确认', reviewer: 'tester', appliedFactIds: e.evidenceFactIds });
    }
  }
  const publication = await engine.recomputeAndPublish('full');
  return { repo, engine, publication };
}

function profileOf(profile: TemplateProfile, runtime = buildRuntime([], [])) {
  return matchProfile(profile, runtime);
}

describe('模板画像器', () => {
  it('同结构不同取值可精确命中同一审核模板（来源 + 页面类型内匹配）', () => {
    const registry = buildBuiltinRegistry();
    const runtime = buildRuntime([], []);
    // 内置参考结构 vs 真实公告（取值不同）应精确命中
    const profile = profileSnapshot(syntheticSnapshot('江苏-2024-04-网页基线-JS2024-JC-011.txt'), 'js');
    const match = matchProfile(profile, runtime);
    expect(match.status).toBe('known');
    expect(match.matchKind).toBe('exact');
    expect(match.templateId).toBe('js-web-v1');
    expect(registry.some((r) => r.definition.templateId === 'js-web-v1')).toBe(true);
  });

  it('从快照生成结构片段、标题层级与字段邻域指纹', () => {
    const profile = profileSnapshot(syntheticSnapshot('江苏-2024-06-标段附件化-JS2024-JC-011.txt'), 'js');
    expect(profile.signature.hasAttachment).toBe(true);
    expect(profile.fragments.some((f) => f.kind === 'attachment_heading')).toBe(true);
    expect(profile.neighborhoods.length).toBeGreaterThan(3);
    for (const n of profile.neighborhoods) {
      expect(n.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(['top', 'middle', 'bottom']).toContain(n.positionBucket);
    }
    // 取值被掩码：标签序列里不应出现真实编号/金额
    const joined = profile.signature.labelSequence.join('|');
    expect(joined).not.toContain('286');
    expect(joined).not.toContain('JC-011');
  });

  it('打印版可仅凭内容识别（文件名不含“打印”），并以结构不可用纳入画像', () => {
    const snap = syntheticSnapshot('江苏-2024-08-归档副本-JS2024-JC-011.txt');
    expect(snap.sources[0].fileName).not.toContain('打印');
    const profile = profileSnapshot(snap, 'js');
    expect(profile.printLikely).toBe(true);
    expect(profile.structuralUnavailable).toBe(true);
  });

  it('页面类型按标题/正文判定，来源按文件名与正文判定', () => {
    expect(detectPageKind('某某项目采购意向公告\n预算金额：10万元')).toBe('intention');
    expect(detectPageKind('某某项目中标公告\n中标供应商：某公司')).toBe('result');
    expect(detectSourceId('江苏-2024-04-网页基线.txt', '')).toBe('js');
    expect(detectSourceId('无来源.txt', '四川省政府采购网 公告')).toBe('sc');
  });
});

describe('契约与已知模板识别', () => {
  it('跨来源同形异义：外观相同但“包件”语义不同，契约按来源分开登记', () => {
    const runtime = buildRuntime([], []);
    const zj = runtime.contracts.find((c) => c.sourceId === 'zj' && c.templateId === 'zj-web-v1')!;
    const js = runtime.contracts.find((c) => c.sourceId === 'js' && c.templateId === 'js-web-v1')!;
    expect(zj.appearanceGroup).toBe(js.appearanceGroup);
    // 浙江把“第X标段”声明为 lot；江苏契约不声明 lot（包件≠标段）
    expect(zj.fields.some((f) => f.field === 'lot')).toBe(true);
    expect(js.fields.some((f) => f.field === 'lot')).toBe(false);
    expect(js.semanticsOverrides?.lot).toContain('不是采购标段');
    // 质量分组 id 必含来源，杜绝跨来源共用一个分母
    expect(zj.id).not.toBe(js.id);
  });

  it('签字相同但取值不同 → 同一模板；结构改版（附件化）低于已知阈值 → unknown', () => {
    const runtime = buildRuntime([], []);
    const baseline = profileOf(profileSnapshot(syntheticSnapshot('江苏-2024-04-网页基线-JS2024-JC-011.txt'), 'js'), runtime);
    const attachment = profileOf(profileSnapshot(syntheticSnapshot('江苏-2024-06-标段附件化-JS2024-JC-011.txt'), 'js'), runtime);
    expect(baseline.status).toBe('known');
    expect(attachment.status).toBe('unknown');
    expect(attachment.nearestKnown?.similarity).toBeLessThan(0.8);
  });
});

describe('质量运行：三类“预算骤减”的区分', () => {
  it('页面改版（折叠）→ 解析失败；来源未披露 → 来源缺失；打印版 → 结构不可用', async () => {
    const { engine } = await importAllAndPublish();
    const analysis = await engine.runQualityCheck({ scope: 'quality-samples' });
    const byFile = (needle: string) => analysis.snapshotSummaries.find((s) => s.fileName.includes(needle))!;

    // 折叠改版样本结构变化较大 → 未登记新模板（unknown）；但页面上出现了预算标签却未提取，
    // 诊断结果必须提示“疑似模板改版/规则不识别”，与“来源未披露”区分开。
    const folded = byFile('预算折叠改版');
    expect(folded.status).toBe('unknown');
    expect(folded.templateChangeSuspectedFields).toContain('amount');
    expect(folded.notDisclosedFields).not.toContain('amount');
    // 同一已知模板下仅标签改名（采购限价→无法识别）→ 解析失败（规则问题，不是门户漏报）
    const renamed = byFile('标签重命名');
    expect(renamed.status).toBe('known');
    expect(renamed.extractionFailedFields).toContain('amount');

    const undisclosed = byFile('来源未披露');
    expect(undisclosed.notDisclosedFields).toContain('amount');
    expect(undisclosed.extractionFailedFields).not.toContain('amount');

    const print = byFile('归档副本');
    expect(print.status).toBe('print');
    expect(print.structuralUnavailableFields).toContain('amount');
    expect(print.extractionFailedFields).not.toContain('amount');
  });

  it('打印版缺失绝不计为门户漏报：序列化结果中该分组来源缺失率与解析失败率均为空', async () => {
    const { engine } = await importAllAndPublish();
    const analysis = await engine.runQualityCheck({ scope: 'quality-samples' });
    const printGroup = analysis.run.groups.find((g) => g.templateStatus === 'print')!;
    const amount = printGroup.fields.find((f) => f.field === 'amount')!;
    expect(amount.structuralUnavailable).toBe(1);
    expect(amount.notDisclosed).toBe(0);
    expect(amount.extractionFailed).toBe(0);
    expect(amount.sourceMissingRate).toBeNull();
    expect(amount.parseFailureRate).toBeNull();
    expect(amount.extractionRate).toBeNull();
  });

  it('字段提取率 / 来源缺失率 / 解析失败率 / 样本量按来源·模板·期间分组计算', async () => {
    const { engine } = await importAllAndPublish();
    const analysis = await engine.runQualityCheck({ scope: 'quality-samples' });
    const jsGroups = analysis.run.groups.filter((g) => g.sourceId === 'js' && g.templateId === 'js-web-v1');
    expect(jsGroups.length).toBeGreaterThan(0);
    // 2024-05 折叠改版为 unknown，不进分组；政务云公告仍在 js-web-v1 分组。
    const mayGroup = jsGroups.find((g) => g.period === '2024-05');
    expect(mayGroup).toBeTruthy();
    for (const g of jsGroups) {
      expect(g.sampleSize).toBe(g.snapshotIds.length);
      for (const f of g.fields) {
        const count = f.extracted + f.extractionFailed + f.notDisclosed;
        if (count > 0) {
          if (f.extracted + f.extractionFailed > 0) {
            expect(f.extractionRate).toBeCloseTo(f.extracted / (f.extracted + f.extractionFailed), 4);
          }
          expect(f.sourceMissingRate).toBeCloseTo(f.notDisclosed / count, 4);
          expect(f.parseFailureRate).toBeCloseTo(f.extractionFailed / count, 4);
        }
      }
    }
    // 已知模板上的“解析失败”来自标签重命名样本（采购限价未被识别）
    const totalFailed = jsGroups.flatMap((g) => g.fields).filter((f) => f.field === 'amount').reduce((n, f) => n + f.extractionFailed, 0);
    expect(totalFailed).toBeGreaterThanOrEqual(1);
    // 同一来源不同模板分组之间不共用样本
    const snapshotOwners = new Map<string, string[]>();
    for (const g of jsGroups) for (const sid of g.snapshotIds) snapshotOwners.set(sid, [...(snapshotOwners.get(sid) ?? []), g.id]);
    expect([...snapshotOwners.values()].every((owners) => owners.length === 1)).toBe(true);
  });

  it('跨来源同形异义：江苏“包件”不计入标段提取率，只作为契约外观察值', async () => {
    const { engine } = await importAllAndPublish();
    const analysis = await engine.runQualityCheck({ scope: 'quality-samples' });
    const jsBase = analysis.run.groups.find((g) => g.sourceId === 'js' && g.templateId === 'js-web-v1' && g.period === '2024-04')!;
    // 契约无 lot 字段
    expect(jsBase.fields.some((f) => f.field === 'lot')).toBe(false);
    // 提取器确实产出了“包件”事实，但只记为观察值
    expect(jsBase.offContractCounts.lot ?? 0).toBeGreaterThan(0);
    // 浙江同模板确实有 lot 指标
    const zjBase = analysis.run.groups.find((g) => g.sourceId === 'zj' && g.templateId === 'zj-web-v1')!;
    expect(zjBase.fields.some((f) => f.field === 'lot')).toBe(true);
  });

  it('未知页面只标 unknown 且不进入提取率分母；确认后才进入分组', async () => {
    const { engine } = await importAllAndPublish();
    const before = await engine.runQualityCheck({ scope: 'quality-samples' });
    expect(before.run.unknownSnapshotIds.length).toBeGreaterThan(0);
    const unknownIds = new Set(before.run.unknownSnapshotIds);
    // 所有 unknown 样本的字段在 assessments 中都是 unknown_template
    const unknownAssess = before.run.assessments.filter((a) => unknownIds.has(a.snapshotId));
    expect(unknownAssess.length).toBeGreaterThan(0);
    expect(unknownAssess.every((a) => a.outcome === 'unknown_template')).toBe(true);

    // 选取附件化聚类（唯一一个 announcement 未知）确认为新模板
    const cluster = before.run.discoveries.clusters.find(
      (c) => c.sourceId === 'js' && c.pageKind === 'announcement' && c.periods.includes('2024-06'),
    )!;
    await engine.confirmTemplate({
      sourceId: cluster.sourceId,
      memberSnapshotIds: cluster.memberSnapshotIds,
      templateId: 'js-web-v2-attach',
      templateVersion: 'v2.0',
      label: '江苏门户 · 附件化公告 v2',
      reviewer: 'tester',
      note: '标段表移入附件',
    });
    const after = await engine.runQualityCheck({ scope: 'quality-samples' });
    expect(after.run.totals.knownTemplateCount).toBeGreaterThan(before.run.totals.knownTemplateCount);
    const newGroup = after.run.groups.find((g) => g.templateId === 'js-web-v2-attach');
    expect(newGroup).toBeTruthy();
    // 新模板版本的契约由同来源派生，绝不跨来源
    expect(newGroup!.sourceId).toBe('js');
  });

  it('渐进式改版：同一来源/页面类型的结构相似度逐期下降会给出渐进式告警', async () => {
    const { engine } = await importAllAndPublish();
    const analysis = await engine.runQualityCheck({ scope: 'quality-samples' });
    const progressive = analysis.run.discoveries.driftAlerts.filter((a) => a.progressive);
    expect(progressive.length).toBeGreaterThanOrEqual(1);
    const announcement = progressive.find((a) => a.sourceId === 'js' && a.pageKind === 'announcement');
    expect(announcement).toBeTruthy();
    expect(announcement!.periods.length).toBeGreaterThanOrEqual(2);
  });
});

describe('影响定位：只标出依赖该字段的项目与统计版本', () => {
  it('规则修复补出“预算”时，只影响依赖预算的项目与预算统计口径', async () => {
    const { engine, publication } = await importAllAndPublish();
    const report = await engine.replayRepairPatches({ sourceId: 'zj' });
    // 浙江更正公告的新写法金额被补出
    expect(report.diffs.some((d) => d.field === 'amount' && d.change === 'added')).toBe(true);
    // 受影响项目只含浙江项目，且字段只含预算
    expect(report.affectedProjects.length).toBeGreaterThan(0);
    for (const p of report.affectedProjects) {
      expect(p.fields.every((f) => f === 'currentBudgetCny' || f === 'lot.budget')).toBe(true);
    }
    // 需复核的发布版本命中当前发布
    expect(report.affectedPublications.some((p) => p.id === publication.id)).toBe(true);
    // 统计口径包含预算合计
    expect(report.affectedPublications[0].statsAffected).toBe(true);
  });

  it('修复补丁的字段范围隔离：江苏补丁不影响浙江项目', async () => {
    const { engine } = await importAllAndPublish();
    const zjReport = await engine.replayRepairPatches({ sourceId: 'zj' });
    const jsReport = await engine.replayRepairPatches({ sourceId: 'js' });
    const zjProjects = new Set(zjReport.affectedProjects.map((p) => p.projectCode));
    const jsProjects = new Set(jsReport.affectedProjects.map((p) => p.projectCode));
    expect([...zjProjects].some((c) => c.startsWith('ZJ'))).toBe(true);
    expect([...jsProjects].some((c) => c.startsWith('JS'))).toBe(true);
    // 两边项目编号互不交叉
    expect([...zjProjects].some((c) => c.startsWith('JS'))).toBe(false);
    expect([...jsProjects].some((c) => c.startsWith('ZJ'))).toBe(false);
  });
});

describe('修复回放不直接改写已发布事实', () => {
  it('回放后事实、快照、发布版本逐字段不变，且回放报告声明未改动', async () => {
    const { repo, engine, publication } = await importAllAndPublish();
    const factsBefore = await repo.getAllFacts();
    const snapshotsBefore = await repo.getAllSnapshots();
    const pubsBefore = await repo.getAllPublications();
    const report = await engine.replayRepairPatches({ sourceId: 'js' });
    expect(report.publishedFactsUntouched).toBe(true);
    const factsAfter = await repo.getAllFacts();
    expect(factsAfter.length).toBe(factsBefore.length);
    expect(factsAfter.map((f) => f.id).sort()).toEqual(factsBefore.map((f) => f.id).sort());
    const snapshotsAfter = await repo.getAllSnapshots();
    expect(snapshotsAfter.map((s) => s.id).sort()).toEqual(snapshotsBefore.map((s) => s.id).sort());
    const pubsAfter = await repo.getAllPublications();
    expect(pubsAfter.length).toBe(pubsBefore.length);
    expect(pubsAfter.find((p) => p.id === publication.id)).toBeTruthy();
    // 回放报告写入仓储，但不写入事实
    expect((await repo.getAllRepairReplays()).some((r) => r.id === report.id)).toBe(true);
  });

  it('补丁只在固定快照水位上比较新旧规则（确定性可复跑）', async () => {
    const { engine } = await importAllAndPublish();
    const snapshots = await (async () => {
      // 仅比较可复算性：同一补丁两次回放，差异集合一致
      const a = await engine.replayRepairPatches({ sourceId: 'js', patchIds: ['patch-amount-tax-inclusive', 'patch-lot-attachment'] });
      const b = await engine.replayRepairPatches({ sourceId: 'js', patchIds: ['patch-amount-tax-inclusive', 'patch-lot-attachment'] });
      return { a, b };
    })();
    expect(snapshots.a.snapshotWatermark).toEqual(snapshots.b.snapshotWatermark);
    expect(snapshots.a.diffs.map((d) => `${d.change}:${d.field}:${d.value}`)).toEqual(
      snapshots.b.diffs.map((d) => `${d.change}:${d.field}:${d.value}`),
    );
  });

  it('补丁仅在解析得到对应结构时产生新增事实，未知页面也可在回放中检验', async () => {
    const { engine } = await importAllAndPublish();
    const withPatch = await engine.replayRepairPatches({ sourceId: 'js' });
    // 附件化标段（无“第”前缀）由补丁补出
    expect(withPatch.diffs.some((d) => d.field === 'lot' && d.change === 'added')).toBe(true);
    // 带“含税”的折叠金额由补丁补出
    expect(withPatch.diffs.some((d) => d.field === 'amount' && d.change === 'added')).toBe(true);
    // 补丁总数与内置补丁一致（默认全选）
    expect(BUILTIN_REPAIR_PATCHES.length).toBeGreaterThanOrEqual(2);
  });
});

describe('质量历史与持久化', () => {
  it('质量运行结果持久化，可用于回看与来源隔离比较', async () => {
    const { repo, engine } = await importAllAndPublish();
    const run = await engine.runQualityCheck({ scope: 'quality-samples' });
    const stored = await repo.getAllQualityRuns();
    expect(stored.some((r) => r.id === run.run.id)).toBe(true);
    const fetched = stored.find((r) => r.id === run.run.id)!;
    expect(fetched.groups.length).toBe(run.run.groups.length);
    expect(fetched.totals.snapshotCount).toBe(run.run.totals.snapshotCount);
    // 每个分组的来源与样本量都可追溯
    for (const g of fetched.groups) {
      expect(g.snapshotIds.length).toBe(g.sampleSize);
      expect(g.sourceId).toMatch(/^(zj|js|sc|ah|hn|unknown)$/);
    }
  });
});

describe('离线缺页与结构不可用的区别', () => {
  it('缺页标记（下页续）使结构字段归因“离线缺页”，而打印版归因“结构不可用”', () => {
    const text = readFileSync(join(SAMPLE_DIR, '06-浙江-中标结果-ZC2024-017-附件摘要.txt'), 'utf-8');
    // 模拟离线归档缺页：只保留前半段并加缺页标记
    const truncated = text.split('\n').slice(0, 12).join('\n') + '\n（下页续）\n';
    const snapshot: Snapshot = {
      id: 'snap_truncated',
      contentHash: 'c',
      normalizedHash: 'n',
      rawText: truncated,
      sources: [{ fileName: '浙江-缺页.txt', batchId: 'b', importedAt: 1, size: truncated.length }],
      parsed: parseDocument(truncated, inferSourceKind('浙江-缺页.txt')),
      createdAt: 1,
    };
    const profile = profileSnapshot(snapshot, 'zj');
    expect(profile.pageIncomplete).toBe(true);
    expect(profile.printLikely).toBe(false);
  });

  it('离线缺页样本的结构字段归因来源为“离线缺页”，不进入来源缺失率', async () => {
    const { repo, engine } = await importAllAndPublish();
    const baseFile = readFileSync(join(QUALITY_DIR, '浙江-2024-04-招标公告-ZJ2024-LM-058.txt'), 'utf-8');
    const truncated = baseFile.split('\n').slice(0, 8).join('\n') + '\n（下页续）\n';
    await engine.importBatch('缺页副本', [{ fileName: 'quality/浙江-2024-04-招标公告-缺页副本.txt', text: truncated }]);
    await engine.recomputeAndPublish('full');
    const analysis = await engine.runQualityCheck({ scope: 'quality-samples' });
    const sum = analysis.snapshotSummaries.find((s) => s.fileName.includes('缺页副本'))!;
    expect(sum.pageIncomplete).toBe(true);
    // 该样本不会因为“预算缺失”而被计为解析失败或来源未披露
    expect(sum.extractionFailedFields).not.toContain('amount');
    expect(sum.notDisclosedFields).not.toContain('amount');
    // 存储中确实存在缺页标记样本
    expect(analysis.run.incompleteSnapshotIds.length).toBeGreaterThan(0);
    void repo;
  });
});

describe('已知模板识别不受取值影响（签名稳定性）', () => {
  it('同一内置模板的两份不同取值公告生成相同结构指纹', () => {
    const a = profileSnapshot(syntheticSnapshot('江苏-2024-04-网页基线-JS2024-JC-011.txt'), 'js');
    const b = profileSnapshot(syntheticSnapshot('江苏-2024-05-政务云公告-JS2024-YJ-022.txt'), 'js');
    expect(a.fingerprint).toBe(b.fingerprint);
    // 结构相似度接近 1（段落长度分布随取值略有差异），且都精确匹配同一已知模板
    expect(signatureSimilarity(a.signature, b.signature)).toBeGreaterThan(0.9);
    expect(profileOf(a).templateId).toBe('js-web-v1');
    expect(profileOf(b).templateId).toBe('js-web-v1');
  });
});
