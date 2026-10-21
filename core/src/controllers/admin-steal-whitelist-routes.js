function getAccountOrRespond(req, res, { getAccountIdFromRequest, canAccessAccount }) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json({ ok: false, error: "Missing accountId" });
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }
  return accountId;
}

/**
 * 偷菜白名单：空数组表示不限制（保持原有全偷行为），
 * 非空时只偷列表内 seedId 对应的作物。
 */
function registerAdminStealWhitelistRoutes({
  app,
  provider,
  store,
  requireAdminToken,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  const access = { getAccountIdFromRequest, canAccessAccount };

  function read(accountId) {
    return store.getStealWhitelist ? store.getStealWhitelist(accountId) : [];
  }

  app.get("/api/steal-whitelist", requireAdminToken, (req, res) => {
    try {
      const accountId = getAccountOrRespond(req, res, access);
      if (!accountId) return;

      res.json({ ok: true, data: read(accountId) });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.put("/api/steal-whitelist", requireAdminToken, (req, res) => {
    try {
      const accountId = getAccountOrRespond(req, res, access);
      if (!accountId) return;

      const seedIds = Array.isArray(req.body && req.body.seedIds) ? req.body.seedIds : [];
      if (store.setStealWhitelist) store.setStealWhitelist(accountId, seedIds);
      if (provider && typeof provider.broadcastConfig === "function") {
        provider.broadcastConfig(accountId);
      }

      res.json({ ok: true, data: read(accountId) });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminStealWhitelistRoutes };
