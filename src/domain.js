// 权利边界领域逻辑：限制求交、上游继承、放行评估。
// 本模块全部为纯函数，时间一律通过 as_of 传入，保证历史评估可重放、可审计。

export const RELEASE_PURPOSES = new Set(["publication", "mass-production", "market-entry"]);
export const MARKET_REQUIRED_PURPOSES = new Set(["mass-production", "market-entry"]);
export const DIMENSIONS = ["purposes", "stages", "receivers", "markets"];

const DIMENSION_LABELS = {
  purposes: "用途",
  stages: "项目阶段",
  receivers: "接收人",
  markets: "拟进入市场",
};

const DIMENSION_CODES = {
  purposes: "PURPOSE_NOT_LICENSED",
  stages: "STAGE_NOT_LICENSED",
  receivers: "RECEIVER_NOT_LICENSED",
  markets: "MARKET_NOT_LICENSED",
};

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function toSet(value) {
  return value === null || value === undefined ? null : new Set(value);
}

function intersect(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return new Set([...a].filter((item) => b.has(item)));
}

function sortedList(set) {
  return set === null ? null : [...set].sort();
}

export function serializeRestrictionSets(final) {
  const out = {};
  for (const dim of DIMENSIONS) out[dim] = sortedList(final[dim]);
  return out;
}

function serializeLayers(layers) {
  const out = {};
  for (const dim of DIMENSIONS) {
    out[dim] = layers[dim].map((layer) => ({
      source: layer.source,
      kind: layer.kind,
      values: sortedList(layer.values),
    }));
  }
  return out;
}

// 从分层限制中提取“上游继承”部分，用于说明结果继承了哪些上游限制。
export function inheritedLayers(layers) {
  const inherited = [];
  for (const dim of DIMENSIONS) {
    for (const layer of layers[dim]) {
      if (layer.kind === "上游继承") {
        inherited.push({ dimension: dim, from: layer.source, values: sortedList(layer.values) });
      }
    }
  }
  return inherited;
}

// 沿衍生链计算某个条目（样品/代码/数据/成果）逐层收窄后的限制。
// 返回每一层的来源（自有许可 / 上游继承）以及逐维交集。
export function computeEffective(store, itemId, seen = new Set()) {
  const node = store.getItem(itemId);
  if (!node || seen.has(itemId)) return null; // 缺失或循环引用：不再额外限制
  seen.add(itemId);

  const layers = { purposes: [], stages: [], receivers: [], markets: [] };
  if (node.license) {
    for (const dim of DIMENSIONS) {
      const values = toSet(node.license[dim]);
      if (values) layers[dim].push({ source: itemId, kind: "自有许可", values });
    }
  }

  const upstreamIds = node.type === "material" ? node.derived_from ?? [] : node.inputs ?? [];
  const chain = [node];
  for (const upstreamId of upstreamIds) {
    const sub = computeEffective(store, upstreamId, seen);
    if (!sub) continue;
    chain.push(...sub.chain);
    for (const dim of DIMENSIONS) {
      if (sub.final[dim]) layers[dim].push({ source: upstreamId, kind: "上游继承", values: sub.final[dim] });
    }
  }

  const final = {};
  for (const dim of DIMENSIONS) {
    let acc = null;
    for (const layer of layers[dim]) acc = intersect(acc, layer.values);
    final[dim] = acc;
  }
  return { layers, final, chain };
}

// 在衍生链之上再叠加“当前有效协议”这一最外层边界：资料许可只能收窄，不能突破协议。
export function computeBoundary(store, itemId, asOf) {
  const agreement = store.currentAgreement(asOf);
  const effective = computeEffective(store, itemId);
  if (!effective) return { agreement, layers: null, final: null, chain: [] };

  const layers = { purposes: [], stages: [], receivers: [], markets: [] };
  if (agreement) {
    const source = `协议 ${agreement.agreement_id}@v${agreement.version}`;
    for (const dim of DIMENSIONS) {
      // 协议的 parties 名单同时充当“接收人”维度的最外层边界；未登记名单则不设限。
      const raw = dim === "receivers"
        ? (agreement.parties?.length ? agreement.parties : null)
        : agreement.envelope?.[dim];
      const values = toSet(raw);
      if (values) layers[dim].push({ source, kind: "当前协议", values });
    }
  }
  for (const dim of DIMENSIONS) layers[dim].push(...effective.layers[dim]);

  const final = {};
  for (const dim of DIMENSIONS) {
    let acc = null;
    for (const layer of layers[dim]) acc = intersect(acc, layer.values);
    final[dim] = acc;
  }

  const chain = [];
  const seenIds = new Set();
  for (const item of effective.chain) {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      chain.push(item);
    }
  }
  return { agreement, layers, final, chain };
}

function formatSet(set) {
  return set === null || set.size === 0 ? "（空）" : [...set].sort().join("、");
}

