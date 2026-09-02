"""
Envia 5 prompts Suno do próximo tema da rotação via email às 06:00.
Agendar via Task Scheduler: python prompt_mailer.py
"""
import json
import os
import sqlite3
import sys
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent / ".env")

RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
TO_EMAIL       = "andreprol1980@gmail.com"
FROM_EMAIL     = "onboarding@resend.dev"
THEMES_FILE    = Path(__file__).parent / "config" / "themes.json"
DB_PATH        = os.getenv("DB_PATH", str(Path(__file__).parent / "data" / "pipeline.db"))

TRACK_PROFILES = [
    {
        "label": "Track 1 — Opening",
        "bpm": 126,
        "energy": "slow hypnotic intro, atmospheric, minimal percussion, soft bass pulse, mysterious mood, building tension",
    },
    {
        "label": "Track 2 — Build",
        "bpm": 128,
        "energy": "rising energy, rolling bassline, tight hi-hat groove, synth arp entering, driving forward momentum",
    },
    {
        "label": "Track 3 — Peak",
        "bpm": 131,
        "energy": "peak hour energy, heavy punchy kick, thick growling bass, intense driving groove, euphoric dark synth lead",
    },
    {
        "label": "Track 4 — Journey",
        "bpm": 130,
        "energy": "sustained peak, hypnotic loop, eerie vocal chop, deep sub bass, relentless groove, dark melodic texture",
    },
    {
        "label": "Track 5 — Outro",
        "bpm": 127,
        "energy": "cool down, softer kick, atmospheric pad swell, melodic synth fading, closing dark groove, introspective mood",
    },
]

