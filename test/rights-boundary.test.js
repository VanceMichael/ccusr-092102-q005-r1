import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server.js";
import { Store } from "../src/store.js";

const T0 = "2026-01-01T00:00:00.000Z";

async function startService() {
  const store = new Store();
  const server = createServer(store);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, server, base };
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(base, path) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

function setupParties(store) {
  for (const id of ["p1", "p2", "p3"]) store.addParty({ party_id: id, name: `团队${id}` });
}

function setupAgreement(store, overrides = {}) {
  store.addAgreementVersion({
    agreement_id: "ag",
    version: 1,
    effective_from: T0,
    parties: ["p1", "p2", "p3"],
    envelope: {
      purposes: ["laboratory-validation", "joint-validation", "publication", "mass-production"],
      stages: ["joint-validation", "pilot"],
      markets: ["cn-mainland"],
    },
    publication_requires_unanimous: true,
    ...overrides,
  });
}

function setupMaterial(store, overrides = {}) {
  store.registerMaterial({
    material_id: "m1",
    owner_party: "p1",
    kind: "sample",
    stage: "joint-validation",
    license: {
      purposes: ["laboratory-validation"],
      stages: ["joint-validation"],
      receivers: ["p2"],
      markets: [],
    },
    ...overrides,
  });
}

function reasonCodes(decision) {
  return decision.reasons.map((reason) => reason.code);
}

test("许可范围内的交付被放行并记录责任人", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  setupAgreement(store);
  setupMaterial(store);

  const res = await post(base, "/deliveries", {
    item_id: "m1",
    sender: "p1",
    receiver: "p2",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
    at: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.decision, "allow");
  assert.equal(res.body.basis.agreement_id, "ag");
  assert.equal(res.body.basis.version, 1);
  assert.ok(res.body.delivery_id);

  const audit = await get(base, "/audit?item_id=m1&kind=delivery-allowed");
  assert.equal(audit.body.length, 1);
  assert.equal(audit.body[0].actor, "pm-li");
  assert.equal(audit.body[0].decision, "allow");
});

test("用途或阶段不在许可范围时被拒绝并给出可解释原因", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  setupAgreement(store);
  setupMaterial(store);

  const res = await post(base, "/evaluate", {
    item_id: "m1",
    receiver: "p2",
    purpose: "mass-production",
    stage: "pilot",
    actor: "pm-li",
  });
  assert.equal(res.body.decision, "deny");
  const codes = reasonCodes(res.body);
  assert.ok(codes.includes("PURPOSE_NOT_LICENSED"));
  assert.ok(codes.includes("STAGE_NOT_LICENSED"));
  const purposeReason = res.body.reasons.find((reason) => reason.code === "PURPOSE_NOT_LICENSED");
  assert.match(purposeReason.message, /m1/);
  assert.deepEqual(res.body.effective_restrictions.purposes, ["laboratory-validation"]);
});

test("接收人不在许可范围时被拒绝", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  setupAgreement(store);
  setupMaterial(store);

  const res = await post(base, "/evaluate", {
    item_id: "m1",
    receiver: "p3",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
  });
  assert.equal(res.body.decision, "deny");
  assert.ok(reasonCodes(res.body).includes("RECEIVER_NOT_LICENSED"));
});

