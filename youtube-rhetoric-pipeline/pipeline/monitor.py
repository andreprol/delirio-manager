import isodate
from googleapiclient.discovery import build


def fetch_new_videos(
    api_key: str,
    channel_id: str,
    max_results: int = 10,
    max_duration_seconds: int = 1800,
) -> list[dict]:
    service = build("youtube", "v3", developerKey=api_key)
    search_resp = (
        service.search()
        .list(
            part="snippet",
            channelId=channel_id,
            order="date",
            type="video",
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
        if duration_secs == 0 or duration_secs > max_duration_seconds:
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
