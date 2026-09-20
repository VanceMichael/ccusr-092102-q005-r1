import assert from "node:assert/strict";
import test from "node:test";

import {
  DomainError,
  evaluateUse,
  listAudit,
  recordContribution,
  recordDelivery,
  withdrawLicense,
} from "../src/engine.js";
import { seedBase } from "./helpers.js";

test("撤回许可后新的使用被拒绝，且说明既往合法使用不受影响", () => {
  const store = seedBase();
  recordDelivery(store, {
    subject_id: "sample-chip-layout-01",
    from_party: "party-a",
    to_party: "party-b-lab",
    purpose: "laboratory-validation",
    actor: "pm-01",
  });
  withdrawLicense(store, "sample-chip-layout-01", { actor: "法务-01", reason: "合作方向调整" });

  const result = evaluateUse(store, {
    subject_id: "sample-chip-layout-01",
    receiver: "party-b-lab",
    purpose: "laboratory-validation",
  });
  assert.equal(result.decision, "deny");
  const check = result.checks.find((entry) => entry.rule === "license-active");
  assert.equal(check.result, "fail");
  assert.match(check.detail, /撤回/);
  assert.match(check.detail, /此前合法完成的使用及其依据保持有效/);
});

test("撤回前的合法交付记录保持有效，审计序列完整", () => {
  const store = seedBase();
  const { record } = recordDelivery(store, {
    subject_id: "sample-chip-layout-01",
    from_party: "party-a",
    to_party: "party-b-lab",
    purpose: "laboratory-validation",
    actor: "pm-01",
  });
  const outcome = withdrawLicense(store, "sample-chip-layout-01", { actor: "法务-01" });

  assert.deepEqual(outcome.preserved_legal_deliveries, [record.delivery_id]);
  const delivery = store.deliveries.find((entry) => entry.delivery_id === record.delivery_id);
  assert.equal(delivery.decision, "released");

  const actions = listAudit(store, { subject_id: "sample-chip-layout-01" }).map((entry) => entry.action);
  assert.deepEqual(actions, ["release", "withdrawal"]);
  const withdrawal = listAudit(store, { action: "withdrawal" })[0];
  assert.equal(withdrawal.actor, "法务-01");
});

test("撤回不抹去此前合法完成的实验及依据", () => {
  const store = seedBase();
  recordDelivery(store, {
    subject_id: "sample-chip-layout-01",
    from_party: "party-a",
    to_party: "party-b-lab",
    purpose: "laboratory-validation",
    actor: "pm-01",
  });
  withdrawLicense(store, "sample-chip-layout-01", { actor: "法务-01" });

  const contribution = recordContribution(store, {
    contribution_id: "exp-01",
    party: "party-b-lab",
    experiment: "样品电学特性复测",
    input_material_ids: ["sample-chip-layout-01"],
  });
  assert.equal(contribution.legal_basis[0].basis, "合法交付");
  assert.equal(contribution.legal_basis[0].agreement_version, "v1");
});

test("没有合法取得依据的实验贡献被拒绝登记", () => {
  const store = seedBase();
  assert.throws(
    () =>
      recordContribution(store, {
        contribution_id: "exp-02",
        party: "party-b-lab",
        experiment: "未获授权的复测",
        input_material_ids: ["sample-chip-layout-01"],
      }),
    (error) => error instanceof DomainError && error.status === 409 && error.code === "no-legal-basis",
  );
});

test("重复撤回被拒绝", () => {
  const store = seedBase();
  withdrawLicense(store, "sample-chip-layout-01", { actor: "法务-01" });
  assert.throws(
    () => withdrawLicense(store, "sample-chip-layout-01", { actor: "法务-01" }),
    (error) => error instanceof DomainError && error.status === 409,
  );
});