test("许可撤回阻止新使用但不抹去此前合法完成的交付与依据", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  setupAgreement(store);
  setupMaterial(store);

  const delivered = await post(base, "/deliveries", {
    item_id: "m1",
    sender: "p1",
    receiver: "p2",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
    at: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(delivered.body.decision, "allow");

  store.registerResult({ result_id: "r1", stage: "joint-validation", inputs: ["m1"], contributors: ["p1", "p2"] });

  const revoke = await post(base, "/materials/m1/revoke", {
    actor: "legal-wang",
    at: "2026-03-01T00:00:00.000Z",
    reason: "合作范围调整",
  });
  assert.equal(revoke.status, 200);

  // 撤回之后的新使用被拒绝
  const after = await post(base, "/evaluate", {
    item_id: "m1",
    receiver: "p2",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
    as_of: "2026-04-01T00:00:00.000Z",
  });
  assert.equal(after.body.decision, "deny");
  assert.ok(reasonCodes(after.body).includes("LICENSE_REVOKED"));

  // 撤回之前的时点重放仍然合法：不溯及既往
  const before = await post(base, "/evaluate", {
    item_id: "m1",
    receiver: "p2",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
    as_of: "2026-02-15T00:00:00.000Z",
  });
  assert.equal(before.body.decision, "allow");

  // 衍生成果的新使用同样被上游撤回阻断
  const derived = await post(base, "/evaluate", {
    item_id: "r1",
    receiver: "p2",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
    as_of: "2026-04-01T00:00:00.000Z",
  });
  assert.equal(derived.body.decision, "deny");
  assert.ok(reasonCodes(derived.body).includes("UPSTREAM_LICENSE_REVOKED"));

  // 审计保留此前合法交付及其协议依据
  const audit = await get(base, "/audit?item_id=m1");
  const kinds = audit.body.map((entry) => entry.kind);
  assert.ok(kinds.includes("delivery-allowed"));
  assert.ok(kinds.includes("license-revoked"));
  const allowedEntry = audit.body.find((entry) => entry.kind === "delivery-allowed");
  assert.equal(allowedEntry.basis.version, 1);
  assert.equal(allowedEntry.actor, "pm-li");
});

test("成果归属未达成一致时进入争议状态并阻断发布，解决后放行", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  setupAgreement(store);
  store.registerMaterial({
    material_id: "m1",
    owner_party: "p1",
    kind: "sample",
    stage: "joint-validation",
    license: { purposes: ["laboratory-validation", "publication"], stages: ["joint-validation"], receivers: ["p1", "p2", "p3"], markets: [] },
  });
  store.registerMaterial({
    material_id: "m2",
    owner_party: "p2",
    kind: "dataset",
    stage: "joint-validation",
    license: { purposes: ["publication"], stages: ["joint-validation"], receivers: ["p1", "p2"], markets: [] },
  });
  store.registerResult({ result_id: "r1", stage: "joint-validation", inputs: ["m1", "m2"], contributors: ["p1", "p2"] });

  await post(base, "/results/r1/claims", { party: "p1", share_percent: 60, actor: "p1-lead" });
  await post(base, "/results/r1/claims", { party: "p2", share_percent: 60, actor: "p2-lead" });

  const result = await get(base, "/results/r1");
  assert.ok(result.body.dispute);
  assert.equal(result.body.dispute.resolved_at, null);

  const publication = await post(base, "/evaluate", {
    item_id: "r1",
    receiver: "p1",
    purpose: "publication",
    stage: "joint-validation",
    actor: "pm-li",
  });
  assert.equal(publication.body.decision, "deny");
  assert.ok(reasonCodes(publication.body).includes("DISPUTE_OPEN"));

  const resolve = await post(base, "/results/r1/disputes/resolve", { actor: "legal-wang", resolution: "双方确认各 50%" });
  assert.equal(resolve.status, 200);

  const afterResolve = await post(base, "/evaluate", {
    item_id: "r1",
    receiver: "p1",
    purpose: "publication",
    stage: "joint-validation",
    actor: "pm-li",
  });
  assert.equal(afterResolve.body.decision, "allow");
});

test("衍生成果继承上游限制的交集并可解释来源", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  setupAgreement(store);
  store.registerMaterial({
    material_id: "m1",
    owner_party: "p1",
    kind: "sample",
    stage: "joint-validation",
    license: { purposes: ["laboratory-validation", "publication"], stages: ["joint-validation"], receivers: ["p2"], markets: [] },
  });
  store.registerMaterial({
    material_id: "m2",
    owner_party: "p2",
    kind: "dataset",
    stage: "joint-validation",
    license: { purposes: ["publication"], stages: ["joint-validation"], receivers: ["p2", "p3"], markets: [] },
  });
  store.registerResult({ result_id: "r1", stage: "joint-validation", inputs: ["m1", "m2"] });

  const view = await get(base, "/items/r1/restrictions");
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.effective_restrictions.purposes, ["publication"]);
  assert.deepEqual(view.body.effective_restrictions.receivers, ["p2"]);
  const inheritedFrom = view.body.inherited.map((layer) => layer.from);
  assert.ok(inheritedFrom.includes("m1"));
  assert.ok(inheritedFrom.includes("m2"));

  const res = await post(base, "/evaluate", {
    item_id: "r1",
    receiver: "p2",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
  });
  assert.equal(res.body.decision, "deny");
  const reason = res.body.reasons.find((item) => item.code === "PURPOSE_NOT_LICENSED");
  assert.match(reason.message, /m2/);
  assert.ok(res.body.inherited.length > 0);
});

