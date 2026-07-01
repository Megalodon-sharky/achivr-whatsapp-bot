import type { Turn } from "./claude";

// In-memory session store, keyed by customer WhatsApp number.
// Fine for a single-process reference build. For production / multiple
// instances, swap this for Redis (same interface).

export type Session = {
  phone: string; // the customer's WhatsApp number (E.164-ish, no +)
  history: Turn[];
  handoff: boolean; // true once a human owns the conversation; bot stays quiet
  greeted: boolean; // have we shown the menu yet this session?
};

const MAX_TURNS = 20; // cap history so token cost stays bounded
const sessions = new Map<string, Session>();

export function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { phone: id, history: [], handoff: false, greeted: false };
    sessions.set(id, s);
  }
  return s;
}

export function pushTurn(id: string, turn: Turn): void {
  const s = getSession(id);
  s.history.push(turn);
  if (s.history.length > MAX_TURNS) {
    s.history.splice(0, s.history.length - MAX_TURNS);
  }
}

export function markHandoff(id: string): void {
  getSession(id).handoff = true;
}

// Hand the conversation back to the bot — call this when the human agent is done
// (e.g. from the BSP's "return to bot" action) so the bot resumes for this customer.
export function clearHandoff(id: string): void {
  getSession(id).handoff = false;
}
