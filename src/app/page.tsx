"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  FileText,
  MessageSquare,
  Sliders,
  LayoutDashboard,
  UploadCloud,
  Trash2,
  Send,
  Sparkles,
  Search,
  CheckCircle,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Plus,
  BookOpen,
  ArrowRight,
  Database,
  HelpCircle,
  Clock,
  CornerDownRight,
  Settings as SettingsIcon,
  Maximize2,
  ShieldCheck,
  Code
} from "lucide-react";

const ACTIVE_CONVERSATION_STORAGE_KEY = "argus.activeConversationId";

function formatRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return "Just now";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "Recently";

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
}

type DocumentStatus = "Uploaded" | "Processing" | "Indexed" | "Failed";

type KnowledgeDocument = {
  id: number;
  name: string;
  type: "pdf" | "docx" | "txt" | string;
  size: number;
  status: DocumentStatus;
  processingStage: string;
  pageCount: number;
  extractedCharacters: number;
  chunkCount: number;
  errorMessage: string | null;
  createdAt: string;
  hasSource: boolean;
};

type RetrievedSource = {
  chunkId: number;
  documentId: number;
  documentName: string;
  documentType: string;
  chunkIndex: number;
  pageNumber: number | null;
  similarity: number;
  textContent: string;
  retrievalMethod?: "vector" | "lexical" | "hybrid" | "contextual";
  vectorSimilarity?: number;
  lexicalScore?: number;
};

type ChatMessage = {
  id: number | string;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  sources?: RetrievedSource[] | null;
  createdAt: string;
};

