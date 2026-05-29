const express = require("express");
const jwt = require("jsonwebtoken");
const {
  listAdminRefundRequests,
  getAdminRefundRequest,
  approveRefundRequest,
  rejectRefundRequest,
  ensureRefundSchema,
} = require("../utils/refundRequests");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";

function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Admin login required." });
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
    req.user = payload;
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid or expired admin session." });
  }
}

router.get("/", requireAdmin, async (req, res) => {
  try {
    await ensureRefundSchema();
    const requests = await listAdminRefundRequests(String(req.query.status || "").trim());
    res.json({
      success: true,
      pendingCount: requests.filter((r) => r.status === "pending_review").length,
      refundRequests: requests,
    });
  } catch (err) {
    console.error("[GET /api/admin/refund-requests]", err.message);
    res.status(500).json({ error: "Could not load refund requests." });
  }
});

router.get("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid refund request id." });
    const request = await getAdminRefundRequest(id);
    if (!request) return res.status(404).json({ error: "Refund request not found." });
    res.json({ success: true, refundRequest: request });
  } catch (err) {
    console.error("[GET /api/admin/refund-requests/:id]", err.message);
    res.status(500).json({ error: "Could not load refund request." });
  }
});

router.post("/:id/approve", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid refund request id." });
    const approvedAmount = req.body?.approved_refund_amount ?? req.body?.approvedRefundAmount;
    const result = await approveRefundRequest({
      id,
      adminId: req.user.sub,
      approvedAmount,
      adminNote: req.body?.admin_note || req.body?.adminNote || "",
    });
    res.json({
      success: true,
      status: result.status,
      stripeRefundId: result.stripeRefundId || null,
      message: result.status === "refunded"
        ? "Refund approved and processed."
        : "Refund approved for manual processing.",
    });
  } catch (err) {
    console.error("[POST /api/admin/refund-requests/:id/approve]", err.message);
    res.status(err.status || 400).json({ error: err.message || "Could not approve refund request." });
  }
});

router.post("/:id/reject", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid refund request id." });
    await rejectRefundRequest({
      id,
      adminId: req.user.sub,
      adminNote: req.body?.admin_note || req.body?.adminNote || "",
    });
    res.json({ success: true, message: "Refund request rejected." });
  } catch (err) {
    console.error("[POST /api/admin/refund-requests/:id/reject]", err.message);
    res.status(err.status || 400).json({ error: err.message || "Could not reject refund request." });
  }
});

module.exports = router;
