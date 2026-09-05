# ARGUS — AI Knowledge Engine

> A grounded Retrieval-Augmented Generation (RAG) knowledge assistant that transforms documents into searchable knowledge and provides evidence-backed answers with source citations.

![ARGUS](https://img.shields.io/badge/ARGUS-AI%20Knowledge%20Engine-00D9FF)
![Next.js](https://img.shields.io/badge/Next.js-16-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Database-336791)
![RAG](https://img.shields.io/badge/Architecture-RAG-purple)

---

## Overview

**ARGUS** is an AI-powered Knowledge Assistant designed to answer questions from user-provided documents rather than relying purely on a general-purpose language model.

The system implements an end-to-end **Retrieval-Augmented Generation (RAG)** pipeline:

**Document → Extraction → Cleaning → Chunking → Embeddings → Vector Storage → Retrieval → Grounded Answer**

ARGUS is designed with a strong emphasis on:

- Grounded responses
- Source transparency
- Document persistence
- Hybrid retrieval
- Conversational memory
- Knowledge-base management
- Local/offline fallback capabilities

The goal is to make AI responses **traceable, explainable, and connected to the user's actual knowledge base**.

---

## Key Features

### 📚 Knowledge Base Management

- Upload PDF, TXT, and DOCX documents
- Automatic text extraction
- Document indexing and processing
- Recursive overlapping text chunking
- Document status tracking
- Re-indexing support
- Document deletion
- Persistent document storage

### 🔎 Hybrid RAG Retrieval

ARGUS combines multiple retrieval strategies to improve relevant context selection:

- Vector similarity retrieval
- Lexical keyword retrieval
- Hybrid relevance ranking
- Configurable similarity thresholds
- Top-K context retrieval

This allows ARGUS to handle both semantic and exact-term queries effectively.

### 🧠 Grounded AI Responses

The assistant generates responses based on retrieved document context.

Instead of simply answering from general knowledge, ARGUS provides:

- Relevant source passages
- Document names
- Page numbers
- Chunk references
- Retrieval information

This makes the generated response easier to verify.

### 🔗 Source Citations

Every grounded response can expose the retrieved evidence through the **RAG Citations Inspector**.

Users can inspect:

- Retrieved segments
- Relevance scores
- Source document
- Page number
- Chunk number
- Retrieved text

### 💬 Persistent Conversations

ARGUS supports saved conversations so users can:

- Create new chats
- Continue previous conversations
- Persist messages
- Clear conversations
- Delete individual conversations

### ⚙️ Settings

The application provides configurable AI provider settings and supports local fallback functionality.

### 📊 Control Tower Dashboard

The dashboard provides a high-level view of the knowledge engine:

- Indexed documents
- Vector chunks
- Failed documents
- Active conversations
- Ingestion pipeline status

---

# System Architecture

```text
                    ┌─────────────────────┐
                    │   User Documents    │
                    │ PDF / TXT / DOCX    │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Text Extraction   │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Text Cleaning     │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Recursive Chunking  │
                    │    + Overlap        │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │    Embeddings       │
                    │ Local / API based   │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   PostgreSQL DB      │
                    │ Documents + Chunks  │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Hybrid Retrieval    │
                    │ Vector + Lexical    │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Retrieved Context   │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Grounded LLM Answer │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Answer + Citations  │
                    └─────────────────────┘
