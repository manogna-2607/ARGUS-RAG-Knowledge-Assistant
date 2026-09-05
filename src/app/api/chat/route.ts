import { NextRequest, NextResponse } from "next/server";
import { asc, count, eq } from "drizzle-orm";
import { db } from "../../../db";
import { conversations, messages } from "../../../db/schema";
import { loadRagSettings } from "../../../lib/rag/config";
import { generateGroundedAnswer } from "../../../lib/rag/llm";
import { retrieveRelevantChunks } from "../../../lib/rag/retrieval";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const conversationId = Number(new URL(request.url).searchParams.get("conversationId"));
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return NextResponse.json({ success: false, error: "A valid conversation ID is required." }, { status: 400 });
    }

    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conversation) {
      return NextResponse.json({ success: false, error: "This conversation no longer exists." }, { status: 404 });
    }

    const history = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));

    return NextResponse.json({ success: true, messages: history });
  } catch (error: unknown) {
    console.error("Failed to load chat history:", error);
    return NextResponse.json({ success: false, error: "Failed to load chat history." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const conversationId = Number(new URL(request.url).searchParams.get("conversationId"));
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return NextResponse.json({ success: false, error: "A valid conversation ID is required." }, { status: 400 });
    }

    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conversation) {
      return NextResponse.json({ success: false, error: "This conversation no longer exists." }, { status: 404 });
    }

    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    return NextResponse.json({ success: true, conversationId, message: "Chat messages cleared." });
  } catch (error: unknown) {
    console.error("Failed to clear chat history:", error);
    return NextResponse.json({ success: false, error: "Unable to clear chat history. Please try again." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { conversationId?: unknown; message?: unknown };
    const conversationId = Number(body.conversationId);
    const question = typeof body.message === "string" ? body.message.trim() : "";

    if (!Number.isInteger(conversationId) || conversationId <= 0 || !question) {
      return NextResponse.json(
        { success: false, error: "A conversation and non-empty message are required." },
        { status: 400 }
      );
    }

    const [conversation] = await db
      .select({ id: conversations.id, title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conversation) {
      return NextResponse.json({ success: false, error: "This conversation no longer exists." }, { status: 404 });
    }

    const [userMessage] = await db
      .insert(messages)
      .values({ conversationId, role: "user", content: question, sources: null })
      .returning();

    // Complete RAG sequence: preprocess → query embedding → persisted cosine
    // search → top-K context → grounded generation → source persistence.
    const config = await loadRagSettings();
    const apiKey =
      config.provider === "openai"
        ? config.openAIKey
        : config.provider === "gemini"
          ? config.geminiKey
          : undefined;
    const contexts = await retrieveRelevantChunks(question, {
      provider: config.provider,
      apiKey,
      limit: config.topK,
    });
    const generated = await generateGroundedAnswer(question, contexts, {
      provider: config.provider,
      apiKey,
      temperature: config.temperature,
      systemPrompt: config.systemPrompt,
    });

    const [assistantMessage] = await db
      .insert(messages)
      .values({
        conversationId,
        role: "assistant",
        content: generated.answer,
        sources: generated.usedSources,
      })
      .returning();

    const [{ totalMessages }] = await db
      .select({ totalMessages: count() })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    let updatedTitle: string | null = null;
    if (totalMessages <= 2 && conversation.title === "New Chat") {
      updatedTitle = question.length > 36 ? `${question.slice(0, 33)}...` : question;
      updatedTitle = updatedTitle.replace(/["'#*`]/g, "");
      await db.update(conversations).set({ title: updatedTitle }).where(eq(conversations.id, conversationId));
    }

    return NextResponse.json({ success: true, userMessage, assistantMessage, updatedTitle });
  } catch (error: unknown) {
    console.error("Failed to process chat message:", error);
    return NextResponse.json({ success: false, error: "ARGUS could not process that question." }, { status: 500 });
  }
}
