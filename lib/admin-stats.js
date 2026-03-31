// ============================================================
// SENTINEL — /admin/stats Endpoint
// Protected by SENTINEL_ADMIN_KEY. Returns usage analytics
// from the request_log table.
// ============================================================

import { Router } from "express";
import { getStats, isDbReady } from "./db.js";

/**
 * Creates the admin router with auth middleware.
 * @param {string} adminKey - The SENTINEL_ADMIN_KEY env var value
 * @returns {Router} Express router mountable at /admin
 */
export function createAdminRouter(adminKey) {
  const router = Router();

  // Auth middleware — every /admin/* route requires Bearer token
  router.use((req, res, next) => {
    if (!adminKey) {
      return res.status(503).json({ error: "Admin endpoint not configured — set SENTINEL_ADMIN_KEY" });
    }

    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${adminKey}`) {
      return res.status(401).json({ error: "Unauthorized — provide Authorization: Bearer <SENTINEL_ADMIN_KEY>" });
    }

    next();
  });

  // GET /admin/stats — usage analytics
  router.get("/stats", async (_req, res) => {
    if (!isDbReady()) {
      return res.status(503).json({ error: "Database not available — request logging is disabled" });
    }

    try {
      const stats = await getStats();
      if (!stats) {
        return res.status(503).json({ error: "Could not retrieve stats" });
      }
      res.json(stats);
    } catch (e) {
      res.status(500).json({ error: "Failed to load stats" });
    }
  });

  return router;
}
