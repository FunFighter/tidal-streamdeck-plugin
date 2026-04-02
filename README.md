# TIDAL Premium Stream Deck Plugin

Standalone repo for the Windows TIDAL Stream Deck plugin.

## What It Includes

- `com.saber.tidalpremium.sdPlugin/` plugin source
- `dist/` packaged `.streamDeckPlugin` installer
- `HELP.md` thin install and usage notes

## Quick Start

```powershell
npm install
npm run install:plugin
npm run pack
```

The packaged installer is written to `dist/`.

## Install

Double-click the `.streamDeckPlugin` file in `dist/`, or copy `com.saber.tidalpremium.sdPlugin` into `%AppData%\\Elgato\\StreamDeck\\Plugins\\`.
