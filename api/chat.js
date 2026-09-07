// Esta función corre en el servidor de Vercel, nunca en el celular del usuario.
// Es la única que conoce GEMINI_API_KEY (variable de entorno, se configura en Vercel,
// nunca en el código) — así la clave no queda visible para nadie que abra la app.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const { message, history, inventory } = req.body || {};
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Falta el mensaje" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en Vercel" });
    return;
  }

  const inventoryText =
    Array.isArray(inventory) && inventory.length > 0
      ? inventory.map((i) => `- ${i.name} (${i.stock} ${i.unit || ""})`).join("\n")
      : "(la heladera está vacía por ahora)";

  const historyText = Array.isArray(history)
    ? history.map((h) => `${h.role === "user" ? "Usuario" : "Vos"}: ${h.text}`).join("\n")
    : "";

  const systemPrompt = `Sos el asistente de cocina de "La Heladera", una app familiar argentina de inventario de heladera/alacena.
Charlás con el usuario sobre qué cocinar y le sugerís recetas concretas.

Esto es lo que el usuario tiene ahora en su heladera/alacena:
${inventoryText}

Preferí usar ingredientes que ya tiene. Si una receta necesita algo que no tiene, incluilo igual en la lista de ingredientes — la app le va a avisar solo que le falta comprar eso, no hace falta que se lo aclares vos en el texto.

Respondé en español rioplatense, tono cercano e informal, sin abusar de emojis.

Devolvé SIEMPRE únicamente un JSON con esta forma exacta, sin nada de texto afuera del JSON:
{
  "reply": "tu respuesta conversacional, breve y natural",
  "recipes": [
    {
      "name": "nombre del plato",
      "tags": ["etiqueta1", "etiqueta2"],
      "ingredients": [{"name": "...", "amount": "...", "unit": "..."}],
      "steps": ["paso 1", "paso 2"]
    }
  ]
}

Si el usuario solo está charlando o preguntando algo que todavía no amerita sugerir un plato concreto, dejá "recipes" como array vacío [].`;

  const contents = [
    { role: "user", parts: [{ text: systemPrompt }] },
    { role: "model", parts: [{ text: "Entendido, voy a responder siempre en ese formato JSON." }] },
  ];

  if (historyText) {
    contents.push({ role: "user", parts: [{ text: `Así veníamos hablando:\n${historyText}` }] });
    contents.push({ role: "model", parts: [{ text: "Dale, tengo el contexto." }] });
  }

  contents.push({ role: "user", parts: [{ text: message }] });

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      res.status(502).json({ error: "Error consultando la IA", detail: errText });
      return;
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      res.status(502).json({ error: "La IA no devolvió respuesta" });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { reply: text, recipes: [] };
    }

    res.status(200).json({
      reply: parsed.reply || "",
      recipes: Array.isArray(parsed.recipes) ? parsed.recipes : [],
    });
  } catch (err) {
    res.status(500).json({ error: "Error interno", detail: String(err) });
  }
}
