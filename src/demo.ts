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

// String.raw so regex backslashes in the client script (\s, \n, \/, ...) survive the
// template literal instead of being processed away. PAGE has no ${} interpolation.
const PAGE = String.raw`<!doctype html>
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
  .msg{flex:shrink:0;max-width:82%;padding:8px 11px;border-radius:10px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 1px .5px rgba(0,0,0,.13)}
  .me{align-self:flex-end;background:var(--me)}
  .bot{align-self:flex-start;background:var(--bot)}
  .sys{flex-shrink:0;align-self:center;background:#fff3c4;color:#5b4600;font-size:12px;padding:4px 10px;border-radius:8px;text-align:center}
  .carousel{flex-shrink:0;align-self:flex-start;display:flex;gap:8px;overflow-x:auto;max-width:100%;padding:2px 2px 8px}
  .card{flex:0 0 228px;background:var(--bot);border-radius:12px;overflow:hidden;box-shadow:0 1px 1px rgba(0,0,0,.15)}
  .card img{display:block;width:calc(100% - 12px);height:158px;margin:6px 6px 0;border-radius:8px;object-fit:cover;background:#eee}
  .card .cb{padding:8px 11px 10px}
  .card .ct{font-size:14.5px;font-weight:600;line-height:1.3}
  .card .crow{display:flex;align-items:center;gap:8px;margin-top:6px}
  .card .cp{font-size:13px;color:#0b6b5f;font-weight:600}
  .card .cs{font-size:11px;padding:1px 8px;border-radius:10px;white-space:nowrap}
  .card .cs.in{background:#d9f5e3;color:#0b6b2f}
  .card .cs.out{background:#fde2e1;color:#8a1c17}
  .card a.cv{display:block;text-align:center;border-top:1px solid #edecea;padding:11px;color:#0a7cff;text-decoration:none;font-size:14px;font-weight:600}
  .bot strong{font-weight:600}.bot em{font-style:italic}.bot del{text-decoration:line-through}
  .bot code{background:#eef0f0;padding:0 4px;border-radius:3px;font-family:Consolas,monospace;font-size:13px}
  .bot a{color:#128c7e;word-break:break-all}
  .bot ul,.bot ol{margin:3px 0 3px 20px;padding:0}.bot li{margin:2px 0}
  .bot .h{font-weight:600;margin:3px 0 1px}
  .bot .q{border-left:3px solid #cfd8d3;padding-left:8px;color:#555;margin:3px 0}
  .bot div+div{margin-top:2px}
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
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function inline(s){s=esc(s);
    s=s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    s=s.replace(/(^|[^"'>])(https?:\/\/[^\s<]+)/g,'$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
    s=s.replace(/(^|[\s(*_~])\*([^*\n]+)\*(?=[\s).,!?:*_~]|$)/g,'$1<strong>$2</strong>');
    s=s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:]|$)/g,'$1<em>$2</em>');
    s=s.replace(/~([^~\n]+)~/g,'<del>$1</del>');
    s=s.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
    return s;}
  function renderMd(t){var lines=String(t).split(/\n/),html='',list=null;
    function cl(){if(list){html+='</'+list+'>';list=null;}}
    lines.forEach(function(ln){
      if(/^\s*([-*•·])\s+/.test(ln)){if(list!=='ul'){cl();html+='<ul>';list='ul';}html+='<li>'+inline(ln.replace(/^\s*[-*•·]\s+/,''))+'</li>';}
      else if(/^\s*\d+[.)]\s+/.test(ln)){if(list!=='ol'){cl();html+='<ol>';list='ol';}html+='<li>'+inline(ln.replace(/^\s*\d+[.)]\s+/,''))+'</li>';}
      else if(/^\s*#{1,6}\s+/.test(ln)){cl();html+='<div class="h">'+inline(ln.replace(/^\s*#{1,6}\s+/,''))+'</div>';}
      else if(/^\s*>\s?/.test(ln)){cl();html+='<div class="q">'+inline(ln.replace(/^\s*>\s?/,''))+'</div>';}
      else if(ln.trim()===''){cl();}
      else{cl();html+='<div>'+inline(ln)+'</div>';}
    });cl();return html;}
  function add(text,cls){var d=document.createElement('div');d.className='msg '+cls;if(cls==='bot'){d.innerHTML=renderMd(text);}else{d.textContent=text;}log.appendChild(d);log.scrollTop=log.scrollHeight;}
  function sys(t){var d=document.createElement('div');d.className='sys';d.textContent=t;log.appendChild(d);log.scrollTop=log.scrollHeight;}
  function card(c,parent){
    var d=document.createElement('div');d.className='card';
    if(c.image){var im=document.createElement('img');im.src=c.image;im.alt=c.title;im.onerror=function(){im.remove();};d.appendChild(im);}
    var b=document.createElement('div');b.className='cb';
    var t=document.createElement('div');t.className='ct';t.textContent=c.title;b.appendChild(t);
    var row=document.createElement('div');row.className='crow';
    if(c.price){var p=document.createElement('span');p.className='cp';p.textContent=c.price;row.appendChild(p);}
    var s=document.createElement('span');s.className='cs '+(c.inStock?'in':'out');s.textContent=c.inStock?'In stock':'Out of stock';row.appendChild(s);
    b.appendChild(row);d.appendChild(b);
    var a=document.createElement('a');a.className='cv';a.href=c.url;a.target='_blank';a.rel='noopener';a.textContent='View product ↗';d.appendChild(a);
    (parent||log).appendChild(d);log.scrollTop=log.scrollHeight;
  }
  async function send(){var t=input.value.trim();if(!t)return;input.value='';add(t,'me');typing.textContent='Achi is typing…';
    try{var r=await fetch('/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:t})});
      var j=await r.json();typing.textContent='';add(j.reply,'bot');
      if(j.cards&&j.cards.length){var car=document.createElement('div');car.className='carousel';j.cards.forEach(function(c){card(c,car);});log.appendChild(car);log.scrollTop=log.scrollHeight;}
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
    res.json({ reply: result.text, cards: result.cards ?? [] });
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
