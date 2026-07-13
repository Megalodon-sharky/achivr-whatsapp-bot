# Achivr Sports — WhatsApp Support Bot

AI support agent on WhatsApp powered by Claude, delivered through **Wati** (a WhatsApp
Business Solution Provider), with automatic fallback to a human agent. Answers strictly
from the Achivr FAQ/TOS knowledge base baked into the system prompt — it cannot invent
policy, and it hands off to a human whenever it's unsure, asked, or anything sensitive
comes up.

## What it does

Matches the flowchart: greeting + quick-reply menu (Track Order / Recommendations /
Help), WhatsApp-number identity (orders are looked up against Shopify by the customer's
number), and these skills:

- **Track order** ("when will I get my product") — Shopify order status + tracking + delivery estimate
- **Refund tracking** — Shopify refund/financial status + the 7–10 working-day window
- **Recommendations** — smart discovery with sizing logic (badminton/tennis racquet
  fitting by skill & play style, shoe & swimwear sizing) → real catalog links
- **FAQ AI extraction** — answers from the embedded FAQ/TOS knowledge base
- **COD policy** — answers "only prepaid, no COD"
- **Human fallback** — escalates on request, low confidence, payment/legal/abuse, or tool failure

## How it works

```
Customer (WhatsApp) → Wati (BSP) → webhook → /webhook
   → verify ?token → parse Wati payload → session state
   → Claude agent (hardened prompt + tools)
        tools: get_order_status · get_refund_status · recommend_products · escalate_to_human
        ├─ order/refund lookup → auto-scoped to the customer's WhatsApp number
        ├─ normal answer → reply via Wati sendSessionMessage
        └─ escalate     → flag handoff, assign a Wati operator, go silent
```