// 核心评估：给定条目、接收方、用途（可带项目阶段/拟进入市场/交付方），
// 基于评估时点生效的协议得出可解释结论。
export function evaluate(store, request) {
  const asOf = request.as_of ?? new Date().toISOString();
  const node = store.getItem(request.item_id);
  if (!node) {
    return {
      decision: "deny",
      item_id: request.item_id,
      as_of: asOf,
      basis: null,
      effective_restrictions: null,
      inherited: [],
      reasons: [{ code: "ITEM_NOT_FOUND", message: `未找到样品、代码或成果：${request.item_id}` }],
      via_exception: null,
    };
  }

  const { agreement, layers, final, chain } = computeBoundary(store, request.item_id, asOf);
  const reasons = [];

  if (!agreement) {
    reasons.push({ code: "NO_EFFECTIVE_AGREEMENT", message: `评估时点 ${asOf} 没有生效的协议文本` });
  }

  // 许可撤回只阻止新使用；as_of 之前已合法完成的交付与实验不受影响。
  if (node.revoked_at && node.revoked_at <= asOf) {
    reasons.push({ code: "LICENSE_REVOKED", message: `所属方已于 ${node.revoked_at} 撤回许可，撤回后不再放行新使用` });
  }
  for (const ancestor of chain) {
    if (ancestor.id !== node.id && ancestor.revoked_at && ancestor.revoked_at <= asOf) {
      reasons.push({
        code: "UPSTREAM_LICENSE_REVOKED",
        message: `上游 ${ancestor.id} 的许可已于 ${ancestor.revoked_at} 撤回，衍生内容不能绕过原许可`,
      });
    }
  }

  // 多方对成果归属未达成一致时，发布/量产/入市类用途被争议状态阻断。
  if (RELEASE_PURPOSES.has(request.purpose) && agreement?.publication_requires_unanimous !== false) {
    const disputed = chain.filter((item) => item.dispute && !item.dispute.resolved_at);
    if (disputed.length > 0) {
      reasons.push({
        code: "DISPUTE_OPEN",
        message: `成果归属存在未决争议（${disputed.map((item) => item.id).join("、")}），不得抢先发布或投入市场`,
      });
    }
  }

  const checkDimension = (dim, requested) => {
    const allowed = final[dim];
    if (allowed === null || allowed.has(requested)) return;
    const sources = layers[dim].map((layer) => `${layer.source}（${layer.kind}）`).join("；");
    reasons.push({
      code: DIMENSION_CODES[dim],
      message: `${DIMENSION_LABELS[dim]}「${requested}」不在有效许可范围 [${formatSet(allowed)}] 内；限制来源：${sources}`,
    });
  };

  checkDimension("purposes", request.purpose);
  const stage = request.stage ?? node.stage ?? null;
  if (stage) checkDimension("stages", stage);
  const isOwner = node.owner_party === request.receiver || (node.contributors ?? []).includes(request.receiver);
  if (!isOwner) checkDimension("receivers", request.receiver);
  if (MARKET_REQUIRED_PURPOSES.has(request.purpose) && !request.market) {
    reasons.push({ code: "MARKET_REQUIRED", message: `用途「${request.purpose}」必须指明拟进入市场` });
  } else if (request.market) {
    checkDimension("markets", request.market);
  }

  // 再分发：交付方必须是所属方或合法持有人，接收范围仍受原许可约束。
  if (request.sender) {
    const senderIsOwner = node.owner_party === request.sender;
    const senderHolds = store.hasValidHolding(request.sender, request.item_id, asOf);
    if (!senderIsOwner && !senderHolds) {
      reasons.push({
        code: "SENDER_NOT_HOLDER",
        message: `交付方 ${request.sender} 既不是所属方，也没有合法持有记录，不能继续分发`,
      });
    }
  }

  // 人工例外：按（条目 + 接收人 + 用途）精确匹配，例外必须记录责任人与理由。
  let viaException = null;
  if (reasons.length > 0) {
    const exception = store.findActiveException({
      item_id: request.item_id,
      receiver: request.receiver,
      purpose: request.purpose,
      as_of: asOf,
    });
    if (exception) {
      viaException = {
        exception_id: exception.exception_id,
        responsible: exception.actor,
        justification: exception.justification,
      };
    }
  }

  return {
    decision: reasons.length === 0 || viaException ? "allow" : "deny",
    item_id: request.item_id,
    receiver: request.receiver,
    purpose: request.purpose,
    stage,
    market: request.market ?? null,
    as_of: asOf,
    basis: agreement
      ? { agreement_id: agreement.agreement_id, version: agreement.version, effective_from: agreement.effective_from }
      : null,
    effective_restrictions: serializeRestrictionSets(final),
    inherited: inheritedLayers(layers),
    reasons,
    via_exception: viaException,
  };
}

// GET /items/:id/restrictions 的序列化视图：说明条目继承了哪些上游限制。
export function boundaryView(store, itemId, asOf) {
  const { agreement, layers, final, chain } = computeBoundary(store, itemId, asOf);
  return {
    item_id: itemId,
    as_of: asOf,
    basis: agreement
      ? { agreement_id: agreement.agreement_id, version: agreement.version, effective_from: agreement.effective_from }
      : null,
    effective_restrictions: final ? serializeRestrictionSets(final) : null,
    layers: layers ? serializeLayers(layers) : null,
    inherited: layers ? inheritedLayers(layers) : [],
    chain: chain.map((item) => item.id),
  };
}
