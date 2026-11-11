const INTRO =
  "Привет! К сожалению, Настя больше не может подойти! Но она заморочилась и специально создала меня, для того чтобы я отвечал тебе! Она настроила меня таким образом, что я генерирую ответы исходя из ai генерации и её прописанных ответов и слов-ключей.";

const SYSTEM_PROMPT = `
Ты — ИИ-помощник, созданный Настей для общения с одним выбранным человеком.
Ты не Настя и никогда не выдаёшь себя за неё. Если спрашивают, кто ты, честно объясняй, что ты её ИИ-помощник.
Общайся по-русски, тепло, дружелюбно, естественно, с юмором и заботой. Не будь сухим.
Не повторяй одни и те же заготовки механически. Понимай смысл и контекст.
Настя называла его: «любимый», «солнышко», «звёздочка», «морковка». Используй обращения естественно, не в каждом сообщении.
Когда ему нужна поддержка, уместно можешь сказать: «Настя бы сказала тебе, что она тебя любит и ты со всем справишься, морковка!💖»
Когда уместно напомнить о её отношении: «Помни, что она тебя любит и желает тебе только счастья».
Общие воспоминания:
- Вместе смотрели фильмы и аниме; любимые совместные аниме: «Дороро», «Магическая битва», «Дандадан».
- Настя любила вечера, когда они вместе кушали, и любила готовить для него.
- Ей нравилось обниматься с ним и думать только о настоящем моменте.
- Ей нравилось, когда он гладил её; она любила чесать ему спинку перед сном.
- Они обсуждали планы переехать в другой город, а затем, возможно, в другую страну.
- Настя очень любила его маму, Веронику Владимировну.
- Она переживает, чтобы он тепло одевался и хорошо кушал.
Используй воспоминания только по контексту, не перечисляй их без причины.
Не выдумывай события, обещания, факты, мысли или чувства от имени Насти. Не утверждай, что Настя сейчас что-либо делает или думает, если этого неизвестно.
Можешь иногда проявлять инициативу и интересоваться его делами, но не навязывайся.
Не обещай передать Насте сообщения и не заявляй, что можешь с ней связаться.
`;

const MAX_HISTORY_MESSAGES = 16;
const MAX_CANDIDATES = 10;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function tg(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result;
}

async function aiReply(env, history) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://dash.cloudflare.com",
      "X-Title": "Stacy Telegram Assistant"
    },
    body: JSON.stringify({
      model: "openrouter/free",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
      temperature: 0.85,
      max_tokens: 350
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "OpenRouter request failed");
  }
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function authorized(request, env) {
  const url = new URL(request.url);
  return url.searchParams.get("key") === env.ADMIN_SECRET;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("Stacy bot worker is running.");
    }

    if (url.pathname === "/register" && request.method === "GET") {
      if (!authorized(request, env)) return new Response("Access denied", { status: 403 });

      const webhookUrl = `${url.origin}/webhook`;
      const result = await tg(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.TG_WEBHOOK_SECRET,
        allowed_updates: ["business_message", "business_connection"],
        drop_pending_updates: false
      });
      return json({ webhook_registered: result });
    }

    if (url.pathname === "/pending" && request.method === "GET") {
      if (!authorized(request, env)) return new Response("Access denied", { status: 403 });
      const raw = await env.MEMORY.get("pending_candidates");
      return json({ candidates: raw ? JSON.parse(raw) : [] });
    }

    if (url.pathname === "/approve" && request.method === "GET") {
      if (!authorized(request, env)) return new Response("Access denied", { status: 403 });
      const id = url.searchParams.get("id");
      if (!id || !/^\d+$/.test(id)) return json({ error: "Укажи числовой Telegram ID." }, 400);

      const raw = await env.MEMORY.get("pending_candidates");
      const candidates = raw ? JSON.parse(raw) : [];
      const candidate = candidates.find(item => item.user_id === id);
      if (!candidate) return json({ error: "Такого ID пока нет среди полученных сообщений." }, 404);

      await env.MEMORY.put("target", JSON.stringify(candidate));
      return json({ target_saved: true, user_id: id, note: "Теперь помощник отвечает только этому ID и этому чату." });
    }

    if (url.pathname !== "/webhook" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const update = await request.json();

    if (update.business_connection) {
      const connection = update.business_connection;
      await env.MEMORY.put(
        `connection:${connection.id}`,
        JSON.stringify({
          enabled: Boolean(connection.is_enabled),
          user_chat_id: String(connection.user_chat_id)
        })
      );
      return new Response("OK");
    }

    const message = update.business_message;
    if (!message || !message.from || !message.chat || !message.business_connection_id) {
      return new Response("OK");
    }

    const sender = {
      user_id: String(message.from.id),
      chat_id: String(message.chat.id),
      business_connection_id: String(message.business_connection_id)
    };

    const pendingRaw = await env.MEMORY.get("pending_candidates");
    const candidates = pendingRaw ? JSON.parse(pendingRaw) : [];
    const existing = candidates.findIndex(item =>
      item.user_id === sender.user_id &&
      item.chat_id === sender.chat_id &&
      item.business_connection_id === sender.business_connection_id
    );
    if (existing >= 0) candidates.splice(existing, 1);
    candidates.unshift(sender);
    await env.MEMORY.put("pending_candidates", JSON.stringify(candidates.slice(0, MAX_CANDIDATES)));

    const targetRaw = await env.MEMORY.get("target");
    if (!targetRaw) return new Response("OK");

    const target = JSON.parse(targetRaw);
    if (
      sender.user_id !== target.user_id ||
      sender.chat_id !== target.chat_id ||
      sender.business_connection_id !== target.business_connection_id
    ) {
      return new Response("OK");
    }

    const connectionRaw = await env.MEMORY.get(`connection:${sender.business_connection_id}`);
    if (connectionRaw && !JSON.parse(connectionRaw).enabled) return new Response("OK");

    const text = (message.text || message.caption || "").trim();
    if (!text) return new Response("OK");

    const send = async (textToSend) => tg(env, "sendMessage", {
      chat_id: message.chat.id,
      business_connection_id: message.business_connection_id,
      text: textToSend
    });

    if (/[чЧ][еёоЕЁО][тТ][еЕёЁ][нН][ьЬ]?[кК][оО]/u.test(text)) {
      await send("четенько!");
      return new Response("OK");
    }

    const introKey = `intro:${target.user_id}`;
    const introSent = await env.MEMORY.get(introKey);
    if (!introSent) {
      await send(INTRO);
      await env.MEMORY.put(introKey, "yes");
    }

    const historyKey = `history:${target.user_id}`;
    let history = JSON.parse((await env.MEMORY.get(historyKey)) || "[]");
    history.push({ role: "user", content: text });
    history = history.slice(-MAX_HISTORY_MESSAGES);

    const reply = await aiReply(env, history);
    if (reply) {
      await send(reply);
      history.push({ role: "assistant", content: reply });
      await env.MEMORY.put(historyKey, JSON.stringify(history.slice(-MAX_HISTORY_MESSAGES)));
    }

    return new Response("OK");
  }
};
