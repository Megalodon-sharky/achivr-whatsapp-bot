import express, { type Request, type Response } from "express";
import { runAgent } from "./claude";
import { getSession, pushTurn } from "./sessions";

// Local demo harness — NO WhatsApp number, NO Wati. Runs the REAL bot (Claude +
// mock Shopify) behind a tiny chat page so you can show the flow to anyone.
//   1) cp .env.example .env, set ANTHROPIC_API_KEY (leave WATI_*/SHOPIFY_* as the
//      shipped placeholders; USE_MOCK_SHOPIFY=true means no store is needed)
//   2) npm run demo   ->   open http://localhost:3001
// Replies render on the page instead of being sent over WhatsApp; the prompt, tools,
// order lookups (mock) and escalation are the exact production code path.

const DEMO_PHONE = "919000000001"; // fake customer; mock Shopify ignores the value

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Achivr Support — demo</title>
<style>
  :root{--bg:#e5ddd5;--head:#075e54;--me:#dcf8c6;--bot:#fff}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0b141a;display:flex;justify-content:center}
  .phone{width:100%;max-width:460px;height:100vh;display:flex;flex-direction:column;background:var(--bg)}
  .head{background:var(--head);color:#fff;padding:12px 16px;display:flex;align-items:center;gap:10px}
  .head .a{width:38px;height:38px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-weight:700}
  .head b{font-size:15px}.head span{font-size:12px;opacity:.8;display:block}
  .head .rst{margin-left:auto;background:transparent;border:1px solid rgba(255,255,255,.5);color:#fff;border-radius:6px;padding:5px 9px;font-size:12px;cursor:pointer}
  .log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
  .msg{max-width:82%;padding:8px 11px;border-radius:10px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 1px .5px rgba(0,0,0,.13)}
  .me{align-self:flex-end;background:var(--me)}
  .bot{align-self:flex-start;background:var(--bot)}
  .sys{align-self:center;background:#fff3c4;color:#5b4600;font-size:12px;padding:4px 10px;border-radius:8px;text-align:center}
  .chips{display:flex;gap:6px;flex-wrap:wrap;padding:6px 14px}
  .chips button{background:#fff;border:1px solid #cfd8d3;border-radius:16px;padding:6px 10px;font-size:12px;cursor:pointer}
  .bar{display:flex;gap:8px;padding:10px;background:#f0f0f0}
  .bar input{flex:1;border:1px solid #ccc;border-radius:20px;padding:10px 14px;font-size:14px;outline:none}
  .bar button{background:var(--head);color:#fff;border:none;border-radius:50%;width:44px;height:44px;font-size:18px;cursor:pointer}
  .typing{font-size:12px;color:#667;padding:0 14px 6px;min-height:16px}
</style></head>
<body><div class="phone">
  <div class="head"><div class="a">A</div><div><b>Achivr Sports</b><span>support bot · demo</span></div>
    <button class="rst" onclick="reset()">Reset</button></div>
  <div class="log" id="log"></div>
  <div class="typing" id="typing"></div>
  <div class="chips" id="chips"></div>
  <div class="bar"><input id="in" placeholder="Type a message" autocomplete="off"/>
    <button onclick="send()" aria-label="send">&#10148;</button></div>
</div>
<script>
  var log=document.getElementById('log'),input=document.getElementById('in'),typing=document.getElementById('typing');
  var seeds=["When will I get my order?","Is COD available?","Recommend a badminton racquet for an attacker","How do I return a product?","I want to talk to a human"];
  function chips(){var c=document.getElementById('chips');c.innerHTML='';seeds.forEach(function(s){var b=document.createElement('button');b.textContent=s;b.onclick=function(){input.value=s;send();};c.appendChild(b);});}
  function add(text,cls){var d=document.createElement('div');d.className='msg '+cls;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;}
  function sys(t){var d=document.createElement('div');d.className='sys';d.textContent=t;log.appendChild(d);log.scrollTop=log.scrollHeight;}
  async function send(){var t=input.value.trim();if(!t)return;input.value='';add(t,'me');typing.textContent='Achi is typing…';
    try{var r=await fetch('/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:t})});
      var j=await r.json();typing.textContent='';add(j.reply,'bot');
      if(j.handoff){sys('handed off to a human — in production this lands in the Wati inbox');}}
    catch(e){typing.textContent='';sys('Error contacting the bot.');}}
  async function reset(){await fetch('/demo/reset',{method:'POST'});log.innerHTML='';sys('New conversation. Say hi or tap a suggestion.');}
  input.addEventListener('keydown',function(e){if(e.key==='Enter')send();});
  chips();sys('Demo — no real WhatsApp number. Say hi or tap a suggestion.');
</script></body></html>`;

const app = express();
app.use(express.json());

app.get("/", (_req: Request, res: Response) => {
  res.type("html").send(PAGE);
});

app.post("/demo", async (req: Request, res: Response) => {
  const text = String(req.body?.message ?? "").trim().slice(0, 1000);
  if (!text) {
    res.json({ reply: "Type a message to start." });
    return;
  }
  try {
    pushTurn(DEMO_PHONE, { role: "user", content: text });
    const session = getSession(DEMO_PHONE);
    const result = await runAgent(session.history, { session });
    if (result.type === "handoff") {
      res.json({
        reply:
          (result.text || "I'm connecting you to a human agent now.") +
          `\n\n— handoff to human · reason: ${result.reason}`,
        handoff: true,
      });
      return;
    }
    pushTurn(DEMO_PHONE, { role: "assistant", content: result.text });
    res.json({ reply: result.text });
  } catch (e: any) {
    console.error("demo error:", e);
    res.status(500).json({ reply: `Error: ${e?.message ?? "unknown"}` });
  }
});

// Reset the demo conversation (handy between run-throughs).
app.post("/demo/reset", (_req: Request, res: Response) => {
  const s = getSession(DEMO_PHONE);
  s.history.length = 0;
  s.greeted = false;
  s.handoff = false;
  res.json({ ok: true });
});

const PORT = Number(process.env.DEMO_PORT ?? 3001);
app.listen(PORT, () => console.log(`Achivr bot DEMO chat → http://localhost:${PORT}`));
