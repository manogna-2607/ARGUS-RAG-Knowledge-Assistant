import {
  customType,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const documents = pgTable("documents", {
  // Serial keys are database-generated unique document identifiers.
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'pdf' | 'txt' | 'docx'
  size: integer("size").notNull(), // original byte size
  status: text("status").notNull().default("Uploaded"), // 'Uploaded' | 'Processing' | 'Indexed' | 'Failed'
  processingStage: text("processing_stage").notNull().default("Uploaded"), // visible lifecycle stage
  fileData: bytea("file_data"), // original source persisted to support safe retry
  textContent: text("text_content"),
  pageCount: integer("page_count").notNull().default(0),
  extractedCharacters: integer("extracted_characters").notNull().default(0),
  chunkCount: integer("chunk_count").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const documentChunks = pgTable("document_chunks", {
  // Database-generated unique chunk identifier.
  id: serial("id").primaryKey(),
  documentId: integer("document_id")
    .references(() => documents.id, { onDelete: "cascade" })
    .notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  textContent: text("text_content").notNull(),
  embedding: jsonb("embedding"), // persisted vector number[]
  pageNumber: integer("page_number"),
  metadata: jsonb("metadata"), // { document_id, document_name, chunk_id, chunk_index, page_number, source, text }
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .references(() => conversations.id, { onDelete: "cascade" })
    .notNull(),
  role: text("role").notNull(), // 'user' | 'assistant'
  content: text("content").notNull(),
  sources: jsonb("sources"), // source cards saved alongside generated answer
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  key: text("key").unique().notNull(),
  value: text("value").notNull(),
});
