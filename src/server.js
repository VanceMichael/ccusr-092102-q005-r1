import http from "node:http";
import {
  DomainError,
  achievementLineage,
  claimOwnership,
  createAchievement,
  createStore,
  currentAgreement,
  evaluateUse,
  listAudit,
  listDeliveries,
  publishAchievement,
  raiseObjection,
  recordContribution,
  recordDelivery,
  registerAgreement,
  registerBackgroundRight,
  registerMaterial,
  registerParty,
  resolveDispute,
  withdrawLicense,
} from "./engine.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function send(response, status, payload) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new DomainError(413, "too-large", "请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError(400, "bad-json", "请求体不是合法 JSON");
  }
}

export function createServer(store = createStore()) {
  const routes = [
    { method: "GET", pattern: /^\/health$/, handler: () => [200, { 状态: "服务已启动" }] },

    { method: "POST", pattern: /^\/parties$/, handler: ({ body }) => [201, registerParty(store, body)] },
    { method: "GET", pattern: /^\/parties$/, handler: () => [200, [...store.parties.values()]] },

    { method: "POST", pattern: /^\/agreements$/, handler: ({ body }) => [201, registerAgreement(store, body)] },
    { method: "GET", pattern: /^\/agreements$/, handler: () => [200, store.agreements] },
    {
      method: "GET",
      pattern: /^\/agreements\/current$/,
      handler: ({ query }) => {
        const agreement = currentAgreement(store, query.get("at") ?? undefined);
        if (!agreement) throw new DomainError(404, "no-agreement", "当前没有生效的协议文本");
        return [200, agreement];
      },
    },

    { method: "POST", pattern: /^\/background-rights$/, handler: ({ body }) => [201, registerBackgroundRight(store, body)] },
    { method: "GET", pattern: /^\/background-rights$/, handler: () => [200, [...store.backgroundRights.values()]] },

    { method: "POST", pattern: /^\/materials$/, handler: ({ body }) => [201, registerMaterial(store, body)] },
    { method: "GET", pattern: /^\/materials$/, handler: () => [200, [...store.materials.values()]] },
    {
      method: "GET",
      pattern: /^\/materials\/(?<id>[^/]+)$/,
      handler: ({ params }) => {
        const material = store.materials.get(decodeURIComponent(params.id));
        if (!material) throw new DomainError(404, "material-not-found", `研发材料未登记：${params.id}`);
        return [200, material];
      },
    },
    {
      method: "POST",
      pattern: /^\/materials\/(?<id>[^/]+)\/withdraw$/,
      handler: ({ params, body }) => [200, withdrawLicense(store, decodeURIComponent(params.id), body)],
    },

    { method: "POST", pattern: /^\/evaluate$/, handler: ({ body }) => [200, evaluateUse(store, body)] },

    { method: "POST", pattern: /^\/deliveries$/, handler: ({ body }) => [201, recordDelivery(store, body).record] },
    { method: "GET", pattern: /^\/deliveries$/, handler: ({ query }) => [200, listDeliveries(store, Object.fromEntries(query))] },

    { method: "POST", pattern: /^\/contributions$/, handler: ({ body }) => [201, recordContribution(store, body)] },
    { method: "GET", pattern: /^\/contributions$/, handler: () => [200, [...store.contributions.values()]] },

    { method: "POST", pattern: /^\/achievements$/, handler: ({ body }) => [201, createAchievement(store, body)] },
    { method: "GET", pattern: /^\/achievements$/, handler: () => [200, [...store.achievements.values()]] },
    {
      method: "GET",
      pattern: /^\/achievements\/(?<id>[^/]+)$/,
      handler: ({ params }) => {
        const achievement = store.achievements.get(decodeURIComponent(params.id));
        if (!achievement) throw new DomainError(404, "achievement-not-found", `阶段成果未登记：${params.id}`);
        return [200, achievement];
      },
    },
    {
      method: "GET",
      pattern: /^\/achievements\/(?<id>[^/]+)\/lineage$/,
      handler: ({ params }) => [200, achievementLineage(store, decodeURIComponent(params.id))],
    },
    {
      method: "POST",
      pattern: /^\/achievements\/(?<id>[^/]+)\/claims$/,
      handler: ({ params, body }) => [201, claimOwnership(store, decodeURIComponent(params.id), body)],
    },
    {
      method: "POST",
      pattern: /^\/achievements\/(?<id>[^/]+)\/objections$/,
      handler: ({ params, body }) => [201, raiseObjection(store, decodeURIComponent(params.id), body)],
    },
    {
      method: "POST",
      pattern: /^\/achievements\/(?<id>[^/]+)\/resolve$/,
      handler: ({ params, body }) => [200, resolveDispute(store, decodeURIComponent(params.id), body)],
    },
    {
      method: "POST",
      pattern: /^\/achievements\/(?<id>[^/]+)\/publish$/,
      handler: ({ params, body }) => [201, publishAchievement(store, decodeURIComponent(params.id), body)],
    },

    { method: "GET", pattern: /^\/audit$/, handler: ({ query }) => [200, listAudit(store, Object.fromEntries(query))] },
  ];

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        const body = request.method === "POST" ? await readJson(request) : {};
        const [status, payload] = route.handler({ body, params: match.groups ?? {}, query: url.searchParams });
        send(response, status, payload);
        return;
      }
      send(response, 404, { error: { code: "not-found", message: "接口不存在" } });
    } catch (error) {
      if (error instanceof DomainError) {
        send(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        send(response, 500, { error: { code: "internal", message: "服务内部错误" } });
      }
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createServer().listen(port, "127.0.0.1");
}
