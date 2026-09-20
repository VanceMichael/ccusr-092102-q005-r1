import {
  createStore,
  registerAgreement,
  registerBackgroundRight,
  registerMaterial,
  registerParty,
} from "../src/engine.js";

export function seedBase() {
  const store = createStore();
  registerParty(store, { party_id: "party-a", name: "北京半导体团队" });
  registerParty(store, { party_id: "party-b-lab", name: "台湾生物电子实验室" });
  registerParty(store, { party_id: "party-c", name: "外部厂商" });
  registerAgreement(store, {
    agreement_id: "jta-2026",
    version: "v1",
    effective_from: "2026-01-01T00:00:00Z",
    clauses: {
      allowed_purposes_by_stage: { "joint-validation": ["laboratory-validation", "testing"] },
      commercial_purposes: ["mass-production", "market-sale"],
    },
  });
  registerBackgroundRight(store, {
    right_id: "patent-chip-01",
    owner_party: "party-a",
    kind: "patent",
    title: "芯片布局专利",
  });
  registerMaterial(store, {
    material_id: "sample-chip-layout-01",
    owner_party: "party-a",
    kind: "sample",
    project_stage: "joint-validation",
    background_right_ids: ["patent-chip-01"],
    license: {
      allowed_purposes: ["laboratory-validation"],
      allowed_receivers: ["party-b-lab"],
    },
  });
  return store;
}
