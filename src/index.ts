import express, { type Request, type Response } from "express";
import { config } from "./config";
import { runAgent } from "./claude";
import { getSession, pushTurn, markHandoff, type Session } from "./sessions";
import { notifyHumanAgent } from "./handoff";
import {
  sendText,
  sendButtons,
  sendProductCards,
  markRead,
  parseIncoming,
  type IncomingMessage,
} from "./whatsapp";

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("Achivr WhatsApp bot is running."));

// Wati has no verification handshake (unlike Meta's hub.challenge). Keep GET for health.
app.get("/webhook", (_req: Request, res: Response) => res.sendStatus(200));

// Incoming messages from Wati.
app.post("/webhook", (req: Request, res: Response) => {
  if (!verifyWebhook(req)) return res.sendStatus(401);
  res.sendStatus(200); // ack immediately so Wati doesn't retry while we think

  for (const msg of parseIncoming(req.body)) {
    handleMessage(msg).catch((err) => console.error("handleMessage error:", err));
  }
});

// --- menu ---

const MENU_BUTTONS = [
  { id: "track", title: "Track Order" },
  { id: "recommend", title: "Recommendations" },
  { id: "help", title: "Help" },
];
const GREETING = "Hi! 👋 Welcome to Achivr Sports support. How can I help you today?";

function sendMenu(to: string): Promise<void> {
  return sendButtons(to, GREETING, MENU_BUTTONS);
}

function isGreeting(text: string): boolean {
  const t = text.trim();
  return t === "" || /^(hi|hello|hey|start|menu|hola|namaste|yo)\b/i.test(t);
}

// --- routing ---

async function handleMessage(msg: IncomingMessage): Promise<void> {
  if (alreadySeen(msg.id)) return;
  void markRead(msg.id);

  const session = getSession(msg.from);
  if (session.handoff) return; // a human owns it

  // First contact → greet with the menu (unless they already stated intent).
  if (!session.greeted) {
    session.greeted = true;
    if (isGreeting(msg.text)) return sendMenu(msg.from);
  }

  // Unsupported payloads (image/audio/etc).
  if (msg.type !== "text" && msg.type !== "interactive") {
    return sendText(
      msg.from,
      "I can read text right now. Please type your question, tap a menu button, or reply " +
        "'agent' for a human. For return photos, email customercare@achivr.in with your Order ID.",
    );
  }

  // 4) Normal path → the AI agent.
  return processWithAgent(session, msg.text);
}

async function processWithAgent(session: Session, text: string): Promise<void> {
  pushTurn(session.phone, { role: "user", content: text });
  const result = await runAgent(getSession(session.phone).history, { session });

  if (result.type === "handoff") {
    return escalate(session, result.reason, result.summary, result.text);
  }
  pushTurn(session.phone, { role: "assistant", content: result.text });
  await sendText(session.phone, result.text);
  // Product recommendations render as cards (image + price + stock + link) after the text.
  if (result.cards?.length) await sendProductCards(session.phone, result.cards);
}

async function escalate(
  session: Session,
  reason: string,
  summary: string,
  customerLine?: string,
): Promise<void> {
  markHandoff(session.phone);
  await notifyHumanAgent(session.phone, reason, summary, getSession(session.phone).history);
  await sendText(
    session.phone,
    customerLine || "I'm connecting you to a human agent now — they'll pick this up shortly.",
  );
}

// --- helpers ---

// Wati doesn't sign its webhooks, so we authenticate by a shared secret appended to the
// webhook URL as ?token=... (set that URL in the Wati dashboard).
function verifyWebhook(req: Request): boolean {
  const token = req.query.token;
  return typeof token === "string" && token === config.wati.webhookSecret;
}

const seen = new Set<string>();
function alreadySeen(id: string): boolean {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 5000) seen.clear();
  return false;
}

app.listen(config.port, () =>
  console.log(`Achivr WhatsApp bot listening on :${config.port}`),
);
