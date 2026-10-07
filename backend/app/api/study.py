"""Study map: see which passages of a folder you have studied, and study the
dark ones with Teach me / Quiz me.

The map itself costs no model calls: it is built from citations every answer
already stores (MongoDB) and the folder's passages (Postgres). Only Teach me and
Quiz me call Gemini, and for a guest each spends one question credit.
"""

from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app import study_store
from app.api.folders import owned_folder
from app.auth import guest
from app.auth.deps import DB, CurrentUser
from app.llm.gemini import LLMBusy, LLMError, complete
from app.models import Chunk, File
from app.rag import prompting
from app.schemas import MapFile, Passage, QuizAnswer, QuizResult, StudyMap, StudyOut, StudyRequest

log = logging.getLogger(__name__)
router = APIRouter(tags=["study"])

# Consecutive passages per Teach me / Quiz me: enough for one idea, short
# enough to read in a minute.
PASSAGES = 3
EXCERPT = 700


def _label(filename: str, page: int | None) -> str:
    return filename + (f", p.{page}" if page and page > 1 else "")


def _json(raw: str) -> dict:
    """JSON mode should return a bare document; tolerate stray prose anyway."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        i, j = raw.find("{"), raw.rfind("}")
        if 0 <= i < j:
            try:
                return json.loads(raw[i:j + 1])
            except json.JSONDecodeError:
                pass
    raise LLMError("The model returned something unexpected. Try again.")


def _model_error(exc: LLMError) -> HTTPException:
    code = status.HTTP_503_SERVICE_UNAVAILABLE if isinstance(exc, LLMBusy) else status.HTTP_502_BAD_GATEWAY
    return HTTPException(code, str(exc))


# ---------------------------------------------------------------- the map


@router.get("/folders/{folder_id}/map", response_model=StudyMap)
async def study_map(folder_id: UUID, user: CurrentUser, db: DB) -> StudyMap:
    folder = await owned_folder(db, user, folder_id)
    files = (await db.execute(
        select(File.id, File.original_filename, File.status)
        .where(File.folder_id == folder.id, File.user_id == user.id)
        .order_by(File.created_at)
    )).all()
    # Only the columns the map needs -- never the embeddings.
    chunks = (await db.execute(
        select(Chunk.id, Chunk.file_id, Chunk.ordinal, Chunk.page_number)
        .where(Chunk.folder_id == folder.id, Chunk.user_id == user.id)
        .order_by(Chunk.file_id, Chunk.ordinal)
    )).all()
    strength = await study_store.strengths(user.id, folder.id)

    now = datetime.now(UTC)
    by_file: dict[UUID, list] = defaultdict(list)
    for c in chunks:
        by_file[c.file_id].append(c)

    out, total, studied, fading = [], 0, 0, 0
    for f in files:
        cells, ages, pages, ords = [], [], [], []
        for c in by_file.get(f.id, []):
            total += 1
            pages.append(c.page_number)
            ords.append(c.ordinal)
            hit = strength.get(c.id)
            if hit is None:
                cells.append(-1.0)
                ages.append(-1)
                continue
            s, last = hit
            studied += 1
            fading += s < study_store.LIT
            cells.append(round(s, 3))
            ages.append(int((now - last).total_seconds() // 86_400))
        out.append(MapFile(id=f.id, name=f.original_filename, status=f.status,
                           cells=cells, ages=ages, pages=pages, ordinals=ords))

    return StudyMap(
        folder_id=folder.id, folder_name=folder.name, total=total,
        studied=studied, fading=fading, lit=study_store.LIT, files=out,
    )


# ---------------------------------------------------------------- teach / quiz


async def _load_passages(db: DB, user_id: UUID, folder_id: UUID, file_id: UUID, start: int):
    file = await db.scalar(
        select(File).where(File.id == file_id, File.user_id == user_id, File.folder_id == folder_id)
    )
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
    rows = (await db.execute(
        select(Chunk.id, Chunk.ordinal, Chunk.page_number, Chunk.text)
        .where(Chunk.file_id == file.id, Chunk.user_id == user_id, Chunk.ordinal >= start)
        .order_by(Chunk.ordinal)
        .limit(PASSAGES)
    )).all()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Those passages are gone. Refresh the map.")
    return file, rows


def _passages_out(file: File, rows, with_text: bool) -> list[Passage]:
    return [
        Passage(n=i, ordinal=r.ordinal, label=_label(file.original_filename, r.page_number),
                excerpt=r.text[:EXCERPT] if with_text else None)
        for i, r in enumerate(rows, 1)
    ]


@router.post("/folders/{folder_id}/study", response_model=StudyOut)
async def study(folder_id: UUID, payload: StudyRequest, user: CurrentUser, db: DB) -> StudyOut:
    folder = await owned_folder(db, user, folder_id)
    file, rows = await _load_passages(db, user.id, folder.id, payload.file_id, payload.start)
    passages = [(_label(file.original_filename, r.page_number), r.text) for r in rows]
    chunk_ids = [r.id for r in rows]

    # A model call: for a guest, one question credit. Committed before the
    # call, like chat, and refunded below if the model fails.
    await guest.spend(db, user, "message")
    await db.commit()

    try:
        if payload.mode == "teach":
            text = await complete(prompting.build_teach(passages), max_tokens=700, timeout=45.0)
            await study_store.record(user.id, folder.id, file.id, chunk_ids, "teach", study_store.TEACH)
            return StudyOut(mode="teach", text=text, passages=_passages_out(file, rows, True))

        data = _json(await complete(prompting.build_quiz(passages), max_tokens=400,
                                    timeout=40.0, json_mode=True))
        question = str(data.get("question") or "").strip()
        points = [str(p).strip() for p in data.get("points") or [] if str(p).strip()]
        if not question or not points:
            raise LLMError("The model couldn't write a question for these passages. Try another spot.")
        quiz_id = await study_store.save_quiz(user.id, folder.id, file.id, chunk_ids, question, points[:4])
        # The passages are withheld until the answer is in: they are the answer.
        return StudyOut(mode="quiz", quiz_id=quiz_id, question=question,
                        passages=_passages_out(file, rows, False))
    except LLMError as exc:
        if user.is_guest:
            await guest.refund(user.id, "message")
        raise _model_error(exc) from None


@router.post("/quizzes/{quiz_id}/answer", response_model=QuizResult)
async def answer_quiz(quiz_id: UUID, payload: QuizAnswer, user: CurrentUser, db: DB) -> QuizResult:
    # Marking is part of the quiz the guest already paid for, so it costs no
    # credit -- which is also why each quiz can be marked only once.
    quiz = await study_store.claim_quiz(quiz_id, user.id)
    if quiz is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That quiz was already answered or has expired.")

    file = await db.scalar(select(File).where(File.id == quiz["file_id"], File.user_id == user.id))
    rows = (await db.execute(
        select(Chunk.id, Chunk.ordinal, Chunk.page_number, Chunk.text)
        .where(Chunk.id.in_(quiz["chunk_ids"]), Chunk.user_id == user.id)
        .order_by(Chunk.ordinal)
    )).all()
    if file is None or not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "The passages for this quiz were deleted.")
    passages = [(_label(file.original_filename, r.page_number), r.text) for r in rows]

    try:
        data = _json(await complete(
            prompting.build_grade(passages, quiz["question"], quiz["points"], payload.answer),
            max_tokens=400, timeout=40.0, json_mode=True,
        ))
    except LLMError as exc:
        await study_store.release_quiz(quiz_id)   # not the student's fault: allow a retry
        raise _model_error(exc) from None

    try:
        score = max(0.0, min(1.0, float(data.get("score", 0))))
    except (TypeError, ValueError):
        score = 0.0
    verdict = data.get("verdict")
    if verdict not in ("correct", "partial", "wrong"):
        verdict = "correct" if score >= 0.8 else "partial" if score >= 0.4 else "wrong"
    missed = [str(m).strip() for m in data.get("missed") or [] if str(m).strip()]

    await study_store.record(user.id, quiz["folder_id"], file.id, [r.id for r in rows],
                             "quiz", study_store.quiz_weight(score))
    return QuizResult(
        score=round(score, 2), verdict=verdict,
        feedback=str(data.get("feedback") or "").strip(), missed=missed[:4],
        points=quiz["points"], passages=_passages_out(file, rows, True),
    )