THEME_EXTRAS = {
    "ibiza":    "Mediterranean sunset mood, beach club terrace, Dalt Vila cliffs in background",
    "santorini": "Greek island night, caldera view, Aegean breeze, white-washed rooftop",
    "maldives": "tropical ocean atmosphere, overwater bungalow, Indian Ocean horizon",
    "bali":     "jungle spiritual energy, Hindu temple fire torches, Uluwatu cliffs",
    "monaco":   "luxury underground, mega yachts harbor, French Riviera sophistication",
    "mykonos":  "iconic windmills night, Little Venice waterfront, Aegean party energy",
    "amalfi":   "Italian cliffside drama, Positano cascading lights, Tyrrhenian sea",
    "dubai":    "futuristic skyline, Burj Khalifa backdrop, desert heat night energy",
    "tulum":    "Mayan ruins mystery, jungle cenote vibes, Caribbean underground",
    "rio":      "Brazilian dark groove, Sugarloaf silhouette, Copacabana Atlantic night",
    "capri":    "Faraglioni rocks drama, emerald Mediterranean, exclusive island night",
    "hawaii":   "volcanic Pacific energy, tropical jungle dark, black lava cliffs night",
    "cannes":     "French Riviera glamour, La Croisette night lights, yacht marina energy",
    "formentera": "Balearic boho spirit, dune-lit lagoon, barefoot sunset groove",
    "zanzibar":   "Swahili coast mystery, spice-market shadows, Indian Ocean night breeze",
    "phuket":     "Andaman jungle drama, karst cliff silhouette, tropical monsoon heat",
    "cabo":       "Baja desert-meets-ocean energy, El Arco silhouette, Pacific night swell",
    "sttropez":   "Riviera glamour, pastel harbor lights, superyacht marina sophistication",
    "seychelles": "granite island mystery, palm jungle hush, Indian Ocean isolation",
    "marbella":   "Costa del Sol luxury, marina yacht lights, Sierra Blanca night silhouette",
    "miami":      "Art Deco neon energy, South Beach skyline, Atlantic night heat",
    "sardinia":   "Costa Smeralda exclusivity, granite cove shadows, emerald night water",
    "borabora":     "Polynesian overwater dream, volcanic peak silhouette, lagoon hush",
    "fiji":         "South Pacific island spirit, coral reef stillness, warm tropical night",
    "barbados":     "Caribbean rum-shack groove, pastel colonial glow, palm-lined coast",
    "cartagena":    "colonial Caribbean heat, colorful rooftop skyline, salsa-tinged night energy",
    "capetown":     "Atlantic mountain drama, Twelve Apostles silhouette, cool ocean breeze",
    "corsica":      "Mediterranean ruggedness, granite cliff mystery, pine-scented night air",
    "cascais":      "Atlantic cliffside romance, fortress silhouette, wild ocean wind",
    "hvar":         "Adriatic island glamour, Venetian stone glow, harbor night energy",
    "havana":       "Cuban colonial nostalgia, vintage seafront neon, warm Caribbean groove",
    "malibu":       "California coastal cool, golden cliff silhouette, Pacific night breeze",
    "bondi":        "Australian beach glamour, sandstone headland drama, Tasman sea energy",
    "algarve":      "Portuguese sea-cave mystery, golden grotto glow, Atlantic night hush",
    "puntadeleste": "South American glam energy, modern skyline silhouette, river-meets-ocean night",
    "langkawi":     "Malaysian jungle-island mystery, limestone karst silhouette, Andaman night calm",
    "kotor":        "Montenegrin fjord drama, medieval fortress glow, deep bay stillness",
    "turks":        "Caribbean powder-sand serenity, endless reef stillness, cabana night hush",
    "mauritius":    "Indian Ocean volcanic drama, sugarcane coastline, lagoon sunset hush",
    "kohsamui":     "Thai island warmth, limestone islet silhouette, Gulf night breeze",
    "boracay":      "Philippine sunset-strip energy, powder-sand glow, Sulu sea night hush",
    "goldcoast":    "Australian surf-city energy, skyline-against-beach drama, Pacific night pulse",
    "nycsubway":    "gritty New York underground pulse, flickering fluorescent tension, distant train rumble",
    "moscowmetro":  "opulent Soviet-era grandeur, marble echo, chandelier-lit underground drama",
    "tokyounderground": "Shibuya neon density, rain-slicked alley glow, restless night pulse",
    "berlinunderground": "raw industrial techno bunker energy, cold strobe haze, relentless underground drive",
    "detroitwarehouse":  "birthplace-of-techno grit, rusted industrial dust, raw warehouse floodlight",
    "londonunderground": "Victorian brick tunnel mystery, amber tunnel glow, subterranean hush",
    "amsterdamcellar":   "canal-side cellar intimacy, candlelit brick warmth, cozy underground pulse",
    "dublinpub":    "warm Irish pub session energy, brass and wood glow, cozy underground groove",
    "praguespeakeasy":   "hidden speakeasy mystery, candlelit stone archway, secretive night energy",
    "vegasnightclub":    "mega-club extravagance, laser-cut haze, towering LED spectacle",
    "seoulnightclub":    "Gangnam glam precision, mirrored neon glow, glass dance floor pulse",
    "amazoncanopy":      "treetop rainforest mystery, humid dusk mist, ancient canopy hush",
    "amazonriver":       "floating river-stage intimacy, torchlit water reflection, starlit canopy gap",
    "amazonwaterfall":   "hidden waterfall grotto serenity, cool cascading mist, mossy stillness",
    "amazonnight":       "deep jungle nocturne, firefly glow, distant torchlit haze",
    "eiffeltower":       "Parisian rooftop romance, iron lattice glow, golden night sparkle",
    "burjkhalifa":       "Dubai sky-high opulence, glass spire glow, desert skyline haze",
    "sydneyopera":       "harborside elegance, sail-shaped silhouette, shimmering forecourt night",
    "romecolosseum":     "ancient floodlit grandeur, 2000-year stone drama, underground chamber mystery",
    "marinabaysands":    "Singapore rooftop spectacle, infinity-skyline glow, glittering night haze",
}


