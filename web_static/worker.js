// Runs the viewer's Python (tools/view_json_server.py's request handler) in
// Pyodide, off the page's main thread.  web_bridge.js sends it the page's
// /api/... requests one message at a time; see web_static/backend.py.
import { loadPyodide } from "../pyodide/pyodide.mjs";

const PACKAGES = ["numpy", "pillow"];
const queue = [];
let backend = null;
let running = false;

function progress(text) {
  postMessage({ type: "progress", text });
}

async function start() {
  progress("Python を読み込んでいます…");
  const pyodide = await loadPyodide({ indexURL: new URL("../pyodide/", import.meta.url).href });
  progress("numpy を読み込んでいます…");
  await pyodide.loadPackage(PACKAGES);
  progress("ビューアーを準備しています…");
  const response = await fetch(new URL("../app.zip", import.meta.url));
  if (!response.ok) throw new Error(`app.zip: ${response.status} ${response.statusText}`);
  pyodide.unpackArchive(await response.arrayBuffer(), "zip", { extractDir: "/app" });
  backend = pyodide.runPython(`
import sys
sys.path.insert(0, "/app")
import backend
backend.init("/app")
backend
`);
  postMessage({ type: "ready" });
  pump();
}

function answer(request) {
  let result = null;
  try {
    result = backend.handle_for_js(request.method, request.url, request.body);
    const [status, contentType, body, isBase64] = result.toJs();
    return { status, contentType, body, isBase64 };
  } catch (error) {
    const body = JSON.stringify({ ok: false, error: `web version error: ${error.message}` });
    return { status: 500, contentType: "application/json", body, isBase64: false };
  } finally {
    if (result) result.destroy();
  }
}

function pump() {
  if (!backend || running) return;
  running = true;
  try {
    while (queue.length) {
      const request = queue.shift();
      postMessage({ type: "response", id: request.id, ...answer(request) });
      // Work the server would have left to a background thread (operation
      // summaries); run it once nothing is waiting.
      if (!queue.length && backend.has_pending()) {
        try {
          backend.run_pending();
        } catch (error) {
          console.error("deferred work failed", error);
        }
      }
    }
  } finally {
    running = false;
  }
}

onmessage = event => {
  if (event.data && event.data.type === "request") {
    queue.push(event.data);
    pump();
  }
};

start().catch(error => {
  console.error(error);
  postMessage({ type: "failed", error: String(error && error.message || error) });
});
