/**
 * 牧场面板路由
 *
 * 与 admin-farm-resource-routes.js 同样的形状：只做鉴权 + 转发，
 * 业务逻辑在 worker 里（services/pasture-*）。
 *
 * 读：
 *   GET  /api/pasture                牧场状态（动物/货架/灾害/草量/空栏）
 *   GET  /api/pasture/animals        牧场动物清单（补栏优先动物下拉用）
 *   GET  /api/pasture/animal-stats   动物档案（经验/时、收入/时）
 *   GET  /api/pasture/tasks          牧场任务（taskpb scene_id=2，task_type 4/5/6）
 *   GET  /api/pasture/ledger         待核对操作（结果未知的写操作）
 *
 * 写：
 *   POST /api/pasture/operate        手动触发一轮自动化（all / harvest / feed / ...）
 *   POST /api/pasture/tasks/claim    立即领取所有可领的牧场任务
 *   POST /api/pasture/:action/quote  两段式第一段：报价（不产生副作用）
 *   POST /api/pasture/:action        两段式第二段：带 expected.signature 执行
 *
 * :action 必须最后注册，否则会截获上面的固定路径。
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
  const withAccount = (handler) => async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;
    try {
      await handler(accountId, req, res);
    }
    catch (error) {
      sendProviderError(res, error);
    }
  };

  app.get("/api/pasture", withAccount(async (accountId, req, res) => {
    res.json({ ok: true, data: await provider.getPasture(accountId) });
  }));

  app.get("/api/pasture/animals", withAccount(async (accountId, req, res) => {
    res.json({ ok: true, data: await provider.listPastureAnimals(accountId) });
  }));

  // 动物档案：真实养殖数据反推出的经验/时、收入/时
  app.get("/api/pasture/animal-stats", withAccount(async (accountId, req, res) => {
    res.json({ ok: true, data: await provider.getPastureAnimalStats(accountId) });
  }));

  app.get("/api/pasture/tasks", withAccount(async (accountId, req, res) => {
    res.json({ ok: true, data: await provider.getPastureTasks(accountId) });
  }));

  // 待核对操作：结果未知的写操作必须先人工确认，才允许同目标再次提交
  app.get("/api/pasture/ledger", withAccount(async (accountId, req, res) => {
    res.json({ ok: true, data: await provider.getPastureLedger(accountId) });
  }));

  app.post("/api/pasture/tasks/claim", withAccount(async (accountId, req, res) => {
    res.json({ ok: true, data: await provider.claimPastureTasks(accountId) });
  }));

  // 自动化轮次（读全量状态 → 按开关做一串动作）
  app.post("/api/pasture/operate", withAccount(async (accountId, req, res) => {
    const opType = String((req.body && req.body.op) || "all");
    if (!PASTURE_OPS.has(opType)) {
      res.status(400).json({ ok: false, error: `不支持的操作类型: ${opType}` });
      return;
    }
    res.json({ ok: true, data: await provider.doPastureOp(accountId, opType) });
  }));

  // 两段式第一段：报价，不产生副作用
  app.post("/api/pasture/:action/quote", withAccount(async (accountId, req, res) => {
    const data = await provider.planPastureAction(accountId, String(req.params.action), req.body || {});
    res.json({ ok: true, data });
  }));

  // 两段式第二段：执行。必须放最后，避免截获上面的固定路径。
  app.post("/api/pasture/:action", withAccount(async (accountId, req, res) => {
    const action = String(req.params.action);
    if (action === "operate" || action === "ledger") {
      res.status(404).json({ ok: false, error: `未知牧场接口: ${action}` });
      return;
    }
    const data = await provider.operatePastureAction(accountId, action, req.body || {});
    res.json({ ok: true, data });
  }));
}

module.exports = { registerAdminPastureRoutes, PASTURE_OPS };