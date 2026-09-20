import http from "node:http";
import { DomainError, boundaryView, evaluate } from "./domain.js";
import { seedJingtai } from "./seed.js";
import { Store } from "./store.js";

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

function need(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw new DomainError("MISSING_FIELD", `缺少必填字段：${field}`);
    }
  }
}

function matchPattern(pattern, segments) {
  const parts = pattern.split("/").filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].startsWith(":")) params[parts[index].slice(1)] = decodeURIComponent(segments[index]);
    else if (parts[index] !== segments[index]) return null;
  }
  return params;
}

function notFound(message) {
  return { status: 404, payload: { error: { code: "UNKNOWN_ITEM", message } } };
}

const routes = [
  ["GET", "/health", () => ({ status: 200, payload: { 状态: "服务已启动" } })],

  ["POST", "/parties", (store, { body }) => {
    need(body, ["party_id", "name"]);
    return { status: 201, payload: store.addParty(body) };
  }],
  ["GET", "/parties", (store) => ({ status: 200, payload: [...store.parties.values()] })],

  ["POST", "/agreements", (store, { body }) => {
    need(body, ["agreement_id", "version", "effective_from"]);
    return { status: 201, payload: store.addAgreementVersion(body) };
  }],
  ["GET", "/agreements/current", (store, { query }) => {
    const asOf = query.get("as_of") ?? new Date().toISOString();
    const agreement = store.currentAgreement(asOf);
    if (!agreement) return notFound(`评估时点 ${asOf} 没有生效的协议文本`);
    return { status: 200, payload: agreement };
  }],

  ["POST", "/background-rights", (store, { body }) => {
    need(body, ["right_id", "owner_party", "kind", "title"]);
    return { status: 201, payload: store.addBackgroundRight(body) };
  }],
  ["GET", "/background-rights", (store) => ({ status: 200, payload: [...store.backgroundRights.values()] })],

  ["POST", "/materials", (store, { body }) => {
    need(body, ["material_id", "owner_party"]);
    return { status: 201, payload: store.registerMaterial(body) };
  }],
  ["GET", "/materials/:id", (store, { params }) => {
    const material = store.materials.get(params.id);
    if (!material) return notFound(`未找到材料：${params.id}`);
    return { status: 200, payload: material };
  }],
  ["POST", "/materials/:id/revoke", (store, { body, params }) => {
    need(body, ["actor"]);
    return { status: 200, payload: store.revokeMaterial(params.id, body) };
  }],

  ["POST", "/results", (store, { body }) => {
    need(body, ["result_id"]);
    return { status: 201, payload: store.registerResult(body) };
  }],
  ["GET", "/results/:id", (store, { params }) => {
    const result = store.results.get(params.id);
    if (!result) return notFound(`未找到成果：${params.id}`);
    return { status: 200, payload: result };
  }],
  ["POST", "/results/:id/claims", (store, { body, params }) => {
    need(body, ["party", "share_percent", "actor"]);
    return { status: 201, payload: store.addClaim(params.id, body) };
  }],
  ["POST", "/results/:id/disputes", (store, { body, params }) => {
    need(body, ["actor", "reason"]);
    return { status: 201, payload: store.openDispute(params.id, body) };
  }],
  ["POST", "/results/:id/disputes/resolve", (store, { body, params }) => {
    need(body, ["actor", "resolution"]);
    return { status: 200, payload: store.resolveDispute(params.id, body) };
  }],

  ["POST", "/contributions", (store, { body }) => {
    need(body, ["contribution_id", "party", "result_id", "experiment", "actor"]);
    return { status: 201, payload: store.recordContribution(body) };
  }],

  // 项目经理查询：输入样品/代码/成果、接收合作方与用途，得到可解释结论。
  ["POST", "/evaluate", (store, { body }) => {
    need(body, ["item_id", "receiver", "purpose", "actor"]);
    const decision = evaluate(store, body);
    store.log({
      kind: "evaluation",
      actor: body.actor,
      item_id: body.item_id,
      receiver: body.receiver,
      purpose: body.purpose,
      decision: decision.decision,
      reasons: decision.reasons.map((reason) => reason.code),
      basis: decision.basis,
    });
    return { status: 200, payload: decision };
  }],

  // 材料交付：评估通过才放行；无论放行或拒绝都留痕。
  ["POST", "/deliveries", (store, { body }) => {
    need(body, ["item_id", "sender", "receiver", "purpose", "actor"]);
    const decision = evaluate(store, body);
    const delivery = store.recordDelivery(body, decision);
    return { status: 200, payload: { ...decision, delivery_id: delivery?.delivery_id ?? null } };
  }],

  ["POST", "/exceptions", (store, { body }) => {
    need(body, ["item_id", "receiver", "purpose", "actor", "justification"]);
    return { status: 201, payload: store.addException(body) };
  }],
  ["GET", "/exceptions", (store) => ({ status: 200, payload: [...store.exceptions.values()] })],
  ["POST", "/exceptions/:id/revoke", (store, { body, params }) => {
    need(body, ["actor"]);
    return { status: 200, payload: store.revokeException(params.id, body) };
  }],

  // 追责入口：历次放行、拒绝与人工例外由谁承担责任。
  ["GET", "/audit", (store, { query }) => ({
    status: 200,
    payload: store.queryAudit({
      item_id: query.get("item_id"),
      kind: query.get("kind"),
      actor: query.get("actor"),
    }),
  })],

  // 继承视图：说明条目继承了哪些上游限制。
  ["GET", "/items/:id/restrictions", (store, { params, query }) => {
    if (!store.getItem(params.id)) return notFound(`未找到条目：${params.id}`);
    const asOf = query.get("as_of") ?? new Date().toISOString();
    return { status: 200, payload: boundaryView(store, params.id, asOf) };
  }],
];

export function createServer(store = new Store()) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const segments = url.pathname.split("/").filter(Boolean);
      const body = request.method === "POST" ? await readBody(request) : {};
      for (const [method, pattern, handler] of routes) {
        if (method !== request.method) continue;
        const params = matchPattern(pattern, segments);
        if (!params) continue;
        const { status, payload } = handler(store, { body, params, query: url.searchParams });
        sendJson(response, status, payload);
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
    } catch (error) {
      if (error instanceof DomainError) {
        sendJson(response, 400, { error: { code: error.code, message: error.message } });
      } else {
        sendJson(response, 500, { error: { code: "INTERNAL", message: String(error?.message ?? error) } });
      }
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const store = new Store();
  seedJingtai(store);
  createServer(store).listen(port, "127.0.0.1", () => {
    console.log(`权利边界服务已监听 127.0.0.1:${port}（已载入京台项目种子数据）`);
  });
}
