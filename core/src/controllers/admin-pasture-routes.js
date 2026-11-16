/**
 * 牧场面板路由
 *
 * 与 admin-farm-resource-routes.js 同样的形状：只做鉴权 + 转发，
 * 业务逻辑在 worker 里（services/pasture-*）。
 *
 * GET  /api/pasture          牧场状态（动物/货架/灾害/草量/空栏）
 * GET  /api/pasture/animals  牧场动物清单（补栏优先动物下拉用）
 * GET  /api/pasture/tasks    牧场任务（taskpb scene_id=2，task_type 4/5/6）
 * POST /api/pasture/operate  手动触发一轮操作（all / harvest / feed / clean / refill / grass）
 * POST /api/pasture/tasks/claim  立即领取所有可领的牧场任务
 */

function sendMissingAccount(res, statusCode = 400) {
  const payload = { ok: false, error: "Missing x-account-id" };
  return statusCode ? res.status(statusCode).json(payload) : res.json(payload);
}

function requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount, missingStatusCode = 400) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    sendMissingAccount(res, missingStatusCode);
    return null;
  }

  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }

  return accountId;
}

/** 面板允许手动触发的操作类型 */
const PASTURE_OPS = new Set(["all", "harvest", "feed", "clean", "stroke", "refill", "grass"]);

function registerAdminPastureRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.get("/api/pasture", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      const data = await provider.getPasture(accountId);
      res.json({ ok: true, data });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/pasture/animals", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      res.json({ ok: true, data: await provider.listPastureAnimals(accountId) });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/pasture/tasks", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      res.json({ ok: true, data: await provider.getPastureTasks(accountId) });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/pasture/tasks/claim", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      res.json({ ok: true, data: await provider.claimPastureTasks(accountId) });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/pasture/operate", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    const opType = String((req.body && req.body.op) || "all");
    if (!PASTURE_OPS.has(opType)) {
      res.status(400).json({ ok: false, error: `不支持的操作类型: ${opType}` });
      return;
    }

    try {
      const result = await provider.doPastureOp(accountId, opType);
      res.json({ ok: true, data: result });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminPastureRoutes, PASTURE_OPS };