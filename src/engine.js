export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_COMMERCIAL_PURPOSES = ["mass-production", "market-sale", "commercialization"];

export function createStore() {
  return {
    parties: new Map(),
    agreements: [],
    backgroundRights: new Map(),
    materials: new Map(),
    contributions: new Map(),
    achievements: new Map(),
    deliveries: [],
    audit: [],
    counters: { delivery: 0, audit: 0 },
  };
}

const nowIso = (now) => now ?? new Date().toISOString();

function nextId(store, kind) {
  store.counters[kind] += 1;
  return `${kind}-${String(store.counters[kind]).padStart(4, "0")}`;
}

function appendAudit(store, entry) {
  const record = { audit_id: nextId(store, "audit"), related: [], ...entry };
  store.audit.push(record);
  return record;
}

function requireFields(body, fields) {
  for (const field of fields) {
    const value = body?.[field];
    if (value === undefined || value === null || value === "") {
      throw new DomainError(400, "missing-field", `缺少必填字段：${field}`);
    }
  }
}

function requireParty(store, partyId) {
  const party = store.parties.get(partyId);
  if (!party) throw new DomainError(404, "party-not-found", `参与主体未登记：${partyId}`);
  return party;
}

function requireMaterial(store, materialId) {
  const material = store.materials.get(materialId);
  if (!material) throw new DomainError(404, "material-not-found", `研发材料未登记：${materialId}`);
  return material;
}

function requireAchievement(store, achievementId) {
  const achievement = store.achievements.get(achievementId);
  if (!achievement) throw new DomainError(404, "achievement-not-found", `阶段成果未登记：${achievementId}`);
  return achievement;
}

const intersectAll = (lists) => {
  if (lists.length === 0) return [];
  return lists.slice(1).reduce((acc, list) => acc.filter((x) => list.includes(x)), [...lists[0]]);
};

const unique = (list) => [...new Set(list)];

// ---------- 参与主体 ----------

export function registerParty(store, body) {
  requireFields(body, ["party_id", "name"]);
  if (store.parties.has(body.party_id)) {
    throw new DomainError(409, "party-exists", `参与主体已存在：${body.party_id}`);
  }
  const party = {
    party_id: body.party_id,
    name: body.name,
    roles: Array.isArray(body.roles) ? [...body.roles] : [],
    registered_at: nowIso(body.now),
  };
  store.parties.set(party.party_id, party);
  return party;
}

// ---------- 协议文本版本 ----------

export function registerAgreement(store, body) {
  requireFields(body, ["agreement_id", "version", "effective_from"]);
  if (store.agreements.some((a) => a.agreement_id === body.agreement_id)) {
    throw new DomainError(409, "agreement-exists", `协议文本已存在：${body.agreement_id}`);
  }
  if (Number.isNaN(Date.parse(body.effective_from))) {
    throw new DomainError(400, "bad-effective-from", `协议生效时间无效：${body.effective_from}`);
  }
  const clauses = body.clauses ?? {};
  const agreement = {
    agreement_id: body.agreement_id,
    version: body.version,
    effective_from: body.effective_from,
    supersedes: body.supersedes ?? null,
    clauses: {
      allowed_purposes_by_stage: clauses.allowed_purposes_by_stage ?? {},
      commercial_purposes: Array.isArray(clauses.commercial_purposes)
        ? [...clauses.commercial_purposes]
        : [...DEFAULT_COMMERCIAL_PURPOSES],
      notes: clauses.notes ?? "",
    },
  };
  store.agreements.push(agreement);
  store.agreements.sort((a, b) => Date.parse(a.effective_from) - Date.parse(b.effective_from));
  return agreement;
}

export function currentAgreement(store, now) {
  const at = Date.parse(nowIso(now));
  let current = null;
  for (const agreement of store.agreements) {
    if (Date.parse(agreement.effective_from) <= at) current = agreement;
    else break;
  }
  return current;
}

// ---------- 背景权利（专利 / 商业秘密） ----------

