import assert from "node:assert/strict";
import test from "node:test";

import {
  DomainError,
  claimOwnership,
  createAchievement,
  publishAchievement,
  raiseObjection,
  recordContribution,
  recordDelivery,
  registerMaterial,
  resolveDispute,
  withdrawLicense,
} from "../src/engine.js";
import { seedBase } from "./helpers.js";

function seedAchievement() {
  const store = seedBase();
  registerMaterial(store, {
    material_id: "bio-algo-01",
    owner_party: "party-b-lab",
    kind: "algorithm",
    project_stage: "joint-validation",
    license: {
      allowed_purposes: ["laboratory-validation"],
      allowed_receivers: ["party-a"],
      commercial_use: true,
    },
  });
  registerMaterial(store, {
    material_id: "chip-ip-01",
    owner_party: "party-a",
    kind: "algorithm",
    project_stage: "joint-validation",
    license: {
      allowed_purposes: ["laboratory-validation"],
      allowed_receivers: ["party-b-lab"],
      commercial_use: true,
    },
  });
  recordDelivery(store, {
    subject_id: "chip-ip-01",
    from_party: "party-a",
    to_party: "party-b-lab",
    purpose: "laboratory-validation",
    actor: "pm-01",
  });
  recordContribution(store, {
    contribution_id: "exp-joint",
    party: "party-b-lab",
    experiment: "联合验证实验",
    input_material_ids: ["chip-ip-01", "bio-algo-01"],
  });
  createAchievement(store, {
    achievement_id: "ach-joint-01",
    name: "联合验证成果",
    stage: "joint-validation",
    input_material_ids: ["chip-ip-01", "bio-algo-01"],
    contribution_ids: ["exp-joint"],
    intended_markets: ["medical-device"],
    created_by: "party-a",
  });
  return store;
}

test("多方主张未达成一致时不能抢先发布", () => {
  const store = seedAchievement();
  claimOwnership(store, "ach-joint-01", { party: "party-a", share_percent: 50, actor: "法务-王" });
  claimOwnership(store, "ach-joint-01", { party: "party-b-lab", share_percent: 50, actor: "法务-李" });
  assert.throws(
    () => publishAchievement(store, "ach-joint-01", { market: "medical-device", actor: "pm-01" }),
    (error) => error instanceof DomainError && error.status === 409 && /尚未达成一致/.test(error.message),
  );
});

test("主张份额合计超过 100% 自动进入争议状态", () => {
  const store = seedAchievement();
  claimOwnership(store, "ach-joint-01", { party: "party-a", share_percent: 60, actor: "法务-王" });
  claimOwnership(store, "ach-joint-01", { party: "party-b-lab", share_percent: 60, actor: "法务-李" });
  const achievement = store.achievements.get("ach-joint-01");
  assert.equal(achievement.ownership_status, "disputed");
  const dispute = store.audit.find((entry) => entry.action === "dispute");
  assert.match(dispute.detail, /120%/);
});

test("同一方自相矛盾的主张触发争议", () => {
  const store = seedAchievement();
  claimOwnership(store, "ach-joint-01", { party: "party-a", share_percent: 40, actor: "法务-王" });
  claimOwnership(store, "ach-joint-01", { party: "party-a", share_percent: 70, actor: "法务-王" });
  assert.equal(store.achievements.get("ach-joint-01").ownership_status, "disputed");
});

test("解决方案须合计 100% 且涵盖全部主张与异议方", () => {
  const store = seedAchievement();
  claimOwnership(store, "ach-joint-01", { party: "party-a", share_percent: 50, actor: "法务-王" });
  raiseObjection(store, "ach-joint-01", { party: "party-b-lab", reason: "贡献被低估", actor: "法务-李" });

  assert.throws(
    () =>
      resolveDispute(store, "ach-joint-01", {
        agreed_shares: { "party-a": 50, "party-b-lab": 40 },
        resolved_by: "园区法务",
      }),
    (error) => error instanceof DomainError && error.code === "shares-not-100",
  );
  assert.throws(
    () =>
      resolveDispute(store, "ach-joint-01", {
        agreed_shares: { "party-a": 100 },
        resolved_by: "园区法务",
      }),
    (error) => error instanceof DomainError && error.code === "resolution-incomplete",
  );

  const achievement = resolveDispute(store, "ach-joint-01", {
    agreed_shares: { "party-a": 50, "party-b-lab": 50 },
    resolved_by: "园区法务",
  });
  assert.equal(achievement.ownership_status, "agreed");
  assert.ok(achievement.objections.every((objection) => !objection.open));
});

test("归属达成一致后新的主张与异议被拒绝", () => {
  const store = seedAchievement();
  claimOwnership(store, "ach-joint-01", { party: "party-a", share_percent: 50, actor: "法务-王" });
  resolveDispute(store, "ach-joint-01", {
    agreed_shares: { "party-a": 50, "party-b-lab": 50 },
    resolved_by: "园区法务",
  });
  assert.throws(
    () => claimOwnership(store, "ach-joint-01", { party: "party-c", share_percent: 10, actor: "法务-某" }),
    (error) => error instanceof DomainError && error.status === 409,
  );
  assert.throws(
    () => raiseObjection(store, "ach-joint-01", { party: "party-c", reason: "事后异议", actor: "法务-某" }),
    (error) => error instanceof DomainError && error.status === 409,
  );
});

test("发布受拟进入市场清单约束", () => {
  const store = seedAchievement();
  assert.throws(
    () => publishAchievement(store, "ach-joint-01", { market: "consumer-electronics", actor: "pm-01" }),
    (error) => error instanceof DomainError && error.status === 409 && /拟进入市场/.test(error.message),
  );
});

test("上游许可撤回阻止新的发布，但不影响已登记的成果与依据", () => {
  const store = seedAchievement();
  withdrawLicense(store, "chip-ip-01", { actor: "法务-王" });
  assert.throws(
    () => publishAchievement(store, "ach-joint-01", { market: "medical-device", actor: "pm-01" }),
    (error) => error instanceof DomainError && /撤回/.test(error.message),
  );
  const achievement = store.achievements.get("ach-joint-01");
  assert.equal(achievement.legal_basis.length > 0, true);
  assert.equal(achievement.legal_basis[0].agreement_version, "v1");
});
