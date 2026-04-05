# TIDAL Premium Stream Deck Plugin

Custom Stream Deck plugin for TIDAL on Windows using GSMTC metadata, queue-aware previews, and Stream Deck+ dial controls.

## Actions

- `Now Playing`
  - album art, scrolling title/artist, playback progress bar
  - key press toggles play/pause
  - encoder press skips next, touch tap toggles play/pause
- `Previous Track`
  - transport control
  - preview title/artist
  - uses queue/history preview art when available
- `Next Track`
  - transport control
  - prefers TIDAL queue preview when the queue panel is exposed in the app UI
  - falls back to history-based preview when queue data is unavailable
- `Volume Dial`
  - rotate to change TIDAL session volume when available, otherwise system volume
  - press to mute

## Runtime Notes

- Metadata and current artwork use Windows GSMTC.
- Transport and session volume prefer Elgato's installed Spotify Windows bridge when present.
- Queue-aware `Next` preview uses TIDAL's Windows accessibility tree.
- Queue artwork capture depends on the queue panel being visible in the TIDAL UI.

## Development

1. Open a terminal in:

   `C:\Users\saber\AppData\Roaming\Elgato\StreamDeck\Plugins\com.saber.tidalpremium.sdPlugin\bin`

2. Install dependencies:

   ```powershell
   npm install
   ```

3. Optional debug mode:

   ```powershell
   $env:TIDAL_PREMIUM_DEBUG = "1"
   $env:TIDAL_PREMIUM_LOG_LEVEL = "debug"
   ```

4. Restart Stream Deck after changing plugin files.

## Packaging

Official packaging uses the Stream Deck CLI:

```powershell
streamdeck pack com.saber.tidalpremium.sdPlugin --output dist
```

If the CLI is not installed globally, you can run it with npm:

```powershell
npm exec --yes --package @elgato/cli@latest -- streamdeck pack com.saber.tidalpremium.sdPlugin --output dist
```

## Local Install Path

`%AppData%\Elgato\StreamDeck\Plugins\com.saber.tidalpremium.sdPlugin`