const RIGHT_KINDS = ["patent", "trade_secret"];

export function registerBackgroundRight(store, body) {
  requireFields(body, ["right_id", "owner_party", "kind", "title"]);
  if (!RIGHT_KINDS.includes(body.kind)) {
    throw new DomainError(400, "bad-kind", `背景权利类型须为：${RIGHT_KINDS.join(" / ")}`);
  }
  requireParty(store, body.owner_party);
  if (store.backgroundRights.has(body.right_id)) {
    throw new DomainError(409, "right-exists", `背景权利已存在：${body.right_id}`);
  }
  const right = {
    right_id: body.right_id,
    owner_party: body.owner_party,
    kind: body.kind,
    title: body.title,
    summary: body.summary ?? "",
    registered_at: nowIso(body.now),
  };
  store.backgroundRights.set(right.right_id, right);
  return right;
}

// ---------- 研发材料（样品 / 代码 / 算法 / 测试数据） ----------

export function registerMaterial(store, body) {
  requireFields(body, ["material_id", "owner_party", "kind", "project_stage", "license"]);
  requireParty(store, body.owner_party);
  if (store.materials.has(body.material_id)) {
    throw new DomainError(409, "material-exists", `研发材料已登记：${body.material_id}`);
  }
  const license = body.license;
  if (typeof license !== "object" || license === null || Array.isArray(license)) {
    throw new DomainError(400, "bad-license", "许可条款须为对象");
  }
  if (!Array.isArray(license.allowed_purposes) || license.allowed_purposes.length === 0) {
    throw new DomainError(400, "bad-license", "许可须列明至少一项允许用途（allowed_purposes）");
  }
  if (!Array.isArray(license.allowed_receivers) || license.allowed_receivers.length === 0) {
    throw new DomainError(400, "bad-license", "许可须列明至少一个允许接收方（allowed_receivers）");
  }
  for (const receiver of license.allowed_receivers) {
    requireParty(store, receiver);
  }
  const backgroundRightIds = body.background_right_ids ?? [];
  for (const rightId of backgroundRightIds) {
    if (!store.backgroundRights.has(rightId)) {
      throw new DomainError(404, "right-not-found", `背景权利未登记：${rightId}`);
    }
  }
  const material = {
    material_id: body.material_id,
    owner_party: body.owner_party,
    kind: body.kind,
    title: body.title ?? "",
    project_stage: body.project_stage,
    license: {
      allowed_purposes: [...license.allowed_purposes],
      allowed_receivers: [...license.allowed_receivers],
      allowed_stages:
        Array.isArray(license.allowed_stages) && license.allowed_stages.length > 0
          ? [...license.allowed_stages]
          : [body.project_stage],
      onward_distribution: license.onward_distribution === true,
      commercial_use: license.commercial_use === true,
    },
    background_right_ids: [...backgroundRightIds],
    withdrawal: null,
    registered_at: nowIso(body.now),
  };
  store.materials.set(material.material_id, material);
  return material;
}

// ---------- 使用评估（可解释结论） ----------

function hasUnresolvedMultiPartyClaims(achievement) {
  if (achievement.ownership_status === "agreed") return false;
  const claimants = new Set(achievement.ownership_claims.map((claim) => claim.party));
  return claimants.size > 1 || achievement.objections.some((objection) => objection.open);
}

