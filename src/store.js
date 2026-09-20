// 内存存储：参与主体、协议版本、背景权利、材料、成果、贡献、交付、人工例外与审计日志。
// 所有写入都会留下审计记录，时间可显式传入（at / as_of），便于重放历史时点。
import {
  DomainError,
  computeEffective,
  inheritedLayers,
  serializeRestrictionSets,
} from "./domain.js";

export class Store {
  constructor() {
    this.parties = new Map();
    this.agreements = new Map(); // agreement_id -> [版本...]
    this.backgroundRights = new Map();
    this.materials = new Map();
    this.results = new Map();
    this.contributions = new Map();
    this.deliveries = [];
    this.exceptions = new Map();
    this.audit = [];
    this.sequence = 0;
  }

  nextId(prefix) {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  timestamp() {
    return new Date().toISOString();
  }

  log(entry) {
    const record = { audit_id: this.nextId("audit"), at: entry.at ?? this.timestamp(), ...entry };
    this.audit.push(record);
    return record;
  }

  addParty({ party_id, name, roles = [] }) {
    if (!party_id || !name) throw new DomainError("MISSING_FIELD", "参与主体需要 party_id 与 name");
    if (this.parties.has(party_id)) throw new DomainError("DUPLICATE_ID", `参与主体已存在：${party_id}`);
    const party = { party_id, name, roles };
    this.parties.set(party_id, party);
    return party;
  }

  addAgreementVersion({ agreement_id, version, effective_from, envelope = {}, parties = [], publication_requires_unanimous = true }) {
    if (!agreement_id || !version || !effective_from) {
      throw new DomainError("MISSING_FIELD", "协议版本需要 agreement_id、version、effective_from");
    }
    const versions = this.agreements.get(agreement_id) ?? [];
    if (versions.some((item) => item.version === version)) {
      throw new DomainError("DUPLICATE_ID", `协议 ${agreement_id} 已存在版本 v${version}`);
    }
    const record = { agreement_id, version, effective_from, envelope, parties, publication_requires_unanimous };
    versions.push(record);
    this.agreements.set(agreement_id, versions);
    return record;
  }

  // 取 as_of 时点生效的协议版本（effective_from 最晚且不超过 as_of）。
  currentAgreement(asOf) {
    let current = null;
    for (const versions of this.agreements.values()) {
      for (const version of versions) {
        if (version.effective_from > asOf) continue;
        if (
          !current ||
          version.effective_from > current.effective_from ||
          (version.effective_from === current.effective_from && version.version > current.version)
        ) {
          current = version;
        }
      }
    }
    return current;
  }

  addBackgroundRight({ right_id, owner_party, kind, title, notes = "" }) {
    if (!right_id || !owner_party || !kind || !title) {
      throw new DomainError("MISSING_FIELD", "背景权利需要 right_id、owner_party、kind、title");
    }
    if (this.backgroundRights.has(right_id)) throw new DomainError("DUPLICATE_ID", `背景权利已存在：${right_id}`);
    if (!this.parties.has(owner_party)) throw new DomainError("UNKNOWN_PARTY", `未登记的参与主体：${owner_party}`);
    const right = { right_id, owner_party, kind, title, notes };
    this.backgroundRights.set(right_id, right);
    return right;
  }

  registerMaterial({ material_id, owner_party, kind, stage, license = {}, derived_from = [], embodies = [], registered_at }) {
    if (!material_id || !owner_party) throw new DomainError("MISSING_FIELD", "材料需要 material_id 与 owner_party");
    if (this.getItem(material_id)) throw new DomainError("DUPLICATE_ID", `条目已存在：${material_id}`);
    if (!this.parties.has(owner_party)) throw new DomainError("UNKNOWN_PARTY", `未登记的参与主体：${owner_party}`);
    for (const upstream of derived_from) {
      if (!this.getItem(upstream)) throw new DomainError("UNKNOWN_ITEM", `上游条目不存在：${upstream}`);
    }
    for (const rightId of embodies) {
      if (!this.backgroundRights.has(rightId)) throw new DomainError("UNKNOWN_RIGHT", `背景权利不存在：${rightId}`);
    }
    const material = {
      material_id,
      owner_party,
      kind: kind ?? "material",
      stage: stage ?? null,
      license,
      derived_from,
      embodies,
      revoked_at: null,
      registered_at: registered_at ?? this.timestamp(),
    };
    this.materials.set(material_id, material);
    return material;
  }

  // 许可撤回只阻止撤回时点之后的新使用，不抹去此前合法完成的交付与实验。
  revokeMaterial(materialId, { actor, at, reason = "" } = {}) {
    const material = this.materials.get(materialId);
    if (!material) throw new DomainError("UNKNOWN_ITEM", `未找到材料：${materialId}`);
    if (material.revoked_at) throw new DomainError("ALREADY_REVOKED", `许可已撤回过：${materialId}`);
    material.revoked_at = at ?? this.timestamp();
    this.log({ kind: "license-revoked", actor, item_id: materialId, note: reason, at: material.revoked_at });
    return material;
  }

  registerResult({ result_id, stage, inputs = [], license = null, contributors = [], created_at }) {
    if (!result_id) throw new DomainError("MISSING_FIELD", "成果需要 result_id");
    if (this.getItem(result_id)) throw new DomainError("DUPLICATE_ID", `条目已存在：${result_id}`);
    for (const input of inputs) {
      if (!this.getItem(input)) throw new DomainError("UNKNOWN_ITEM", `成果输入不存在：${input}`);
    }
    const result = {
      result_id,
      stage: stage ?? null,
      inputs,
      license,
      contributors: [...new Set(contributors)],
      claims: [],
      dispute: null,
      contributions: [],
      created_at: created_at ?? this.timestamp(),
    };
    this.results.set(result_id, result);
    // 登记时固化继承快照，便于随时解释“继承了哪些上游限制”。
    const effective = computeEffective(this, result_id);
    result.inherited_snapshot = effective
      ? { effective: serializeRestrictionSets(effective.final), inherited: inheritedLayers(effective.layers) }
      : null;
    return result;
  }

  addClaim(resultId, { party, share_percent, actor, at } = {}) {
    const result = this.results.get(resultId);
    if (!result) throw new DomainError("UNKNOWN_ITEM", `未找到成果：${resultId}`);
    if (!this.parties.has(party)) throw new DomainError("UNKNOWN_PARTY", `未登记的参与主体：${party}`);
    const claim = { party, share_percent, actor, at: at ?? this.timestamp() };
    result.claims.push(claim);
    this.log({ kind: "ownership-claim", actor, item_id: resultId, note: `${party} 主张归属 ${share_percent}%`, at: claim.at });
    // 各方最新主张合计超过 100% 即视为未达成一致，成果进入争议状态。
    const latestByParty = new Map();
    for (const item of result.claims) latestByParty.set(item.party, item.share_percent);
    const total = [...latestByParty.values()].reduce((sum, value) => sum + value, 0);
    if (latestByParty.size > 1 && total > 100 && (!result.dispute || result.dispute.resolved_at)) {
      result.dispute = {
        opened_at: claim.at,
        reason: `多方归属主张合计 ${total}%，未达成一致`,
        resolved_at: null,
        resolution: null,
      };
      this.log({ kind: "dispute-opened", actor, item_id: resultId, note: result.dispute.reason, at: claim.at });
    }
    return claim;
  }

  openDispute(resultId, { actor, reason, at } = {}) {
    const result = this.results.get(resultId);
    if (!result) throw new DomainError("UNKNOWN_ITEM", `未找到成果：${resultId}`);
    if (result.dispute && !result.dispute.resolved_at) {
      throw new DomainError("DISPUTE_OPEN", `成果 ${resultId} 已存在未决争议`);
    }
    result.dispute = { opened_at: at ?? this.timestamp(), reason, resolved_at: null, resolution: null };
    this.log({ kind: "dispute-opened", actor, item_id: resultId, note: reason, at: result.dispute.opened_at });
    return result.dispute;
  }

  resolveDispute(resultId, { actor, resolution, at } = {}) {
    const result = this.results.get(resultId);
    if (!result) throw new DomainError("UNKNOWN_ITEM", `未找到成果：${resultId}`);
    if (!result.dispute || result.dispute.resolved_at) {
      throw new DomainError("NO_OPEN_DISPUTE", `成果 ${resultId} 没有未决争议`);
    }
    result.dispute.resolved_at = at ?? this.timestamp();
    result.dispute.resolution = resolution;
    this.log({ kind: "dispute-resolved", actor, item_id: resultId, note: resolution, at: result.dispute.resolved_at });
    return result.dispute;
  }

  recordContribution({ contribution_id, party, result_id, experiment, inputs = [], actor, at } = {}) {
    if (!contribution_id || !party || !result_id || !experiment || !actor) {
      throw new DomainError("MISSING_FIELD", "实验贡献需要 contribution_id、party、result_id、experiment、actor");
    }
    if (this.contributions.has(contribution_id)) {
      throw new DomainError("DUPLICATE_ID", `实验贡献已存在：${contribution_id}`);
    }
    const result = this.results.get(result_id);
    if (!result) throw new DomainError("UNKNOWN_ITEM", `未找到成果：${result_id}`);
    if (!this.parties.has(party)) throw new DomainError("UNKNOWN_PARTY", `未登记的参与主体：${party}`);
    for (const input of inputs) {
      if (!this.getItem(input)) throw new DomainError("UNKNOWN_ITEM", `贡献输入不存在：${input}`);
    }
    const contribution = { contribution_id, party, result_id, experiment, inputs, actor, at: at ?? this.timestamp() };
    this.contributions.set(contribution_id, contribution);
    result.contributions.push(contribution_id);
    if (!result.contributors.includes(party)) result.contributors.push(party);
    this.log({ kind: "contribution-registered", actor, item_id: result_id, note: `${party}：${experiment}`, at: contribution.at });
    return contribution;
  }

  addException({ item_id, receiver, purpose, actor, justification, expires_at = null, at } = {}) {
    if (!item_id || !receiver || !purpose || !actor || !justification) {
      throw new DomainError("MISSING_FIELD", "人工例外需要 item_id、receiver、purpose、actor、justification");
    }
    if (!this.getItem(item_id)) throw new DomainError("UNKNOWN_ITEM", `未找到条目：${item_id}`);
    const exception = {
      exception_id: this.nextId("exc"),
      item_id,
      receiver,
      purpose,
      actor,
      justification,
      created_at: at ?? this.timestamp(),
      expires_at,
      revoked_at: null,
    };
    this.exceptions.set(exception.exception_id, exception);
    this.log({
      kind: "manual-exception",
      actor,
      item_id,
      receiver,
      purpose,
      note: justification,
      at: exception.created_at,
    });
    return exception;
  }

  revokeException(exceptionId, { actor, at } = {}) {
    const exception = this.exceptions.get(exceptionId);
    if (!exception) throw new DomainError("UNKNOWN_ITEM", `未找到人工例外：${exceptionId}`);
    if (exception.revoked_at) throw new DomainError("ALREADY_REVOKED", `人工例外已撤销：${exceptionId}`);
    exception.revoked_at = at ?? this.timestamp();
    this.log({ kind: "exception-revoked", actor, item_id: exception.item_id, note: `撤销例外 ${exceptionId}`, at: exception.revoked_at });
    return exception;
  }

  findActiveException({ item_id, receiver, purpose, as_of }) {
    for (const exception of this.exceptions.values()) {
      if (exception.item_id !== item_id || exception.receiver !== receiver || exception.purpose !== purpose) continue;
      if (exception.revoked_at && exception.revoked_at <= as_of) continue;
      if (exception.created_at > as_of) continue;
      if (exception.expires_at && exception.expires_at <= as_of) continue;
      return exception;
    }
    return null;
  }

  // 合法持有：在 as_of 之前获得过放行的交付。撤回不影响已完成的持有事实。
  hasValidHolding(party, itemId, asOf) {
    return this.deliveries.some(
      (delivery) => delivery.receiver === party && delivery.item_id === itemId && delivery.at <= asOf,
    );
  }

  recordDelivery(request, decision) {
    const at = request.at ?? this.timestamp();
    let delivery = null;
    if (decision.decision === "allow") {
      delivery = {
        delivery_id: this.nextId("del"),
        item_id: request.item_id,
        sender: request.sender,
        receiver: request.receiver,
        purpose: request.purpose,
        stage: decision.stage,
        market: decision.market,
        at,
        basis: decision.basis,
        via_exception: decision.via_exception,
      };
      this.deliveries.push(delivery);
    }
    this.log({
      kind: decision.decision === "allow" ? "delivery-allowed" : "delivery-denied",
      actor: request.actor,
      item_id: request.item_id,
      receiver: request.receiver,
      purpose: request.purpose,
      decision: decision.decision,
      reasons: decision.reasons.map((reason) => reason.code),
      basis: decision.basis,
      via_exception: decision.via_exception,
      delivery_id: delivery?.delivery_id ?? null,
      at,
    });
    return delivery;
  }

  // 统一条目视图：材料与成果共享同一标识空间。
  getItem(id) {
    const material = this.materials.get(id);
    if (material) {
      return {
        id,
        type: "material",
        owner_party: material.owner_party,
        stage: material.stage,
        license: material.license ?? null,
        derived_from: material.derived_from ?? [],
        inputs: [],
        revoked_at: material.revoked_at,
        dispute: null,
        contributors: [material.owner_party],
      };
    }
    const result = this.results.get(id);
    if (result) {
      return {
        id,
        type: "result",
        owner_party: null,
        stage: result.stage,
        license: result.license ?? null,
        derived_from: [],
        inputs: result.inputs ?? [],
        revoked_at: null,
        dispute: result.dispute,
        contributors: result.contributors ?? [],
      };
    }
    return null;
  }

  queryAudit({ item_id, kind, actor } = {}) {
    return this.audit.filter(
      (entry) =>
        (!item_id || entry.item_id === item_id) &&
        (!kind || entry.kind === kind) &&
        (!actor || entry.actor === actor),
    );
  }
}
