/**
 * 内存版 Repository：供单元测试使用，与 IndexedDbRepository 实现同一接口。
 */
import type {
  Adjudication,
  Fact,
  ImportBatch,
  Publication,
  QualityRun,
  RelationEdge,
  RepairReplayReport,
  Snapshot,
  TemplateAnnotation,
  TemplateRegistryEntry,
  FieldContract,
  WithdrawnEdgeRecord,
} from './types';
import type { Repository } from './repository';
import type { EngineMeta } from './engine';

export class MemoryRepository implements Repository {
  snapshots = new Map<string, Snapshot>();
  batches = new Map<string, ImportBatch>();
  facts = new Map<string, Fact>();
  edges = new Map<string, RelationEdge>();
  adjudications = new Map<string, Adjudication>();
  withdrawn = new Map<string, WithdrawnEdgeRecord>();
  publications = new Map<string, Publication>();
  qualityRuns = new Map<string, QualityRun>();
  templateRegistry = new Map<string, TemplateRegistryEntry>();
  fieldContracts = new Map<string, FieldContract>();
  annotations = new Map<string, TemplateAnnotation>();
  repairReplays = new Map<string, RepairReplayReport>();
  meta: EngineMeta | null = null;

  async getAllSnapshots() {
    return [...this.snapshots.values()];
  }
  async getSnapshot(id: string) {
    return this.snapshots.get(id);
  }
  async getSnapshotByContentHash(hash: string) {
    return [...this.snapshots.values()].find((s) => s.contentHash === hash);
  }
  async putSnapshot(snapshot: Snapshot) {
    this.snapshots.set(snapshot.id, snapshot);
  }
  async putBatch(batch: ImportBatch) {
    this.batches.set(batch.id, batch);
  }
  async getAllBatches() {
    return [...this.batches.values()];
  }
  async getAllFacts() {
    return [...this.facts.values()];
  }
  async putFacts(facts: Fact[]) {
    for (const f of facts) this.facts.set(f.id, f);
  }
  async replaceAllFacts(facts: Fact[]) {
    this.facts.clear();
    await this.putFacts(facts);
  }
  async getAllEdges() {
    return [...this.edges.values()];
  }
  async putEdge(edge: RelationEdge) {
    this.edges.set(edge.id, edge);
  }
  async replaceAllEdges(edges: RelationEdge[]) {
    this.edges.clear();
    for (const e of edges) this.edges.set(e.id, e);
  }
  async putAdjudication(adjudication: Adjudication) {
    this.adjudications.set(adjudication.id, adjudication);
  }
  async getAllAdjudications() {
    return [...this.adjudications.values()];
  }
  async getAdjudicationByEdge(edgeId: string) {
    return [...this.adjudications.values()].filter((a) => a.edgeId === edgeId).sort((a, b) => b.createdAt - a.createdAt)[0];
  }
  async putWithdrawn(record: WithdrawnEdgeRecord) {
    this.withdrawn.set(record.edgeId, record);
  }
  async getAllWithdrawn() {
    return [...this.withdrawn.values()];
  }
  async putPublication(publication: Publication) {
    this.publications.set(publication.id, publication);
  }
  async getLatestPublication(): Promise<Publication | null> {
    const all = [...this.publications.values()];
    return all.length ? all.sort((a, b) => b.version - a.version)[0] : null;
  }
  async getAllPublications() {
    return [...this.publications.values()];
  }
  async getMeta() {
    return this.meta;
  }
  async putMeta(meta: EngineMeta) {
    this.meta = meta;
  }

  async getAllQualityRuns() {
    return [...this.qualityRuns.values()];
  }
  async putQualityRun(run: QualityRun) {
    this.qualityRuns.set(run.id, run);
  }

  async getAllTemplateRegistry() {
    return [...this.templateRegistry.values()];
  }
  async putTemplateRegistry(entry: TemplateRegistryEntry) {
    this.templateRegistry.set(entry.id, entry);
  }

  async getAllContracts() {
    return [...this.fieldContracts.values()];
  }
  async putContract(contract: FieldContract) {
    this.fieldContracts.set(contract.id, contract);
  }

  async getAllAnnotations() {
    return [...this.annotations.values()];
  }
  async putAnnotation(annotation: TemplateAnnotation) {
    this.annotations.set(annotation.id, annotation);
  }

  async getAllRepairReplays() {
    return [...this.repairReplays.values()];
  }
  async putRepairReplay(report: RepairReplayReport) {
    this.repairReplays.set(report.id, report);
  }

  async clearAll() {
    this.snapshots.clear();
    this.batches.clear();
    this.facts.clear();
    this.edges.clear();
    this.adjudications.clear();
    this.withdrawn.clear();
    this.publications.clear();
    this.qualityRuns.clear();
    this.templateRegistry.clear();
    this.fieldContracts.clear();
    this.annotations.clear();
    this.repairReplays.clear();
    this.meta = null;
  }
}