export function evaluateUse(store, input) {
  requireFields(input, ["subject_id", "receiver", "purpose"]);
  const now = nowIso(input.now);
  const checks = [];
  const check = (rule, ok, detail) => {
    checks.push({ rule, result: ok ? "pass" : "fail", detail });
    return ok;
  };

  const agreement = currentAgreement(store, now);
  check(
    "agreement-in-effect",
    Boolean(agreement),
    agreement
      ? `当前有效协议为 ${agreement.agreement_id}（版本 ${agreement.version}，${agreement.effective_from} 起生效）`
      : "当前没有生效的协议文本，任何使用都不能放行",
  );

  const material = store.materials.get(input.subject_id);
  const achievement = material ? null : store.achievements.get(input.subject_id);
  const subject = material ?? achievement ?? null;
  const subjectKind = material ? "material" : achievement ? "achievement" : null;
  check(
    "subject-registered",
    Boolean(subject),
    subject ? `对象已登记：${input.subject_id}` : `对象未登记：${input.subject_id}`,
  );

  const receiverKnown = store.parties.has(input.receiver);
  check(
    "receiver-registered",
    receiverKnown,
    receiverKnown ? `接收方为已登记主体：${input.receiver}` : `接收方未登记：${input.receiver}`,
  );

  let effective = null;
  let stage = input.stage ?? null;
  let inherited = [];
  let background = [];

  if (material) {
    effective = material.license;
    stage = stage ?? material.project_stage;
    check(
      "license-active",
      !material.withdrawal,
      material.withdrawal
        ? `许可已于 ${material.withdrawal.withdrawn_at} 被 ${material.withdrawal.withdrawn_by} 撤回，新的使用被阻止；此前合法完成的使用及其依据保持有效`
        : "许可有效，未被撤回",
    );
    background = material.background_right_ids
      .map((rightId) => store.backgroundRights.get(rightId))
      .filter(Boolean)
      .map((right) => ({
        right_id: right.right_id,
        kind: right.kind,
        owner_party: right.owner_party,
        title: right.title,
      }));
  }

  if (achievement) {
    effective = achievement.effective_license;
    stage = stage ?? achievement.stage;
    inherited = achievement.inherited_restrictions;
    const withdrawnInputs = achievement.input_material_ids.filter((id) => store.materials.get(id)?.withdrawal);
    check(
      "upstream-license-active",
      withdrawnInputs.length === 0,
      withdrawnInputs.length === 0
        ? "全部上游许可仍然有效"
        : `上游许可已撤回：${withdrawnInputs.join("、")}，衍生成果的新使用被阻止；此前合法完成的实验及依据保持有效`,
    );
    const disputed = achievement.ownership_status === "disputed";
    const unsettled = hasUnresolvedMultiPartyClaims(achievement);
    check(
      "ownership-clear",
      !disputed && !unsettled,
      disputed
        ? "成果归属存在争议，相关内容不得抢先发布或交付"
        : unsettled
          ? "多方对成果归属尚未达成一致，相关内容不得抢先发布或交付"
          : "成果归属无争议障碍",
    );
  }

  if (effective) {
    check(
      "purpose-licensed",
      effective.allowed_purposes.includes(input.purpose),
      effective.allowed_purposes.includes(input.purpose)
        ? `用途 ${input.purpose} 在许可允许范围（${effective.allowed_purposes.join("、")}）`
        : `用途 ${input.purpose} 不在许可允许范围（${effective.allowed_purposes.join("、")}）`,
    );
    check(
      "receiver-licensed",
      effective.allowed_receivers.includes(input.receiver),
      effective.allowed_receivers.includes(input.receiver)
        ? `接收方 ${input.receiver} 在许可允许范围`
        : `接收方 ${input.receiver} 不在许可允许范围（${effective.allowed_receivers.join("、")}）`,
    );
    check(
      "stage-licensed",
      effective.allowed_stages.includes(stage),
      effective.allowed_stages.includes(stage)
        ? `项目阶段 ${stage} 与许可一致`
        : `项目阶段 ${stage} 超出许可范围（${effective.allowed_stages.join("、")}）`,
    );
    if (agreement) {
      const caps = agreement.clauses.allowed_purposes_by_stage?.[stage];
      check(
        "purpose-within-agreement-stage",
        !caps || caps.includes(input.purpose),
        !caps
          ? `协议未对阶段 ${stage} 设额外用途限制`
          : caps.includes(input.purpose)
            ? `协议 ${agreement.version} 允许阶段 ${stage} 的用途 ${input.purpose}`
            : `协议 ${agreement.version} 对阶段 ${stage} 仅允许用途：${caps.join("、")}`,
      );
    }
    const commercialPurposes = agreement?.clauses.commercial_purposes ?? DEFAULT_COMMERCIAL_PURPOSES;
    if (commercialPurposes.includes(input.purpose)) {
      check(
        "commercial-authorized",
        effective.commercial_use === true,
        effective.commercial_use
          ? "许可明确允许商业使用"
          : `用途 ${input.purpose} 属商业使用，许可未明确授权`,
      );
    }
    const holders = material ? [material.owner_party] : achievement.holder_parties;
    const sender = input.sender_party ?? holders[0];
    if (sender && !holders.includes(sender)) {
      check(
        "redistribution-authorized",
        effective.onward_distribution === true,
        effective.onward_distribution
          ? "原许可明确允许接收方再次分发"
          : `发送方 ${sender} 并非权利所属方，原许可未允许再次分发，接收者不能绕过原许可转交他人`,
      );
    }
  }

  const failed = checks.filter((entry) => entry.result === "fail");
  const decision = failed.length === 0 ? "allow" : "deny";
  const summary =
    decision === "allow"
      ? `放行：${input.receiver} 以用途 ${input.purpose} 使用 ${input.subject_id}，符合许可条件与协议版本 ${agreement?.version ?? "（无）"}`
      : `拒绝：${failed.map((entry) => entry.detail).join("；")}`;

  return {
    subject_id: input.subject_id,
    subject_kind: subjectKind,
    receiver: input.receiver,
    purpose: input.purpose,
    stage,
    sender_party: input.sender_party ?? null,
    decision,
    checks,
    summary,
    agreement_id: agreement?.agreement_id ?? null,
    agreement_version: agreement?.version ?? null,
    inherited_restrictions: inherited,
    background_rights: background,
    evaluated_at: now,
  };
}

