import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { SYSTEM_PROMPT } from "./systemPrompt";
import type { Session } from "./sessions";
import { fetchOrder, searchProducts, type OrderInfo } from "./shopify";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export type Turn = { role: "user" | "assistant"; content: string };
export type ToolContext = { session: Session };

export type AgentResult =
  | { type: "reply"; text: string }
  | { type: "handoff"; reason: string; summary: string; text: string };

const MAX_STEPS = 5;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_order_status",
    description:
      "Track an order / answer 'when will I get my product'. Omit order_id for the " +
      "customer's most recent order. Results are automatically limited to orders placed " +
      "with this customer's WhatsApp number.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Order number, e.g. 1042 or #1042. Optional." },
      },
    },
  },
  {
    name: "get_refund_status",
    description:
      "Check refund status / tracking for an order. Results are limited to orders placed " +
      "with this customer's WhatsApp number.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Order number. Optional — defaults to most recent." },
      },
    },
  },
  {
    name: "recommend_products",
    description:
      "Search the Achivr product catalog. Pass concise keywords (sport + category + " +
      "attributes), e.g. 'badminton racquet head-heavy attacking'.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand off to a human agent (explicit request, out of scope, tool failure, " +
      "payment/fraud/legal/abuse, or low confidence).",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: [
            "explicit_request",
            "out_of_scope",
            "tool_failure",
            "payment_or_fraud",
            "legal_or_dispute",
            "abuse_or_distress",
            "low_confidence",
            "suspected_exploit",
          ],
        },
        summary: { type: "string", description: "1–2 sentence summary for the human agent." },
      },
      required: ["reason", "summary"],
    },
  },
];

function fmtOrder(o: OrderInfo): string {
  const lines = [
    `Order ${o.name} (placed ${o.createdAt.slice(0, 10)})`,
    `Fulfillment: ${o.fulfillmentStatus}`,
    `Payment: ${o.financialStatus}`,
    `Items: ${o.items.map((i) => `${i.quantity}x ${i.title}`).join(", ")}`,
    `Total: ${o.total}`,
  ];
  if (o.tracking) {
    lines.push(
      `Tracking: ${[o.tracking.company, o.tracking.number, o.tracking.url].filter(Boolean).join(" ")}`,
    );
  }
  return lines.join("\n");
}

function fmtRefund(o: OrderInfo): string {
  if (!o.refunds.length) {
    return `Order ${o.name}: financial status ${o.financialStatus}. No refund has been issued yet.`;
  }
  const r = o.refunds.map((x) => `${x.amount} on ${x.createdAt.slice(0, 10)}`).join("; ");
  return `Order ${o.name}: status ${o.financialStatus}. Refunds: ${r}. (Bank settlement takes 7–10 working days to the original source.)`;
}

async function dispatch(name: string, input: any, ctx: ToolContext): Promise<string> {
  try {
    if (name === "get_order_status") {
      const o = await fetchOrder(ctx.session.phone, input?.order_id);
      return o
        ? fmtOrder(o)
        : "NO_ORDER_FOUND under this customer's WhatsApp number. Don't invent one — ask them to " +
            "confirm the Order ID, note it may be under a different number, or escalate.";
    }
    if (name === "get_refund_status") {
      const o = await fetchOrder(ctx.session.phone, input?.order_id);
      return o ? fmtRefund(o) : "NO_ORDER_FOUND under this customer's WhatsApp number.";
    }
    if (name === "recommend_products") {
      const list = await searchProducts(String(input?.query ?? ""));
      if (!list.length) return "NO_PRODUCTS_FOUND. Suggest popular items or ask the customer to refine.";
      return list
        .map(
          (p) =>
            `• ${p.title} — ${p.price}\n  ${p.url}\n  variants: ${p.variants.map((v) => v.title).join(", ")}`,
        )
        .join("\n");
    }
    return `UNKNOWN_TOOL: ${name}`;
  } catch (e) {
    console.error("tool error", name, e);
    return "TOOL_ERROR: the lookup failed. Offer the customer a retry or escalate to a human.";
  }
}

export async function runAgent(history: Turn[], ctx: ToolContext): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({
      model: config.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      return { type: "reply", text: text || "Sorry, I didn't catch that — could you rephrase?" };
    }

    // Terminal: escalation.
    const esc = toolUses.find((b) => b.name === "escalate_to_human");
    if (esc) {
      const input = esc.input as { reason: string; summary: string };
      return { type: "handoff", reason: input.reason, summary: input.summary, text };
    }

    // Execute tools and feed results back to the model. Order/refund lookups are
    // auto-scoped to the customer's WhatsApp number (shopify.ts phoneMatches), so a
    // customer can only ever see their own orders — no separate identity step needed.
    messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const out = await dispatch(tu.name, tu.input, ctx);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }

  return {
    type: "handoff",
    reason: "low_confidence",
    summary: "Agent exceeded its tool-step limit without resolving the request.",
    text: "Let me bring in a human agent to sort this out.",
  };
}
