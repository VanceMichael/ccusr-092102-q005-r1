import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/server.js";

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  const get = async (path) => {
    const response = await fetch(base + path);
    return { status: response.status, json: await response.json() };
  };
  try {
    await run({ base, post, get });
  } finally {
    server.close();
  }
}

async function seedHttp(post) {
  await post("/parties", { party_id: "party-a", name: "北京半导体团队" });
  await post("/parties", { party_id: "party-b-lab", name: "台湾生物电子实验室" });
  await post("/parties", { party_id: "party-c", name: "外部厂商" });
  await post("/agreements", {
    agreement_id: "jta-2026",
    version: "v1",
    effective_from: "2026-01-01T00:00:00Z",
    clauses: {
      allowed_purposes_by_stage: { "joint-validation": ["laboratory-validation", "testing"] },
      commercial_purposes: ["mass-production"],
    },
  });
  await post("/background-rights", {
    right_id: "patent-chip-01",
    owner_party: "party-a",
    kind: "patent",
    title: "芯片布局专利",
  });
  await post("/materials", {
    material_id: "sample-chip-layout-01",
    owner_party: "party-a",
    kind: "sample",
    project_stage: "joint-validation",
    background_right_ids: ["patent-chip-01"],
    license: { allowed_purposes: ["laboratory-validation"], allowed_receivers: ["party-b-lab"] },
  });
}

test("健康检查保持原有响应", async () => {
  await withServer(async ({ get }) => {
    const { status, json } = await get("/health");
    assert.equal(status, 200);
    assert.deepEqual(json, { 状态: "服务已启动" });
  });
});

test("端到端：登记 → 评估 → 交付 → 审计可追责", async () => {
  await withServer(async ({ post, get }) => {
    await seedHttp(post);

    const evaluation = await post("/evaluate", {
      subject_id: "sample-chip-layout-01",
      receiver: "party-b-lab",
      purpose: "laboratory-validation",
    });
    assert.equal(evaluation.status, 200);
    assert.equal(evaluation.json.decision, "allow");
    assert.equal(evaluation.json.agreement_version, "v1");

    const released = await post("/deliveries", {
      subject_id: "sample-chip-layout-01",
      from_party: "party-a",
      to_party: "party-b-lab",
      purpose: "laboratory-validation",
      actor: "pm-01",
    });
    assert.equal(released.status, 201);
    assert.equal(released.json.decision, "released");

    const denied = await post("/deliveries", {
      subject_id: "sample-chip-layout-01",
      from_party: "party-a",
      to_party: "party-c",
      purpose: "mass-production",
      actor: "pm-01",
    });
    assert.equal(denied.status, 201);
    assert.equal(denied.json.decision, "denied");
    assert.match(denied.json.explanation, /拒绝/);

    const exception = await post("/deliveries", {
      subject_id: "sample-chip-layout-01",
      from_party: "party-a",
      to_party: "party-c",
      purpose: "mass-production",
      actor: "pm-01",
      override: { approved_by: "法务-王", reason: "临时豁免：对方仅做兼容性评估" },
    });
    assert.equal(exception.status, 201);
    assert.equal(exception.json.decision, "exception");
    assert.equal(exception.json.override.approved_by, "法务-王");

    const audit = await get("/audit?subject_id=sample-chip-layout-01");
    assert.equal(audit.status, 200);
    const actions = audit.json.map((entry) => entry.action);
    assert.deepEqual(actions, ["release", "denial", "exception"]);
    assert.equal(audit.json[0].actor, "pm-01");
    assert.equal(audit.json[2].actor, "法务-王");
    assert.ok(audit.json.every((entry) => entry.delivery_id));
  });
});