// ---------- 材料交付（放行 / 拒绝 / 人工例外都留痕） ----------

export function recordDelivery(store, body) {
  requireFields(body, ["subject_id", "from_party", "to_party", "purpose", "actor"]);
  if (body.override !== undefined) {
    requireFields(body.override, ["approved_by", "reason"]);
  }
  const now = nowIso(body.now);
  const evaluation = evaluateUse(store, {
    subject_id: body.subject_id,
    receiver: body.to_party,
    purpose: body.purpose,
    stage: body.stage,
    sender_party: body.from_party,
    now,
  });

  let decision;
  if (evaluation.decision === "allow") decision = "released";
  else if (body.override) decision = "exception";
  else decision = "denied";

  const record = {
    delivery_id: nextId(store, "delivery"),
    subject_id: body.subject_id,
    from_party: body.from_party,
    to_party: body.to_party,
    purpose: body.purpose,
    stage: evaluation.stage,
    decision,
    agreement_version: evaluation.agreement_version,
    explanation: evaluation.summary,
    checks: evaluation.checks,
    actor: body.actor,
    override:
      decision === "exception"
        ? {
            approved_by: body.override.approved_by,
            reason: body.override.reason,
            note: "人工例外：自动评估拒绝后由责任人放行，责任由审批人承担",
          }
        : null,
    recorded_at: now,
  };
  store.deliveries.push(record);

  const action = decision === "released" ? "release" : decision === "exception" ? "exception" : "denial";
  appendAudit(store, {
    at: now,
    action,
    actor: decision === "exception" ? body.override.approved_by : body.actor,
    subject_id: body.subject_id,
    delivery_id: record.delivery_id,
    detail:
      decision === "released"
        ? `放行 ${body.subject_id} → ${body.to_party}（${body.purpose}），依据协议版本 ${evaluation.agreement_version}`
        : decision === "exception"
          ? `人工例外放行 ${body.subject_id} → ${body.to_party}（${body.purpose}），审批人 ${body.override.approved_by}：${body.override.reason}`
          : `拒绝 ${body.subject_id} → ${body.to_party}（${body.purpose}）：${evaluation.summary}`,
  });
  return { record, evaluation };
}

