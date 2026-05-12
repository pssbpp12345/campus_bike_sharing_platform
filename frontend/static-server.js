// Static file server for non-/api routes on port 3000.
// Forwards /api/* to the Node Express backend on port 8001 (via Python proxy).
const path = require("path");
const express = require("express");
const http = require("http");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(__dirname, "..");
const BACKEND_PORT = 8001;

const app = express();

// Proxy /api/* to the backend
app.use("/api", (req, res) => {
  const options = {
    hostname: "127.0.0.1",
    port: BACKEND_PORT,
    path: "/api" + req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` },
  };
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (e) => {
    res.status(502).json({ error: "Backend unavailable: " + e.message });
  });
  req.pipe(proxyReq);
});

app.use(express.static(ROOT, { extensions: ["html"] }));

app.get("*", (_req, res) => res.sendFile(path.join(ROOT, "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Static server running on http://0.0.0.0:${PORT}/  serving ${ROOT}`);
});
