import { config } from "./config";
import type { ProductInfo } from "./shopify";

// WhatsApp transport via Wati (BSP). Same exports the rest of the app already uses
// (sendText / sendButtons / markRead / parseIncoming) — only the wire format changed
// from Meta Cloud API to Wati's API.

const BASE = config.wati.apiEndpoint;
const AUTH = { Authorization: `Bearer ${config.wati.accessToken}` };

export type IncomingMessage = {
  from: string; // customer WhatsApp number (waId, incl. country code, no +)
  id: string; // Wati message id, used for dedupe
  type: string; // normalized: "text" | "interactive" | original media type
  text: string; // text body, or the tapped button/list title, else ""
};

async function watiPost(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    console.error("Wati send failed:", res.status, await res.text().catch(() => ""));
  }
}

// Free-form session reply. Works because the bot only ever replies inside the 24-hour
// customer-service window (it always answers an inbound message) — no template needed.
// messageText goes in the query string; also sent in the body to be robust across Wati
// API versions.
// WhatsApp uses its own lightweight markup, not Markdown. Normalize any Markdown the
// model slips through: **bold**->*bold*, #headings->*bold*, [t](url)->"t: url". Single-*
// bold, _italic_, ~strike~ and "- " bullets are already valid WhatsApp and pass through.
export function toWhatsApp(md: string): string {
  return md
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1: $2");
}

export function sendText(to: string, body: string): Promise<void> {
  const text = toWhatsApp(body);
  const url = `/api/v1/sendSessionMessage/${encodeURIComponent(to)}?messageText=${encodeURIComponent(text)}`;
  return watiPost(url, { messageText: text });
}

// Quick-reply buttons (max 3, per WhatsApp limits). Wati returns the tapped button's
// TITLE in the webhook (no custom id), so titles must be meaningful on their own.
export function sendButtons(
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
): Promise<void> {
  return watiPost(
    `/api/v1/sendInteractiveButtonsMessage?whatsappNumber=${encodeURIComponent(to)}`,
    {
      body,
      buttons: buttons.slice(0, 3).map((b) => ({ text: b.title.slice(0, 20) })),
    },
  );
}

// A product recommendation as a WhatsApp CARD. A true WhatsApp card (image header +
// body + tappable "View product" button) is only possible via an APPROVED template —
// WhatsApp's free-form/session API has no native product-card. So:
//  • config.wati.productTemplate SET  → send that approved template per product (real card).
//  • blank                            → degrade to an image + caption message (works in
//                                        the 24h session window, needs no approval).
// The template to create + submit for approval in WhatsApp Manager is documented in the
// README ("Product card template"). NOTE: Wati template/field names here are best-effort
// and not yet verified against a live Wati account.
function productPathSuffix(url: string): string {
  return url.replace(/^https?:\/\/[^/]+\//, ""); // e.g. "products/astrox-88d-pro"
}

export async function sendProductCards(to: string, cards: ProductInfo[]): Promise<void> {
  const tmpl = config.wati.productTemplate;
  for (const c of cards.slice(0, 3)) {
    if (tmpl) {
      // Real template card. Template header = IMAGE variable, body = {{title}}/{{price}}/
      // {{stock}}, URL button = base + {{url}} dynamic suffix.
      await watiPost(`/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(to)}`, {
        template_name: tmpl,
        broadcast_name: `${tmpl}-auto`,
        parameters: [
          { name: "image", value: c.image ?? "" },
          { name: "title", value: c.title },
          { name: "price", value: c.price },
          { name: "stock", value: c.inStock ? "In stock" : "Out of stock" },
          { name: "url", value: productPathSuffix(c.url) },
        ],
      });
    } else {
      // Fallback: image + caption (title, price, in-stock, tappable link).
      const caption =
        `*${c.title}*\n${c.price}` +
        (c.inStock ? " · In stock" : " · Out of stock") +
        `\n${c.url}`;
      if (c.image) {
        await watiPost("/api/ext/v3/conversations/messages/fileviaurl", {
          target: to,
          fileUrl: c.image,
          caption,
        });
      } else {
        await sendText(to, caption);
      }
    }
  }
}

// Wati has no public mark-read endpoint; its inbox manages read state. No-op kept so
// callers don't change.
export function markRead(_messageId: string): Promise<void> {
  return Promise.resolve();
}

const MEDIA_TYPES = new Set([
  "image",
  "video",
  "document",
  "audio",
  "voice",
  "sticker",
  "location",
  "contacts",
]);

// Parse a Wati inbound webhook (a single message object, not Meta's entry/changes array).
// Ignores our own outgoing messages (owner=true) and non-message events (status callbacks,
// system events) so the bot never replies to noise.
export function parseIncoming(payload: any): IncomingMessage[] {
  if (!payload || payload.owner === true) return []; // outgoing / agent message
  const from = payload.waId;
  if (!from) return [];
  const id = payload.id ?? payload.whatsappMessageId ?? from;

  const reply =
    payload.interactiveButtonReply?.title ??
    payload.listReply?.title ??
    payload.buttonReply?.text ??
    payload.buttonReply?.title;

  if (reply) return [{ from, id, type: "interactive", text: reply }];
  if (payload.type === "text" || typeof payload.text === "string") {
    return [{ from, id, type: "text", text: payload.text ?? "" }];
  }
  if (MEDIA_TYPES.has(payload.type)) return [{ from, id, type: payload.type, text: "" }];
  return []; // status callbacks, system events, etc. — nothing to answer
}
