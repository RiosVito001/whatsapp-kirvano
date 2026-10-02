import express from "express";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth";
const QUEUE_API_URL = process.env.QUEUE_API_URL;
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const POLL_MS = Number(process.env.POLL_MS || 4000);

if (!QUEUE_API_URL || !WORKER_TOKEN) {
  throw new Error("QUEUE_API_URL e WORKER_TOKEN são obrigatórios");
}

const app = express();
app.use(express.json());

let socket = null;
let qrDataUrl = null;
let waStatus = "starting";
let waPhone = null;
let reconnectTimer = null;
let processing = false;

async function api(path, options = {}) {
  const res = await fetch(QUEUE_API_URL + path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-worker-token": WORKER_TOKEN,
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Queue API ${res.status}: ${body}`);
  }
  return res.json();
}

async function reportState(extra = {}) {
  try {
    await api("/state", {
      method: "POST",
      body: JSON.stringify({
        status: waStatus,
        phone: waPhone,
        ...extra
      })
    });
  } catch (err) {
    console.error("Falha ao atualizar estado:", err.message);
  }
}

async function connectWhatsApp() {
  clearTimeout(reconnectTimer);
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  waStatus = "connecting";
  await reportState();

  socket = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Kirvano Automation", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

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
      await reportState({
        last_error: loggedOut ? "Sessão desconectada. Escaneie um novo QR." : "Conexão caiu; reconectando."
      });
      if (!loggedOut) {
        reconnectTimer = setTimeout(connectWhatsApp, 3000);
      } else {
        qrDataUrl = null;
      }
    }
  });
}

async function processQueue() {
  if (processing || waStatus !== "connected" || !socket) return;
  processing = true;
  let item = null;
  try {
    const result = await api("/next");
    item = result.message || null;
    if (!item) return;

    const phone = String(item.phone || "").replace(/\D/g, "");
    if (!phone) throw new Error("Telefone inválido");

    const jid = phone + "@s.whatsapp.net";
    const exists = await socket.onWhatsApp(jid);
    if (!exists?.[0]?.exists) throw new Error("Número não encontrado no WhatsApp");

    await socket.sendMessage(jid, { text: item.message });
    await api("/ack", {
      method: "POST",
      body: JSON.stringify({ id: item.id, status: "sent" })
    });
    console.log("Mensagem enviada:", item.id, phone);
  } catch (err) {
    console.error("Erro no processamento:", err.message);
    if (item?.id) {
      try {
        await api("/ack", {
          method: "POST",
          body: JSON.stringify({
            id: item.id,
            status: "failed",
            error: String(err.message || err)
          })
        });
      } catch {}
    }
  } finally {
    processing = false;
  }
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp Kirvano</title>
<style>body{font-family:Arial,sans-serif;background:#0b0b0b;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#171717;padding:28px;border-radius:18px;max-width:460px;width:calc(100% - 40px);text-align:center}img{max-width:100%;border-radius:12px;background:#fff}.ok{color:#22c55e}.warn{color:#f59e0b}small{color:#aaa}</style></head>
<body><div class="card"><h1>WhatsApp Kirvano</h1>
<p>Status: <strong class="${waStatus === "connected" ? "ok" : "warn"}">${waStatus}</strong></p>
${waPhone ? `<p>Número: ${waPhone}</p>` : ""}
${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR Code"><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p>` : waStatus === "connected" ? "<p>Conectado e pronto para enviar.</p>" : "<p>Aguardando QR Code...</p>"}
<small>A página atualiza a cada 8 segundos.</small></div><script>setTimeout(()=>location.reload(),8000)</script></body></html>`);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, whatsapp: waStatus, phone: waPhone });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor iniciado na porta", PORT);
});

await connectWhatsApp();
setInterval(processQueue, POLL_MS);
