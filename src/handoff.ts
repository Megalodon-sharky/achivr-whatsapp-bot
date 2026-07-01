import { config } from "./config";
import type { Turn } from "./claude";

// Human handoff. The caller already set session.handoff = true (markHandoff), so the bot
// stays silent for this customer. Here we surface the chat to a human in Wati's shared
// inbox: if WATI_AGENT_EMAIL is set we assign the conversation to that operator, otherwise
// we leave it unassigned for Wati's own auto-routing to pick up. Either way the human
// replies inside the same WhatsApp thread via the Wati inbox app. When the agent is done,
// a Wati "return to bot" automation should hit our endpoint to call clearHandoff(from).

export async function notifyHumanAgent(
  from: string,
  reason: string,
  summary: string,
  history: Turn[],
): Promise<void> {
  console.log("=== HUMAN HANDOFF ===");
  console.log("customer:", from);
  console.log("reason:  ", reason);
  console.log("summary: ", summary);
  console.log("last msg:", history[history.length - 1]?.content ?? "");
  console.log("=====================");

  if (!config.wati.agentEmail) return; // leave unassigned → Wati auto-routing handles it

  const url =
    `${config.wati.apiEndpoint}/api/v1/assignOperator` +
    `?email=${encodeURIComponent(config.wati.agentEmail)}` +
    `&whatsappNumber=${encodeURIComponent(from)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.wati.accessToken}` },
  });
  if (!res.ok) {
    console.error("Wati assignOperator failed:", res.status, await res.text().catch(() => ""));
  }
}
