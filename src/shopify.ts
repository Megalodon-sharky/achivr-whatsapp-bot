import { config } from "./config";

// Shopify Admin GraphQL client. Orders/refunds are always constrained to the
// customer's WhatsApp number so one customer can never read another's order.
// With USE_MOCK_SHOPIFY=true the bot runs end-to-end on canned data.

const { domain, adminToken, apiVersion, storefrontBase } = config.shopify;
const GQL_URL = `https://${domain}/admin/api/${apiVersion}/graphql.json`;

export type OrderInfo = {
  name: string; // "#1234"
  createdAt: string;
  fulfillmentStatus: string; // UNFULFILLED, FULFILLED, ...
  financialStatus: string; // PAID, REFUNDED, PARTIALLY_REFUNDED, ...
  items: { title: string; quantity: number }[];
  tracking?: { number?: string; url?: string; company?: string };
  total: string;
  refunds: { createdAt: string; amount: string }[];
};

export type ProductInfo = {
  title: string;
  url: string;
  price: string;
  tags: string[];
  variants: { title: string; available: boolean }[];
};

function lastTen(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": adminToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

const ORDER_FIELDS = `
  name
  createdAt
  displayFulfillmentStatus
  displayFinancialStatus
  phone
  customer { phone }
  totalPriceSet { presentmentMoney { amount currencyCode } }
  lineItems(first: 20) { nodes { title quantity } }
  fulfillments(first: 5) { trackingInfo { number url company } }
  refunds(first: 10) { createdAt totalRefundedSet { presentmentMoney { amount currencyCode } } }
`;

function mapOrder(o: any): OrderInfo {
  const money = o.totalPriceSet?.presentmentMoney;
  const t = o.fulfillments?.[0]?.trackingInfo?.[0];
  return {
    name: o.name,
    createdAt: o.createdAt,
    fulfillmentStatus: o.displayFulfillmentStatus,
    financialStatus: o.displayFinancialStatus,
    items: (o.lineItems?.nodes ?? []).map((n: any) => ({ title: n.title, quantity: n.quantity })),
    tracking: t ? { number: t.number, url: t.url, company: t.company } : undefined,
    total: money ? `${money.amount} ${money.currencyCode}` : "",
    refunds: (o.refunds ?? []).map((r: any) => {
      const m = r.totalRefundedSet?.presentmentMoney;
      return { createdAt: r.createdAt, amount: m ? `${m.amount} ${m.currencyCode}` : "" };
    }),
  };
}

function phoneMatches(order: any, phone: string): boolean {
  const want = lastTen(phone);
  return lastTen(order.phone ?? "") === want || lastTen(order.customer?.phone ?? "") === want;
}

// Look up an order for the customer's WhatsApp number. If orderId is given, that
// order must belong to this number; otherwise return the most recent order.
export async function fetchOrder(phone: string, orderId?: string): Promise<OrderInfo | null> {
  if (config.useMockShopify) return mockOrder(phone, orderId);

  const e164 = `+${lastTen(phone)}`; // best-effort; adjust for your numbering
  const q = orderId
    ? `name:#${orderId.replace(/[^0-9]/g, "")}`
    : `phone:${e164}`;
  const data = await gql<{ orders: { nodes: any[] } }>(
    `query($q: String!) {
       orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } }
     }`,
    { q },
  );
  const match = (data.orders?.nodes ?? []).find((o) => phoneMatches(o, phone));
  return match ? mapOrder(match) : null;
}

export async function searchProducts(query: string): Promise<ProductInfo[]> {
  if (config.useMockShopify) return mockProducts(query);

  const data = await gql<{ products: { nodes: any[] } }>(
    `query($q: String!) {
       products(first: 6, query: $q) {
         nodes {
           title handle onlineStoreUrl tags
           priceRangeV2 { minVariantPrice { amount currencyCode } }
           variants(first: 15) { nodes { title availableForSale } }
         }
       }
     }`,
    { q: query },
  );
  return (data.products?.nodes ?? []).map((p: any) => {
    const mp = p.priceRangeV2?.minVariantPrice;
    return {
      title: p.title,
      url: p.onlineStoreUrl ?? `${storefrontBase}/products/${p.handle}`,
      price: mp ? `from ${mp.amount} ${mp.currencyCode}` : "",
      tags: p.tags ?? [],
      variants: (p.variants?.nodes ?? []).map((v: any) => ({
        title: v.title,
        available: v.availableForSale,
      })),
    };
  });
}

// --- mock data (USE_MOCK_SHOPIFY=true) ---

function mockOrder(_phone: string, orderId?: string): OrderInfo {
  return {
    name: orderId ? `#${orderId.replace(/\D/g, "")}` : "#1042",
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    fulfillmentStatus: "FULFILLED",
    financialStatus: "PAID",
    items: [{ title: "Yonex Astrox 88D Pro Badminton Racquet", quantity: 1 }],
    tracking: {
      number: "BD123456789IN",
      url: "https://www.bluedart.com/tracking",
      company: "Blue Dart",
    },
    total: "12999.00 INR",
    refunds: [],
  };
}

function mockProducts(query: string): ProductInfo[] {
  const q = query.toLowerCase();
  const all: ProductInfo[] = [
    {
      title: "Yonex Astrox 88D Pro (head-heavy, attacking)",
      url: `${storefrontBase}/products/astrox-88d-pro`,
      price: "from 12999.00 INR",
      tags: ["badminton", "racquet", "advanced", "attack"],
      variants: [{ title: "4U G5", available: true }],
    },
    {
      title: "Yonex Nanoflare 700 (even balance, all-round)",
      url: `${storefrontBase}/products/nanoflare-700`,
      price: "from 10999.00 INR",
      tags: ["badminton", "racquet", "intermediate", "all-round"],
      variants: [{ title: "4U G5", available: true }],
    },
    {
      title: "Asics Court Speed FF Indoor Shoes",
      url: `${storefrontBase}/products/court-speed-ff`,
      price: "from 7999.00 INR",
      tags: ["footwear", "indoor", "badminton", "tennis"],
      variants: [{ title: "UK 8", available: true }, { title: "UK 9", available: true }],
    },
    {
      title: "Speedo Fastskin Endurance+ (competition swimsuit)",
      url: `${storefrontBase}/products/fastskin-endurance`,
      price: "from 5499.00 INR",
      tags: ["swimming", "competition", "swimwear"],
      variants: [{ title: "32", available: true }, { title: "34", available: true }],
    },
  ];
  return all.filter((p) => p.tags.some((t) => q.includes(t)) || q.length < 3).slice(0, 4);
}
