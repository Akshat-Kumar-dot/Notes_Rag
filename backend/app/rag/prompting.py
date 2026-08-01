from __future__ import annotations

from app.rag.retrieval import Hit

SYSTEM = """You answer questions using only the numbered excerpts from the user's \
own uploaded files, shown below.

Rules:
- Ground every claim in the excerpts. Cite with bracketed numbers like [2].
- If the excerpts don't contain the answer, say so plainly and stop. Never fill \
gaps from general knowledge.
- These are the user's own documents. Keep their terminology.
- Be concise and direct."""


def format_context(hits: list[Hit]) -> str:
    parts = []
    for i, h in enumerate(hits, start=1):
        label = f"[{i}] {h.filename}"
        if h.page_number and h.page_number > 1:
            label += f", p.{h.page_number}"
        if h.heading:
            label += f" — {h.heading}"
        parts.append(f"{label}\n{h.text}")
    return "\n\n---\n\n".join(parts)


def build_prompt(question: str, hits: list[Hit], history: list[tuple[str, str]]) -> str:
    convo = ""
    if history:
        turns = "\n".join(f"{r}: {c}" for r, c in history[-4:])
        convo = f"Earlier in this conversation:\n{turns}\n\n"
    return (
        f"{SYSTEM}\n\n{convo}Excerpts:\n\n{format_context(hits)}\n\nQuestion: {question}"
    )


REWRITE = """Rewrite the user's latest message into a standalone search query, using \
the conversation history to resolve references. Output only the query."""


def build_rewrite(question: str, history: list[tuple[str, str]]) -> str:
    turns = "\n".join(f"{r}: {c}" for r, c in history[-4:])
    return f"{REWRITE}\n\nHistory:\n{turns}\n\nLatest: {question}"
