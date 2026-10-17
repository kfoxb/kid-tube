# Kid Tube

A small YouTube player that only plays channels and videos listed in [`allowlist.json`](allowlist.json). It's hosted on GitHub Pages, has no accounts, and keeps watch history in the browser on each device.

## Choosing what's allowed

Edit `allowlist.json` and push. The site rebuilds in a minute or two.

```json
{
  "settings": { "maxVideosPerChannel": 100, "includeShorts": false },
  "channels": [
    { "id": "UC…", "name": "Deep Look", "handle": "@KQEDDeepLook", "category": "Nature & Animals", "ages": "5+", "note": "…" }
  ],
  "curateByVideo": [
    { "id": "UC…", "name": "NASA", "handle": "@NASA", "category": "Science & Engineering" }
  ],
  "videos": [
    "https://www.youtube.com/watch?v=xxxxxxxxxxx",
    { "id": "xxxxxxxxxxx", "category": "Music" }
  ],
  "blockedVideos": ["xxxxxxxxxxx"]
}
```

- **channels**: channels whose newest `maxVideosPerChannel` uploads are all included. Give an `id`, a `handle`, or both. `category` sets where the channel shows up. `ages` appears on the Channels page, and `name` and `note` are just for you. A plain string (an @handle, a channel URL, or a `UC…` id) also works.
- **curateByVideo**: channels where only hand-picked videos are allowed. Nothing from them shows up until you add their videos to `videos`. Those videos then get the channel's category and channel page.
- **videos**: single videos, as a URL or id. A video from a channel not listed above goes under "More videos", in the category you give it or "Other".
- **blockedVideos**: videos to hide from an allowed channel.
- **includeShorts**: Shorts and live streams are left out unless this is `true`.

Categories appear in the order they first appear in this file.

Private, age-restricted, live, and non-embeddable videos are skipped automatically. If a channel or entry can't be found, the rest of the list still updates. The problem is listed in the site's footer and in the Action's log. If the API itself fails (a bad key, or the daily quota is used up), the build fails, the live site stays as it was, and GitHub emails you.

New uploads from allowed channels appear on their own, since the list refreshes every 6 hours.

## Setup

1. Create a YouTube Data API key: in [Google Cloud Console](https://console.cloud.google.com/), create a project, enable **YouTube Data API v3**, then go to **Credentials → Create credentials → API key**. Under API restrictions, limit the key to YouTube Data API v3.
2. In this repo, open **Settings → Secrets and variables → Actions** and add a secret named `YOUTUBE_API_KEY`.
3. Open **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Open **Actions → Build and deploy → Run workflow**.

The key is only used during the build and never reaches the browser.

GitHub turns off scheduled workflows in repos with no activity for 60 days. If new uploads stop appearing, re-enable the workflow on the Actions tab, or push any change.

## Running locally

```sh
YOUTUBE_API_KEY=your-key node scripts/fetch-videos.mjs
python3 -m http.server -d site 8000
```

Then open http://localhost:8000. The page has to be served over http; the YouTube player won't load from a `file://` URL.

## How the player is locked down

- Videos play in the privacy-enhanced `youtube-nocookie.com` embed with YouTube's controls turned off.
- A transparent layer sits over the video, so the YouTube logo, title, and end-screen links can't be clicked. The play, skip, seek, mute, and full-screen buttons belong to this page.
- While a video is paused or finished, the thumbnail covers it, hiding YouTube's suggested-video screens.
- The app only plays IDs that are in the built `videos.json`.

## Thumbnails

Uploaders' thumbnails aren't used. Each video shows a still that YouTube takes from about ¾ of the way through, or about ¼ if that one is missing. If neither exists, the card shows a plain tile.

The page footer shows when the video list was last refreshed. It turns red if that was more than a day ago, which means the scheduled workflow has stopped.

Ads still play. Skippable ads can't be skipped because the skip button is under the click-blocking layer.

Keyboard: space or `k` play/pause, ←/→ skip 10 seconds, `f` full screen, `m` mute.
