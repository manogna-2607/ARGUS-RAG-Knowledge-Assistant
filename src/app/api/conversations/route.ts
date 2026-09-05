import { NextRequest, NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db";
import { conversations, messages } from "../../../db/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const list = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        createdAt: conversations.createdAt,
        messageCount: sql<number>`count(${messages.id})::int`,
        lastMessageAt: sql<Date | null>`max(${messages.createdAt})`,
      })
      .from(conversations)
      .leftJoin(messages, eq(messages.conversationId, conversations.id))
      .groupBy(conversations.id)
      .orderBy(desc(sql`coalesce(max(${messages.createdAt}), ${conversations.createdAt})`));

    return NextResponse.json({ success: true, conversations: list });
  } catch (error: unknown) {
    console.error("Failed to list conversations:", error);
    return NextResponse.json({ success: false, error: "Unable to load conversations. Please refresh and try again." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { title?: unknown };
    const requestedTitle = typeof body.title === "string" ? body.title.trim() : "";
    const title = (requestedTitle || "New Chat").slice(0, 100);

    const [conversation] = await db.insert(conversations).values({ title }).returning();
    return NextResponse.json({ success: true, conversation });
  } catch (error: unknown) {
    console.error("Failed to create conversation:", error);
    return NextResponse.json({ success: false, error: "Unable to create a new conversation. Please try again." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const idValue = new URL(request.url).searchParams.get("id");

    // This preserves the existing clear-all endpoint for the Clear All control.
    if (!idValue) {
      await db.delete(conversations);
      return NextResponse.json({ success: true, message: "All conversations were deleted." });
    }

    const conversationId = Number(idValue);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return NextResponse.json({ success: false, error: "A valid conversation ID is required." }, { status: 400 });
    }

    const deleted = await db
      .delete(conversations)
      .where(eq(conversations.id, conversationId))
      .returning({ id: conversations.id });

    if (deleted.length === 0) {
      return NextResponse.json(
        { success: false, error: "This conversation was already deleted or is unavailable." },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, id: deleted[0].id, message: "Conversation deleted." });
  } catch (error: unknown) {
    console.error("Failed to delete conversation:", error);
    return NextResponse.json(
      { success: false, error: "Unable to delete conversation. Please try again." },
      { status: 500 }
    );
  }
}
