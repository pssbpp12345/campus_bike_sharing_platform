const express = require("express");
const settingsService = require("../services/settingsService");

const router = express.Router();

router.get("/public", async (_req, res) => {
  try {
    const settings = await settingsService.getPublicSettings();
    res.json(settings);
  } catch (err) {
    console.error("[GET /api/settings/public]", err);
    res.status(500).json({ error: "Could not load public platform settings." });
  }
});

module.exports = router;