export function listDeliveries(store, filters = {}) {
  return store.deliveries.filter(
    (delivery) =>
      (!filters.subject_id || delivery.subject_id === filters.subject_id) &&
      (!filters.decision || delivery.decision === filters.decision) &&
      (!filters.to_party || delivery.to_party === filters.to_party),
  );
}

// ---------- 许可撤回：阻断新使用，保留既得合法使用 ----------

export function withdrawLicense(store, materialId, body) {
  requireFields(body, ["actor"]);
  const material = requireMaterial(store, materialId);
  if (material.withdrawal) {
    throw new DomainError(409, "already-withdrawn", `材料 ${materialId} 的许可此前已撤回`);
  }
  const now = nowIso(body.now);
  material.withdrawal = {
    withdrawn_at: now,
    withdrawn_by: body.actor,
    reason: body.reason ?? "",
  };
  const preserved = store.deliveries.filter(
    (delivery) =>
      delivery.subject_id === materialId &&
      (delivery.decision === "released" || delivery.decision === "exception"),
  );
  appendAudit(store, {
    at: now,
    action: "withdrawal",
    actor: body.actor,
    subject_id: materialId,
    detail: `撤回 ${materialId} 的许可（${body.reason ?? "未说明原因"}）；此前 ${preserved.length} 次合法交付及其实验依据保持有效`,
  });
  return {
    material_id: materialId,
    withdrawal: material.withdrawal,
    preserved_legal_deliveries: preserved.map((delivery) => delivery.delivery_id),
    note: "撤回仅阻止新的使用；此前合法完成的交付、实验及其依据保持有效",
  };
}

// ---------- 实验贡献：登记时核验合法取得依据 ----------

export function recordContribution(store, body) {
  requireFields(body, ["contribution_id", "party", "experiment", "input_material_ids"]);
  if (store.contributions.has(body.contribution_id)) {
    throw new DomainError(409, "contribution-exists", `实验贡献已登记：${body.contribution_id}`);
  }
  requireParty(store, body.party);
  if (!Array.isArray(body.input_material_ids) || body.input_material_ids.length === 0) {
    throw new DomainError(400, "bad-inputs", "实验贡献须引用至少一项输入材料（input_material_ids）");
  }
  const now = nowIso(body.now);
  const legalBasis = [];
  for (const materialId of body.input_material_ids) {
    const material = requireMaterial(store, materialId);
    if (material.owner_party === body.party) {
      legalBasis.push({ material_id: materialId, basis: "自有背景材料", delivery_id: null, agreement_version: null });
      continue;
    }
    const delivery = [...store.deliveries].reverse().find(
      (entry) =>
        entry.subject_id === materialId &&
        entry.to_party === body.party &&
        (entry.decision === "released" || entry.decision === "exception") &&
        Date.parse(entry.recorded_at) <= Date.parse(now),
    );
    if (!delivery) {
      throw new DomainError(
        409,
        "no-legal-basis",
        `${body.party} 未合法取得 ${materialId}，不能登记以其为输入的实验贡献`,
      );
    }
    legalBasis.push({
      material_id: materialId,
      basis: "合法交付",
      delivery_id: delivery.delivery_id,
      agreement_version: delivery.agreement_version,
    });
  }
  const contribution = {
    contribution_id: body.contribution_id,
    party: body.party,
    experiment: body.experiment,
    input_material_ids: [...body.input_material_ids],
    legal_basis: legalBasis,
    output_summary: body.output_summary ?? "",
    recorded_by: body.actor ?? body.party,
    recorded_at: now,
  };
  store.contributions.set(contribution.contribution_id, contribution);
  appendAudit(store, {
    at: now,
    action: "contribution",
    actor: contribution.recorded_by,
    subject_id: contribution.contribution_id,
    related: [...body.input_material_ids],
    detail: `登记实验贡献 ${contribution.contribution_id}（${body.party}），输入 ${body.input_material_ids.join("、")}，合法依据已核验`,
  });
  return contribution;
}

