import express from "express";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from "@whiskeysockets/baileys";

const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth";
const QUEUE_API_URL = process.env.QUEUE_API_URL;
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const ADMIN_API_URL = process.env.ADMIN_API_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || WORKER_TOKEN;
const DASHBOARD_USER = process.env.DASHBOARD_USER || "rios";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const POLL_MS = Number(process.env.POLL_MS || 4000);

if (!QUEUE_API_URL || !WORKER_TOKEN) throw new Error("QUEUE_API_URL e WORKER_TOKEN são obrigatórios");
if (!ADMIN_API_URL || !ADMIN_TOKEN || !DASHBOARD_PASSWORD) throw new Error("Configuração do dashboard ausente");

const app = express();
app.use(express.json({ limit: "1mb" }));

let socket = null;
let qrDataUrl = null;
let waStatus = "starting";
let waPhone = null;
let reconnectTimer = null;
let processing = false;
const deliveredMessageIds = new Set();

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Rios Dashboard"');
    return res.status(401).send("Autenticação necessária");
  }
  const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
  const p = raw.indexOf(":");
  const user = p >= 0 ? raw.slice(0, p) : "";
  const pass = p >= 0 ? raw.slice(p + 1) : "";
  if (user !== DASHBOARD_USER || pass !== DASHBOARD_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Rios Dashboard"');
    return res.status(401).send("Usuário ou senha inválidos");
  }
  next();
}

