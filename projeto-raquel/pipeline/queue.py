import sqlite3
import json
import os
from pathlib import Path
from datetime import datetime, timedelta


def _db_path() -> Path:
    return Path(os.getenv("DB_PATH", "data/pipeline.db"))


def _conn():
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    # fetch grava no pool enquanto compile lê; sem isto a escrita morre com SQLITE_BUSY.
    con.execute("PRAGMA busy_timeout = 10000")
    return con


def init_db():
    con = _conn()
    con.executescript("""
        CREATE TABLE IF NOT EXISTS content_briefs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            source_ref TEXT,
            drama_title TEXT,
            event_name TEXT,
            artists TEXT,
            event_date TEXT,
            event_location TEXT,
            ticket_price TEXT,
            platform TEXT,
            raw_notes TEXT,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
        );

        CREATE TABLE IF NOT EXISTS instagram_synced (
            instagram_id TEXT PRIMARY KEY,
            synced_at TEXT NOT NULL,
            youtube_video_id TEXT
        );

        CREATE TABLE IF NOT EXISTS upload_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            brief_id INTEGER NOT NULL,
            video_type TEXT NOT NULL DEFAULT 'long',
            title TEXT,
            description TEXT,
            tags TEXT,
            chapters TEXT,
            thumbnail_text TEXT,
            script TEXT,
            shorts_hooks TEXT,
            blog_keywords TEXT,
            blog_article TEXT,
            scheduled_time TEXT,
            uploaded_at TEXT,
            youtube_video_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            FOREIGN KEY (brief_id) REFERENCES content_briefs(id)
        );

        -- Reels baixados aguardando entrar num compilado 16:9.
        -- Só migram para instagram_synced quando o compilado que os contém é publicado.
        CREATE TABLE IF NOT EXISTS clip_pool (
            instagram_id TEXT PRIMARY KEY,
            file_path TEXT NOT NULL,
            caption TEXT,
            duration REAL,
            taken_at TEXT,
            added_at TEXT NOT NULL,
            compilation_id INTEGER
        );

        -- Clipes que chegaram ilegíveis (download truncado, decode quebrado).
        -- Ficam fora do pool para não derrubar o render, mas o fetch tenta
        -- baixar de novo enquanto attempts < MAX_CLIP_ATTEMPTS.
        CREATE TABLE IF NOT EXISTS clip_quarantine (
            instagram_id TEXT PRIMARY KEY,
            reason TEXT,
            attempts INTEGER NOT NULL DEFAULT 1,
            last_seen_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS compilations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            file_path TEXT,
            duration REAL,
            clip_ids TEXT NOT NULL,
            created_at TEXT NOT NULL,
            uploaded_at TEXT,
            youtube_video_id TEXT,
            status TEXT NOT NULL DEFAULT 'built'
        );
    """)
    con.commit()
    con.close()


# ─── COMPILADOS 16:9 ─────────────────────────────────────────────────────────