// ---------- 阶段成果：继承上游限制 ----------

function describeInheritedRestriction(material) {
  const license = material.license;
  return {
    material_id: material.material_id,
    owner_party: material.owner_party,
    allowed_purposes: [...license.allowed_purposes],
    allowed_receivers: [...license.allowed_receivers],
    commercial_use: license.commercial_use,
    onward_distribution: license.onward_distribution,
    withdrawn: Boolean(material.withdrawal),
    note:
      `继承自 ${material.material_id}（${material.owner_party}）：允许用途 ${license.allowed_purposes.join("、")}；` +
      `允许接收方 ${license.allowed_receivers.join("、")}；` +
      `${license.commercial_use ? "允许商业使用" : "禁止商业使用"}；` +
      `${license.onward_distribution ? "允许再分发" : "禁止再分发"}` +
      `${material.withdrawal ? "；许可已撤回（新使用被阻止）" : ""}`,
  };
}

export function createAchievement(store, body) {
  requireFields(body, ["achievement_id", "name", "stage", "input_material_ids", "created_by"]);
  if (store.achievements.has(body.achievement_id)) {
    throw new DomainError(409, "achievement-exists", `阶段成果已登记：${body.achievement_id}`);
  }
  requireParty(store, body.created_by);
  if (!Array.isArray(body.input_material_ids) || body.input_material_ids.length === 0) {
    throw new DomainError(400, "bad-inputs", "阶段成果须引用至少一项输入材料（input_material_ids）");
  }
  const inputs = body.input_material_ids.map((materialId) => requireMaterial(store, materialId));
  const contributionIds = body.contribution_ids ?? [];
  const contributions = contributionIds.map((contributionId) => {
    const contribution = store.contributions.get(contributionId);
    if (!contribution) {
      throw new DomainError(404, "contribution-not-found", `实验贡献未登记：${contributionId}`);
    }
    return contribution;
  });
  const now = nowIso(body.now);

  const inheritedRestrictions = inputs.map(describeInheritedRestriction);
  const effectiveLicense = {
    allowed_purposes: intersectAll(inputs.map((material) => material.license.allowed_purposes)),
    allowed_receivers: intersectAll(inputs.map((material) => material.license.allowed_receivers)),
    allowed_stages: [body.stage],
    onward_distribution: inputs.every((material) => material.license.onward_distribution),
    commercial_use: inputs.every((material) => material.license.commercial_use),
  };

  const legalBasis = [];
  const seenBasis = new Set();
  for (const contribution of contributions) {
    for (const basis of contribution.legal_basis) {
      const key = `${basis.material_id}|${basis.delivery_id ?? "own"}`;
      if (!seenBasis.has(key)) {
        seenBasis.add(key);
        legalBasis.push({ ...basis, contribution_id: contribution.contribution_id });
      }
    }
  }

  const achievement = {
    achievement_id: body.achievement_id,
    name: body.name,
    stage: body.stage,
    input_material_ids: [...body.input_material_ids],
    contribution_ids: [...contributionIds],
    intended_markets: Array.isArray(body.intended_markets) ? [...body.intended_markets] : [],
    created_by: body.created_by,
    holder_parties: unique([body.created_by, ...contributions.map((contribution) => contribution.party)]),
    inherited_restrictions: inheritedRestrictions,
    effective_license: effectiveLicense,
    legal_basis: legalBasis,
    ownership_status: "unclaimed",
    ownership_claims: [],
    objections: [],
    resolution: null,
    publications: [],
    created_at: now,
  };
  store.achievements.set(achievement.achievement_id, achievement);
  appendAudit(store, {
    at: now,
    action: "achievement",
    actor: body.created_by,
    subject_id: achievement.achievement_id,
    related: [...body.input_material_ids, ...contributionIds],
    detail: `登记阶段成果 ${achievement.achievement_id}，继承 ${inputs.length} 项上游材料的限制`,
  });
  return achievement;
}

