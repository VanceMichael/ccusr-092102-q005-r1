import assert from "node:assert/strict";
import test from "node:test";

import {
  achievementLineage,
  createAchievement,
  evaluateUse,
  recordContribution,
  recordDelivery,
  registerMaterial,
  withdrawLicense,
} from "../src/engine.js";
import { seedBase } from "./helpers.js";

function seedDerived() {
  const store = seedBase();
  registerMaterial(store, {
    material_id: "bio-sensor-data-01",
    owner_party: "party-b-lab",
    kind: "test-data",
    project_stage: "joint-validation",
    license: {
      allowed_purposes: ["laboratory-validation", "testing"],
      allowed_receivers: ["party-a", "party-b-lab"],
      commercial_use: true,
    },
  });
  recordDelivery(store, {
    subject_id: "sample-chip-layout-01",
    from_party: "party-a",
    to_party: "party-b-lab",
    purpose: "laboratory-validation",
    actor: "pm-01",
  });
  recordContribution(store, {
    contribution_id: "exp-a",
    party: "party-a",
    experiment: "版图噪声仿真",
    input_material_ids: ["sample-chip-layout-01"],
  });
  recordContribution(store, {
    contribution_id: "exp-b",
    party: "party-b-lab",
    experiment: "传感器联合标定",
    input_material_ids: ["sample-chip-layout-01", "bio-sensor-data-01"],
  });
  const achievement = createAchievement(store, {
    achievement_id: "ach-fusion-01",
    name: "融合传感算法 v1",
    stage: "joint-validation",
    input_material_ids: ["sample-chip-layout-01", "bio-sensor-data-01"],
    contribution_ids: ["exp-a", "exp-b"],
    intended_markets: ["medical-device"],
    created_by: "party-a",
  });
  return { store, achievement };
}

test("多输入衍生的成果继承各上游许可的交集", () => {
  const { achievement } = seedDerived();
  assert.deepEqual(achievement.effective_license.allowed_purposes, ["laboratory-validation"]);
  assert.deepEqual(achievement.effective_license.allowed_receivers, ["party-b-lab"]);
  assert.equal(achievement.effective_license.commercial_use, false);
  assert.equal(achievement.effective_license.onward_distribution, false);
});

test("继承限制逐条说明来源上游", () => {
  const { store } = seedDerived();
  const lineage = achievementLineage(store, "ach-fusion-01");
  assert.equal(lineage.inherited_restrictions.length, 2);
  const fromSample = lineage.inherited_restrictions.find((entry) => entry.material_id === "sample-chip-layout-01");
  assert.match(fromSample.note, /sample-chip-layout-01/);
  assert.match(fromSample.note, /party-a/);
  assert.match(fromSample.note, /禁止商业使用/);
  assert.match(lineage.explanation, /交集/);
  assert.equal(lineage.legal_basis.length > 0, true);
});

test("继承交集之外的用途被拒绝", () => {
  const { store } = seedDerived();
  const result = evaluateUse(store, {
    subject_id: "ach-fusion-01",
    receiver: "party-b-lab",
    purpose: "testing",
  });
  assert.equal(result.decision, "deny");
  assert.ok(result.checks.some((check) => check.rule === "purpose-licensed" && check.result === "fail"));
  assert.equal(result.inherited_restrictions.length, 2);
});

test("成果的商业使用受最严上游限制约束", () => {
  const { store } = seedDerived();
  const result = evaluateUse(store, {
    subject_id: "ach-fusion-01",
    receiver: "party-b-lab",
    purpose: "mass-production",
  });
  assert.equal(result.decision, "deny");
  assert.ok(result.checks.some((check) => check.rule === "commercial-authorized" && check.result === "fail"));
});

test("上游许可撤回后，衍生成果的新交付被阻止", () => {
  const { store } = seedDerived();
  withdrawLicense(store, "sample-chip-layout-01", { actor: "法务-01" });
  const result = evaluateUse(store, {
    subject_id: "ach-fusion-01",
    receiver: "party-b-lab",
    purpose: "laboratory-validation",
  });
  assert.equal(result.decision, "deny");
  const upstream = result.checks.find((check) => check.rule === "upstream-license-active");
  assert.equal(upstream.result, "fail");
  assert.match(upstream.detail, /sample-chip-layout-01/);
});