def add_clip_to_pool(instagram_id: str, file_path: str, caption: str,
                     duration: float, taken_at: str = None):
    """Registra um Reel baixado como disponível para compilação."""
    con = _conn()
    con.execute(
        """INSERT OR IGNORE INTO clip_pool
           (instagram_id, file_path, caption, duration, taken_at, added_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (instagram_id, file_path, caption, duration, taken_at, datetime.utcnow().isoformat()),
    )
    # Entrou no pool íntegro: a quarentena anterior era de um download que
    # falhou e já foi refeito. Deixar a linha lá faria o `pool` listar como
    # ilegível um clipe que está justamente ali dentro, esperando compilação.
    con.execute("DELETE FROM clip_quarantine WHERE instagram_id = ?", (instagram_id,))
    con.commit()
    con.close()


def get_original_captions() -> dict:
    """
    Legenda original de cada Reel já publicado, tirada do que foi enviado ao
    YouTube na época. É a fonte para titular compilados de clipes reprocessados,
    que entram no pool sem legenda.
    """
    con = _conn()
    rows = con.execute(
        """SELECT b.source_ref AS ig, q.title, q.description
           FROM upload_queue q
           JOIN content_briefs b ON q.brief_id = b.id
           WHERE b.source_ref IS NOT NULL"""
    ).fetchall()
    con.close()
    return {
        r["ig"]: (r["title"] or r["description"] or "")
        for r in rows
        if r["ig"] and (r["title"] or r["description"])
    }


def set_clip_caption(instagram_id: str, caption: str):
    con = _conn()
    con.execute(
        "UPDATE clip_pool SET caption = ? WHERE instagram_id = ?",
        (caption, instagram_id),
    )
    con.commit()
    con.close()


def get_pool_ids() -> set:
    """Todos os ids já no pool — evita rebaixar o que está esperando compilação."""
    con = _conn()
    rows = con.execute("SELECT instagram_id FROM clip_pool").fetchall()
    con.close()
    return {row[0] for row in rows}


# Um download truncado costuma ser falha de rede: vale tentar de novo. Depois de
# três tentativas o clipe é dado como perdido e passa a ser ignorado pelo fetch,
# senão toda rodada gasta banda no mesmo arquivo quebrado.
MAX_CLIP_ATTEMPTS = 3


def quarantine_clip(instagram_id: str, reason: str, file_path: str = None):
    """
    Tira um clipe ilegível do pool e conta a tentativa. Apaga o MP4 quebrado
    quando o caminho é informado: o arquivo parcial é justamente o que precisa
    sair da frente para o fetch baixar de novo.
    """
    con = _conn()
    con.execute("DELETE FROM clip_pool WHERE instagram_id = ?", (instagram_id,))
    con.execute(
        """INSERT INTO clip_quarantine (instagram_id, reason, attempts, last_seen_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(instagram_id) DO UPDATE SET
               reason = excluded.reason,
               attempts = clip_quarantine.attempts + 1,
               last_seen_at = excluded.last_seen_at""",
        (instagram_id, reason, datetime.utcnow().isoformat()),
    )
    con.commit()
    con.close()
    if file_path:
        Path(file_path).unlink(missing_ok=True)


def get_exhausted_clip_ids() -> set:
    """Clipes que estouraram as tentativas — o fetch não tenta mais."""
    con = _conn()
    rows = con.execute(
        "SELECT instagram_id FROM clip_quarantine WHERE attempts >= ?",
        (MAX_CLIP_ATTEMPTS,),
    ).fetchall()
    con.close()
    return {row[0] for row in rows}


def get_quarantined_clips() -> list[dict]:
    con = _conn()
    rows = con.execute(
        "SELECT * FROM clip_quarantine ORDER BY last_seen_at DESC"
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def get_available_clips() -> list[dict]:
    """Clipes do pool ainda não atribuídos a nenhum compilado, mais antigos primeiro."""
    con = _conn()
    rows = con.execute(
        """SELECT * FROM clip_pool
           WHERE compilation_id IS NULL
           ORDER BY COALESCE(taken_at, added_at)"""
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def create_compilation(title: str, description: str, file_path: str,
                       duration: float, clip_ids: list[str]) -> int:
    """Grava o compilado e reserva seus clipes numa única transação."""
    con = _conn()
    try:
        cur = con.execute(
            """INSERT INTO compilations
               (title, description, file_path, duration, clip_ids, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (title, description, file_path, duration,
             json.dumps(clip_ids), datetime.utcnow().isoformat()),
        )
        comp_id = cur.lastrowid
        con.executemany(
            "UPDATE clip_pool SET compilation_id = ? WHERE instagram_id = ?",
            [(comp_id, cid) for cid in clip_ids],
        )
        con.commit()
    finally:
        con.close()
    return comp_id


def next_compilation_number() -> int:
    """
    Próximo número de arquivo para um compilado. Baseado no MAX(id) da tabela,
    não na contagem de pendentes — senão, depois de publicar, o contador volta
    a zero e sobrescreve o arquivo de um compilado que já está no ar.
    """
    con = _conn()
    n = con.execute("SELECT COALESCE(MAX(id), 0) FROM compilations").fetchone()[0]
    con.close()
    return n + 1


def get_compilation_clips(comp_id: int) -> list[dict]:
    """Clipes que compõem um compilado, na ordem em que entraram no vídeo."""
    con = _conn()
    rows = con.execute(
        """SELECT * FROM clip_pool WHERE compilation_id = ?
           ORDER BY COALESCE(taken_at, added_at)""",
        (comp_id,),
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def set_compilation_description(comp_id: int, description: str):
    con = _conn()
    con.execute(
        "UPDATE compilations SET description = ? WHERE id = ? AND status = 'built'",
        (description, comp_id),
    )
    con.commit()
    con.close()


def set_compilation_title(comp_id: int, title: str) -> bool:
    """Renomeia um compilado ainda não publicado. False se já foi ao ar."""
    con = _conn()
    try:
        cur = con.execute(
            "UPDATE compilations SET title = ? WHERE id = ? AND status = 'built'",
            (title, comp_id),
        )
        con.commit()
        return cur.rowcount > 0
    finally:
        con.close()


def get_pending_compilations() -> list[dict]:
    con = _conn()
    rows = con.execute(
        "SELECT * FROM compilations WHERE status = 'built' ORDER BY id"
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def mark_compilation_uploaded(comp_id: int, youtube_video_id: str):
    """
    Fecha o compilado e propaga o id do YouTube para cada Reel que o compõe,
    para que o sync do Instagram não volte a baixá-los.
    """
    con = _conn()
    try:
        row = con.execute("SELECT clip_ids FROM compilations WHERE id = ?", (comp_id,)).fetchone()
        clip_ids = json.loads(row["clip_ids"]) if row else []
        now = datetime.utcnow().isoformat()
        con.execute(
            """UPDATE compilations
               SET status = 'done', uploaded_at = ?, youtube_video_id = ?
               WHERE id = ?""",
            (now, youtube_video_id, comp_id),
        )
        # OR IGNORE, não OR REPLACE: Reels reprocessados a partir de Shorts que já
        # estão no ar preservam o id do vídeo original. Só clipes inéditos são
        # marcados com o id do compilado.
        con.executemany(
            """INSERT OR IGNORE INTO instagram_synced
               (instagram_id, synced_at, youtube_video_id) VALUES (?, ?, ?)""",
            [(cid, now, youtube_video_id) for cid in clip_ids],
        )
        con.commit()
    finally:
        con.close()


def add_brief(
    content_type: str,
    raw_notes: str,
    source: str = "manual",
    source_ref: str = None,
    drama_title: str = None,
    event_name: str = None,
    artists: str = None,
    event_date: str = None,
    event_location: str = None,
    ticket_price: str = None,
    platform: str = None,
) -> int:
    con = _conn()
    cur = con.execute(
        """INSERT INTO content_briefs
           (type, source, source_ref, drama_title, event_name, artists,
            event_date, event_location, ticket_price, platform, raw_notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            content_type, source, source_ref, drama_title, event_name, artists,
            event_date, event_location, ticket_price, platform,
            raw_notes, datetime.utcnow().isoformat(),
        ),
    )
    brief_id = cur.lastrowid
    con.commit()
    con.close()
    return brief_id


def get_pending_briefs() -> list[dict]:
    con = _conn()
    rows = con.execute(
        "SELECT * FROM content_briefs WHERE status = 'pending' ORDER BY created_at"
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def get_brief(brief_id: int) -> dict | None:
    con = _conn()
    row = con.execute("SELECT * FROM content_briefs WHERE id = ?", (brief_id,)).fetchone()
    con.close()
    return dict(row) if row else None


def mark_brief_scripted(brief_id: int):
    con = _conn()
    con.execute(
        "UPDATE content_briefs SET status = 'scripted' WHERE id = ?", (brief_id,)
    )
    con.commit()
    con.close()


def mark_brief_done(brief_id: int):
    con = _conn()
    con.execute(
        "UPDATE content_briefs SET status = 'done' WHERE id = ?", (brief_id,)
    )
    con.commit()
    con.close()


def enqueue_upload(brief_id: int, script_data: dict, video_type: str = "long") -> int:
    con = _conn()
    cur = con.execute(
        """INSERT INTO upload_queue
           (brief_id, video_type, title, description, tags, chapters,
            thumbnail_text, script, shorts_hooks, blog_keywords)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            brief_id,
            video_type,
            script_data.get("youtube_title"),
            script_data.get("description"),
            json.dumps(script_data.get("tags", [])),
            json.dumps(script_data.get("chapters", [])),
            script_data.get("thumbnail_text"),
            script_data.get("script"),
            json.dumps(script_data.get("shorts_hooks", [])),
            json.dumps(script_data.get("blog_keywords", [])),
        ),
    )
    queue_id = cur.lastrowid
    con.commit()
    con.close()
    return queue_id


def set_blog_article(queue_id: int, article_json: str):
    con = _conn()
    con.execute(
        "UPDATE upload_queue SET blog_article = ? WHERE id = ?", (article_json, queue_id)
    )
    con.commit()
    con.close()


def schedule_upload(queue_id: int, scheduled_time: str):
    con = _conn()
    con.execute(
        "UPDATE upload_queue SET scheduled_time = ?, status = 'scheduled' WHERE id = ?",
        (scheduled_time, queue_id),
    )
    con.commit()
    con.close()


def get_due_uploads() -> list[dict]:
    con = _conn()
    now = datetime.utcnow().isoformat()
    rows = con.execute(
        """SELECT * FROM upload_queue
           WHERE status = 'scheduled' AND scheduled_time <= ?
           ORDER BY scheduled_time""",
        (now,),
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def get_all_queue() -> list[dict]:
    con = _conn()
    rows = con.execute(
        """SELECT q.*, b.type as brief_type, b.drama_title, b.event_name
           FROM upload_queue q
           JOIN content_briefs b ON q.brief_id = b.id
           ORDER BY q.id DESC"""
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def mark_uploaded(queue_id: int, youtube_video_id: str):
    con = _conn()
    con.execute(
        "UPDATE upload_queue SET status = 'done', uploaded_at = ?, youtube_video_id = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), youtube_video_id, queue_id),
    )
    con.commit()
    con.close()


def get_all_synced_instagram_ids() -> set:
    con = _conn()
    rows = con.execute("SELECT instagram_id FROM instagram_synced").fetchall()
    con.close()
    return {row[0] for row in rows}


def is_instagram_synced(instagram_id: str) -> bool:
    con = _conn()
    row = con.execute(
        "SELECT 1 FROM instagram_synced WHERE instagram_id = ?", (instagram_id,)
    ).fetchone()
    con.close()
    return row is not None


def mark_instagram_synced(instagram_id: str, youtube_video_id: str = None):
    con = _conn()
    con.execute(
        "INSERT OR REPLACE INTO instagram_synced (instagram_id, synced_at, youtube_video_id) VALUES (?, ?, ?)",
        (instagram_id, datetime.utcnow().isoformat(), youtube_video_id),
    )
    con.commit()
    con.close()


def enqueue_instagram_video(instagram_id: str, title: str, description: str, tags: list, video_path: str) -> int:
    """Cria um brief 'instagram' e enfileira o vídeo para upload."""
    con = _conn()
    now = datetime.utcnow().isoformat()
    cur = con.execute(
        """INSERT INTO content_briefs (type, source, source_ref, raw_notes, created_at, status)
           VALUES ('instagram', 'instagram', ?, ?, ?, 'scripted')""",
        (instagram_id, title, now),
    )
    brief_id = cur.lastrowid
    cur2 = con.execute(
        """INSERT INTO upload_queue (brief_id, video_type, title, description, tags, status)
           VALUES (?, 'long', ?, ?, ?, 'ready')""",
        (brief_id, title, description, json.dumps(tags)),
    )
    queue_id = cur2.lastrowid
    con.commit()
    con.close()
    return queue_id


def get_ready_uploads() -> list[dict]:
    """Retorna uploads com status 'ready' (prontos para upload imediato)."""
    con = _conn()
    rows = con.execute(
        """SELECT q.*, b.type as brief_type, b.source_ref as instagram_id
           FROM upload_queue q
           JOIN content_briefs b ON q.brief_id = b.id
           WHERE q.status = 'ready'
           ORDER BY q.id"""
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def next_upload_slot(upload_slots_brt: list[str], max_per_day: int = 1) -> str:
    con = _conn()
    for days_ahead in range(14):
        day = (datetime.utcnow() + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
        day_count = con.execute(
            "SELECT COUNT(*) FROM upload_queue WHERE scheduled_time LIKE ? AND status IN ('scheduled', 'done')",
            (f"{day}%",),
        ).fetchone()[0]
        if day_count >= max_per_day:
            continue
        for slot in upload_slots_brt:
            candidate = f"{day}T{slot}:00"
            if datetime.fromisoformat(candidate) < datetime.utcnow():
                continue
            taken = con.execute(
                "SELECT id FROM upload_queue WHERE scheduled_time = ? AND status IN ('scheduled', 'done')",
                (candidate,),
            ).fetchone()
            if not taken:
                con.close()
                return candidate
    con.close()
    raise RuntimeError("Nenhum slot disponível nos próximos 14 dias")