test("人工例外放行并记录责任人，撤销后恢复拒绝", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  setupAgreement(store);
  setupMaterial(store);

  const denied = await post(base, "/evaluate", {
    item_id: "m1",
    receiver: "p3",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
  });
  assert.equal(denied.body.decision, "deny");

  const exception = await post(base, "/exceptions", {
    item_id: "m1",
    receiver: "p3",
    purpose: "laboratory-validation",
    actor: "legal-wang",
    justification: "法务特批：联合调试一次性放行",
  });
  assert.equal(exception.status, 201);

  const allowed = await post(base, "/evaluate", {
    item_id: "m1",
    receiver: "p3",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
  });
  assert.equal(allowed.body.decision, "allow");
  assert.equal(allowed.body.via_exception.responsible, "legal-wang");

  const delivery = await post(base, "/deliveries", {
    item_id: "m1",
    sender: "p1",
    receiver: "p3",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
  });
  assert.equal(delivery.body.decision, "allow");

  const audit = await get(base, "/audit?item_id=m1");
  const exceptionEntry = audit.body.find((entry) => entry.kind === "manual-exception");
  assert.equal(exceptionEntry.actor, "legal-wang");
  const deliveryEntry = audit.body.find((entry) => entry.kind === "delivery-allowed");
  assert.equal(deliveryEntry.via_exception.responsible, "legal-wang");

  await post(base, `/exceptions/${exception.body.exception_id}/revoke`, { actor: "legal-wang" });
  const again = await post(base, "/evaluate", {
    item_id: "m1",
    receiver: "p3",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
  });
  assert.equal(again.body.decision, "deny");
});

test("评估基于当前有效协议版本，新版本生效后口径随之变化", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  store.addAgreementVersion({
    agreement_id: "ag",
    version: 1,
    effective_from: T0,
    parties: ["p1", "p2"],
    envelope: { purposes: ["laboratory-validation"], stages: ["joint-validation"], markets: [] },
    publication_requires_unanimous: true,
  });
  store.addAgreementVersion({
    agreement_id: "ag",
    version: 2,
    effective_from: "2026-06-01T00:00:00.000Z",
    parties: ["p1", "p2"],
    envelope: { purposes: ["laboratory-validation", "mass-production"], stages: ["joint-validation", "pilot"], markets: ["cn-mainland"] },
    publication_requires_unanimous: true,
  });
  store.registerMaterial({
    material_id: "m1",
    owner_party: "p1",
    kind: "sample",
    stage: "pilot",
    license: { purposes: ["mass-production"], stages: ["pilot"], receivers: ["p2"], markets: ["cn-mainland"] },
  });

  const request = {
    item_id: "m1",
    receiver: "p2",
    purpose: "mass-production",
    stage: "pilot",
    market: "cn-mainland",
    actor: "pm-li",
  };
  const underV1 = await post(base, "/evaluate", { ...request, as_of: "2026-03-01T00:00:00.000Z" });
  assert.equal(underV1.body.decision, "deny");
  assert.equal(underV1.body.basis.version, 1);
  assert.ok(reasonCodes(underV1.body).includes("PURPOSE_NOT_LICENSED"));

  const underV2 = await post(base, "/evaluate", { ...request, as_of: "2026-07-01T00:00:00.000Z" });
  assert.equal(underV2.body.decision, "allow");
  assert.equal(underV2.body.basis.version, 2);

  const current = await get(base, "/agreements/current?as_of=2026-07-01T00:00:00.000Z");
  assert.equal(current.body.version, 2);
});

