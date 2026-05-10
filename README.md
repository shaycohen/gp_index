# 🎸 Guitar Pro Index

[![GitHub](https://img.shields.io/badge/GitHub-shaycohen%2Fgp__index-orange?logo=github)](https://github.com/shaycohen/gp_index)

A fast local web app that indexes your Guitar Pro files, reads artist / title / tuning directly from file metadata, and lets you search, filter, sort, group, and open them — backed by SQLite.

![Guitar Pro Index screenshot](screenshot.png)

---

## Quick Start

**Requirements:** Node.js 18+, Python 3 (for `.gpx` / `.gp7` metadata parsing)

```bash
npm install
node server.js
```

The app opens automatically at `http://localhost:3847`.  
Click **⚙ Settings**, add a folder, then **Save & Scan**.

---

## Features

### File Scanning & Metadata
- **Recursive scanning** — indexes `.gp`, `.gp3`, `.gp4`, `.gp5`, `.gp6`, `.gpx`, and `.gp7` files from any number of directories
- **Metadata from file contents** — artist, song title, and tuning are read from the Guitar Pro binary or XML, not guessed from the filename
- **Tuning detection** — identifies standard, drop, and multi-string tunings (6-, 7-, 8-string) from MIDI pitch data

### Search & Filtering
- **Live search** — filters by artist, song, or filename as you type, with inline highlighting of matches
- **Filter sidebar** — filter by tuning, string count, favorites, or group
- **Sorting** — click any column header; sort by artist, song, tuning, strings, format, or last opened

### Groups
- **Create groups** — assign a name and a color (8 presets + custom color picker)
- **Rename & recolor** — click the ✎ icon on any group to rename it or change its color; all file assignments update automatically
- **Delete groups** — removes the group and all its file assignments
- **Color-coded chips** — group chips on each song row reflect the group's assigned color
- **Bulk assignment** — select multiple files with checkboxes (shift-click for ranges), then **＋ Add to group**

### Editing & Organization
- **Edit metadata** — override artist, song, tuning, string count, and freeform notes per file via the ✎ Edit button
- **Group assignment** — assign/remove a file from multiple groups inside the edit modal
- **Favorites** — star any file; filter to favorites only
- **Open in Guitar Pro** — click ▶ Open to launch the file in your default Guitar Pro application
- **Last opened tracking** — recorded in the database on each open; sortable column (most recent first)

### UI & Appearance
- **Light / Dark / System theme** — auto-follows your OS appearance by default; override anytime with the `◑ System` button in the header
- **Dark-mode checkboxes** — fully custom styled checkboxes that match the active theme
- **Keyboard shortcuts**
  - `/` or `Ctrl+F` — focus the search bar
  - `Esc` — close any open modal

### Storage
- All data persisted in a local **SQLite database** (`gpi.db`) via `better-sqlite3`
- Dirs, groups (with colors), file metadata, favorites, and last-opened timestamps all survive restarts
- File list cached in `localStorage` to render instantly on load

---

## Supported Formats

| Extension | Version |
|-----------|---------|
| `.gp`     | Guitar Pro 7 / 8 |
| `.gp7`    | Guitar Pro 7 |
| `.gpx`    | Guitar Pro 6 |
| `.gp6`    | Guitar Pro 6 (alt extension) |
| `.gp5`    | Guitar Pro 5 |
| `.gp4`    | Guitar Pro 4 |
| `.gp3`    | Guitar Pro 3 |

## Platform Support

| OS      | Status |
|---------|--------|
| macOS   | ✅ |
| Windows | ✅ (requires Python 3 in PATH) |
| Linux   | ✅ (requires `xdg-open` and Python 3) |

---

## Data & Storage

- **`gpi.db`** — SQLite database; all user data lives here (back it up to preserve metadata)
- **`localStorage`** — caches the last scan result and UI state (filters, sort); auto-migrates to the server DB on first run if you used an older version

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Serves `index.html` |
| GET | `/api/data` | Returns all dirs, groups (with colors), and metadata |
| POST | `/api/scan` | Scans directories and returns file list with metadata |
| POST | `/api/meta` | Upserts metadata for a file |
| POST | `/api/dirs` | Saves scan directory list |
| POST | `/api/groups` | Saves group list (`[{name, color}]`) |
| POST | `/api/open` | Opens a file in Guitar Pro, records timestamp |

---

## Credits

Built by [Shay Cohen](https://github.com/shaycohen) · [github.com/shaycohen/gp_index](https://github.com/shaycohen/gp_index)