test("许可撤回阻断新交付，既往合法交付保持有效", async () => {
  await withServer(async ({ post, get }) => {
    await seedHttp(post);
    await post("/deliveries", {
      subject_id: "sample-chip-layout-01",
      from_party: "party-a",
      to_party: "party-b-lab",
      purpose: "laboratory-validation",
      actor: "pm-01",
    });

    const withdrawn = await post("/materials/sample-chip-layout-01/withdraw", {
      actor: "法务-王",
      reason: "许可范围重新谈判",
    });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.json.preserved_legal_deliveries.length, 1);

    const evaluation = await post("/evaluate", {
      subject_id: "sample-chip-layout-01",
      receiver: "party-b-lab",
      purpose: "laboratory-validation",
    });
    assert.equal(evaluation.json.decision, "deny");
    assert.ok(evaluation.json.checks.some((check) => check.rule === "license-active" && check.result === "fail"));

    const audit = await get("/audit?subject_id=sample-chip-layout-01");
    assert.deepEqual(audit.json.map((entry) => entry.action), ["release", "withdrawal"]);
  });
});

test("争议中的成果不能抢先发布，解决后放行", async () => {
  await withServer(async ({ post, get }) => {
    await seedHttp(post);
    await post("/materials", {
      material_id: "party-a-ip-01",
      owner_party: "party-a",
      kind: "algorithm",
      project_stage: "joint-validation",
      license: {
        allowed_purposes: ["laboratory-validation"],
        allowed_receivers: ["party-b-lab"],
        commercial_use: true,
      },
    });
    await post("/materials", {
      material_id: "joint-algo-01",
      owner_party: "party-b-lab",
      kind: "algorithm",
      project_stage: "joint-validation",
      license: {
        allowed_purposes: ["laboratory-validation"],
        allowed_receivers: ["party-a"],
        commercial_use: true,
      },
    });
    await post("/deliveries", {
      subject_id: "party-a-ip-01",
      from_party: "party-a",
      to_party: "party-b-lab",
      purpose: "laboratory-validation",
      actor: "pm-01",
    });
    await post("/contributions", {
      contribution_id: "exp-01",
      party: "party-b-lab",
      experiment: "联合标定实验",
      input_material_ids: ["party-a-ip-01", "joint-algo-01"],
    });
    const achievement = await post("/achievements", {
      achievement_id: "ach-01",
      name: "联合验证算法",
      stage: "joint-validation",
      input_material_ids: ["party-a-ip-01", "joint-algo-01"],
      contribution_ids: ["exp-01"],
      intended_markets: ["medical-device"],
      created_by: "party-a",
    });
    assert.equal(achievement.status, 201);
    assert.equal(achievement.json.effective_license.commercial_use, true);

    await post("/achievements/ach-01/claims", { party: "party-a", share_percent: 60, actor: "法务-王" });
    await post("/achievements/ach-01/objections", {
      party: "party-b-lab",
      reason: "核心算法由本实验室提供",
      actor: "法务-李",
    });

    const blocked = await post("/achievements/ach-01/publish", { market: "medical-device", actor: "pm-01" });
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.error.message, /争议/);

    const evaluation = await post("/evaluate", {
      subject_id: "ach-01",
      receiver: "party-b-lab",
      purpose: "laboratory-validation",
    });
    assert.equal(evaluation.json.decision, "deny");
    assert.ok(evaluation.json.checks.some((check) => check.rule === "ownership-clear" && check.result === "fail"));

    const resolved = await post("/achievements/ach-01/resolve", {
      agreed_shares: { "party-a": 50, "party-b-lab": 50 },
      resolved_by: "园区法务",
      reason: "双方书面确认共同所有",
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json.ownership_status, "agreed");

    const published = await post("/achievements/ach-01/publish", { market: "medical-device", actor: "pm-01" });
    assert.equal(published.status, 201);
    assert.equal(published.json.market, "medical-device");

    const audit = await get("/audit?subject_id=ach-01");
    const actions = audit.json.map((entry) => entry.action);
    assert.ok(actions.includes("dispute"));
    assert.ok(actions.includes("denial"));
    assert.ok(actions.includes("resolution"));
    assert.ok(actions.includes("publish"));
  });
});

test("错误输入得到结构化错误", async () => {
  await withServer(async ({ base, post, get }) => {
    const missing = await post("/parties", { name: "缺 id" });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error.code, "missing-field");

    const notFound = await get("/materials/no-such");
    assert.equal(notFound.status, 404);

    const badRoute = await get("/nope");
    assert.equal(badRoute.status, 404);

    const badJson = await fetch(`${base}/parties`, { method: "POST", body: "not-json" });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error.code, "bad-json");
  });
});
