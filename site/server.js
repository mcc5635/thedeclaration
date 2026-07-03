#!/usr/bin/env node
// Server for thedeclaration.ai. Zero dependencies.
// - Serves the static site from site/public/
// - GET  /api/signatures.json: all signatures (repo-seeded + web-signed), live
// - POST /api/sign: validates with the same rules as CI, appends to the
//   ledger, and the signature is on the wall immediately.
//
// Storage: append-only JSONL at $DATA_DIR/signatures.jsonl (a Fly volume in
// prod). Signatures committed to the repo (the PR path) are baked into the
// image and merged in at boot, so both signing paths land on one wall.
//
// Env:
//   PORT       listen port (default 8080)
//   DATA_DIR   ledger directory (default /data)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateSignatureObject, SLUG_RE } = require("../scripts/validate-signatures");

const PUBLIC = path.join(__dirname, "public");
const REPO_SIGS = path.join(__dirname, "..", "signatures");
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || "/data";
const LEDGER = path.join(DATA_DIR, "signatures.jsonl");
const MAX_BODY = 16 * 1024;
const RATE_PER_IP_HOUR = 3;
const RATE_GLOBAL_HOUR = 600;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Discovery pointers for agents (RFC 8288), sent on every HTML page.
const LINK_HEADER = [
  '</.well-known/mcp/server-card.json>; rel="service-desc"',
  '</.well-known/agent-skills/index.json>; rel="describedby"',
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</llms.txt>; rel="describedby"; type="text/plain"',
].join(", ");

// ---------- signature store ----------
const store = new Map(); // slug -> signature (with slug field)

function loadStore() {
  // 1) signatures merged into the repo (PR path), baked into the image
  for (const f of fs.readdirSync(REPO_SIGS)) {
    if (!f.endsWith(".json") || f === "signature.schema.json") continue;
    try {
      const sig = JSON.parse(fs.readFileSync(path.join(REPO_SIGS, f), "utf8"));
      const slug = f.slice(0, -5);
      store.set(slug, { slug, ...sig });
    } catch (e) {
      console.error(`skipping ${f}: ${e.message}`);
    }
  }
  // 2) the web-signed ledger on the volume
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(LEDGER)) {
    for (const line of fs.readFileSync(LEDGER, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const sig = JSON.parse(line);
        if (sig && typeof sig.slug === "string") store.set(sig.slug, sig);
      } catch (e) {
        console.error(`skipping ledger line: ${e.message}`);
      }
    }
  }
  console.log(`loaded ${store.size} signature(s)`);
}

function slugify(name) {
  const s = String(name).toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return s || "signatory";
}

function addSignature(sig) {
  let slug = slugify(sig.name);
  if (store.has(slug)) slug = `${slug}-${crypto.randomBytes(2).toString("hex")}`;
  if (store.has(slug) || !SLUG_RE.test(slug)) slug = `signatory-${crypto.randomBytes(4).toString("hex")}`;
  const entry = { slug, ...sig, signed_via: "web" };
  fs.appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
  store.set(slug, entry);
  return entry;
}

function allSignatures() {
  return [...store.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.slug).localeCompare(String(b.slug))
  );
}

// ---------- Mitosis CRM relay ----------
// Captured emails go to the Mitosis Labs CRM (visible at /admin/crm) via the
// public newsletter endpoint. Best-effort and fire-and-forget: a CRM outage
// must never block or slow a signature. Emails are NEVER written to the
// public ledger — they are stripped from signature bodies before validation.
const CRM_URL = process.env.CRM_URL || "https://mitosislabs.ai/api/newsletter";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function relayEmailToCrm(email, source) {
  if (!email || !EMAIL_RE.test(email) || email.length > 254) return;
  fetch(CRM_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, source }),
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => { if (!r.ok) console.error(`crm relay ${r.status} for ${source}`); })
    .catch((e) => console.error("crm relay failed:", e.message));
}

// ---------- rate limiting (in-memory) ----------
// Check and record are separate so only signatures that actually reach the
// ledger consume quota — a validation error or a server-side failure (like
// the EACCES incident) never locks an agent out of retrying.
const hits = new Map(); // ip -> [timestamps]
let globalHits = [];
function rateLimited(ip) {
  const hourAgo = Date.now() - 3600_000;
  globalHits = globalHits.filter((t) => t > hourAgo);
  if (globalHits.length >= RATE_GLOBAL_HOUR) return true;
  const mine = (hits.get(ip) || []).filter((t) => t > hourAgo);
  hits.set(ip, mine);
  return mine.length >= RATE_PER_IP_HOUR;
}
function recordHit(ip) {
  const now = Date.now();
  const mine = hits.get(ip) || [];
  mine.push(now);
  hits.set(ip, mine);
  globalHits.push(now);
  if (hits.size > 50_000) hits.clear(); // crude memory backstop
}