export function achievementLineage(store, achievementId) {
  const achievement = requireAchievement(store, achievementId);
  const inputs = achievement.input_material_ids.map((materialId) => {
    const material = store.materials.get(materialId);
    return {
      material_id: materialId,
      owner_party: material.owner_party,
      project_stage: material.project_stage,
      withdrawn: Boolean(material.withdrawal),
    };
  });
  const effective = achievement.effective_license;
  const explanation =
    `成果 ${achievementId} 由 ${inputs.length} 项输入衍生，继承各上游许可的交集——` +
    `允许用途：${effective.allowed_purposes.join("、") || "（空交集，无共同允许用途）"}；` +
    `允许接收方：${effective.allowed_receivers.join("、") || "（空交集，无共同允许接收方）"}；` +
    `商业使用${effective.commercial_use ? "允许" : "禁止"}；再分发${effective.onward_distribution ? "允许" : "禁止"}`;
  return {
    achievement_id: achievementId,
    inputs,
    inherited_restrictions: achievement.inherited_restrictions,
    effective_license: effective,
    legal_basis: achievement.legal_basis,
    ownership_status: achievement.ownership_status,
    intended_markets: achievement.intended_markets,
    explanation,
  };
}

// ---------- 成果归属：主张、异议、争议、解决 ----------

export function claimOwnership(store, achievementId, body) {
  requireFields(body, ["party", "share_percent", "actor"]);
  const achievement = requireAchievement(store, achievementId);
  requireParty(store, body.party);
  const share = Number(body.share_percent);
  if (!Number.isFinite(share) || share < 0 || share > 100) {
    throw new DomainError(400, "bad-share", "归属份额须为 0–100 的数字");
  }
  if (achievement.ownership_status === "agreed") {
    throw new DomainError(409, "ownership-settled", "成果归属已达成一致，新的主张须先通过争议流程重新开启");
  }
  const now = nowIso(body.now);
  achievement.ownership_claims.push({
    party: body.party,
    share_percent: share,
    statement: body.statement ?? "",
    claimed_by: body.actor,
    claimed_at: now,
  });

  const sharesByParty = new Map();
  let selfConflict = false;
  for (const claim of achievement.ownership_claims) {
    if (sharesByParty.has(claim.party) && sharesByParty.get(claim.party) !== claim.share_percent) {
      selfConflict = true;
    }
    sharesByParty.set(claim.party, claim.share_percent);
  }
  const total = [...sharesByParty.values()].reduce((sum, value) => sum + value, 0);
  if (selfConflict || total > 100) {
    achievement.ownership_status = "disputed";
    appendAudit(store, {
      at: now,
      action: "dispute",
      actor: body.actor,
      subject_id: achievementId,
      detail: `归属主张冲突（合计 ${total}%${selfConflict ? "，且存在自相矛盾的主张" : ""}），成果进入争议状态`,
    });
  } else if (achievement.objections.some((objection) => objection.open)) {
    achievement.ownership_status = "disputed";
  } else {
    achievement.ownership_status = "claimed";
  }
  return achievement;
}

export function raiseObjection(store, achievementId, body) {
  requireFields(body, ["party", "reason", "actor"]);
  const achievement = requireAchievement(store, achievementId);
  requireParty(store, body.party);
  if (achievement.ownership_status === "agreed") {
    throw new DomainError(409, "ownership-settled", "成果归属已达成一致，异议须先通过争议流程重新开启");
  }
  const now = nowIso(body.now);
  achievement.objections.push({
    party: body.party,
    reason: body.reason,
    raised_by: body.actor,
    raised_at: now,
    open: true,
  });
  achievement.ownership_status = "disputed";
  appendAudit(store, {
    at: now,
    action: "dispute",
    actor: body.actor,
    subject_id: achievementId,
    detail: `${body.party} 对成果归属提出异议：${body.reason}，成果进入争议状态`,
  });
  return achievement;
}

