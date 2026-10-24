// api.ts
// axios client for your FastAPI backend, through the ngrok link.

import axios from "axios";

const API_BASE = "https://revival-difficult-walk.ngrok-free.dev";

const REQUEST_TIMEOUT_MS = 45000; // the backend's own AI timeout is 30 s
const LIVE_HINT = "Answer in at most two short sentences.";
const OUTPUT_LANGUAGE_HINT =
  "Respond only in the requested language. Do not translate the requested language name.";

const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic",
  arabic: "Arabic",
  en: "English",
  english: "English",
  france: "French",
  fr: "French",
  french: "French",
};

function normalizeLanguage(language: unknown): string {
  const value = typeof language === "string" ? language.trim().toLowerCase() : "";
  return LANGUAGE_NAMES[value] ?? "English";
}

const client = axios.create({
  baseURL: API_BASE,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    "Content-Type": "application/json",
    // lets ngrok's free plan skip its browser warning page
    "ngrok-skip-browser-warning": "true",
  },
});

function httpErrorMessage(status: number, detail: unknown): string {
  if (typeof detail === "string" && detail) return detail;
  if (status === 422) return "The request was rejected. Try again.";
  if (status === 429) return "Too many requests. Please wait a moment.";
  if (status >= 500) return "The server had a problem. Please try again.";
  return `The request failed (HTTP ${status}).`;
}

// Turns any axios error into a clear sentence
function explainError(e: any): Error {
  if (axios.isAxiosError(e)) {
    if (e.response) {
      // ngrok adds this header when the tunnel itself has a problem
      const ngrokCode = e.response.headers?.["ngrok-error-code"];
      if (ngrokCode) {
        return new Error(
          `The tunnel is not working (ngrok ${ngrokCode}). The backend or ngrok is probably not running.`
        );
      }

      return new Error(httpErrorMessage(e.response.status, e.response.data?.detail));
    }
    if (e.code === "ECONNABORTED") {
      return new Error("The request timed out. Check your connection.");
    }
    return new Error("Cannot reach the server. Check the link and your internet.");
  }
  return e instanceof Error ? e : new Error(String(e));
}

// Asks the backend's /health endpoint if it is alive
export async function checkServer(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await client.get("/health", { timeout: 10000 });
    if (res.data?.status === "ok") {
      return { ok: true, message: "Server is online." };
    }
    return { ok: false, message: "The link answered, but it is not the EDITH backend." };
  } catch (e) {
    return { ok: false, message: explainError(e).message };
  }
}

export async function analyze(
  imageBase64: string,
  action: string,
  question: string,
  language: string
): Promise<string> {
  const targetLanguage = normalizeLanguage(language);
  const safeQuestion = typeof question === "string" ? question.trim() : "";
  let finalQuestion = `${safeQuestion} ${OUTPUT_LANGUAGE_HINT} Write the answer in ${targetLanguage}.`.trim();
  if (action === "describe" || action === "explain") {
    finalQuestion = (finalQuestion + " " + LIVE_HINT).trim();
  }

  try {
    const res = await client.post("/analyze", {
      image_base64: imageBase64,
      action,
      question: finalQuestion,
      language: targetLanguage,
    });

    const answer =
      typeof res.data?.answer === "string" ? res.data.answer.trim() : "";
    if (!answer) throw new Error("The server returned an empty answer.");
    return answer;
  } catch (e) {
    throw explainError(e);
  }
}