**Why Wati:** the bot generates **free-form** replies, which the plain WhatsApp Business
app and template-only BSPs (e.g. Interakt) can't send. Wati exposes a session-message API
(free-form text within WhatsApp's 24-hour window) plus a team inbox app where a human can
take over the same thread. The bot only ever replies to an inbound message, so it always
stays inside the 24h window — no message templates required.

**Identity** is the **WhatsApp number** (authenticated by WhatsApp). Order/refund lookups
are constrained to the customer's number — Shopify is queried and results are filtered to
orders whose phone matches it — so a customer can only ever read their own orders. There's
no OTP: an OTP would be delivered to the same WhatsApp, so it adds no real security over
the number itself.

**Mock mode** (`USE_MOCK_SHOPIFY=true`, the default) runs the whole flow on canned data —
no Shopify store needed to test the conversation. Set it `false` and fill the `SHOPIFY_*`
vars to go live.

- **Knowledge** lives in `src/systemPrompt.ts` (no database/RAG — the FAQ fits in the
  prompt). Edit policy there.
- **Exploit resistance**: hardened rules in the system prompt (grounding, no policy
  invention, untrusted-input handling, no prompt disclosure, PII refusal, scope lock).
  The webhook is authenticated by a shared `?token=` secret (Wati doesn't sign webhooks).
- **Human fallback**: the model calls `escalate_to_human`; the bot sets `handoff=true` and
  goes silent, and `src/handoff.ts` assigns the chat to a Wati operator (or leaves it for
  Wati auto-routing). The human replies in the Wati inbox app; a "return to bot" automation
  should call `clearHandoff()` to resume the bot.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Express server: webhook auth, menu, routing, dedupe |
| `src/claude.ts` | Agentic tool loop + tool definitions |
| `src/systemPrompt.ts` | Hardened prompt + Achivr knowledge base + recommendation guidance |
| `src/shopify.ts` | Shopify Admin GraphQL: orders, refunds, catalog (+ mock mode) |
| `src/whatsapp.ts` | Wati transport: send text / buttons / parse webhook |
| `src/sessions.ts` | In-memory per-customer state (history, handoff, greeted) |
| `src/handoff.ts` | Human-handoff: assign chat to a Wati operator |
| `src/config.ts` | Env loading + validation |

## Setup

### 1. Install
```bash
npm install
cp .env.example .env   # then fill it in
```

### 2. Wati account + your number
1. Sign up at <https://www.wati.io> and onboard your existing WhatsApp number. Wati
   migrates it onto the WhatsApp Business Platform — note this **removes the number from
   the green WhatsApp Business app** (a number lives in one place). Humans will use the
   **Wati Team Inbox** app (web + mobile) instead.
2. Wati dashboard → **API Docs**: copy your **API endpoint** → `WATI_API_ENDPOINT` and
   your **Access Token** → `WATI_ACCESS_TOKEN`.
3. Invent a long random string for `WATI_WEBHOOK_SECRET`.
4. (Optional) set `WATI_AGENT_EMAIL` to the operator who should receive escalated chats.

### 3. Run + expose
```bash
npm run dev          # starts on http://localhost:3000
npx ngrok http 3000  # in another terminal — gives you an https URL
```

### 4. Configure the Wati webhook
In Wati → **Settings → Webhooks** (or **Integrations → Webhooks**):
- **URL**: `https://<your-ngrok>.ngrok.io/webhook?token=<WATI_WEBHOOK_SECRET>`
- Enable the **message received** event.

Message your Wati number — the bot replies. Watch the console for `=== HUMAN HANDOFF ===`
when it escalates.

## Demo without a WhatsApp number

To show the flow (e.g. to management) with no Wati and no number — the real bot on mock data:

```bash
cp .env.example .env    # set ANTHROPIC_API_KEY; leave WATI_*/SHOPIFY_* as placeholders
npm run demo            # → open http://localhost:3001
```

A WhatsApp-style chat page runs the actual agent (`runAgent`) with `USE_MOCK_SHOPIFY=true`,
so it tracks the canned order, refuses COD, recommends products, and shows the human-handoff
step — all locally. `src/demo.ts` is standalone and never touches Wati.

## Product card template

Recommendations are shown as **product cards** (image + title + price + stock + a "View
product" button). In WhatsApp a real card like this can only be sent with an **approved
message template** — the free-form session API has no product-card type. So:

- **No template configured** (`WATI_PRODUCT_TEMPLATE` blank, the default): each product is
  sent as an **image + caption** (title, price, in-stock, tappable link). Works inside the
  24h window, needs no approval. This is the safe default.
- **Template configured**: `sendProductCards` sends the approved template per product (up to
  3), giving the true card look.

To enable real cards, create this template in **Wati → Templates** (or WhatsApp Manager) and
submit it for Meta approval, then set `WATI_PRODUCT_TEMPLATE` to its name:

- **Category**: Marketing (or Utility if you frame it as an order-related suggestion).
- **Header**: **Media → Image** (dynamic — the product photo).
- **Body**: `*{{title}}*` on line 1, `{{price}} · {{stock}}` on line 2.
- **Button**: **Visit website (URL)**, text `View product`, URL = `https://achivr.in/{{url}}`
  (static base + one dynamic suffix; the bot passes `products/<handle>` as the suffix).

The bot fills these via Wati's `sendTemplateMessage` params (`image`, `title`, `price`,
`stock`, `url`). Approval usually takes minutes–hours. Until approved, leave
`WATI_PRODUCT_TEMPLATE` blank and the image+caption fallback is used.

> Note: WhatsApp carousels (multiple cards, swipeable) are a separate template type and
> aren't reliably sendable through Wati's simple template API — this uses one card per
> product, sent as up to three template messages. The local demo renders them as a
> swipeable carousel for presentation.

## Notes
- Identity = the WhatsApp number. Order/refund lookups are filtered to orders whose phone
  matches it (`phoneMatches` in `src/shopify.ts`), so customers can only read their own. If
  an order is under a different number, the bot says it can't find one and offers a human —
  confirm your Shopify orders store the customer's WhatsApp number.
- The bot only sends **free-form session replies** (always answering an inbound message, so
  always inside the 24h window). It uses no message templates.
- Quick-reply buttons use Wati's `sendInteractiveButtonsMessage`; Wati returns the tapped
  button's **title** (not a custom id), so button titles must be self-explanatory.
- Sessions and dedupe are in-memory: fine for one process. For production / horizontal
  scaling, back `sessions.ts` and the dedupe set with Redis.
- `handoff.ts` assigns to a Wati operator when `WATI_AGENT_EMAIL` is set, else leaves the
  chat unassigned for Wati auto-routing. Add a "return to bot" path that calls
  `clearHandoff()` when the human is done so the bot resumes.
- Model is set by `CLAUDE_MODEL`. `claude-sonnet-4-6` (default) balances quality and cost;
  `claude-haiku-4-5-20251001` is cheaper and faster.