async function queueApi(path, options = {}) {
  const res = await fetch(QUEUE_API_URL + path, {
    ...options,
    headers: { "content-type": "application/json", "x-worker-token": WORKER_TOKEN, ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error("Queue API " + res.status + ": " + await res.text());
  return res.json();
}

async function adminApi(path, options = {}) {
  const res = await fetch(ADMIN_API_URL + path, {
    ...options,
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN, ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error("Admin API " + res.status + ": " + await res.text());
  return res.json();
}

async function reportState(extra = {}) {
  try {
    await queueApi("/state", { method: "POST", body: JSON.stringify({ status: waStatus, phone: waPhone, ...extra }) });
  } catch (e) {
    console.error("Falha ao atualizar estado:", e.message);
  }
}

async function connectWhatsApp() {
  clearTimeout(reconnectTimer);
  const authState = await useMultiFileAuthState(AUTH_DIR);
  const versionInfo = await fetchLatestBaileysVersion();
  waStatus = "connecting";
  await reportState();

  socket = makeWASocket({
    version: versionInfo.version,
    auth: authState.state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Kirvano Automation", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  socket.ev.on("creds.update", authState.saveCreds);

  socket.ev.on("messages.update", async (updates) => {
    for (const item of updates || []) {
      const messageId = item?.key?.id;
      const status = Number(item?.update?.status ?? 0);
      if (!messageId || status < 3) continue;

      deliveredMessageIds.add(messageId);

      try {
        await queueApi("/delivery-by-message-id", {
          method: "POST",
          body: JSON.stringify({ message_id: messageId })
        });
        console.log("Mensagem entregue:", messageId);
      } catch (e) {
        console.error("Falha ao confirmar entrega:", e.message);
      }
    }
  });

  socket.ev.on("connection.update", async (update) => {
    const connection = update.connection;
    const lastDisconnect = update.lastDisconnect;
    const qr = update.qr;

    if (qr) {
      qrDataUrl = await QRCode.toDataURL(qr, { width: 360, margin: 2 });
      waStatus = "qr_ready";
      await reportState();
      console.log("QR Code atualizado.");
    }

    if (connection === "open") {
      qrDataUrl = null;
      waStatus = "connected";
      waPhone = socket.user?.id?.split(":")[0] || socket.user?.id?.split("@")[0] || null;
      await reportState({ last_error: null });
      console.log("WhatsApp conectado:", waPhone || "número detectado");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      waStatus = loggedOut ? "disconnected" : "connecting";
      await reportState({ last_error: loggedOut ? "Sessão desconectada. Escaneie um novo QR." : "Conexão caiu; reconectando." });
      if (!loggedOut) reconnectTimer = setTimeout(connectWhatsApp, 3000);
      else qrDataUrl = null;
    }
  });
}

async function processQueue() {
  if (processing || waStatus !== "connected" || !socket) return;
  processing = true;
  let item = null;
  try {
    const result = await queueApi("/next");
    item = result.message || null;
    if (!item) return;
    const phone = String(item.phone || "").replace(/\D/g, "");
    if (!phone) throw new Error("Telefone inválido");
    const jid = phone + "@s.whatsapp.net";
    const exists = await socket.onWhatsApp(jid);
    if (!exists?.[0]?.exists) throw new Error("Número não encontrado no WhatsApp");

    const resolvedJid = exists[0].jid || jid;
    const sent = await socket.sendMessage(resolvedJid, { text: item.message });
    const messageId = sent?.key?.id;
    if (!messageId) throw new Error("WhatsApp não retornou ID da mensagem");

    await queueApi("/ack", {
      method: "POST",
      body: JSON.stringify({
        id: item.id,
        status: "accepted",
        message_id: messageId,
        jid: resolvedJid
      })
    });

    if (deliveredMessageIds.has(messageId)) {
      await queueApi("/delivery-by-message-id", {
        method: "POST",
        body: JSON.stringify({ message_id: messageId })
      });
    }

    console.log("Mensagem aceita pelo WhatsApp:", item.id, phone, messageId);
  } catch (e) {
    console.error("Erro no processamento:", e.message);
    if (item?.id) {
      try {
        await queueApi("/ack", { method: "POST", body: JSON.stringify({ id: item.id, status: "failed", error: String(e.message || e) }) });
      } catch {}
    }
  } finally {
    processing = false;
  }
}

function qrPage() {
  var body = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp Kirvano</title>';
  body += '<style>body{font-family:Arial,sans-serif;background:#0b0b0b;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#171717;padding:28px;border-radius:18px;max-width:460px;width:calc(100% - 40px);text-align:center}img{max-width:100%;border-radius:12px;background:#fff}.ok{color:#22c55e}.warn{color:#f59e0b}a{color:#fff}small{color:#aaa}</style></head><body><div class="card">';
  body += '<h1>WhatsApp Kirvano</h1><p>Status: <strong class="' + (waStatus === "connected" ? "ok" : "warn") + '">' + waStatus + '</strong></p>';
  if (waPhone) body += '<p>Número: ' + waPhone + '</p>';
  if (qrDataUrl) body += '<img src="' + qrDataUrl + '" alt="QR Code"><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p>';
  else if (waStatus === "connected") body += '<p>Conectado e pronto para enviar.</p>';
  else body += '<p>Aguardando QR Code...</p>';
  body += '<p><a href="/dashboard">Abrir dashboard</a></p><small>A página atualiza a cada 8 segundos.</small></div><script>setTimeout(function(){location.reload()},8000)</script></body></html>';
  return body;
}

const dashboardHtml = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rios Dashboard</title>' +
'<style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#0b0b0d;color:#f5f5f5}.wrap{max-width:1280px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}h1{font-size:25px;margin:0}.muted{color:#9ca3af}.status{padding:7px 10px;border-radius:999px;background:#162319;color:#86efac;font-size:13px}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px}.card{background:#151518;border:1px solid #26262b;border-radius:16px;padding:18px}.num{font-size:28px;font-weight:700;margin-top:7px}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.tab{border:1px solid #2c2c31;background:#17171a;color:#ddd;border-radius:10px;padding:10px 14px;cursor:pointer}.tab.active{background:#fff;color:#111}.panel{display:none}.panel.active{display:block}table{width:100%;border-collapse:collapse;background:#151518}th,td{text-align:left;padding:12px;border-bottom:1px solid #26262b;font-size:13px;vertical-align:top}th{color:#aaa}.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#232329}.sent{color:#86efac}.failed{color:#fca5a5}.queued{color:#fde68a}.template{background:#151518;border:1px solid #26262b;border-radius:16px;padding:18px;margin-bottom:12px}textarea{width:100%;min-height:150px;background:#0f0f11;color:#fff;border:1px solid #303038;border-radius:10px;padding:12px}.save{margin-top:10px;background:#22c55e;border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}.small{font-size:12px;color:#999}.scroll{overflow:auto}@media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}.wrap{padding:16px}}</style></head><body>' +
'<div class="wrap"><div class="top"><div><h1>Automação WhatsApp</h1><div class="muted">Kirvano → Supabase → WhatsApp</div></div><div id="wa" class="status">carregando...</div></div>' +
'<div class="cards"><div class="card"><div class="muted">Contatos salvos</div><div class="num" id="contacts">0</div></div><div class="card"><div class="muted">Mensagens enviadas</div><div class="num" id="sent">0</div></div><div class="card"><div class="muted">Na fila</div><div class="num" id="queued">0</div></div><div class="card"><div class="muted">Falhas</div><div class="num" id="failed">0</div></div><div class="card"><div class="muted">Eventos hoje</div><div class="num" id="eventsToday">0</div></div></div>' +
'<div class="tabs"><button class="tab active" data-tab="contactsPanel">Contatos</button><button class="tab" data-tab="templatesPanel">Mensagens</button><button class="tab" data-tab="historyPanel">Histórico</button><button class="tab" data-tab="eventsPanel">Eventos</button></div>' +
'<div id="contactsPanel" class="panel active"><div class="scroll"><table><thead><tr><th>Nome</th><th>Celular</th><th>Produto</th><th>Último evento</th><th>Último contato</th><th>Opt-in disparos</th></tr></thead><tbody id="contactsBody"></tbody></table></div></div>' +
'<div id="templatesPanel" class="panel"><div id="templates"></div><div class="small">Variáveis: {{name}}, {{full_name}}, {{product}}, {{sale_id}}, {{total_price}}, {{pix_code}}, {{boleto_link}}</div></div>' +
'<div id="historyPanel" class="panel"><div class="scroll"><table><thead><tr><th>Data</th><th>Nome</th><th>Celular</th><th>Status</th><th>Mensagem</th></tr></thead><tbody id="messagesBody"></tbody></table></div></div>' +
'<div id="eventsPanel" class="panel"><div class="scroll"><table><thead><tr><th>Data</th><th>Evento</th><th>Status</th><th>Erro</th></tr></thead><tbody id="eventsBody"></tbody></table></div></div></div>' +
'<script>' +
'function esc(s){return String(s==null?"":s).replace(/[&<>"\\x27]/g,function(m){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\\x27":"&#039;"}[m]||m})}' +
'function fmt(s){return s?new Date(s).toLocaleString("pt-BR"):"—"}' +
'async function get(p){var r=await fetch("/admin-api"+p);if(!r.ok)throw new Error(await r.text());return r.json()}' +
'async function post(p,b){var r=await fetch("/admin-api"+p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(await r.text());return r.json()}' +
'async function load(){var all=await Promise.all([get("/stats"),get("/contacts"),get("/messages"),get("/events"),get("/templates")]);var s=all[0],c=all[1],m=all[2],e=all[3],t=all[4];' +
'document.getElementById("contacts").textContent=s.contacts;document.getElementById("sent").textContent=s.sent;document.getElementById("queued").textContent=s.queued;document.getElementById("failed").textContent=s.failed;document.getElementById("eventsToday").textContent=s.events_today;document.getElementById("wa").textContent="WhatsApp: "+((s.whatsapp&&s.whatsapp.status)||"desconhecido");' +
'document.getElementById("contactsBody").innerHTML=c.contacts.map(function(x){return "<tr><td>"+esc(x.name||"—")+"</td><td>"+esc(x.phone)+"</td><td>"+esc(x.product_name||x.product_id||"—")+"</td><td>"+esc(x.last_event_type||"—")+"</td><td>"+fmt(x.last_seen_at)+"</td><td>"+(x.broadcast_opt_in?"sim":"não")+"</td></tr>"}).join("");' +
'document.getElementById("messagesBody").innerHTML=m.messages.map(function(x){return "<tr><td>"+fmt(x.queued_at)+"</td><td>"+esc(x.customer_name||"—")+"</td><td>"+esc(x.phone)+"</td><td><span class=\\"badge "+esc(x.status)+"\\">"+esc(x.status)+"</span></td><td style=\\"max-width:420px;white-space:pre-wrap\\">"+esc(x.message)+"</td></tr>"}).join("");' +
'document.getElementById("eventsBody").innerHTML=e.events.map(function(x){return "<tr><td>"+fmt(x.received_at)+"</td><td>"+esc(x.event_type)+"</td><td>"+esc(x.status)+"</td><td>"+esc(x.error_message||"—")+"</td></tr>"}).join("");' +
'document.getElementById("templates").innerHTML=t.templates.map(function(x){return "<div class=\\"template\\"><b>"+esc(x.name)+"</b><div class=\\"small\\">"+esc(x.event_type)+(x.product_id?" • Produto "+esc(x.product_id):" • Todos os produtos")+"</div><textarea id=\\"tpl-"+x.id+"\\">"+esc(x.body)+"</textarea><button class=\\"save\\" onclick=\\"saveTemplate(\\x27"+x.id+"\\x27)\\">Salvar mensagem</button></div>"}).join("")}' +
'async function saveTemplate(id){var el=document.getElementById("tpl-"+id);await post("/templates",{id:id,body:el.value,active:true});alert("Mensagem salva.")}' +
'document.querySelectorAll(".tab").forEach(function(b){b.onclick=function(){document.querySelectorAll(".tab,.panel").forEach(function(x){x.classList.remove("active")});b.classList.add("active");document.getElementById(b.dataset.tab).classList.add("active")}});load().catch(function(e){alert("Erro ao carregar dashboard: "+e.message)});' +
'</script></body></html>';

app.get("/", function(req, res) { res.type("html").send(qrPage()); });
app.get("/health", function(req, res) { res.json({ ok: true, whatsapp: waStatus, phone: waPhone }); });

app.all("/admin-api/*path", auth, async function(req, res) {
  try {
    var p = req.params.path;
    var suffix = "/" + (Array.isArray(p) ? p.join("/") : String(p || ""));
    var data = await adminApi(suffix, {
      method: req.method,
      body: (req.method === "GET" || req.method === "HEAD") ? undefined : JSON.stringify(req.body || {})
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/dashboard", auth, function(req, res) { res.type("html").send(dashboardHtml); });

app.listen(PORT, "0.0.0.0", function() { console.log("Servidor iniciado na porta", PORT); });
await connectWhatsApp();
setInterval(processQueue, POLL_MS);
