// 京台科技合作项目种子数据：半导体、生物电子、软件三个研发团队，
// 两版协议文本（v2 起开放量产与拟进入市场），以及各方带入的背景权利与材料。
export function seedJingtai(store) {
  store.addParty({ party_id: "party-semi", name: "半导体研发团队", roles: ["芯片设计", "版图"] });
  store.addParty({ party_id: "party-bio", name: "生物电子研发团队", roles: ["生物传感", "柔性电极"] });
  store.addParty({ party_id: "party-soft", name: "软件研发团队", roles: ["算法", "平台"] });
  store.addParty({ party_id: "park-legal", name: "园区法务", roles: ["合规", "争议协调"] });

  store.addAgreementVersion({
    agreement_id: "jingtai-coop",
    version: 1,
    effective_from: "2026-01-01T00:00:00.000Z",
    parties: ["party-semi", "party-bio", "party-soft"],
    envelope: {
      purposes: ["laboratory-validation", "joint-validation", "algorithm-training"],
      stages: ["background-review", "joint-validation"],
      markets: [],
    },
    publication_requires_unanimous: true,
  });
  store.addAgreementVersion({
    agreement_id: "jingtai-coop",
    version: 2,
    effective_from: "2026-06-01T00:00:00.000Z",
    parties: ["party-semi", "party-bio", "party-soft"],
    envelope: {
      purposes: ["laboratory-validation", "joint-validation", "algorithm-training", "publication", "mass-production"],
      stages: ["background-review", "joint-validation", "pilot"],
      markets: ["cn-mainland", "tw"],
    },
    publication_requires_unanimous: true,
  });

  store.addBackgroundRight({ right_id: "br-semi-patent-01", owner_party: "party-semi", kind: "patent", title: "芯片布线结构专利" });
  store.addBackgroundRight({ right_id: "br-bio-secret-01", owner_party: "party-bio", kind: "trade-secret", title: "柔性电极配方（商业秘密）" });
  store.addBackgroundRight({ right_id: "br-soft-code-01", owner_party: "party-soft", kind: "copyright", title: "信号处理算法代码库" });

  store.registerMaterial({
    material_id: "sample-chip-layout-01",
    owner_party: "party-semi",
    kind: "sample",
    stage: "joint-validation",
    embodies: ["br-semi-patent-01"],
    license: {
      purposes: ["laboratory-validation", "joint-validation"],
      stages: ["joint-validation"],
      receivers: ["party-bio", "party-soft"],
      markets: [],
    },
  });
  store.registerMaterial({
    material_id: "algo-signal-01",
    owner_party: "party-soft",
    kind: "code",
    stage: "joint-validation",
    embodies: ["br-soft-code-01"],
    license: {
      purposes: ["algorithm-training", "joint-validation"],
      stages: ["joint-validation"],
      receivers: ["party-semi", "party-bio"],
      markets: [],
    },
  });
  store.registerMaterial({
    material_id: "dataset-electrode-01",
    owner_party: "party-bio",
    kind: "dataset",
    stage: "joint-validation",
    embodies: ["br-bio-secret-01"],
    license: {
      purposes: ["laboratory-validation"],
      stages: ["joint-validation"],
      receivers: ["party-semi"],
      markets: [],
    },
  });
}
