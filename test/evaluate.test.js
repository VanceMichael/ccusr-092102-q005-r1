import assert from "node:assert/strict";
import test from "node:test";

import {
  createStore,
  currentAgreement,
  evaluateUse,
  registerAgreement,
  registerMaterial,
  registerParty,
} from "../src/engine.js";
import { seedBase } from "./helpers.js";

test("许可、阶段、用途、接收人全部满足时放行，并给出协议依据", () => {
  const store = seedBase();
  const result = evaluateUse(store, {
    subject_id: "sample-chip-layout-01",
    receiver: "party-b-lab",
    purpose: "laboratory-validation",
  });
  assert.equal(result.decision, "allow");
  assert.equal(result.agreement_version, "v1");
  assert.equal(result.stage, "joint-validation");
  assert.ok(result.checks.every((check) => check.result === "pass"));
  assert.equal(result.background_rights[0].right_id, "patent-chip-01");
  assert.match(result.summary, /放行/);
});

test("量产用途被许可与商业授权双重拒绝，结论可解释", () => {
  const store = seedBase();
  const result = evaluateUse(store, {
    subject_id: "sample-chip-layout-01",
    receiver: "party-b-lab",
    purpose: "mass-production",
  });
  assert.equal(result.decision, "deny");
  const failedRules = result.checks.filter((check) => check.result === "fail").map((check) => check.rule);
  assert.ok(failedRules.includes("purpose-licensed"));
  assert.ok(failedRules.includes("purpose-within-agreement-stage"));
  assert.ok(failedRules.includes("commercial-authorized"));
  assert.match(result.summary, /拒绝/);
});

test("许可外接收方与未登记接收方都被拒绝", () => {
  const store = seedBase();
  const outsider = evaluateUse(store, {
    subject_id: "sample-chip-layout-01",
    receiver: "party-c",
    purpose: "laboratory-validation",
  });
  assert.equal(outsider.decision, "deny");
  assert.ok(outsider.checks.some((check) => check.rule === "receiver-licensed" && check.result === "fail"));

  const unknown = evaluateUse(store, {
    subject_id: "sample-chip-layout-01",
    receiver: "party-unknown",
    purpose: "laboratory-validation",
  });
  assert.equal(unknown.decision, "deny");
  assert.ok(unknown.checks.some((check) => check.rule === "receiver-registered" && check.result === "fail"));
});

test("接收方不能绕过原许可再次分发", () => {
  const store = seedBase();
  const result = evaluateUse(store, {
    subject_id: "sample-chip-layout-01",
    receiver: "party-c",
    purpose: "laboratory-validation",
    sender_party: "party-b-lab",
  });
  assert.equal(result.decision, "deny");
  const redistribution = result.checks.find((check) => check.rule === "redistribution-authorized");
  assert.equal(redistribution.result, "fail");
  assert.match(redistribution.detail, /不能绕过原许可/);
});

test("许可明确允许再分发时接收方可以转交许可内对象", () => {
  const store = seedBase();
  registerMaterial(store, {
    material_id: "test-data-01",
    owner_party: "party-a",
    kind: "test-data",
    project_stage: "joint-validation",
    license: {
      allowed_purposes: ["testing"],
      allowed_receivers: ["party-b-lab", "party-c"],
      onward_distribution: true,
    },
  });
  const result = evaluateUse(store, {
    subject_id: "test-data-01",
    receiver: "party-c",
    purpose: "testing",
    sender_party: "party-b-lab",
  });
  assert.equal(result.decision, "allow");
});

test("协议阶段用途上限：许可允许但协议对该阶段不允许时拒绝", () => {
  const store = seedBase();
  registerMaterial(store, {
    material_id: "algo-01",
    owner_party: "party-a",
    kind: "algorithm",
    project_stage: "joint-validation",
    license: {
      allowed_purposes: ["joint-development"],
      allowed_receivers: ["party-b-lab"],
    },
  });
  const result = evaluateUse(store, {
    subject_id: "algo-01",
    receiver: "party-b-lab",
    purpose: "joint-development",
  });
  assert.equal(result.decision, "deny");
  const cap = result.checks.find((check) => check.rule === "purpose-within-agreement-stage");
  assert.equal(cap.result, "fail");
  assert.match(cap.detail, /joint-validation/);
});

test("没有生效协议时一律拒绝", () => {
  const store = createStore();
  registerParty(store, { party_id: "party-a", name: "北京半导体团队" });
  registerParty(store, { party_id: "party-b-lab", name: "台湾生物电子实验室" });
  registerMaterial(store, {
    material_id: "sample-x",
    owner_party: "party-a",
    kind: "sample",
    project_stage: "joint-validation",
    license: { allowed_purposes: ["laboratory-validation"], allowed_receivers: ["party-b-lab"] },
  });
  const result = evaluateUse(store, {
    subject_id: "sample-x",
    receiver: "party-b-lab",
    purpose: "laboratory-validation",
  });
  assert.equal(result.decision, "deny");
  assert.ok(result.checks.some((check) => check.rule === "agreement-in-effect" && check.result === "fail"));
});

test("当前协议按生效时间选取最新版本", () => {
  const store = seedBase();
  registerAgreement(store, {
    agreement_id: "jta-2026-r2",
    version: "v2",
    effective_from: "2026-06-01T00:00:00Z",
    supersedes: "jta-2026",
  });
  assert.equal(currentAgreement(store, "2026-03-01T00:00:00Z").version, "v1");
  assert.equal(currentAgreement(store, "2026-09-19T00:00:00Z").version, "v2");
  const result = evaluateUse(store, {
    subject_id: "sample-chip-layout-01",
    receiver: "party-b-lab",
    purpose: "laboratory-validation",
    now: "2026-09-19T00:00:00Z",
  });
  assert.equal(result.agreement_version, "v2");
});
