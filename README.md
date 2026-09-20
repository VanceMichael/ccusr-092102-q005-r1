# 联合研发权利边界服务

面向京台科技合作项目（半导体、生物电子、软件研发团队共用一条协作链）的权利边界服务。
在下一轮样品、算法与测试数据交换之前，把"背景技术归谁、共同成果归谁、商业使用权归谁"
变成可计算、可解释、可追责的边界判定，而不是停留在签约文件里的合作方向。

服务把参与主体、协议文本版本、各方带入的专利或商业秘密、每次材料交付、实验贡献、
阶段成果和拟进入市场连成可审计关系；项目经理输入某份样品或代码、接收合作方和用途后，
得到基于当前有效协议的可解释结论，并能追查历次放行、拒绝和人工例外由谁承担责任。

## 运行

```bash
npm start   # 启动服务（载入京台项目种子数据），默认 127.0.0.1:8080
npm test    # 运行检查
```

## 领域模型

| 概念 | 说明 |
| --- | --- |
| 参与主体 `parties` | 研发团队、园区法务等项目方 |
| 协议版本 `agreements` | 协议文本按版本生效（`effective_from`），评估取评估时点生效的版本 |
| 背景权利 `background-rights` | 各方带入的专利、商业秘密等，材料可声明 `embodies` 关联 |
| 材料 `materials` | 样品/代码/数据，含所属方许可（用途、阶段、接收人、市场）与上游 `derived_from` |
| 成果 `results` | 阶段成果，记录输入 `inputs`、贡献者、归属主张与争议状态 |
| 实验贡献 `contributions` | 谁在哪项成果上做了什么实验、用了哪些输入 |
| 交付 `deliveries` | 每次材料交付（放行才成立），携带当时的协议依据 |
| 人工例外 `exceptions` | 按（条目+接收人+用途）精确放行，必须记录责任人与理由 |
| 审计 `audit` | 放行、拒绝、例外、撤回、争议、贡献等全部留痕 |

## 判定规则

1. **当前有效协议是最外层边界**：资料许可只能收窄，不能突破协议 envelope
   （用途、项目阶段、拟进入市场；协议 `parties` 名单同时约束接收人范围）。
2. **所属方许可逐维收窄**：用途、项目阶段、接收人、拟进入市场四个维度分别求交。
3. **衍生继承取交集**：多个输入衍生出的结果继承各上游限制的交集，
   评估结论会说明继承了哪些上游限制（`inherited`）以及是哪一条上游导致拒绝。
4. **许可撤回不溯及既往**：撤回只阻止撤回时点之后的新使用；此前合法完成的交付与
   实验及其协议依据保留在审计中。用 `as_of` 可重放历史时点的合法性。
   上游被撤回后，衍生内容的新使用同样被阻断（不能借衍生绕过原许可）。
5. **归属争议阻断抢先发布**：多方归属主张合计超过 100%（或法务手动标记）时成果进入
   争议状态，`publication` / `mass-production` / `market-entry` 类用途被拒绝，直至争议解决。
6. **接收者不能绕过原许可再分发**：交付方必须是所属方或合法持有人，
   接收范围仍按原许可与协议判定。
7. **人工例外必须负责到人**：例外精确匹配（条目+接收人+用途），记录责任人与理由，
   可撤销；经例外放行的评估与交付在审计中标注 `via_exception`。

## 主要接口

| 方法与路径 | 说明 |
| --- | --- |
| `POST /parties` | 登记参与主体 |
| `POST /agreements`、`GET /agreements/current?as_of=` | 登记协议版本 / 查询某时点生效版本 |
| `POST /background-rights` | 登记背景权利（专利、商业秘密等） |
| `POST /materials`、`GET /materials/:id` | 登记材料（含许可与上游）/ 查询 |
| `POST /materials/:id/revoke` | 撤回材料许可（`actor`、`at`、`reason`） |
| `POST /results`、`GET /results/:id` | 登记阶段成果（自动固化继承快照）/ 查询 |
| `POST /results/:id/claims` | 提交归属主张；冲突自动进入争议 |
| `POST /results/:id/disputes`、`.../disputes/resolve` | 手动开启 / 解决争议 |
| `POST /contributions` | 登记实验贡献 |
| `POST /evaluate` | 核心评估：`item_id` + `receiver` + `purpose`（可带 `stage`、`market`、`as_of`） |
| `POST /deliveries` | 材料交付：评估通过才放行，放行与拒绝都留痕 |
| `POST /exceptions`、`POST /exceptions/:id/revoke` | 登记 / 撤销人工例外 |
| `GET /items/:id/restrictions` | 查看条目有效限制、分层来源与继承链 |
| `GET /audit?item_id=&kind=&actor=` | 追责查询：放行、拒绝、例外等由谁承担责任 |

## 示例

```bash
curl -s -X POST localhost:8080/evaluate -H 'content-type: application/json' -d '{
  "item_id": "sample-chip-layout-01",
  "receiver": "party-bio",
  "purpose": "mass-production",
  "stage": "pilot",
  "market": "cn-mainland",
  "actor": "pm-li"
}'
```

拒绝时的响应会给出可解释原因与有效边界，例如：

```json
{
  "decision": "deny",
  "basis": { "agreement_id": "jingtai-coop", "version": 2 },
  "effective_restrictions": { "purposes": ["joint-validation", "laboratory-validation"], "...": "..." },
  "reasons": [
    { "code": "PURPOSE_NOT_LICENSED",
      "message": "用途「mass-production」不在有效许可范围 [...] 内；限制来源：协议 jingtai-coop@v2（当前协议）；sample-chip-layout-01（自有许可）" }
  ]
}
```

协议文本、授权和成果关系都使用稳定标识；已经发生的合法使用与之后的许可变化分别记录，
历史评估可通过 `as_of` 参数重放。
