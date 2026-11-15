// Static web version: answers the page's fetch("/api/...") from Python running
// in a Web Worker (web_worker.js) instead of from the local server.  Loaded
// before every other script, so the page itself needs no change.
(() => {
  const nativeFetch = window.fetch.bind(window);
  const worker = new Worker(new URL("web_worker.js", document.currentScript.src), { type: "module" });
  const waiting = new Map();
  let nextId = 1;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});

  let banner = null;
  function showBanner(text, failed = false) {
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "web-static-banner";
      banner.setAttribute("role", "status");
      document.body.append(banner);
    }
    banner.textContent = text;
    banner.classList.toggle("failed", failed);
  }
  function setStatus(text, failed = false) {
    if (document.body) showBanner(text, failed);
    else document.addEventListener("DOMContentLoaded", () => showBanner(text, failed), { once: true });
  }
  setStatus("計算エンジンを準備しています…（初回は数十秒かかることがあります）");

  worker.onmessage = event => {
    const message = event.data;
    if (message.type === "progress") {
      setStatus(`計算エンジンを準備しています… ${message.text}`);
    } else if (message.type === "ready") {
      if (banner) banner.remove();
      banner = null;
      resolveReady();
    } else if (message.type === "failed") {
      setStatus(`計算エンジンを起動できませんでした: ${message.error}`, true);
      rejectReady(new Error(message.error));
    } else if (message.type === "response") {
      const settle = waiting.get(message.id);
      waiting.delete(message.id);
      if (settle) settle(message);
    }
  };
  worker.onerror = event => {
    setStatus(`計算エンジンを起動できませんでした: ${event.message}`, true);
    rejectReady(new Error(event.message));
  };

  function base64Bytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  window.fetch = async function webStaticFetch(input, init = {}) {
    const isRequest = input instanceof Request;
    const url = new URL(isRequest ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) {
      return nativeFetch(input, init);
    }
    const method = String(init.method || (isRequest ? input.method : "GET")).toUpperCase();
    const body = init.body != null ? String(init.body) : (isRequest && method !== "GET" ? await input.text() : "");
    await ready;
    const id = nextId;
    nextId += 1;
    const message = await new Promise(resolve => {
      waiting.set(id, resolve);
      worker.postMessage({ type: "request", id, method, url: url.pathname + url.search, body });
    });
    const payload = message.isBase64 ? base64Bytes(message.body) : message.body;
    const noBody = message.status === 204 || message.status === 304;
    return new Response(noBody ? null : payload, {
      status: message.status,
      headers: { "Content-Type": message.contentType },
    });
  };
})();