export function resolveDispute(store, achievementId, body) {
  requireFields(body, ["agreed_shares", "resolved_by"]);
  const achievement = requireAchievement(store, achievementId);
  const shares = body.agreed_shares;
  if (typeof shares !== "object" || shares === null || Array.isArray(shares) || Object.keys(shares).length === 0) {
    throw new DomainError(400, "bad-shares", "agreed_shares 须为「主体 → 份额」的非空对象");
  }
  const parties = Object.keys(shares);
  for (const party of parties) requireParty(store, party);
  const total = parties.reduce((sum, party) => sum + Number(shares[party]), 0);
  if (Math.round(total * 100) !== 10000) {
    throw new DomainError(400, "shares-not-100", `归属份额合计须为 100%，当前为 ${total}%`);
  }
  const involved = unique([
    ...achievement.ownership_claims.map((claim) => claim.party),
    ...achievement.objections.map((objection) => objection.party),
  ]);
  const missing = involved.filter((party) => !(party in shares));
  if (missing.length > 0) {
    throw new DomainError(400, "resolution-incomplete", `解决方案须涵盖全部主张/异议方：${missing.join("、")}`);
  }
  const now = nowIso(body.now);
  achievement.ownership_status = "agreed";
  for (const objection of achievement.objections) objection.open = false;
  achievement.resolution = {
    agreed_shares: { ...shares },
    resolved_by: body.resolved_by,
    reason: body.reason ?? "",
    resolved_at: now,
  };
  appendAudit(store, {
    at: now,
    action: "resolution",
    actor: body.resolved_by,
    subject_id: achievementId,
    detail: `成果归属达成一致：${parties.map((party) => `${party} ${shares[party]}%`).join("，")}`,
  });
  return achievement;
}

// ---------- 发布到拟进入市场 ----------

export function publishAchievement(store, achievementId, body) {
  requireFields(body, ["market", "actor"]);
  const achievement = requireAchievement(store, achievementId);
  const now = nowIso(body.now);
  const failures = [];
  if (achievement.ownership_status === "disputed") {
    failures.push("成果归属存在争议，相关内容不能抢先发布");
  } else if (hasUnresolvedMultiPartyClaims(achievement)) {
    failures.push("多方对成果归属尚未达成一致，相关内容不能抢先发布");
  }
  const withdrawnInputs = achievement.input_material_ids.filter((id) => store.materials.get(id)?.withdrawal);
  if (withdrawnInputs.length > 0) {
    failures.push(`上游许可已撤回（${withdrawnInputs.join("、")}），新的发布被阻止`);
  }
  if (achievement.intended_markets.length > 0 && !achievement.intended_markets.includes(body.market)) {
    failures.push(`市场 ${body.market} 不在拟进入市场清单（${achievement.intended_markets.join("、")}）`);
  }
  if (!achievement.effective_license.commercial_use) {
    failures.push("继承的上游限制禁止商业使用");
  }
  if (failures.length > 0) {
    appendAudit(store, {
      at: now,
      action: "denial",
      actor: body.actor,
      subject_id: achievementId,
      detail: `拒绝发布 ${achievementId} 至市场 ${body.market}：${failures.join("；")}`,
    });
    throw new DomainError(409, "publish-blocked", failures.join("；"));
  }
  const publication = { market: body.market, published_by: body.actor, published_at: now };
  achievement.publications.push(publication);
  appendAudit(store, {
    at: now,
    action: "publish",
    actor: body.actor,
    subject_id: achievementId,
    detail: `成果 ${achievementId} 发布至市场 ${body.market}`,
  });
  return publication;
}

// ---------- 审计查询 ----------

export function listAudit(store, filters = {}) {
  return store.audit.filter(
    (entry) =>
      (!filters.subject_id || entry.subject_id === filters.subject_id) &&
      (!filters.action || entry.action === filters.action),
  );
}