def get_next_theme() -> dict:
    """Espelha pipeline.queue.get_next_theme() — cópia local para não depender
    do cwd do Task Scheduler ao importar o pacote pipeline.
    Ver [[feedback-rotacao-travava-em-ibiza]] no projeto Umbra Sessions."""
    themes = json.loads(THEMES_FILE.read_text(encoding="utf-8"))
    try:
        con = sqlite3.connect(DB_PATH)
        con.execute("PRAGMA busy_timeout = 5000")
        used = [r[0] for r in con.execute(
            "SELECT theme_id FROM theme_rotation ORDER BY id ASC"
        ).fetchall()]
        con.close()
    except Exception:
        used = []
    theme_ids = [t["id"] for t in themes]
    for tid in theme_ids:
        if tid not in used:
            return next(t for t in themes if t["id"] == tid)
    last_index = {tid: i for i, tid in enumerate(used)}
    next_tid = min(theme_ids, key=lambda tid: last_index.get(tid, -1))
    return next(t for t in themes if t["id"] == next_tid)


def build_prompts(theme: dict) -> list[dict]:
    extra = THEME_EXTRAS.get(theme["id"], theme["location"])
    prompts = []
    for profile in TRACK_PROFILES:
        prompt = (
            f"dark tech house, {profile['bpm']} BPM, "
            f"{profile['energy']}, "
            f"{extra}, "
            f"no lyrics, instrumental"
        )
        prompts.append({"label": profile["label"], "prompt": prompt})
    return prompts


def build_html(theme: dict, prompts: list[dict]) -> str:
    rows = ""
    for i, p in enumerate(prompts, 1):
        rows += f"""
        <div style="margin-bottom:24px;padding:16px;background:#1a1a2e;border-left:4px solid #7c3aed;border-radius:4px;">
          <p style="margin:0 0 6px;color:#a78bfa;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">{p['label']}</p>
          <p style="margin:0;color:#e2e8f0;font-family:monospace;font-size:13px;line-height:1.6;">{p['prompt']}</p>
        </div>"""

    return f"""
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0f0f1a;padding:32px;border-radius:8px;">
      <h1 style="color:#7c3aed;margin:0 0 4px;font-size:22px;">🎧 Umbra Sessions</h1>
      <p style="color:#6b7280;margin:0 0 24px;font-size:13px;">Prompts do dia — {theme['name']}</p>

      <p style="color:#94a3b8;font-size:14px;margin:0 0 20px;">
        Gere os 5 tracks abaixo no Suno (Style field, Lyrics em branco).
        Baixe os MP3s e jogue no atalho da área de trabalho.
      </p>

      {rows}

      <hr style="border:none;border-top:1px solid #1e293b;margin:24px 0;">
      <p style="color:#4b5563;font-size:12px;margin:0;">
        Pasta: <code style="color:#7c3aed;">F:\\RichClub\\music-channel-pipeline\\data\\audio\\pending\\</code><br>
        Após colocar os 5 MP3s, o pipeline roda automaticamente às 10h (gera) e 18h (upload).
      </p>
    </div>"""


def send_email(subject: str, html: str):
    if not RESEND_API_KEY or RESEND_API_KEY == "your_resend_key_here":
        print("RESEND_API_KEY não configurada. Imprimindo prompts no terminal:\n")
        return False
    resp = requests.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
        json={"from": FROM_EMAIL, "to": [TO_EMAIL], "subject": subject, "html": html},
        timeout=15,
    )
    resp.raise_for_status()
    return True


def main():
    theme   = get_next_theme()
    prompts = build_prompts(theme)
    html    = build_html(theme, prompts)
    subject = f"🎧 Umbra Sessions — 5 Prompts Suno: {theme['name']}"

    sent = send_email(subject, html)
    if not sent:
        for p in prompts:
            print(f"\n{p['label']}:\n{p['prompt']}")
    else:
        print(f"Email enviado → {TO_EMAIL} | Tema: {theme['name']}")


if __name__ == "__main__":
    main()
