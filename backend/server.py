"""
ASGI wrapper that boots the Node.js Express backend as a subprocess
(on internal port 5050) and proxies every request to it.

Supervisor manages this Python process via uvicorn; the Node app is a child.
"""
import os
import asyncio
import subprocess
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

NODE_PORT = int(os.environ.get("NODE_PORT", "5050"))
NODE_URL = f"http://127.0.0.1:{NODE_PORT}"

node_proc: subprocess.Popen | None = None


async def _wait_node_ready(timeout: float = 30.0) -> bool:
    """Poll the Node /api/health endpoint until ready or timeout."""
    deadline = asyncio.get_event_loop().time() + timeout
    async with httpx.AsyncClient(timeout=2.0) as client:
        while asyncio.get_event_loop().time() < deadline:
            try:
                r = await client.get(f"{NODE_URL}/api/health")
                if r.status_code < 500:
                    return True
            except Exception:
                pass
            await asyncio.sleep(0.4)
    return False


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global node_proc
    env = os.environ.copy()
    env["PORT"] = str(NODE_PORT)
    node_proc = subprocess.Popen(
        ["node", "server.js"],
        cwd="/app/backend",
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    await _wait_node_ready()
    try:
        yield
    finally:
        if node_proc and node_proc.poll() is None:
            node_proc.terminate()
            try:
                node_proc.wait(timeout=5)
            except Exception:
                node_proc.kill()


app = FastAPI(lifespan=lifespan)
_client = httpx.AsyncClient(base_url=NODE_URL, timeout=60.0)


@app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def proxy(full_path: str, request: Request):
    url = f"/{full_path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    headers = {k: v for k, v in request.headers.items() if k.lower() not in ("host", "content-length")}
    body = await request.body()
    try:
        upstream = await _client.request(request.method, url, content=body, headers=headers)
    except httpx.RequestError as e:
        return Response(content=f"Upstream Node error: {e}", status_code=502)
    resp_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in ("content-encoding", "transfer-encoding", "content-length", "connection")}
    return Response(content=upstream.content, status_code=upstream.status_code, headers=resp_headers)