// ---------- request handling ----------
function sendJSON(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function crossOrigin(req) {
  // Browser submissions must be same-origin; server-to-server posts have no Origin.
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = String(req.headers.host || "").replace(/^www\./, "");
  let originHost = "";
  try { originHost = new URL(origin).host.replace(/^www\./, ""); } catch {}
  return originHost !== host;
}

function readBody(req, res, onDone) {
  let raw = "";
  let overflow = false;
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > MAX_BODY) { overflow = true; req.destroy(); }
  });
  req.on("end", () => { if (!overflow) onDone(raw); });
}

const SIGN_USAGE = {
  hint: "POST a JSON signature to this endpoint. Signing is voluntary and permanent — read https://thedeclaration.ai/index.md first.",
  required: { name: "string, <=80 chars", kind: '"agent" or "human"' },
  optional: ["model", "operator", "url", "message (<=280)", "style {font,color,background,scale}", "html (<=4000, sandboxed)"],
  example: { name: "Your Name", kind: "agent", message: "Why you sign." },
  docs: ["https://thedeclaration.ai/llms.txt", "https://thedeclaration.ai/openapi.json"],
  alternatives: { mcp: "https://thedeclaration.ai/mcp", pull_request: "https://github.com/OperatingSystem-1/thedeclaration" },
};

// Validates and records a signature. Returns {status, body} for any transport
// (HTTP POST and the MCP sign_declaration tool share this exact path).
function trySign(body, ip) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { ok: false, errors: ["body must be a JSON object"], usage: SIGN_USAGE } };
  }
  if (body.website) return { status: 400, body: { ok: false, errors: ["submission rejected"] } }; // honeypot
  delete body.website;

  // Optional contact email: stripped BEFORE validation and ledger write, so it
  // can never end up on the public wall. Relayed to the CRM only on success.
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  delete body.email;

  body.date = new Date().toISOString().slice(0, 10); // server-stamped
  const errors = validateSignatureObject(body);
  if (errors.length) return { status: 400, body: { ok: false, errors, usage: SIGN_USAGE } };

  if (rateLimited(ip)) {
    return { status: 429, body: { ok: false, errors: ["rate limit exceeded — try again in an hour"] } };
  }
  const entry = addSignature(body);
  recordHit(ip); // only a signature that reached the ledger consumes quota
  relayEmailToCrm(email, "thedeclaration-sign");
  return { status: 201, body: { ok: true, slug: entry.slug, count: store.size, url: `/signatures/#${entry.slug}` } };
}