type Conversation = {
  id: number;
  title: string;
  createdAt: string;
  messageCount?: number;
  lastMessageAt?: string | null;
};

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "documents" | "chat" | "settings">("dashboard");
  
  // Dashboard / General states
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [documentStatistics, setDocumentStatistics] = useState({
    indexedDocuments: 0,
    failedDocuments: 0,
    vectorChunks: 0,
  });
  const [searchQuery, setSearchQuery] = useState("");
  
  // Settings states
  const [config, setConfig] = useState({
    llm_provider: "local",
    openai_api_key: "",
    gemini_api_key: "",
    chunk_size: "3200",
    chunk_overlap: "500",
    top_k: "5",
    temperature: "0.2",
    system_prompt: ""
  });
  const [sanitizedConfig, setSanitizedConfig] = useState({
    llm_provider: "local",
    openai_api_key: "",
    gemini_api_key: "",
    chunk_size: "3200",
    chunk_overlap: "500",
    top_k: "5",
    temperature: "0.2",
    system_prompt: ""
  });
  const [apiKeyStatus, setApiKeyStatus] = useState({ openai: false, gemini: false });

  // UX states
  const [isLoadingDocs, setIsLoadingDocs] = useState(false);
  const [isLoadingConvs, setIsLoadingConvs] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  const [isDeletingConversation, setIsDeletingConversation] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [activeDocumentActionId, setActiveDocumentActionId] = useState<number | null>(null);
  const [isDeletingDocument, setIsDeletingDocument] = useState(false);
  const [pendingDocumentDelete, setPendingDocumentDelete] = useState<KnowledgeDocument | null>(null);
  const [retryUploadDocument, setRetryUploadDocument] = useState<KnowledgeDocument | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [activeSources, setActiveSources] = useState<RetrievedSource[] | null>(null);
  const [activeRetrievalQuery, setActiveRetrievalQuery] = useState("");
  const [showSourcesPanel, setShowSourcesPanel] = useState(true);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatToast, setChatToast] = useState<string | null>(null);
  const [pendingConversationDelete, setPendingConversationDelete] = useState<{ id: number | null; title: string; clearAll?: boolean; clearMessages?: boolean } | null>(null);

  // File Ref
  const fileInputRef = useRef<HTMLInputElement>(null);
  const retryFileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasInitializedConversations = useRef(false);
  const messageLoadRequestId = useRef(0);

  // Load all initial data on mount
  useEffect(() => {
    loadSettings();
    loadDocuments();
    loadConversations();
  }, []);

  // Fetch messages when active conversation changes
  useEffect(() => {
    if (activeConvId !== null) {
      loadMessages(activeConvId);
    } else {
      setMessages([]);
      setActiveSources(null);
      setActiveRetrievalQuery("");
    }
  }, [activeConvId]);

  useEffect(() => {
    if (!hasInitializedConversations.current) return;
    if (activeConvId) {
      window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, String(activeConvId));
    } else {
      window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    }
  }, [activeConvId]);

  // Scroll to bottom of chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isGenerating]);

  // API Calls
  const loadSettings = async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      if (data.success) {
        const safeSettings = {
          ...data.settings,
          openai_api_key: "",
          gemini_api_key: ""
        };
        setConfig(safeSettings);
        setSanitizedConfig(data.sanitizedSettings || safeSettings);
        setApiKeyStatus({
          openai: Boolean(data.settings.openai_api_key_configured),
          gemini: Boolean(data.settings.gemini_api_key_configured)
        });
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  };

  const saveSettings = async (updatedConfig = config) => {
    setIsSavingSettings(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedConfig)
      });
      const data = await res.json();
      if (data.success) {
        setConfig(data.settings);
        // Reload settings to get updated masked keys
        await loadSettings();
        setUploadSuccess("Settings saved successfully!");
        setTimeout(() => setUploadSuccess(null), 3000);
      } else {
        setUploadError(data.error || "Failed to save settings");
        setTimeout(() => setUploadError(null), 4000);
      }
    } catch (err: any) {
      setUploadError(err.message || "Failed to save settings");
      setTimeout(() => setUploadError(null), 4000);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const loadDocuments = async (showLoader = true) => {
    if (showLoader) setIsLoadingDocs(true);
    try {
      const res = await fetch("/api/documents");
      const data = await res.json();
      if (data.success) {
        setDocuments(data.documents);
        if (data.statistics) setDocumentStatistics(data.statistics);
      }
    } catch (err) {
      console.error("Failed to load documents:", err);
    } finally {
      setIsLoadingDocs(false);
    }
  };

  const loadConversations = async () => {
    setIsLoadingConvs(true);
    try {
      const response = await fetch("/api/conversations");
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || "Unable to load conversations.");
      }

      const nextConversations = data.conversations || [];
      setConversations(nextConversations);
      setActiveConversationId((currentId) => {
        if (currentId && nextConversations.some((conversation: any) => conversation.id === currentId)) {
          return currentId;
        }

        if (!hasInitializedConversations.current) {
          const storedId = Number(window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY));
          const restoredId = nextConversations.some((conversation: any) => conversation.id === storedId)
            ? storedId
            : nextConversations[0]?.id ?? null;
          return restoredId;
        }

        return null;
      });
      hasInitializedConversations.current = true;
      setChatError(null);
    } catch (error: unknown) {
      console.error("Failed to load conversations:", error);
      setChatError("Unable to load conversations. Please refresh and try again.");
      hasInitializedConversations.current = true;
    } finally {
      setIsLoadingConvs(false);
    }
  };

  const loadMessages = async (convId: number) => {
    const requestId = ++messageLoadRequestId.current;
    setIsLoadingMessages(true);
    try {
      const response = await fetch(`/api/chat?conversationId=${convId}`);
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || "Unable to load this conversation.");
      }
      if (requestId !== messageLoadRequestId.current) return;

      const history = data.messages || [];
      setMessages(history);
      const assistantMessages = history.filter((message: any) => message.role === "assistant");
      if (assistantMessages.length > 0) {
        const lastMessage = assistantMessages[assistantMessages.length - 1];
        const assistantIndex = history.findIndex((message: any) => message.id === lastMessage.id);
        const correspondingQuestion = [...history.slice(0, assistantIndex)]
          .reverse()
          .find((message: any) => message.role === "user");
        setActiveSources(lastMessage.sources || []);
        setActiveRetrievalQuery(correspondingQuestion?.content || "");
      } else {
        setActiveSources([]);
        setActiveRetrievalQuery("");
      }
      setChatError(null);
    } catch (error: unknown) {
      if (requestId === messageLoadRequestId.current) {
        console.error("Failed to load messages:", error);
        setMessages([]);
        setActiveSources([]);
        setChatError("Unable to load this conversation. Please try again.");
      }
    } finally {
      if (requestId === messageLoadRequestId.current) setIsLoadingMessages(false);
    }
  };

  const uploadDocument = async (file: File, retryName?: string) => {
    const validTypes = [".pdf", ".txt", ".docx"];
    const fileExt = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();

    if (!validTypes.includes(fileExt)) {
      setUploadError("Unsupported file type. ARGUS accepts PDF, DOCX, and TXT files only.");
      setTimeout(() => setUploadError(null), 5000);
      return;
    }

    setIsUploading(true);
    setUploadError(null);
    setUploadSuccess(null);
    const refreshTimer = window.setInterval(() => void loadDocuments(false), 900);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/documents", { method: "POST", body: formData });
      const data = await response.json();

      if (data.success) {
        const result = data.document;
        setUploadSuccess(
          `${retryName ? "Retry completed" : "Indexed"} "${file.name}" — ${result.extractedCharacters.toLocaleString()} characters, ${result.chunkCount} chunks${result.pageCount ? `, ${result.pageCount} pages` : ""}.`
        );
        setTimeout(() => setUploadSuccess(null), 6000);
      } else {
        setUploadError(data.error || "ARGUS could not process this document.");
        setTimeout(() => setUploadError(null), 6000);
      }
    } catch (error: unknown) {
      setUploadError(error instanceof Error ? error.message : "An error occurred during document upload.");
      setTimeout(() => setUploadError(null), 6000);
    } finally {
      window.clearInterval(refreshTimer);
      setIsUploading(false);
      await loadDocuments();
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await uploadDocument(file);
    e.target.value = "";
  };

  const handleRetryFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const retryName = retryUploadDocument?.name;
    if (file) await uploadDocument(file, retryName);
    setRetryUploadDocument(null);
    e.target.value = "";
  };

  const handleProcessDocument = async (document: KnowledgeDocument, action: "process" | "retry") => {
    if (!document.hasSource) {
      setRetryUploadDocument(document);
      retryFileInputRef.current?.click();
      return;
    }

    setActiveDocumentActionId(document.id);
    setUploadError(null);
    setUploadSuccess(null);
    const refreshTimer = window.setInterval(() => void loadDocuments(false), 900);

    try {
      const response = await fetch("/api/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: document.id, action })
      });
      const data = await response.json();
      if (data.success) {
        setUploadSuccess(
          `${action === "retry" ? "Retry completed" : "Processing completed"} for "${document.name}" — ${data.document.chunkCount} chunks indexed.`
        );
        setTimeout(() => setUploadSuccess(null), 5000);
      } else {
        setUploadError(data.error || "ARGUS could not process this document.");
        setTimeout(() => setUploadError(null), 6000);
      }
    } catch (error: unknown) {
      setUploadError(error instanceof Error ? error.message : "Failed to process document.");
      setTimeout(() => setUploadError(null), 6000);
    } finally {
      window.clearInterval(refreshTimer);
      setActiveDocumentActionId(null);
      await loadDocuments();
    }
  };

  const requestDocumentDelete = (document: KnowledgeDocument) => {
    setPendingDocumentDelete(document);
  };

  const confirmDocumentDelete = async () => {
    const document = pendingDocumentDelete;
    if (!document || isDeletingDocument) return;

    setIsDeletingDocument(true);
    setUploadError(null);
    try {
      const response = await fetch(`/api/documents?id=${document.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || "Unable to delete the document.");

      setDocuments((current) => current.filter((item) => item.id !== document.id));
      setPendingDocumentDelete(null);
      setUploadSuccess("Document deleted successfully.");
      window.setTimeout(() => setUploadSuccess(null), 3200);
      await loadDocuments(false);
    } catch (error: unknown) {
      console.error("Failed to delete document:", error);
      setUploadError("Unable to delete the document. Please try again.");
      window.setTimeout(() => setUploadError(null), 5000);
    } finally {
      setIsDeletingDocument(false);
    }
  };

  const showChatToast = (message: string) => {
    setChatToast(message);
    window.setTimeout(() => setChatToast(null), 2800);
  };

  const handleCreateConversation = async () => {
    if (isCreatingConversation) return;

    setIsCreatingConversation(true);
    setChatError(null);
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Chat" })
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || "Unable to create a new conversation.");

      const nextConversation = { ...data.conversation, messageCount: 0, lastMessageAt: null };
      setConversations((current) => [nextConversation, ...current]);
      setMessages([]);
      setActiveSources([]);
      setActiveRetrievalQuery("");
      setActiveConversationId(nextConversation.id);
      setActiveTab("chat");
    } catch (error: unknown) {
      console.error("Failed to create conversation:", error);
      setChatError("Unable to create a new conversation. Please try again.");
    } finally {
      setIsCreatingConversation(false);
    }
  };

  const requestConversationDelete = (conversation: Conversation | undefined) => {
    if (!conversation?.id) return;
    setPendingConversationDelete({ id: conversation.id, title: conversation.title });
  };

  const requestClearAllConversations = () => {
    if (conversations.length === 0) return;
    setPendingConversationDelete({ id: null, title: "all conversations", clearAll: true });
  };

  const requestClearChat = () => {
    const activeConversation = conversations.find((conversation) => conversation.id === activeConvId);
    if (!activeConversation) return;
    setPendingConversationDelete({ id: activeConversation.id, title: activeConversation.title, clearMessages: true });
  };

  const confirmConversationDelete = async () => {
    if (!pendingConversationDelete || isDeletingConversation) return;

    setIsDeletingConversation(true);
    setChatError(null);
    const target = pendingConversationDelete;

    try {
      const url = target.clearMessages
        ? `/api/chat?conversationId=${target.id}`
        : target.clearAll
          ? "/api/conversations"
          : `/api/conversations?id=${target.id}`;
      const response = await fetch(url, { method: "DELETE" });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || "Unable to complete the requested action.");

      if (target.clearMessages) {
        setMessages([]);
        setActiveSources([]);
        setActiveRetrievalQuery("");
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === target.id ? { ...conversation, messageCount: 0, lastMessageAt: null } : conversation
          )
        );
      } else if (target.clearAll) {
        setConversations([]);
        setActiveConversationId(null);
        setMessages([]);
        setActiveSources([]);
        setActiveRetrievalQuery("");
      } else {
        setConversations((current) => current.filter((conversation) => conversation.id !== target.id));
        if (activeConvId === target.id) {
          // Intentional clean state: do not silently open a different conversation.
          setActiveConversationId(null);
          setMessages([]);
          setActiveSources([]);
          setActiveRetrievalQuery("");
        }
      }

      setPendingConversationDelete(null);
      showChatToast(target.clearMessages ? "Conversation cleared" : target.clearAll ? "All conversations deleted" : "Conversation deleted");
      await loadConversations();
    } catch (error: unknown) {
      console.error("Failed to update conversation:", error);
      setChatError(target.clearMessages ? "Unable to clear this conversation. Please try again." : "Unable to delete conversation. Please try again.");
    } finally {
      setIsDeletingConversation(false);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || activeConvId === null || isGenerating) return;

    const conversationId = activeConvId;
    const messageText = chatInput.trim();
    setChatInput("");
    setChatError(null);
    setIsGenerating(true);

    const temporaryUserMessage: ChatMessage = {
      id: `temporary-${Date.now()}`,
      conversationId,
      role: "user",
      content: messageText,
      createdAt: new Date().toISOString()
    };
    setMessages((current) => [...current, temporaryUserMessage]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message: messageText })
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || "ARGUS could not generate an answer.");

      setMessages((current) => {
        const withoutTemporary = current.filter((message) => message.id !== temporaryUserMessage.id);
        return [...withoutTemporary, data.userMessage, data.assistantMessage];
      });
      setActiveSources(data.assistantMessage.sources || []);
      setActiveRetrievalQuery(messageText);
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                title: data.updatedTitle || conversation.title,
                messageCount: (conversation.messageCount || 0) + 2,
                lastMessageAt: data.assistantMessage.createdAt
              }
            : conversation
        )
      );
      await loadConversations();
    } catch (error: unknown) {
      console.error("Failed to send chat message:", error);
      setMessages((current) => current.filter((message) => message.id !== temporaryUserMessage.id));
      setChatInput(messageText);
      setChatError("Unable to generate an answer. Please check your connection and try again.");
      await loadMessages(conversationId);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleChatInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  // Client-side inventory search; it never changes persistent document data.
  const normalizedDocumentSearch = searchQuery.trim().toLocaleLowerCase();
  const filteredDocuments = documents.filter((document) => {
    if (!normalizedDocumentSearch) return true;
    return [document.name, document.type, document.status, document.processingStage]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedDocumentSearch);
  });

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden font-sans">
      {/* Sidebar Navigation */}
      <aside className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col justify-between shrink-0">
        <div>
          {/* Header/Logo */}
          <div className="p-6 border-b border-zinc-800 flex items-center gap-3">
            <div className="relative">
              <div className="h-9 w-9 bg-gradient-to-tr from-cyan-600 to-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-cyan-900/40">
                <Sparkles className="h-5 w-5 text-white animate-pulse" />
              </div>
              <div className="absolute -bottom-1 -right-1 h-3.5 w-3.5 bg-emerald-500 border-2 border-zinc-900 rounded-full"></div>
            </div>
            <div>
              <span className="text-lg font-bold tracking-wider text-white">ARGUS</span>
              <p className="text-[10px] text-zinc-400 font-medium uppercase tracking-[0.1em]">AI Knowledge Engine</p>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="p-4 space-y-1.5">
            <button
              onClick={() => setActiveTab("dashboard")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                activeTab === "dashboard"
                  ? "bg-zinc-800 text-white shadow-sm shadow-black/10 border-l-2 border-cyan-500"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-white"
              }`}
            >
              <LayoutDashboard className="h-4 w-4" />
              <span>Dashboard</span>
            </button>
            <button
              onClick={() => setActiveTab("documents")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                activeTab === "documents"
                  ? "bg-zinc-800 text-white shadow-sm shadow-black/10 border-l-2 border-cyan-500"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-white"
              }`}
            >
              <FileText className="h-4 w-4" />
              <span>Knowledge Base</span>
              {documents.length > 0 && (
                <span className="ml-auto bg-zinc-700 text-zinc-300 text-[10px] font-bold px-2 py-0.5 rounded-full">
                  {documents.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("chat")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                activeTab === "chat"
                  ? "bg-zinc-800 text-white shadow-sm shadow-black/10 border-l-2 border-cyan-500"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-white"
              }`}
            >
              <MessageSquare className="h-4 w-4" />
              <span>AI Chat</span>
              {conversations.length > 0 && (
                <span className="ml-auto bg-zinc-700 text-zinc-300 text-[10px] font-bold px-2 py-0.5 rounded-full">
                  {conversations.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("settings")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                activeTab === "settings"
                  ? "bg-zinc-800 text-white shadow-sm shadow-black/10 border-l-2 border-cyan-500"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-white"
              }`}
            >
              <Sliders className="h-4 w-4" />
              <span>Settings</span>
            </button>
          </nav>
        </div>

        {/* Footprint / Active Model Widget */}
        <div className="p-4 border-t border-zinc-800">
          <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">RAG Status</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-white font-semibold">
                {config.llm_provider === "local"
                  ? "Local Fallback Engine"
                  : config.llm_provider === "openai"
                  ? "OpenAI (GPT-4o-mini)"
                  : "Google (Gemini-1.5-Flash)"}
              </span>
              <span className="text-[10px] text-zinc-500">
                Vector space size: {documentStatistics.vectorChunks} chunks
              </span>
            </div>
            {config.llm_provider === "local" && (
              <div className="mt-2 flex items-center gap-1.5 text-[10px] text-cyan-400 bg-cyan-950/40 px-2 py-1 rounded border border-cyan-900/50">
                <ShieldCheck className="h-3 w-3 shrink-0" />
                <span>Offline local search active</span>
              </div>
            )}
          </div>
          <div className="mt-3 text-center">
            <p className="text-[10px] text-zinc-600 font-mono">ARGUS Engine v1.0.0</p>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-zinc-950 relative">
        {/* Banner messages */}
        {uploadSuccess && (
          <div className="bg-emerald-950/80 border-b border-emerald-800 text-emerald-300 px-6 py-2.5 text-xs font-medium flex items-center gap-2 animate-fade-in z-50">
            <CheckCircle className="h-4 w-4 shrink-0" />
            <span>{uploadSuccess}</span>
          </div>
        )}
        {uploadError && (
          <div className="bg-red-950/80 border-b border-red-800 text-red-300 px-6 py-2.5 text-xs font-medium flex items-center gap-2 animate-fade-in z-50">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{uploadError}</span>
          </div>
        )}

        {/* Dashboard Tab */}
        {activeTab === "dashboard" && (
          <div className="flex-1 overflow-y-auto p-8 space-y-8">
            {/* Title / Action */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h1 className="text-3xl font-extrabold text-white tracking-tight">ARGUS Control Tower</h1>
                <p className="text-zinc-400 mt-1">Monitor text extraction, chunking pipelines, and vector database stats.</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setActiveTab("documents")}
                  className="bg-zinc-800 hover:bg-zinc-750 text-white text-xs font-semibold px-4 py-2.5 rounded-lg border border-zinc-700 flex items-center gap-2"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Manage Knowledge</span>
                </button>
                <button
                  onClick={handleCreateConversation}
                  className="bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white text-xs font-semibold px-4 py-2.5 rounded-lg flex items-center gap-2 shadow-lg shadow-cyan-900/20"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  <span>Start New AI Chat</span>
                </button>
              </div>
            </div>

            {/* Metrics Dashboard Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 hover:border-zinc-700 transition">
                <div className="flex justify-between items-start">
                  <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Indexed Documents</span>
                  <div className="p-2 bg-cyan-950/60 rounded-lg border border-cyan-900/40 text-cyan-400">
                    <BookOpen className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-4">
                  <p className="text-3xl font-bold text-white">
                    {documentStatistics.indexedDocuments}
                  </p>
                  <p className="text-[10px] text-zinc-500 mt-1">
                    {documents.filter((d) => d.status === "Uploaded" || d.status === "Processing").length} uploading/processing
                  </p>
                </div>
              </div>

              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 hover:border-zinc-700 transition">
                <div className="flex justify-between items-start">
                  <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Vector Chunks</span>
                  <div className="p-2 bg-indigo-950/60 rounded-lg border border-indigo-900/40 text-indigo-400">
                    <Database className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-4">
                  <p className="text-3xl font-bold text-white">
                    {documentStatistics.vectorChunks}
                  </p>
                  <p className="text-[10px] text-zinc-500 mt-1">
                    Across all fully indexed files
                  </p>
                </div>
              </div>

              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 hover:border-zinc-700 transition">
                <div className="flex justify-between items-start">
                  <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Failed Documents</span>
                  <div className="p-2 bg-red-950/60 rounded-lg border border-red-900/40 text-red-400">
                    <AlertTriangle className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-4">
                  <p className="text-3xl font-bold text-white">
                    {documentStatistics.failedDocuments}
                  </p>
                  <p className="text-[10px] text-zinc-500 mt-1">
                    Incomplete text extraction or bad keys
                  </p>
                </div>
              </div>

              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 hover:border-zinc-700 transition">
                <div className="flex justify-between items-start">
                  <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Active Conversations</span>
                  <div className="p-2 bg-purple-950/60 rounded-lg border border-purple-900/40 text-purple-400">
                    <MessageSquare className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-4">
                  <p className="text-3xl font-bold text-white">{conversations.length}</p>
                  <p className="text-[10px] text-zinc-500 mt-1">Saved index sessions</p>
                </div>
              </div>
            </div>

            {/* In-depth Workflow Pipeline Visualization */}
            <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <Code className="h-4.5 w-4.5 text-cyan-400 animate-spin-slow" />
                    <span>Core RAG Flow Visualizer</span>
                  </h3>
                  <p className="text-xs text-zinc-400 mt-0.5">Understanding how files are processed, vectorized, and retrieved under the hood.</p>
                </div>
                <span className="text-[10px] bg-zinc-800 border border-zinc-700 text-zinc-300 font-mono px-2 py-1 rounded">
                  Modular Architecture
                </span>
              </div>

              {/* Graphical workflow chain */}
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 relative">
                {[
                  { title: "Documents", sub: "PDF, TXT, DOCX", color: "from-blue-600 to-cyan-500", step: "01" },
                  { title: "Text Extraction", sub: "Raw parser", color: "from-cyan-500 to-teal-500", step: "02" },
                  { title: "Text Cleaning", sub: "Boundary trim", color: "from-teal-500 to-emerald-500", step: "03" },
                  { title: "Chunking", sub: "Recursive overlaps", color: "from-emerald-500 to-amber-500", step: "04" },
                  { title: "Embeddings", sub: "128d local/API", color: "from-amber-500 to-orange-500", step: "05" },
                  { title: "Vector DB", sub: "Postgres JSONB", color: "from-orange-500 to-indigo-500", step: "06" },
                  { title: "Retrieval", sub: "Cosine cosine()", color: "from-indigo-500 to-purple-500", step: "07" },
                  { title: "Grounded LLM", sub: "Final Cited Answer", color: "from-purple-500 to-pink-500", step: "08" }
                ].map((wf, idx) => (
                  <div key={idx} className="bg-zinc-950 border border-zinc-800 p-3 rounded-lg flex flex-col justify-between group relative overflow-hidden">
                    <div className={`absolute top-0 left-0 w-1 h-full bg-gradient-to-b ${wf.color}`}></div>
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-[10px] font-mono text-zinc-500 font-bold">STEP {wf.step}</span>
                      <span className="text-[10px] font-bold text-zinc-600">→</span>
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-white group-hover:text-cyan-400 transition-colors">{wf.title}</h4>
                      <p className="text-[9px] text-zinc-500 mt-1">{wf.sub}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent Documents Table & Quick Instructions */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Recent Files Table */}
              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-6 lg:col-span-2 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-bold text-white">Recently Ingested Documents</h3>
                  <button
                    onClick={() => void loadDocuments()}
                    className="text-xs text-zinc-400 hover:text-white flex items-center gap-1"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>Refresh</span>
                  </button>
                </div>

                {isLoadingDocs ? (
                  <div className="py-12 flex flex-col items-center justify-center gap-3 text-zinc-500">
                    <Loader2 className="h-6 w-6 animate-spin text-cyan-500" />
                    <span className="text-xs">Loading library...</span>
                  </div>
                ) : documents.length === 0 ? (
                  <div className="border border-dashed border-zinc-800 rounded-lg p-12 text-center text-zinc-500">
                    <FileText className="h-10 w-10 mx-auto text-zinc-600 mb-3" />
                    <p className="text-xs">No documents uploaded yet</p>
                    <button
                      onClick={() => setActiveTab("documents")}
                      className="mt-4 inline-flex items-center gap-1.5 text-xs bg-cyan-950 hover:bg-cyan-900 text-cyan-400 border border-cyan-800 px-3 py-1.5 rounded-lg font-semibold"
                    >
                      <UploadCloud className="h-3.5 w-3.5" />
                      <span>Upload first document</span>
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-zinc-800 text-zinc-500 font-bold uppercase tracking-wider pb-2">
                          <th className="pb-3">Name</th>
                          <th className="pb-3">Size</th>
                          <th className="pb-3">Status</th>
                          <th className="pb-3 text-right">Chunks</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/50">
                        {documents.slice(0, 5).map((doc) => (
                          <tr key={doc.id} className="hover:bg-zinc-850/40">
                            <td className="py-3 font-semibold text-white max-w-[200px] truncate">
                              {doc.name}
                            </td>
                            <td className="py-3 text-zinc-400">
                              {(doc.size / 1024).toFixed(1)} KB
                            </td>
                            <td className="py-3">
                              {doc.status === "Indexed" && (
                                <span className="inline-flex items-center gap-1 text-[10px] bg-emerald-950/80 text-emerald-400 border border-emerald-800/50 px-2 py-0.5 rounded-full font-semibold">
                                  <span className="h-1 w-1 bg-emerald-400 rounded-full"></span>
                                  Indexed
                                </span>
                              )}
                              {doc.status === "Uploaded" && (
                                <span className="inline-flex items-center gap-1 text-[10px] bg-zinc-800 text-zinc-300 border border-zinc-700 px-2 py-0.5 rounded-full font-semibold">
                                  Uploaded
                                </span>
                              )}
                              {doc.status === "Processing" && (
                                <span className="inline-flex items-center gap-1 text-[10px] bg-amber-950/80 text-amber-400 border border-amber-800/50 px-2 py-0.5 rounded-full font-semibold">
                                  <Loader2 className="h-2 w-2 animate-spin text-blue-400" />
                                  {doc.processingStage || "Processing"}
                                </span>
                              )}
                              {doc.status === "Failed" && (
                                <span
                                  title={doc.errorMessage || "Processing failed"}
                                  className="inline-flex items-center gap-1 text-[10px] bg-red-950/80 text-red-400 border border-red-800/50 px-2 py-0.5 rounded-full font-semibold cursor-help"
                                >
                                  Failed
                                </span>
                              )}

                            </td>
                            <td className="py-3 text-right text-zinc-300 font-mono font-medium">
                              {doc.chunkCount || 0}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* System Overview Side-Card */}
              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-6 space-y-5">
                <h3 className="text-sm font-bold text-white">ARGUS Ingestion Guide</h3>
                <div className="space-y-4 text-xs text-zinc-400 leading-relaxed">
                  <p>
                    To use ARGUS, navigate to the <strong className="text-white">Knowledge Base</strong> tab, select your PDF, TXT or DOCX files, and submit.
                  </p>
                  <p>
                    Our vectorizer immediately creates a chunk matrix with mathematical embeddings of size 128 (Local) or 1536 (OpenAI). 
                  </p>
                  <p>
                    When questions are asked in the <strong className="text-white">AI Chat</strong>, we run real-time cosine calculations and retrieve source-grounded references.
                  </p>
                </div>
                <div className="pt-3 border-t border-zinc-800 flex flex-col gap-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-500">PDF Ingestion:</span>
                    <span className="text-emerald-400 font-semibold">Fully Supported</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-500">DOCX Word:</span>
                    <span className="text-emerald-400 font-semibold">Fully Supported</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-500">TXT Files:</span>
                    <span className="text-emerald-400 font-semibold">Fully Supported</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Knowledge Base Tab */}
        {activeTab === "documents" && (
          <div className="flex-1 overflow-y-auto p-8 space-y-8">
            <div>
              <h1 className="text-3xl font-extrabold text-white tracking-tight">Knowledge Base Library</h1>
              <p className="text-zinc-400 mt-1">Upload, update, and manage the background files grounding the assistant.</p>
            </div>

            {/* Upload Area / Dropzone */}
            <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-8 flex flex-col items-center justify-center text-center relative overflow-hidden">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                accept=".pdf,.txt,.docx"
                className="hidden"
                id="argus-file-uploader"
                disabled={isUploading}
              />
              <input
                type="file"
                ref={retryFileInputRef}
                onChange={handleRetryFileUpload}
                accept=".pdf,.txt,.docx"
                className="hidden"
                aria-label="Choose the original source file to retry processing"
              />
              <label
                htmlFor="argus-file-uploader"
                className={`w-full cursor-pointer group flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-xl transition-all ${
                  isUploading
                    ? "border-cyan-800 bg-cyan-950/10 cursor-not-allowed"
                    : "border-zinc-800 bg-zinc-950/20 hover:border-cyan-600/60 hover:bg-cyan-950/5"
                }`}
              >
                {isUploading ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="h-12 w-12 bg-cyan-950 text-cyan-400 rounded-full flex items-center justify-center animate-spin">
                      <Loader2 className="h-6 w-6" />
                    </div>
                    <span className="text-sm font-bold text-cyan-400 animate-pulse">Uploading and indexing your document...</span>
                    <span className="text-xs text-zinc-500 max-w-sm">
                      Uploading → extracting and cleaning → chunking → embedding → indexing. The library will update automatically when it is ready.
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div className="h-12 w-12 bg-zinc-800 group-hover:bg-cyan-950 text-zinc-400 group-hover:text-cyan-400 rounded-full flex items-center justify-center transition-colors">
                      <UploadCloud className="h-6 w-6" />
                    </div>
                    <span className="text-sm font-bold text-white group-hover:text-cyan-400 transition-colors">
                      Click to upload document
                    </span>
                    <span className="text-xs text-zinc-400">
                      Supports PDF, TXT or DOCX (Word) documents up to 25MB
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono mt-1 bg-zinc-800 px-2 py-0.5 rounded">
                      Recursive overlapping text chunk pipeline
                    </span>
                  </div>
                )}
              </label>
            </div>

            {/* Document Library List */}
            <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-6 space-y-4">
              <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4">
                <h3 className="text-base font-bold text-white">Document Inventory ({documents.length})</h3>
                
                {/* Search */}
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                  <input
                    aria-label="Search documents by name, type, or status"
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search name, type, or status..."
                    className="w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-lg pl-9 pr-4 py-1.5 text-xs focus:outline-none focus:border-cyan-500"
                  />
                </div>
              </div>

              {isLoadingDocs ? (
                <div className="py-20 flex flex-col items-center justify-center gap-3 text-zinc-500">
                  <Loader2 className="h-8 w-8 animate-spin text-cyan-500" />
                  <span className="text-xs">Fetching knowledge inventory...</span>
                </div>
              ) : filteredDocuments.length === 0 ? (
                <div className="py-16 text-center border border-dashed border-zinc-800 rounded-lg text-zinc-500">
                  <FileText className="h-12 w-12 mx-auto text-zinc-700 mb-3" />
                  <p className="text-sm font-medium">No documents found matching search criteria</p>
                  <p className="text-xs text-zinc-600 mt-1">Upload files above to begin building your knowledge assistant.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-500 font-bold uppercase tracking-wider pb-3">
                        <th className="pb-3">Name / Diagnostics</th>
                        <th className="pb-3">Type</th>
                        <th className="pb-3">Size</th>
                        <th className="pb-3">Pages</th>
                        <th className="pb-3">Extracted</th>
                        <th className="pb-3">Status</th>
                        <th className="pb-3 text-right">Chunks</th>
                        <th className="pb-3">Uploaded</th>
                        <th className="sticky right-0 z-10 bg-zinc-900 pb-3 pl-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/40">
                      {filteredDocuments.map((doc) => {
                        const isWorking = activeDocumentActionId === doc.id;
                        const stage = doc.processingStage || doc.status;
                        const actionLabel = doc.status === "Failed" ? "Retry" : doc.status === "Indexed" ? "Re-index" : "Process";
                        return (
                          <tr key={doc.id} className="hover:bg-zinc-850/30 group align-top">
                            <td className="py-4 pr-4 max-w-[260px]">
                              <p className="font-semibold text-white truncate" title={doc.name}>{doc.name}</p>
                              {doc.errorMessage ? (
                                <p className="mt-1 text-[10px] leading-relaxed text-red-400 whitespace-normal" title={doc.errorMessage}>
                                  {doc.errorMessage}
                                </p>
                              ) : (
                                <p className="mt-1 text-[10px] text-zinc-600">
                                  {doc.hasSource ? "Original source retained for retry" : "Legacy entry — choose source file to retry"}
                                </p>
                              )}
                            </td>
                            <td className="py-4 text-zinc-400 uppercase font-mono text-[10px]">{doc.type}</td>
                            <td className="py-4 text-zinc-400 whitespace-nowrap">{(doc.size / 1024).toFixed(1)} KB</td>
                            <td className="py-4 text-zinc-400 font-mono">{doc.pageCount || "—"}</td>
                            <td className="py-4 text-zinc-400 font-mono whitespace-nowrap">
                              {doc.extractedCharacters ? `${(doc.extractedCharacters / 1000).toFixed(1)}k` : "—"}
                            </td>
                            <td className="py-4">
                              {doc.status === "Indexed" ? (
                                <span className="inline-flex items-center gap-1 text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-900/50 px-2.5 py-0.5 rounded-full font-bold">
                                  <span className="h-1 w-1 bg-emerald-400 rounded-full animate-pulse"></span>
                                  Indexed
                                </span>
                              ) : doc.status === "Failed" ? (
                                <span title={doc.errorMessage || "Processing failed"} className="inline-flex items-center gap-1 text-[10px] bg-red-950 text-red-400 border border-red-900/50 px-2.5 py-0.5 rounded-full font-bold cursor-help">
                                  Failed
                                </span>
                              ) : doc.status === "Processing" ? (
                                <span className="inline-flex items-center gap-1 text-[10px] bg-amber-950 text-amber-400 border border-amber-900/50 px-2.5 py-0.5 rounded-full font-bold whitespace-nowrap">
                                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                  {stage}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[10px] bg-zinc-800 text-zinc-300 border border-zinc-700 px-2.5 py-0.5 rounded-full font-bold">
                                  Uploaded
                                </span>
                              )}
                            </td>
                            <td className="py-4 text-right text-zinc-300 font-mono font-bold">{doc.chunkCount || 0}</td>
                            <td className="py-4 text-zinc-500 whitespace-nowrap text-[10px]">
                              {new Date(doc.createdAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                            </td>
                            <td className="sticky right-0 z-10 bg-zinc-900 py-4 pl-3 text-right whitespace-nowrap group-hover:bg-zinc-850/30">
                              <button
                                onClick={() => handleProcessDocument(doc, doc.status === "Failed" ? "retry" : "process")}
                                disabled={isWorking || isUploading}
                                className="text-cyan-400 hover:text-cyan-300 disabled:text-zinc-600 p-1.5 rounded hover:bg-cyan-950/30 transition-colors"
                                title={doc.hasSource ? `${actionLabel} this document` : `${actionLabel} by selecting the original file`}
                              >
                                {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                                <span className="hidden xl:inline ml-1 text-[10px] font-semibold">{actionLabel}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => requestDocumentDelete(doc)}
                                disabled={isWorking || isUploading || isDeletingDocument}
                                aria-label={`Delete document ${doc.name}`}
                                className="inline-flex items-center text-zinc-500 hover:text-red-400 disabled:text-zinc-700 p-1.5 rounded hover:bg-red-950/20 focus:outline-none focus:ring-2 focus:ring-red-900 transition-colors"
                                title="Delete document"
                              >
                                <Trash2 className="h-4 w-4" />
                                <span className="hidden xl:inline ml-1 text-[10px] font-semibold">Delete</span>
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* AI Chat Tab */}
        {activeTab === "chat" && (
          <div className="flex-1 flex overflow-hidden relative">
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 w-[min(92%,32rem)] space-y-2 pointer-events-none">
              {chatError && (
                <div role="alert" className="pointer-events-auto rounded-xl border border-red-900/70 bg-red-950/95 px-3.5 py-2.5 text-xs text-red-200 shadow-2xl flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
                  <span>{chatError}</span>
                </div>
              )}
              {chatToast && (
                <div role="status" className="pointer-events-auto rounded-xl border border-emerald-900/70 bg-emerald-950/95 px-3.5 py-2.5 text-xs font-medium text-emerald-200 shadow-2xl flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span>{chatToast}</span>
                </div>
              )}
            </div>

            {/* Conversations Sidebar (Left column) */}
            <aside className="hidden md:flex w-64 bg-zinc-900/80 border-r border-zinc-800/80 flex-col justify-between shrink-0">
              <div>
                <div className="p-4 border-b border-zinc-800 flex justify-between items-center">
                  <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Saved Chats</span>
                  <button
                    onClick={requestClearAllConversations}
                    disabled={conversations.length === 0 || isDeletingConversation || isGenerating}
                    className="text-[10px] text-zinc-500 hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed font-bold"
                    title="Delete all histories"
                  >
                    Clear All
                  </button>
                </div>
                
                {/* Create Conversation Button */}
                <div className="p-3">
                  <button
                    onClick={handleCreateConversation}
                    disabled={isCreatingConversation || isGenerating}
                    className="w-full bg-zinc-850 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 text-white border border-zinc-850 text-xs font-semibold px-3 py-2.5 rounded-lg flex items-center justify-center gap-2 transition-all"
                  >
                    {isCreatingConversation ? <Loader2 className="h-4 w-4 animate-spin text-cyan-400" /> : <Plus className="h-4 w-4 text-cyan-400" />}
                    <span>{isCreatingConversation ? "Creating..." : "New Chat"}</span>
                  </button>
                </div>

                {/* Conversation List */}
                <div className="px-2 overflow-y-auto max-h-[calc(100vh-250px)] space-y-1">
                  {isLoadingConvs ? (
                    <div className="py-8 text-center text-zinc-500 flex justify-center items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin text-cyan-500" />
                      <span className="text-xs">Loading sessions...</span>
                    </div>
                  ) : conversations.length === 0 ? (
                    <div className="mx-2 mt-2 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/30 px-4 py-8 text-center">
                      <MessageSquare className="mx-auto h-5 w-5 text-zinc-600" />
                      <p className="mt-3 text-xs font-semibold text-zinc-300">No conversations yet</p>
                      <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                        Start a new conversation to begin exploring your knowledge base.
                      </p>
                    </div>
                  ) : (
                    conversations.map((conv) => (
                      <div
                        key={conv.id}
                        className={`w-full rounded-lg text-xs font-medium flex items-center gap-1 transition-all ${
                          activeConvId === conv.id
                            ? "bg-zinc-800 text-white shadow-inner border border-zinc-700/50"
                            : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
                        }`}
                      >
                        <button
                          type="button"
                          disabled={isGenerating || isDeletingConversation}
                          onClick={() => {
                            setChatError(null);
                            setActiveConversationId(conv.id);
                          }}
                          className="min-w-0 flex-1 text-left px-3 py-2.5 disabled:cursor-not-allowed"
                          title={`Open ${conv.title}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <MessageSquare className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                            <div className="min-w-0">
                              <span className="block truncate" title={conv.title}>{conv.title}</span>
                              <span className="block mt-0.5 text-[9px] font-normal text-zinc-500">
                                {formatRelativeTime(conv.lastMessageAt || conv.createdAt)} · {conv.messageCount || 0} messages
                              </span>
                            </div>
                          </div>
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete conversation ${conv.title}`}
                          title="Delete conversation"
                          disabled={isGenerating || isDeletingConversation}
                          onClick={() => requestConversationDelete(conv)}
                          className="mr-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-red-950/50 hover:text-red-400 focus:outline-none focus:ring-2 focus:ring-red-900 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Sidebar Quick Footer */}
              <div className="p-4 border-t border-zinc-800 bg-zinc-950/20 text-center">
                <span className="text-[10px] text-zinc-500">Citations are matched instantly.</span>
              </div>
            </aside>

            {/* Chat Messages Panel (Center column) */}
            <div className="flex-1 flex flex-col bg-zinc-950 overflow-hidden">
              {activeConvId === null ? (
                <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-zinc-500 space-y-4">
                  <div className="h-16 w-16 bg-zinc-900 border border-zinc-800 rounded-2xl flex items-center justify-center text-cyan-400 animate-bounce">
                    <MessageSquare className="h-8 w-8" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white">
                      {conversations.length === 0 ? "No conversations yet" : "Conversation cleared"}
                    </h3>
                    <p className="text-xs text-zinc-500 max-w-sm mt-1 leading-relaxed">
                      {conversations.length === 0
                        ? "Start a new conversation to begin exploring your knowledge base."
                        : "Select a saved conversation from the sidebar or start a clean new chat."}
                    </p>
                  </div>
                  <button
                    onClick={handleCreateConversation}
                    disabled={isCreatingConversation}
                    className="bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 disabled:opacity-60 text-white text-xs font-bold px-4 py-2.5 rounded-lg flex items-center gap-2 shadow-lg shadow-cyan-950/30"
                  >
                    {isCreatingConversation ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    <span>{isCreatingConversation ? "Creating..." : "New Chat"}</span>
                  </button>
                </div>
              ) : (
                <>
                  {/* Chat Session Header */}
                  <div className="p-4 bg-zinc-900/40 border-b border-zinc-800 flex justify-between items-center gap-3 px-4 md:px-6 shrink-0">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="h-2.5 w-2.5 bg-emerald-500 rounded-full shadow-[0_0_10px_rgba(16,185,129,0.8)]"></div>
                      <div className="min-w-0">
                        <h2 className="text-sm font-bold text-white truncate">
                          {conversations.find((c) => c.id === activeConvId)?.title || "Active Chat"}
                        </h2>
                        <span className="text-[10px] text-zinc-500">Grounded answers with source evidence.</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <select
                        aria-label="Switch conversation"
                        value={activeConvId || ""}
                        onChange={(event) => setActiveConversationId(Number(event.target.value) || null)}
                        className="md:hidden max-w-28 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-[10px] text-zinc-300 focus:outline-none focus:border-cyan-600"
                      >
                        {conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
                      </select>
                      <button
                        onClick={handleCreateConversation}
                        disabled={isCreatingConversation || isGenerating}
                        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold"
                        title="Create a new chat"
                      >
                        {isCreatingConversation ? <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" /> : <Plus className="h-3.5 w-3.5 text-cyan-400" />}
                        <span className="hidden sm:inline">New Chat</span>
                      </button>
                      <button
                        onClick={requestClearChat}
                        disabled={messages.length === 0 || isGenerating || isDeletingConversation}
                        className="hidden md:inline-flex px-2 py-1.5 rounded-lg text-[10px] font-semibold text-zinc-400 hover:text-amber-300 hover:bg-amber-950/30 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Clear messages in this conversation"
                      >
                        Clear chat
                      </button>
                      <button
                        onClick={() => requestConversationDelete(conversations.find((conversation) => conversation.id === activeConvId))}
                        disabled={isGenerating || isDeletingConversation}
                        className="inline-flex p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-950/30 disabled:opacity-40"
                        title="Delete this conversation"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setShowSourcesPanel(prev => !prev)}
                        aria-label={showSourcesPanel ? "Hide source inspector" : "Show source inspector"}
                        aria-expanded={showSourcesPanel}
                        className={`hidden xl:inline-flex text-xs px-3 py-1.5 rounded-lg border font-semibold transition-all ${
                          showSourcesPanel
                            ? "bg-cyan-950/40 border-cyan-850 text-cyan-400"
                            : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700"
                        }`}
                      >
                        {showSourcesPanel ? "Hide sources" : "Show sources"}
                      </button>
                    </div>
                  </div>

                  {/* Messages Scroll Area */}
                  <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {isLoadingMessages ? (
                      <div className="py-20 flex flex-col items-center justify-center gap-2 text-zinc-500">
                        <Loader2 className="h-8 w-8 animate-spin text-cyan-500" />
                        <span className="text-xs">Retrieving conversation thread...</span>
                      </div>
                    ) : messages.length === 0 ? (
                      <div className="py-12 flex flex-col items-center justify-center text-center text-zinc-500 max-w-lg mx-auto">
                        <Sparkles className="h-10 w-10 text-cyan-500 mb-4 animate-pulse" />
                        <h3 className="text-sm font-bold text-white">Prompt your Ingested Files</h3>
                        <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                          Enter any question. ARGUS will calculate token cosine matrices, extract matching clauses, and synthesise a cited response.
                        </p>
                        
                        {documents.filter((document) => document.status === "Indexed").length === 0 && (
                          <div className="mt-4 p-3 bg-amber-950/30 border border-amber-900/50 rounded-lg text-amber-300 text-[11px] flex gap-2 items-start text-left">
                            <AlertTriangle className="h-4.5 w-4.5 shrink-0 text-amber-400 mt-0.5" />
                            <div>
                              <span><strong>Warning:</strong> You have no completed documents in your Knowledge Base. Upload documents first or the RAG assistant will state it cannot find answers.</span>
                            </div>
                          </div>
                        )}
                        
                        <div className="mt-6 w-full grid grid-cols-1 sm:grid-cols-2 gap-2 text-left">
                          {[
                            "What are the requirements of the internship?",
                            "What are the project deliverables?",
                            "What are the evaluation criteria?",
                            "Summarize the important deadlines.",
                            "What technologies are recommended?"
                          ].map((suggestion, sIdx) => (
                            <button
                              key={sIdx}
                              onClick={() => setChatInput(suggestion)}
                              className="bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 hover:bg-zinc-850 p-2.5 rounded-lg text-[10px] text-zinc-400 hover:text-zinc-200 transition-colors"
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      messages.map((msg, messageIndex) => {
                        const isUser = msg.role === "user";
                        const messageSources = msg.sources ?? [];
                        const usedDocuments = Array.from(new Set(messageSources.map((source) => source.documentName)));
                        const usedPages = Array.from(
                          new Set(messageSources.flatMap((source) => source.pageNumber ? [source.pageNumber] : []))
                        );
                        const topSimilarity = messageSources.reduce(
                          (highest, source) => Math.max(highest, source.similarity || 0),
                          0
                        );
                        return (
                          <div
                            key={msg.id}
                            onClick={() => {
                              if (!isUser && msg.sources) {
                                const correspondingQuestion = [...messages.slice(0, messageIndex)]
                                  .reverse()
                                  .find((message) => message.role === "user");
                                setActiveSources(msg.sources);
                                setActiveRetrievalQuery(correspondingQuestion?.content || "");
                              }
                            }}
                            className={`min-w-0 flex flex-col max-w-[85%] rounded-xl p-4 cursor-pointer transition-all ${
                              isUser
                                ? "bg-zinc-850/80 border border-zinc-800 ml-auto text-zinc-100"
                                : "bg-zinc-900 border border-zinc-800/80 mr-auto text-zinc-100 hover:border-zinc-700"
                            }`}
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <span
                                className={`text-[10px] font-bold uppercase tracking-wider ${
                                  isUser ? "text-indigo-400" : "text-cyan-400"
                                }`}
                              >
                                {isUser ? "User" : "ARGUS Assistant"}
                              </span>
                              <span className="text-[9px] text-zinc-500 font-mono">
                                {new Date(msg.createdAt).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit"
                                })}
                              </span>
                            </div>

                            {/* Markdown-ish formatting support */}
                            <div className="break-words text-xs leading-relaxed whitespace-pre-wrap font-sans text-zinc-200">
                              {msg.content.split("\n\n").map((para: string, pIdx: number) => {
                                // Bold and highlights parsing
                                return (
                                  <p key={pIdx} className="mb-2 last:mb-0">
                                    {para.split("**").map((textPart, tpIdx) => {
                                      if (tpIdx % 2 === 1) {
                                        return <strong key={tpIdx} className="text-white font-bold">{textPart}</strong>;
                                      }
                                      return textPart;
                                    })}
                                  </p>
                                );
                              })}
                            </div>

                            {/* Inline Sources Tags */}
                              {!isUser && messageSources.length > 0 && (
                                <>
                                  <div className="mt-3.5 pt-2.5 border-t border-zinc-800/60 flex flex-wrap gap-1.5">
                                    <span className="text-[10px] text-zinc-500 font-medium mr-1 flex items-center gap-1">
                                      <BookOpen className="h-3 w-3" />
                                      <span>Sources:</span>
                                    </span>
                                    {Array.from(new Map(messageSources.map((source) => [
                                      `${source.documentName}:${source.pageNumber ?? "source"}`,
                                      source
                                    ])).values()).map((source, sourceIndex) => (
                                      <button
                                        key={sourceIndex}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          const correspondingQuestion = [...messages.slice(0, messageIndex)]
                                            .reverse()
                                            .find((message) => message.role === "user");
                                          setActiveSources(messageSources);
                                          setActiveRetrievalQuery(correspondingQuestion?.content || "");
                                          setShowSourcesPanel(true);
                                        }}
                                        className="inline-flex max-w-full items-center gap-1 break-all text-left text-[9px] bg-zinc-950 border border-zinc-800 text-cyan-400 px-2 py-0.5 rounded font-mono font-medium hover:border-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-900 transition"
                                        title="Open retrieved source inspection"
                                      >
                                        📄 {source.documentName}{source.pageNumber ? ` · Page ${source.pageNumber}` : ""} · Chunk {source.chunkIndex + 1}
                                      </button>
                                    ))}
                                  </div>
                                  <details
                                    className="mt-2 rounded-lg border border-zinc-800/80 bg-zinc-950/40 px-2.5 py-2 text-[10px] text-zinc-400"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <summary className="cursor-pointer select-none font-semibold text-zinc-300 hover:text-cyan-400">
                                      Retrieval details
                                    </summary>
                                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-zinc-800/70 pt-2 text-zinc-500">
                                      <span>✓ {messageSources.length} chunk{messageSources.length === 1 ? "" : "s"} retrieved</span>
                                      <span>✓ {usedPages.length} source page{usedPages.length === 1 ? "" : "s"}</span>
                                      <span className="col-span-2 truncate" title={usedDocuments.join(", ")}>✓ {usedDocuments.length} document{usedDocuments.length === 1 ? "" : "s"}: {usedDocuments.join(", ")}</span>
                                      <span>Top relevance: {Math.round(topSimilarity * 100)}%</span>
                                      <span className="capitalize">{Array.from(new Set(messageSources.map((source) => source.retrievalMethod || "vector"))).join(" + ")} match</span>
                                      <span className="col-span-2 text-emerald-400">✓ Grounded evidence selected for this answer</span>
                                    </div>
                                    <ul className="mt-2 space-y-1.5 border-t border-zinc-800/70 pt-2 text-[10px] text-zinc-500">
                                      {messageSources.map((source) => (
                                        <li key={source.chunkId} className="flex min-w-0 items-start justify-between gap-2">
                                          <span className="min-w-0 break-words text-zinc-400">
                                            📄 {source.documentName}{source.pageNumber ? ` · Page ${source.pageNumber}` : ""} · Chunk {source.chunkIndex + 1}
                                          </span>
                                          <span className="shrink-0 font-mono text-cyan-400">{Math.round(source.similarity * 100)}%</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </details>
                                </>
                              )}
                            </div>
                        );
                      })
                    )}
                    {isGenerating && (
                      <div role="status" aria-live="polite" className="bg-zinc-900 border border-zinc-800 mr-auto max-w-[85%] rounded-xl p-4 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400 animate-pulse">
                            ARGUS is preparing your answer
                          </span>
                          <Loader2 className="h-3 w-3 animate-spin text-cyan-400" />
                        </div>
                        <span className="text-xs text-zinc-500">Searching indexed sources, selecting relevant evidence, and generating a grounded response...</span>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* Input Form Box */}
                  <form onSubmit={handleSendMessage} className="p-3 md:p-4 bg-zinc-900/80 border-t border-zinc-800 shrink-0">
                    <div className="mx-auto max-w-4xl rounded-2xl border border-zinc-800 bg-zinc-950/90 focus-within:border-cyan-700 focus-within:ring-1 focus-within:ring-cyan-900/40 transition-all">
                      <textarea
                        aria-label="Ask ARGUS about your indexed knowledge base"
                        rows={1}
                        value={chatInput}
                        onChange={(event) => setChatInput(event.target.value)}
                        onKeyDown={handleChatInputKeyDown}
                        placeholder={
                          documents.filter((document) => document.status === "Indexed").length === 0
                            ? "Upload and index a document before asking a grounded question..."
                            : "Ask a question about your indexed knowledge base..."
                        }
                        disabled={isGenerating}
                        className="block min-h-12 max-h-32 w-full resize-none bg-transparent px-4 pt-3 text-sm leading-5 text-zinc-100 outline-none placeholder:text-zinc-600 disabled:cursor-not-allowed"
                      />
                      <div className="flex items-center justify-between gap-3 px-3 pb-3">
                        <span className="hidden sm:block text-[10px] text-zinc-600">Enter to send · Shift + Enter for a new line</span>
                        <span className="sm:hidden text-[10px] text-zinc-600">Grounded retrieval enabled</span>
                        <button
                          type="submit"
                          disabled={!chatInput.trim() || isGenerating}
                          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                            !chatInput.trim() || isGenerating
                              ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                              : "bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-950/30"
                          }`}
                        >
                          {isGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                          <span>{isGenerating ? "Thinking" : "Send"}</span>
                        </button>
                      </div>
                    </div>
                  </form>
                </>
              )}
            </div>

            {/* Citations Explorer / RAG Sources (Right column) */}
            {showSourcesPanel && activeConvId !== null && (
              <aside className="hidden xl:flex w-80 bg-zinc-900 border-l border-zinc-800/80 flex-col shrink-0 overflow-hidden">
                <div className="p-4 border-b border-zinc-800 flex justify-between items-center shrink-0">
                  <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Database className="h-3.5 w-3.5 text-cyan-400" />
                    <span>RAG Citations Inspector</span>
                  </span>
                  <span className="text-[10px] bg-cyan-950 border border-cyan-900 text-cyan-400 font-bold px-1.5 py-0.5 rounded">
                    Active
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {!activeSources || activeSources.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center text-zinc-600 text-xs py-20 px-4">
                      <HelpCircle className="h-8 w-8 text-zinc-700 mb-2" />
                      <p className="font-semibold text-zinc-400">No active citations</p>
                      <p className="mt-1 leading-relaxed text-[11px]">
                        Click on any assistant chat message or ask a new question to inspect which source vector chunks were matched via Cosine similarity search.
                      </p>
                    </div>
                  ) : (
                    <>
                      {activeRetrievalQuery && (
                        <div className="bg-cyan-950/20 border border-cyan-900/50 rounded-lg p-2.5">
                          <span className="block text-[9px] text-cyan-400 uppercase font-bold tracking-wider mb-1">Retrieved for query</span>
                          <p className="text-[11px] leading-relaxed text-zinc-300">{activeRetrievalQuery}</p>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-zinc-500 uppercase">
                          Retrieved ({activeSources.length} segments)
                        </span>
                        <span className="text-[9px] text-zinc-400">Hybrid relevance ranking</span>
                      </div>

                      {activeSources.map((source, sIdx) => {
                        const simPct = source.similarity ? `${Math.round(source.similarity * 100)}%` : "N/A";
                        
                        return (
                          <div
                            key={sIdx}
                            className="bg-zinc-950/80 border border-zinc-800/80 hover:border-zinc-700 rounded-lg p-3 space-y-2.5 transition-colors"
                          >
                            {/* Source Header */}
                            <div className="flex items-start justify-between">
                              <div className="flex flex-col gap-0.5 max-w-[70%]">
                                <span className="break-words text-[10.5px] font-bold text-white" title={source.documentName}>
                                  {source.documentName}
                                </span>
                                <span className="text-[9px] text-zinc-500 font-mono">
                                  Format: {source.documentType || "PDF"} 
                                  {source.pageNumber ? ` • Page ${source.pageNumber}` : ""}
                                </span>
                              </div>
                              <span
                                className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-bold ${
                                  source.similarity > 0.6
                                    ? "bg-emerald-950 text-emerald-400 border border-emerald-900/50"
                                    : source.similarity > 0.3
                                    ? "bg-cyan-950 text-cyan-400 border border-cyan-900/50"
                                    : "bg-zinc-800 text-zinc-400"
                                }`}
                                title="Calculated Cosine Match Value"
                              >
                                {simPct} match
                              </span>
                            </div>

                            {/* Chunk content preview */}
                            <div className="break-words text-[11px] text-zinc-400 leading-relaxed max-h-36 overflow-y-auto bg-zinc-900/40 p-2 rounded border border-zinc-850/60 whitespace-pre-wrap font-mono select-all">
                              {source.textContent}
                            </div>

                            <div className="flex justify-between items-center text-[9px] text-zinc-500">
                              <span>Chunk {source.chunkIndex + 1} · ID #{source.chunkId ?? sIdx}</span>
                              <span className="text-[8px] bg-zinc-800 px-1 py-0.5 rounded font-mono uppercase">
                                {source.retrievalMethod || "vector"} retrieval
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              </aside>
            )}
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === "settings" && (
          <div className="flex-1 overflow-y-auto p-8 max-w-4xl space-y-8">
            <div>
              <h1 className="text-3xl font-extrabold text-white tracking-tight">System Configuration</h1>
              <p className="text-zinc-400 mt-1">Configure your LLM model router, API keys, text chunk overlapping parameters, and custom system instruction blocks.</p>
            </div>

            <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-6 space-y-6">
              {/* Choose Provider */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-zinc-300 uppercase tracking-wider block">
                  AI Model Routing Provider
                </label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {[
                    {
                      id: "local",
                      name: "Local Offline Summary",
                      desc: "Generates answers on local text extraction using sentence matches. 100% free & offline."
                    },
                    {
                      id: "openai",
                      name: "OpenAI GPT-4o-mini",
                      desc: "Requires a standard OpenAI API Key. Highest grounded answer accuracy."
                    },
                    {
                      id: "gemini",
                      name: "Google Gemini 1.5 Flash",
                      desc: "Requires a Google Gemini API Key. Excellent RAG performance & context length."
                    }
                  ].map((prov) => (
                    <button
                      key={prov.id}
                      onClick={() => setConfig(prev => ({ ...prev, llm_provider: prov.id }))}
                      className={`text-left p-4 rounded-xl border transition-all ${
                        config.llm_provider === prov.id
                          ? "bg-cyan-950/20 border-cyan-500 text-white"
                          : "bg-zinc-950/30 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                      }`}
                    >
                      <div className="flex items-center gap-2 justify-between">
                        <span className="text-xs font-bold text-white">{prov.name}</span>
                        {config.llm_provider === prov.id && (
                          <CheckCircle className="h-4 w-4 text-cyan-400 shrink-0" />
                        )}
                      </div>
                      <p className="text-[10px] text-zinc-500 mt-2 leading-relaxed">{prov.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* API Keys Panel */}
              {config.llm_provider === "openai" && (
                <div className="space-y-2 p-4 bg-zinc-950/50 border border-zinc-800 rounded-xl animate-fade-in">
                  <label className="text-xs font-bold text-white block">
                    OpenAI API Key
                  </label>
                  <p className="text-[10px] text-zinc-500">
                    This is a write-only value. {apiKeyStatus.openai ? "An OpenAI key is configured on the server." : "No server-side OpenAI key is configured; ARGUS will use local mode."}
                  </p>
                  <input
                    type="password"
                    placeholder="Enter a new OpenAI key to replace the server value"
                    value={config.openai_api_key}
                    onChange={(e) => setConfig(prev => ({ ...prev, openai_api_key: e.target.value }))}
                    className="w-full bg-zinc-900 border border-zinc-800 focus:border-cyan-500 text-zinc-100 rounded-lg px-3 py-2 text-xs focus:outline-none mt-1 font-mono"
                  />
                </div>
              )}

              {config.llm_provider === "gemini" && (
                <div className="space-y-2 p-4 bg-zinc-950/50 border border-zinc-800 rounded-xl animate-fade-in">
                  <label className="text-xs font-bold text-white block">
                    Google Gemini API Key
                  </label>
                  <p className="text-[10px] text-zinc-500">
                    This is a write-only value. {apiKeyStatus.gemini ? "A Gemini key is configured on the server." : "No server-side Gemini key is configured; ARGUS will use local mode."}
                  </p>
                  <input
                    type="password"
                    placeholder="Enter a new Gemini key to replace the server value"
                    value={config.gemini_api_key}
                    onChange={(e) => setConfig(prev => ({ ...prev, gemini_api_key: e.target.value }))}
                    className="w-full bg-zinc-900 border border-zinc-800 focus:border-cyan-500 text-zinc-100 rounded-lg px-3 py-2 text-xs focus:outline-none mt-1 font-mono"
                  />
                </div>
              )}

              {/* Advanced Chunking & RAG Config */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-300 block">
                    Chunk Size (Characters)
                  </label>
                  <p className="text-[10px] text-zinc-500">
                    Approx. 500–800 tokens per chunk. Recommended: 3200 characters.
                  </p>
                  <input
                    type="number"
                    value={config.chunk_size}
                    onChange={(e) => setConfig(prev => ({ ...prev, chunk_size: e.target.value }))}
                    className="w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 text-xs focus:outline-none mt-1 font-mono"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-300 block">
                    Chunk Overlap (Characters)
                  </label>
                  <p className="text-[10px] text-zinc-500">
                    Approx. 80–120 tokens of overlap. Recommended: 500 characters.
                  </p>
                  <input
                    type="number"
                    value={config.chunk_overlap}
                    onChange={(e) => setConfig(prev => ({ ...prev, chunk_overlap: e.target.value }))}
                    className="w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 text-xs focus:outline-none mt-1 font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-300 block">
                    Top-K Retrieval
                  </label>
                  <p className="text-[10px] text-zinc-500">
                    Maximum relevant source chunks passed into grounded answer generation.
                  </p>
                  <input
                    type="number"
                    min="1"
                    max="15"
                    value={config.top_k}
                    onChange={(e) => setConfig(prev => ({ ...prev, top_k: e.target.value }))}
                    className="w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-lg px-3 py-2 text-xs focus:outline-none mt-1 font-mono"
                  />
                </div>
              </div>

              {/* LLM Temperature & Custom System Prompt */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-zinc-800/60 pt-4">
                <div className="md:col-span-1 space-y-2">
                  <label className="text-xs font-bold text-zinc-300 block">
                    Model Temperature: {config.temperature}
                  </label>
                  <p className="text-[10px] text-zinc-500">
                    Lower temperature yields highly deterministic factual matches. Higher values increase phrasing flexibility.
                  </p>
                  <input
                    type="range"
                    min="0.0"
                    max="1.0"
                    step="0.1"
                    value={config.temperature}
                    onChange={(e) => setConfig(prev => ({ ...prev, temperature: e.target.value }))}
                    className="w-full h-1 bg-zinc-850 rounded-lg appearance-none cursor-pointer accent-cyan-500 mt-2"
                  />
                </div>

                <div className="md:col-span-2 space-y-2">
                  <label className="text-xs font-bold text-zinc-300 block">
                    Custom Grounded System Prompt Instructions
                  </label>
                  <p className="text-[10px] text-zinc-500">
                    Provide instructions governing how ARGUS responds (e.g. strictness of factual grounding).
                  </p>
                  <textarea
                    placeholder="Leave empty to use ARGUS standard non-hallucination configuration..."
                    value={config.system_prompt}
                    onChange={(e) => setConfig(prev => ({ ...prev, system_prompt: e.target.value }))}
                    className="w-full h-20 bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-lg p-2 text-xs focus:outline-none mt-1"
                  />
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 justify-end border-t border-zinc-800/60 pt-6">
                <button
                  onClick={() => {
                    const fallback = {
                      llm_provider: "local",
                      openai_api_key: "",
                      gemini_api_key: "",
                      chunk_size: "3200",
                      chunk_overlap: "500",
                      top_k: "5",
                      temperature: "0.2",
                      system_prompt: ""
                    };
                    setConfig(fallback);
                    saveSettings(fallback);
                  }}
                  className="bg-zinc-950 hover:bg-zinc-900 text-zinc-400 text-xs font-semibold px-4 py-2 rounded-lg border border-zinc-800"
                >
                  Reset Defaults
                </button>
                <button
                  onClick={() => saveSettings(config)}
                  disabled={isSavingSettings}
                  className="bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white text-xs font-semibold px-5 py-2 rounded-lg flex items-center gap-1.5 shadow-lg shadow-cyan-900/20"
                >
                  {isSavingSettings ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle className="h-3.5 w-3.5" />
                      <span>Save Config</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {pendingDocumentDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-document-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/75 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl shadow-black/50">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-red-900/60 bg-red-950/50 text-red-400">
              <Trash2 className="h-4 w-4" />
            </div>
            <h2 id="delete-document-title" className="mt-4 text-base font-bold text-white">Delete document?</h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              This will permanently remove <span className="font-semibold text-zinc-200">{pendingDocumentDelete.name}</span>, its extracted content, chunks, embeddings, and metadata.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={isDeletingDocument}
                onClick={() => setPendingDocumentDelete(null)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeletingDocument}
                onClick={confirmDocumentDelete}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isDeletingDocument ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {isDeletingDocument ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingConversationDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-conversation-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/75 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl shadow-black/50">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-red-900/60 bg-red-950/50 text-red-400">
              <Trash2 className="h-4 w-4" />
            </div>
            <h2 id="delete-conversation-title" className="mt-4 text-base font-bold text-white">
              {pendingConversationDelete.clearMessages
                ? "Clear chat?"
                : pendingConversationDelete.clearAll
                  ? "Delete all conversations?"
                  : "Delete conversation?"}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              {pendingConversationDelete.clearMessages
                ? "All messages in this conversation will be permanently deleted, but the conversation will remain available."
                : pendingConversationDelete.clearAll
                  ? "All conversations and their messages will be permanently deleted."
                  : "This conversation and all of its messages will be permanently removed."}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={isDeletingConversation}
                onClick={() => setPendingConversationDelete(null)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeletingConversation}
                onClick={confirmConversationDelete}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isDeletingConversation ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {isDeletingConversation
                  ? pendingConversationDelete.clearMessages ? "Clearing..." : "Deleting..."
                  : pendingConversationDelete.clearMessages ? "Clear chat" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
