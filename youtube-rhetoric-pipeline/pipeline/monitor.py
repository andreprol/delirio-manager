import isodate
from googleapiclient.discovery import build


def fetch_new_videos(
    api_key: str,
    channel_id: str,
    max_results: int = 50,
    min_duration_seconds: int = 300,
    max_duration_seconds: int = 1200,
) -> list[dict]:
    """
    Vídeos longos do creator, mais vistos primeiro.

    O piso de duração é o que mantém o canal fora do feed de Shorts: um Short do
    creator vira um vídeo vertical de menos de 3 minutos, que o YouTube
    reclassifica como Short e cujas horas não contam para as 4.000h do YPP.
    `videoDuration="medium"` já filtra 4–20 min no servidor, poupando quota.
    """
    service = build("youtube", "v3", developerKey=api_key)
    search_resp = (
        service.search()
        .list(
            part="snippet",
            channelId=channel_id,
            order="viewCount",
            type="video",
            videoDuration="medium",
            maxResults=max_results,
        )
        .execute()
    )
    video_ids = [item["id"]["videoId"] for item in search_resp.get("items", [])]
    if not video_ids:
        return []

    details_resp = (
        service.videos()
        .list(part="contentDetails,snippet", id=",".join(video_ids))
        .execute()
    )

    results = []
    for item in details_resp.get("items", []):
        live_status = item["snippet"].get("liveBroadcastContent", "none")
        if live_status in ("upcoming", "live"):
            continue
        duration_iso = item["contentDetails"]["duration"]
        duration_secs = int(isodate.parse_duration(duration_iso).total_seconds())
        if duration_secs < min_duration_seconds or duration_secs > max_duration_seconds:
            continue
        results.append(
            {
                "id": item["id"],
                "title": item["snippet"]["title"],
                "published_at": item["snippet"]["publishedAt"],
                "duration_seconds": duration_secs,
            }
        )
    return results
