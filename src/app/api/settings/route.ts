import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { settings } from "../../../db/schema";
import { DEFAULT_RAG_SETTINGS, loadPublicSettings } from "../../../lib/rag/config";

export const dynamic = "force-dynamic";

const ALLOWED_KEYS = Object.keys(DEFAULT_RAG_SETTINGS);
const SECRET_KEYS = new Set(["openai_api_key", "gemini_api_key"]);

function isValidProvider(value: string) {
  return value === "local" || value === "openai" || value === "gemini";
}

export async function GET() {
  try {
    const publicSettings = await loadPublicSettings();
    return NextResponse.json({
      success: true,
      settings: publicSettings,
      sanitizedSettings: publicSettings,
    });
  } catch (error: unknown) {
    console.error("Failed to load settings:", error);
    return NextResponse.json({ success: false, error: "Failed to load settings." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;

    if (body.llm_provider !== undefined && !isValidProvider(String(body.llm_provider))) {
      return NextResponse.json({ success: false, error: "Invalid AI provider." }, { status: 400 });
    }

    for (const key of ALLOWED_KEYS) {
      if (body[key] === undefined) continue;
      const value = String(body[key]).trim();

      // Keys are write-only: a blank client value means "keep existing key",
      // not erase it after the Settings page reloads.
      if (SECRET_KEYS.has(key) && !value) continue;

      const existing = await db.select({ id: settings.id }).from(settings).where(eq(settings.key, key)).limit(1);
      if (existing.length > 0) {
        await db.update(settings).set({ value }).where(eq(settings.key, key));
      } else {
        await db.insert(settings).values({ key, value });
      }
    }

    return NextResponse.json({ success: true, settings: await loadPublicSettings() });
  } catch (error: unknown) {
    console.error("Failed to save settings:", error);
    return NextResponse.json({ success: false, error: "Failed to save settings." }, { status: 500 });
  }
}