test("接收者不能绕过原许可再次分发", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  setupAgreement(store);
  setupMaterial(store);

  const first = await post(base, "/deliveries", {
    item_id: "m1",
    sender: "p1",
    receiver: "p2",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
    at: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(first.body.decision, "allow");

  // 合法持有人向许可外的第三方再分发：仍受原许可约束
  const onward = await post(base, "/deliveries", {
    item_id: "m1",
    sender: "p2",
    receiver: "p3",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
  });
  assert.equal(onward.body.decision, "deny");
  assert.ok(reasonCodes(onward.body).includes("RECEIVER_NOT_LICENSED"));

  // 没有持有记录的发送方不能分发
  const stranger = await post(base, "/deliveries", {
    item_id: "m1",
    sender: "p3",
    receiver: "p2",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
  });
  assert.equal(stranger.body.decision, "deny");
  assert.ok(reasonCodes(stranger.body).includes("SENDER_NOT_HOLDER"));

  // 合法持有人交还所属方：放行
  const back = await post(base, "/deliveries", {
    item_id: "m1",
    sender: "p2",
    receiver: "p1",
    purpose: "laboratory-validation",
    stage: "joint-validation",
    actor: "pm-li",
  });
  assert.equal(back.body.decision, "allow");
});

test("量产用途必须指明拟进入市场且市场须被许可", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  setupAgreement(store);
  store.registerMaterial({
    material_id: "m1",
    owner_party: "p1",
    kind: "sample",
    stage: "pilot",
    license: { purposes: ["mass-production"], stages: ["pilot"], receivers: ["p2"], markets: ["cn-mainland"] },
  });

  const noMarket = await post(base, "/evaluate", {
    item_id: "m1",
    receiver: "p2",
    purpose: "mass-production",
    stage: "pilot",
    actor: "pm-li",
  });
  assert.ok(reasonCodes(noMarket.body).includes("MARKET_REQUIRED"));

  const wrongMarket = await post(base, "/evaluate", {
    item_id: "m1",
    receiver: "p2",
    purpose: "mass-production",
    stage: "pilot",
    market: "tw",
    actor: "pm-li",
  });
  assert.ok(reasonCodes(wrongMarket.body).includes("MARKET_NOT_LICENSED"));

  const allowed = await post(base, "/evaluate", {
    item_id: "m1",
    receiver: "p2",
    purpose: "mass-production",
    stage: "pilot",
    market: "cn-mainland",
    actor: "pm-li",
  });
  assert.equal(allowed.body.decision, "allow");
});

test("背景权利与实验贡献进入可审计关系", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  setupAgreement(store);

  const right = await post(base, "/background-rights", {
    right_id: "br1",
    owner_party: "p1",
    kind: "patent",
    title: "芯片布线结构专利",
  });
  assert.equal(right.status, 201);

  const material = await post(base, "/materials", {
    material_id: "m1",
    owner_party: "p1",
    kind: "sample",
    stage: "joint-validation",
    embodies: ["br1"],
    license: { purposes: ["laboratory-validation"], stages: ["joint-validation"], receivers: ["p2"], markets: [] },
  });
  assert.equal(material.status, 201);
  assert.deepEqual(material.body.embodies, ["br1"]);

  store.registerResult({ result_id: "r1", stage: "joint-validation", inputs: ["m1"] });
  const contribution = await post(base, "/contributions", {
    contribution_id: "c1",
    party: "p2",
    result_id: "r1",
    experiment: "电极阻抗复测",
    inputs: ["m1"],
    actor: "tech-wang",
  });
  assert.equal(contribution.status, 201);

  const result = await get(base, "/results/r1");
  assert.deepEqual(result.body.contributions, ["c1"]);
  assert.ok(result.body.contributors.includes("p2"));

  const audit = await get(base, "/audit?item_id=r1&kind=contribution-registered");
  assert.equal(audit.body.length, 1);
  assert.equal(audit.body[0].actor, "tech-wang");
});

test("未知条目与重复登记返回明确错误", async (t) => {
  const { store, server, base } = await startService();
  t.after(() => server.close());
  setupParties(store);
  setupAgreement(store);

  const evaluation = await post(base, "/evaluate", {
    item_id: "nope",
    receiver: "p2",
    purpose: "laboratory-validation",
    actor: "pm-li",
  });
  assert.equal(evaluation.body.decision, "deny");
  assert.equal(evaluation.body.reasons[0].code, "ITEM_NOT_FOUND");

  const missing = await get(base, "/materials/nope");
  assert.equal(missing.status, 404);

  await post(base, "/materials", { material_id: "m1", owner_party: "p1" });
  const duplicate = await post(base, "/materials", { material_id: "m1", owner_party: "p1" });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.error.code, "DUPLICATE_ID");
});

test("健康检查", async (t) => {
  const { server, base } = await startService();
  t.after(() => server.close());
  const res = await get(base, "/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.状态, "服务已启动");
});