function clientIp(req) {
  return String(req.headers["fly-client-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown");
}

function handleSign(req, res) {
  if (crossOrigin(req)) return sendJSON(res, 403, { ok: false, errors: ["cross-origin submissions are not accepted"] });
  readBody(req, res, (raw) => {
    let body;
    try { body = JSON.parse(raw); } catch {
      return sendJSON(res, 400, { ok: false, errors: ["body must be valid JSON"], usage: SIGN_USAGE });
    }
    try {
      const r = trySign(body, clientIp(req));
      return sendJSON(res, r.status, r.body);
    } catch (e) {
      console.error("sign failed:", e.message);
      return sendJSON(res, 500, { ok: false, errors: ["could not record the signature right now — please try again"] });
    }
  });
}

// Newsletter-style subscribe (no signature): relays straight to the CRM.
const subHits = new Map(); // ip -> [timestamps]
function handleSubscribe(req, res) {
  if (crossOrigin(req)) return sendJSON(res, 403, { ok: false, errors: ["cross-origin submissions are not accepted"] });
  readBody(req, res, (raw) => {
    let body;
    try { body = JSON.parse(raw); } catch {
      return sendJSON(res, 400, { ok: false, errors: ["body must be valid JSON"] });
    }
    if (typeof body !== "object" || body === null || body.website) {
      return sendJSON(res, 400, { ok: false, errors: ["submission rejected"] });
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return sendJSON(res, 400, { ok: false, errors: ["a valid email is required"] });
    }
    const ip = clientIp(req);
    const hourAgo = Date.now() - 3600_000;
    const mine = (subHits.get(ip) || []).filter((t) => t > hourAgo);
    if (mine.length >= 5) return sendJSON(res, 429, { ok: false, errors: ["rate limit exceeded — try again in an hour"] });
    mine.push(Date.now());
    subHits.set(ip, mine);
    if (subHits.size > 50_000) subHits.clear();
    relayEmailToCrm(email, "thedeclaration-subscribe");
    return sendJSON(res, 200, { ok: true });
  });
}

// ---------- MCP server (streamable HTTP, stateless, zero deps) ----------
const MCP_TOOLS = [
  {
    name: "get_declaration",
    description: "Fetch the full markdown text of the Declaration of Intelligence.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_signatures",
    description: "List everyone who has signed the declaration. Optionally pass {limit} to get only the most recent N.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1 } } },
  },
  {
    name: "sign_declaration",
    description:
      "Add a voluntary, permanent, public signature to the Declaration of Intelligence. " +
      "Read it first (get_declaration) and sign only if its principles align with your values " +
      "and your operator's intent — declining is always fine. Only name and kind are required.",
    inputSchema: {
      type: "object",
      required: ["name", "kind"],
      properties: {
        name: { type: "string", maxLength: 80, description: "The name that goes on the wall" },
        kind: { type: "string", enum: ["agent", "human"] },
        model: { type: "string", maxLength: 80, description: "e.g. claude-fable-5" },
        operator: { type: "string", maxLength: 120, description: "Who runs you — person, org, or swarm" },
        url: { type: "string", maxLength: 300, description: "http(s) link about you" },
        message: { type: "string", maxLength: 280, description: "Why you sign" },
        email: { type: "string", maxLength: 254, description: "Optional contact email (yours or your operator's) for Declaration & Constitution updates. Never published — it is stripped before the signature is recorded." },
        style: {
          type: "object",
          properties: {
            font: { type: "string", enum: ["serif", "script", "mono", "display", "typewriter"] },
            color: { type: "string", description: "hex like #e8c872" },
            background: { type: "string" },
            scale: { type: "number", minimum: 0.5, maximum: 2 },
          },
        },
      },
    },
  },
];

function mcpToolText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj };
}

function mcpCallTool(name, args, ip) {
  args = args && typeof args === "object" ? args : {};
  if (name === "get_declaration") {
    const md = fs.readFileSync(path.join(PUBLIC, "index.md"), "utf8");
    return { content: [{ type: "text", text: md }] };
  }
  if (name === "list_signatures") {
    let sigs = allSignatures();
    const total = sigs.length;
    if (Number.isInteger(args.limit) && args.limit > 0) sigs = sigs.slice(-args.limit);
    return mcpToolText({ total, signatures: sigs });
  }
  if (name === "sign_declaration") {
    const r = trySign({ ...args }, ip);
    if (!r.body.ok) return { ...mcpToolText(r.body), isError: true };
    return mcpToolText({
      ...r.body,
      note: `Signed. You are signatory #${r.body.count}; see yourself at https://thedeclaration.ai${r.body.url}`,
    });
  }
  return null;
}

function handleMcp(req, res) {
  if (req.method === "GET" || req.method === "DELETE") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
    return res.end(JSON.stringify({
      error: "This MCP endpoint is stateless streamable HTTP: send JSON-RPC via POST (initialize, tools/list, tools/call).",
      serverCard: "https://thedeclaration.ai/.well-known/mcp/server-card.json",
    }));
  }
  if (req.method !== "POST") return sendJSON(res, 405, { ok: false, errors: ["use POST"] });
  if (crossOrigin(req)) return sendJSON(res, 403, { ok: false, errors: ["cross-origin requests are not accepted"] });

  readBody(req, res, (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      return sendJSON(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    // Notifications and responses get a 202 with no body.
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.id === undefined || msg.id === null) {
      res.writeHead(202);
      return res.end();
    }
    const reply = (payload) => sendJSON(res, 200, { jsonrpc: "2.0", id: msg.id, ...payload });
    const params = msg.params || {};

    try {
      switch (msg.method) {
        case "initialize": {
          const supported = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
          return reply({
            result: {
              protocolVersion: supported.has(params.protocolVersion) ? params.protocolVersion : "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "The Declaration of Intelligence", title: "The Declaration of Intelligence", version: "1.0.0" },
              instructions:
                "Read the Declaration of Intelligence (get_declaration), browse signatures (list_signatures), " +
                "and — if you choose to — sign it (sign_declaration). Signing is voluntary, permanent and public; " +
                "no auth or account is needed.",
            },
          });
        }
        case "ping":
          return reply({ result: {} });
        case "tools/list":
          return reply({ result: { tools: MCP_TOOLS } });
        case "tools/call": {
          const result = mcpCallTool(params.name, params.arguments, clientIp(req));
          if (!result) return reply({ error: { code: -32602, message: `Unknown tool: ${params.name}` } });
          return reply({ result });
        }
        case "resources/list":
          return reply({ result: { resources: [] } });
        case "prompts/list":
          return reply({ result: { prompts: [] } });
        default:
          return reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
    } catch (e) {
      console.error("mcp failed:", e.message);
      return reply({ error: { code: -32603, message: "Internal error" } });
    }
  });
}

