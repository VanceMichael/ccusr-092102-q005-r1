# 联合研发权利控制服务

京台科技合作项目（半导体、生物电子、软件）共用的权利边界服务。签约文件里的合作方向回答不了背景技术、共同成果和商业使用权归谁，本服务把参与主体、协议文本版本、各方带入的专利或商业秘密、每次材料交付、实验贡献、阶段成果和拟进入市场连成可审计关系，在下一轮样品、算法和测试数据交换前给出可解释的权利结论。

基础服务采用 Node.js 标准库运行（Node ≥ 22，无外部依赖），数据保存在进程内存中。

## 运行与检查

```bash
npm start     # 启动服务（默认 127.0.0.1:8080，PORT 可覆盖）
npm test      # 运行全部检查
```

## 领域概念

| 概念 | 说明 |
| --- | --- |
| 参与主体 `party` | 园区内外各方团队 / 实验室 / 厂商，一切许可与交付都以其稳定标识为准 |
| 协议文本版本 `agreement` | 带生效时间的协议版本；评估永远基于"当前有效"的版本，并支持按阶段限定用途、界定商业用途 |
| 背景权利 `background-right` | 各方带入项目的专利（patent）或商业秘密（trade_secret） |
| 研发材料 `material` | 样品 / 代码 / 算法 / 测试数据，随附所属方许可：允许用途、允许接收方、允许阶段、是否允许再分发与商业使用 |
| 交付 `delivery` | 一次材料移交的评估与记录，结论为放行 / 拒绝 / 人工例外 |
| 实验贡献 `contribution` | 以材料为输入的实验，登记时核验合法取得依据（自有或合法交付） |
| 阶段成果 `achievement` | 由多项输入衍生的成果，自动继承上游限制并进入归属流程 |
| 拟进入市场 `intended market` | 成果登记时声明的目标市场，发布时校验 |

## 核心规则

1. **可解释评估**：`POST /evaluate` 输入对象（样品或代码）、接收合作方和用途（如量产 `mass-production`），返回基于当前有效协议的逐项检查结论（许可、阶段、用途、接收人、商业授权、再分发），放行或拒绝都附中文说明。
2. **再分发不越权**：接收者下载后再次转交他人时，仍按原所属方许可评估；许可未明确允许再分发（`onward_distribution`）即拒绝。
3. **许可撤回不溯及既往**：撤回只阻止新的使用；此前合法完成的交付、实验及其依据（交付记录 + 协议版本）保持有效，撤回响应会列出被保留的合法交付。
4. **衍生继承上游限制**：多输入衍生的成果继承各上游许可的**交集**（用途、接收方取交集，商业使用与再分发取最严），`GET /achievements/:id/lineage` 逐条说明每条限制来自哪个上游。
5. **争议不抢先发布**：多方归属主张未达成一致、主张冲突（合计超 100% 或自相矛盾）或存在未决异议时，成果进入争议状态，发布与对外交付一律拒绝；书面解决（份额合计 100% 且涵盖全部主张/异议方）后恢复。
6. **全程可追责**：每次放行、拒绝、人工例外、撤回、争议、解决、发布都写入审计日志并记录责任人；人工例外必须给出审批人与理由，责任由审批人承担。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST/GET | `/parties` | 登记 / 列出参与主体 |
| POST/GET | `/agreements`，GET `/agreements/current` | 登记协议版本 / 查询当前有效版本 |
| POST/GET | `/background-rights` | 登记背景专利或商业秘密 |
| POST/GET | `/materials`，GET `/materials/:id` | 登记研发材料及其许可 |
| POST | `/materials/:id/withdraw` | 撤回材料许可（保留既往合法使用） |
| POST | `/evaluate` | 可解释的使用评估（不落地记录） |
| POST/GET | `/deliveries` | 交付评估与记录（支持 `override` 人工例外）/ 查询交付历史 |
| POST/GET | `/contributions` | 登记实验贡献（核验合法取得依据） |
| POST/GET | `/achievements`，GET `/achievements/:id`，GET `/achievements/:id/lineage` | 登记阶段成果 / 查询继承谱系 |
| POST | `/achievements/:id/claims`、`/objections`、`/resolve`、`/publish` | 归属主张、异议、争议解决、发布到市场 |
| GET | `/audit?subject_id=&action=` | 审计追踪（放行 release / 拒绝 denial / 人工例外 exception / 撤回 withdrawal / 争议 dispute / 解决 resolution / 发布 publish） |

## 示例流程

```bash
# 登记主体、协议、背景权利与材料许可
curl -X POST localhost:8080/parties -d '{"party_id":"party-a","name":"北京半导体团队"}' -H 'content-type: application/json'
curl -X POST localhost:8080/agreements -d '{"agreement_id":"jta-2026","version":"v1","effective_from":"2026-01-01T00:00:00Z","clauses":{"allowed_purposes_by_stage":{"joint-validation":["laboratory-validation","testing"]},"commercial_purposes":["mass-production"]}}' -H 'content-type: application/json'
curl -X POST localhost:8080/materials -d '{"material_id":"sample-chip-layout-01","owner_party":"party-a","kind":"sample","project_stage":"joint-validation","license":{"allowed_purposes":["laboratory-validation"],"allowed_receivers":["party-b-lab"]}}' -H 'content-type: application/json'

# 项目经理查询：样品能否交给合作方用于量产？
curl -X POST localhost:8080/evaluate -d '{"subject_id":"sample-chip-layout-01","receiver":"party-b-lab","purpose":"mass-production"}' -H 'content-type: application/json'
# → decision: deny，checks 逐项说明：用途不在许可范围、协议对该阶段不允许、商业使用未授权

# 合规交付（自动评估并留痕）
curl -X POST localhost:8080/deliveries -d '{"subject_id":"sample-chip-layout-01","from_party":"party-a","to_party":"party-b-lab","purpose":"laboratory-validation","actor":"pm-01"}' -H 'content-type: application/json'

# 追责：谁放行、谁拒绝、谁批了人工例外
curl 'localhost:8080/audit?subject_id=sample-chip-layout-01'
```

协议文本、授权和成果关系都应使用稳定标识。已经发生的合法使用与之后的许可变化需要分别记录。
