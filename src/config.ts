import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// When mock mode is on, the bot runs end-to-end without a real Shopify store
// (order/refund/catalog tools return canned data). Flip to false once you wire
// real Shopify credentials.
const useMockShopify = (process.env.USE_MOCK_SHOPIFY ?? "true") === "true";

function shopifyVar(name: string): string {
  // Only hard-required when NOT mocking.
  return useMockShopify ? (process.env[name] ?? "") : required(name);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  // Wati (WhatsApp BSP). The bot talks to Wati's API; humans take over in Wati's inbox.
  wati: {
    // Base URL from Wati dashboard > API Docs, e.g. https://live-mt-server.wati.io/{tenantId}
    // (older accounts: https://app-server.wati.io). Trailing slash trimmed.
    apiEndpoint: required("WATI_API_ENDPOINT").replace(/\/$/, ""),
    accessToken: required("WATI_ACCESS_TOKEN"), // Bearer token from Wati dashboard
    // A secret YOU invent and append to the webhook URL as ?token=... — Wati does not
    // sign its webhooks, so this is how we authenticate inbound calls.
    webhookSecret: required("WATI_WEBHOOK_SECRET"),
    // Optional operator email to auto-assign on handoff. Blank = leave unassigned for
    // Wati's own auto-routing to pick up.
    agentEmail: process.env.WATI_AGENT_EMAIL ?? "",
  },

  // Claude
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",

  // Shopify (Admin GraphQL, custom app token)
  useMockShopify,
  shopify: {
    domain: shopifyVar("SHOPIFY_STORE_DOMAIN"), // e.g. achivr.myshopify.com
    adminToken: shopifyVar("SHOPIFY_ADMIN_TOKEN"), // shpat_...
    apiVersion: process.env.SHOPIFY_API_VERSION ?? "2025-01",
    storefrontBase: process.env.SHOPIFY_STOREFRONT_BASE ?? "https://achivr.in",
  },
} as const;
