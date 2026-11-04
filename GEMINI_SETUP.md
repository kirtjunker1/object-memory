# Object Memory — Gemini setup

This project sends room photos to Google Gemini from its server function. The API key is read only on the server from `GEMINI_API_KEY`; it is not placed in browser code.

## Configure the key in Vercel

1. Open your Vercel dashboard and select the Object Memory project.
2. Open **Settings → Environment Variables**.
3. Add a variable named `GEMINI_API_KEY`.
4. Paste your Gemini API key as the value. Do not add quotation marks or a `VITE_` prefix.
5. Select the environments you use (at least **Production**; also Preview if you deploy previews), then save.
6. Redeploy the latest deployment so the server receives the new variable.

Never commit the API key to GitHub, put it in an HTML file, or send it in chat.

## Gemini model

Object identification uses `gemini-2.5-flash-lite` with image input and JSON output. Google's free tier has usage limits and may change. Check current pricing and limits before relying on it for heavy usage:
https://ai.google.dev/gemini-api/docs/pricing

Google AI Studio API keys:
https://aistudio.google.com/app/apikey

Keep the key restricted to the Gemini API where Google's key-management options allow it. If a newly created key is an authorization key, follow the current AI Studio instructions for using it with the Gemini API.
