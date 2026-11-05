# Object Memory — Vision setup

This project sends room photos to a vision model from its server function. Keys are read only on the server; they are never placed in browser code.

## Gemini (primary)

1. Open your host dashboard (e.g. Vercel) and select the Object Memory project.
2. Open **Settings → Environment Variables**.
3. Add `GEMINI_API_KEY` with your Gemini API key (no quotes, no `VITE_` prefix).
4. Select Production (and Preview if you use it), save, then redeploy.

Get a key: https://aistudio.google.com/app/apikey

## OpenRouter (free fallback)

When Gemini is overloaded (503) or rate-limited (429), the app automatically tries free vision models on OpenRouter.

1. Create a free account at https://openrouter.ai
2. Create an API key at https://openrouter.ai/keys
3. Add environment variable `OPENROUTER_API_KEY` with that key.
4. Redeploy so the server receives it.

Free OpenRouter models are rate-limited (about 50 requests/day without purchased credits, higher after a small one-time credit purchase). See OpenRouter docs for current limits.

## Models used

- **Gemini (first):** `gemini-3.5-flash-lite`, then `gemini-3.8-flash`, then `gemini-2.5-flash-lite`
- **OpenRouter (fallback):** `google/gemma-4-31b-it:free`, `google/gemma-4-26b-a4b-it:free`, `nvidia/nemotron-3.5-super-vl:free`

Never commit API keys to GitHub or put them in client code.
