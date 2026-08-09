from googleapiclient.discovery import build


def fetch_new_videos(api_key: str, channel_id: str, max_results: int = 10) -> list[dict]:
    service = build("youtube", "v3", developerKey=api_key)
    response = (
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
    return [
        {
            "id": item["id"]["videoId"],
            "title": item["snippet"]["title"],
            "published_at": item["snippet"]["publishedAt"],
        }
        for item in response.get("items", [])
    ]
