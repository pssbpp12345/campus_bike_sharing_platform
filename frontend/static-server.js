// Static file server for the deployed frontend.
// Visible HTML stays on the frontend service; /api/* is proxied only in local dev.
const path = require("path");
const express = require("express");
const http = require("http");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(__dirname, "..");
const FRONTEND_ROOT = __dirname;
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || "https://campus-bike-sharing-backend.onrender.com";

const app = express();

// Proxy /api/* to the backend
app.use("/api", (req, res) => {
  const backend = new URL(BACKEND_ORIGIN);
  const options = {
    protocol: backend.protocol,
    hostname: backend.hostname,
    port: backend.port || undefined,
    path: "/api" + req.url,
    method: req.method,
    headers: { ...req.headers, host: backend.host },
  };
  const client = backend.protocol === "https:" ? require("https") : http;
  const proxyReq = client.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (e) => {
    res.status(502).json({ error: "Backend unavailable: " + e.message });
  });
  req.pipe(proxyReq);
});

// Render serves the public app from this frontend service. Keep the clean
// deployment URLs (/Admin/..., /User/...) while still serving the root marketing
// pages such as /login.html from the repository root.
app.use("/Admin", express.static(path.join(FRONTEND_ROOT, "Admin"), { extensions: ["html"] }));
app.use("/User", express.static(path.join(FRONTEND_ROOT, "User"), { extensions: ["html"] }));
app.use("/Student", express.static(path.join(FRONTEND_ROOT, "Student"), { extensions: ["html"] }));
app.use("/Staff", express.static(path.join(FRONTEND_ROOT, "Staff"), { extensions: ["html"] }));
app.use(express.static(ROOT, { extensions: ["html"] }));

app.get("*", (_req, res) => res.sendFile(path.join(ROOT, "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Static server running on http://0.0.0.0:${PORT}/  serving ${ROOT}`);
});