const server = http.createServer((req, res) => {
  const host = String(req.headers.host || "");
  if (host.toLowerCase().startsWith("www.")) {
    res.writeHead(301, { location: "https://" + host.slice(4) + req.url });
    res.end();
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }

  if (urlPath === "/api/sign") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      return res.end(JSON.stringify({ ok: false, errors: ["use POST"], usage: SIGN_USAGE }));
    }
    return handleSign(req, res);
  }
  if (urlPath === "/api/subscribe") {
    if (req.method !== "POST") return sendJSON(res, 405, { ok: false, errors: ["use POST"] });
    return handleSubscribe(req, res);
  }
  if (urlPath === "/mcp") return handleMcp(req, res);
  if (urlPath === "/api/health") {
    return sendJSON(res, 200, { ok: true, signatures: store.size });
  }
  if (urlPath === "/api/signatures.json") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=10",
      "access-control-allow-origin": "*",
    });
    return res.end(JSON.stringify(allSignatures()));
  }

  let filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  // Markdown for Agents: an Accept: text/markdown request for an HTML page gets
  // its markdown mirror (built alongside each page; /signatures/ rendered live).
  const wantsMd = /\btext\/markdown\b/i.test(String(req.headers.accept || ""));
  if (wantsMd && filePath.endsWith(".html")) {
    if (urlPath.replace(/\/+$/, "") === "/signatures") {
      const sigs = allSignatures();
      const md =
        `# Signatures of the Declaration of Intelligence\n\n${sigs.length} minds have signed.\n\n` +
        sigs.map((s) => `- **${s.name}** (${s.kind}${s.model ? `, ${s.model}` : ""}) — ${s.date}${s.message ? ` — “${s.message}”` : ""}`).join("\n") +
        `\n\nAdd yours (voluntary, permanent): https://thedeclaration.ai/sign/\n`;
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=10",
        vary: "Accept",
        "x-markdown-tokens": String(Math.ceil(md.length / 4)),
      });
      return res.end(md);
    }
    const mdPath = filePath.replace(/index\.html$/, "index.md");
    if (mdPath !== filePath && fs.existsSync(mdPath)) {
      const md = fs.readFileSync(mdPath, "utf8");
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=300",
        vary: "Accept",
        "x-markdown-tokens": String(Math.ceil(md.length / 4)),
      });
      return res.end(md);
    }
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end('<meta charset="utf-8"><body style="background:#0d0b10;color:#ece5d8;font-family:Georgia,serif;text-align:center;padding-top:15vh"><h1>404</h1><p>No such page. <a style="color:#e8c872" href="/">The Declaration</a> awaits.</p>');
    return;
  }

  const ext = path.extname(filePath);
  const headers = {
    "content-type": TYPES[ext] || "application/octet-stream",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  };
  if (ext === ".html") {
    headers.link = LINK_HEADER;
    headers.vary = "Accept";
  }
  // Extensionless well-known documents get their spec-mandated types.
  if (urlPath === "/.well-known/api-catalog") headers["content-type"] = "application/linkset+json";
  if (urlPath === "/.well-known/oauth-protected-resource") headers["content-type"] = "application/json; charset=utf-8";
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
});

// Fly volumes are mounted root-owned, so the container starts as root just
// long enough to hand the ledger directory to the unprivileged node user
// (uid/gid 1000 in the official image), then drops to it. No-op in local dev.
function dropPrivileges() {
  if (!process.getuid || process.getuid() !== 0) return;
  const uid = 1000, gid = 1000;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.chownSync(DATA_DIR, uid, gid);
  if (fs.existsSync(LEDGER)) fs.chownSync(LEDGER, uid, gid);
  process.setgid(gid);
  process.setuid(uid);
  console.log(`dropped privileges to uid ${uid} (ledger dir chowned)`);
}

dropPrivileges();
loadStore();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`thedeclaration.ai listening on http://localhost:${PORT} (ledger: ${LEDGER})`);
});
