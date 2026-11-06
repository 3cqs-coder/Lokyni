# Lokyni

**Lokyni** is a local document AI that answers questions from your own files — and tells you when it doesn't know, instead of confidently making something up. It combines dense vector search (FAISS), keyword search (BM25), and a cross-encoder reranker. A relevance gate then declines to answer when nothing in your documents genuinely matches, so answers stay grounded and cited rather than invented. It even learns from your feedback, down-weighting sources that led to unhelpful answers.

It runs entirely on your own hardware. Point it at folders you already keep documents in, or upload PDFs, Word documents, Markdown, text, and scanned images (with OCR) directly. Then ask questions in natural language and get answers drawn only from your indexed content. Your documents and conversations never leave your machine, and it can run completely offline with a local model — no cloud dependency required.

## Table of Contents

- [Why Lokyni](#why-lokyni)
- [Requirements](#requirements)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Running in the Background (pm2)](#running-in-the-background-pm2)
- [Running as a Service (no pm2)](#running-as-a-service-no-pm2)
  - [What `--install` Does](#what---install-does)
  - [Shutdown and Cleanup](#shutdown-and-cleanup)
  - [Where Your Data Lives](#where-your-data-lives)
    - [Secrets at rest](#secrets-at-rest)
- [Docker](#docker)
- [Scanned Documents (OCR)](#scanned-documents-ocr)
- [Why This Answer](#why-this-answer)
  - [Learning from Ratings](#learning-from-ratings)
- [Measuring Answer Quality](#measuring-answer-quality)
- [Workspaces](#workspaces)
  - [When to use separate workspaces](#when-to-use-separate-workspaces)
  - [Backup and Restore](#backup-and-restore)
- [Users and Access](#users-and-access)
- [Single Sign-On (SSO)](#single-sign-on-sso)
- [Scaling to Multiple Instances](#scaling-to-multiple-instances)
- [Adding Documents](#adding-documents)
  - [Indexing Folders Outside Lokyni](#indexing-folders-outside-lokyni)
  - [Obsidian Vaults](#obsidian-vaults)
  - [YouTube Transcripts](#youtube-transcripts)
- [Configuration](#configuration)
  - [Command-line Flags](#command-line-flags)
  - [Large-file parse isolation](#large-file-parse-isolation)
  - [Provider Settings](#provider-settings)
  - [Retrieval and Generation Settings](#retrieval-and-generation-settings)
  - [Conversational Intelligence Settings](#conversational-intelligence-settings)
  - [Cross-Encoder Reranker Settings](#cross-encoder-reranker-settings)
  - [Web Search Settings](#web-search-settings)
  - [Email (SMTP) Settings](#email-smtp-settings)
  - [Security Settings](#security-settings)
- [Features](#features)
  - [The Composer and Answer Options](#the-composer-and-answer-options)
  - [Stopping a Turn and Long-Running Progress](#stopping-a-turn-and-long-running-progress)
  - [Read Answers Aloud](#read-answers-aloud)
  - [Ask by Voice](#ask-by-voice)
  - [Hands-Free Voice Mode](#hands-free-voice-mode)
  - [Audio and Video Files](#audio-and-video-files)
  - [Hybrid Retrieval](#hybrid-retrieval)
  - [Conversational Follow-ups](#conversational-follow-ups)
  - [Context Switching](#context-switching)
  - [Multi-Document Comparison](#multi-document-comparison)
  - [Workspace Synthesis](#workspace-synthesis)
  - [Audio Overview](#audio-overview)
  - [Extraction Tables](#extraction-tables)
  - [Corpus Mind-Map](#corpus-mind-map)
  - [Notes](#notes)
  - [Nested Folders in the Document List](#nested-folders-in-the-document-list)
  - [Finding and Opening a Document](#finding-and-opening-a-document)
  - [Focusing on Specific Documents](#focusing-on-specific-documents)
  - [Full-Context Mode](#full-context-mode)
  - [One-Off Attachments](#one-off-attachments)
  - [Meta-Conversational Turns](#meta-conversational-turns)
  - [Citations and Passage Highlighting](#citations-and-passage-highlighting)
  - [Verifying Answers (Faithfulness Check)](#verifying-answers-faithfulness-check)
  - [Answer Confidence](#answer-confidence)
  - [Conversation Persistence](#conversation-persistence)
  - [Real-Time Indexing](#real-time-indexing)
  - [Related Documents](#related-documents)
  - [Rebuilding the Index](#rebuilding-the-index)
  - [Conversation Compression](#conversation-compression)
  - [Live Web Search](#live-web-search)
  - [Deep Research](#deep-research)
  - [Prompt Templates](#prompt-templates)
  - [Scheduled Automations and Digests](#scheduled-automations-and-digests)
  - [Themes](#themes)
  - [Text Size](#text-size)
  - [Desktop App](#desktop-app)
  - [In-App Guide](#in-app-guide)
- [Settings Panel](#settings-panel)
- [API Information](#api-information)
  - [Documents](#documents)
  - [Public API (v1)](#public-api-v1)
    - [Security audit log](#security-audit-log)
    - [OpenAI-Compatible Endpoint](#openai-compatible-endpoint)
  - [Configuration Endpoints](#configuration-endpoints)
  - [Document Viewer](#document-viewer)
- [MCP (Model Context Protocol)](#mcp-model-context-protocol)
- [Watchdog](#watchdog)
- [Health Endpoint](#health-endpoint)
  - [Viewing Logs](#viewing-logs)
- [Reverse Proxy Setup](#reverse-proxy-setup)
- [Upgrading](#upgrading)
- [Frequently Asked Questions (FAQ)](#frequently-asked-questions-faq)
- [Retrieval Pipeline Reference](#retrieval-pipeline-reference)
- [MCP Reference](#mcp-reference)
  - [Connectors](#connectors)
- [Disclaimer](#disclaimer)
- [License](#license)

For a detailed map of the retrieval decision path — every gate, its threshold, the
reasoning behind it, and how the layers interact — see the [Retrieval Pipeline Reference](#retrieval-pipeline-reference) section below.
That document is the reference to read before changing anything in
`lib/retrieval/`.

## Why Lokyni

Most AI assistants are general-purpose chatbots. They answer from what the model memorized during training, they tend to fill any gap with a confident guess, and they usually send your questions — and your files — to a company's servers. Lokyni is built for a narrower, more careful job: giving accurate, trustworthy answers about *your own* documents.

The difference comes down to three promises:

1. **Grounded and cited.** It answers only from your documents, and you can click any answer back to the exact source it came from.
2. **No guessing.** A general chatbot will usually invent a plausible-sounding reply. Lokyni says plainly when your documents don't cover the question.
3. **Stays on your machine.** Your documents and questions never leave your hardware, and with a local model it works fully offline — no account, no cloud, no tracking.

Everything below follows from those three promises:

- **It tells you when it doesn't know.** A relevance gate checks whether your documents actually contain an answer before responding — so instead of confidently inventing something, Lokyni says when the answer isn't there. Every answer is grounded in your files and cited back to them.
- **Retrieval built to actually find the right passage.** It combines semantic (vector) search, keyword (BM25) search, and a cross-encoder reranker, then serves the surrounding parent passage rather than an isolated fragment. It also learns from your ratings, down-weighting sources that led to unhelpful answers.
- **It works out of the box.** Sensible defaults, automatic indexing, and settings that explain their own trade-offs. There's no pipeline to assemble or tuning required to get good answers on day one.
- **It reads your documents where they already live.** Point it at folders you already use — `~/Documents`, a project directory, a synced folder — and it indexes them in place, without moving or copying anything. New and changed files are picked up automatically. No reorganizing your files around the tool.
- **It reads messy real-world documents.** OCR handles scanned PDFs and images — including pages that are rotated, photographed at an angle, or scanned slightly crooked — so the documents you actually have become searchable, not just the clean ones.
- **A research tool for documents that can't leave your machine.** Everything runs locally, and with a local model it runs fully offline — no accounts, no cloud, no telemetry. That makes it suited to the material most tools can't touch: legal files, medical records, unpublished research, confidential business documents. Ask grounded questions across your own sources, compare them, and synthesize an overview of the whole collection — without a single document leaving your hardware.
- **It keeps the conversation moving.** Every answer has a **Copy** button that puts it on your clipboard as Markdown, with its sources listed, and a **Download** button to save it as a Word document (`.docx`) or a Markdown file (`.md`) — sources included. The Word file is a real Office document that opens cleanly in Word, Pages, Google Docs, and LibreOffice. Where your browser supports it (and in the desktop app) you get a **Save As** dialog to choose exactly where the file goes. Turn on **Suggest** and each answer is followed by a few one-click follow-up questions, so the next step is a single tap. Each source pill shows a small dot for how strongly that document actually matched.
- **It can read answers aloud.** Turn on **Read answers aloud** in Settings and each answer gets a **Read aloud** button that speaks it in a natural voice — handy for long answers, for stepping away from the screen, or for accessibility. English uses a bundled local voice; other languages use the voices already installed on your device, so coverage follows your operating system. The bundled voice runs entirely on your machine. A small model (about 90 MB) downloads once the first time you turn the feature on, and then it works offline. Settings shows that download's progress as a live percentage, so you can see how it is going — you do not have to guess. System voices are normally local too; any the browser reports as online are used only if you allow online voices explicitly. Pick voices and the read-aloud language in Settings, and open **Installed voices** there to see what this device can speak.
- **You can ask by voice.** Turn on **Ask questions by voice** in Settings and a microphone button appears in the composer. Click it, speak your question, and it is transcribed into the box so you can check it and press Send. Transcription is fully local and supports many languages — pick your spoken language in Settings. A small model (about 75 MB) downloads once the first time you turn the feature on, and then it works offline. Settings shows that download's progress as a live percentage, the same as read-aloud. Paired with read-aloud, you can ask out loud and hear the answer back; read-aloud follows each answer's language, using the bundled English voice or a system voice for other languages.
- **It can go fully hands-free.** Click the hands-free button once and just talk: Lokyni listens, notices when you finish speaking, transcribes, answers, and reads the answer back — then listens again, no clicks. Talk over the answer and it stops and listens to you (barge-in). All of it runs locally in your browser; nothing is sent anywhere it isn't already.
- **It can listen to your recordings.** Turn on **Transcribe audio & video** and Lokyni indexes what is *spoken* in a media file — a lecture, meeting, podcast, or video becomes a searchable, cited document, just like a PDF. Transcription is fully local. WAV files work right away; other formats use a media decoder Lokyni fetches once into its own data folder (never your system's), so nothing depends on what you happen to have installed.
- **It can turn a workspace into a podcast.** Pick **Audio Overview** from the Generate menu and Lokyni writes a two-host dialogue about your documents — grounded in them, no invented facts — that you can read in the chat and, with read-aloud on, play as a two-voice podcast. A private, local take on the "listen to your notes" feature.

## Requirements

- Linux, macOS, or Windows based system
- [Node.js](https://nodejs.org) v22.22 or later (required — Lokyni and its core libraries need Node 22.22+, and it checks your version at startup)
- A language model, to write the answers — one of:
  - [Ollama](https://ollama.com) running locally (recommended for fully private, offline use)
  - An OpenAI-compatible API endpoint
- 4GB RAM minimum, 8GB or more recommended for larger document sets and local models
- 1GB disk space minimum, plus room for your documents and the vector index
- Reliable internet connection only if using a remote provider; none required with a local Ollama model

**Two different jobs — only one needs setup.** Lokyni does two things with a model. It **embeds** your documents (turns them into vectors so they can be searched), and it **writes answers** from the passages it finds. Embedding is handled out of the box by a **built-in model that runs on your own machine** — no Ollama and no API key, fully offline, and it works in many languages — so your documents become searchable the moment you add them. (It downloads once, about 120 MB, and is chosen to run on modest hardware; a larger, more accurate multilingual model — such as `bge-m3` — is one setting away if you have the memory for it.) Writing answers is the part that needs a language model: a local Ollama model, or an OpenAI-compatible API key. In other words, search works with zero setup; to get written answers, connect a language model. You can switch embeddings to Ollama or OpenAI later in Settings if you prefer a different embedding model.

**NOTE:** Running Lokyni with a local Ollama model keeps everything — your documents, your questions, and the model's answers — entirely on your own machine. Nothing is sent to any third party. The built-in embedder is local too: it downloads once, then runs offline.

## How It Works

Lokyni turns a folder of documents into a searchable knowledge base and answers questions against it:

1. **Indexing** — Documents you add are split into overlapping semantic chunks. Each chunk is embedded into a vector using your embeddings model (the built-in local model by default, so no external service is involved) and stored in a FAISS index. A BM25 keyword index and a TF-IDF term table are built alongside it.

2. **Retrieval** — When you ask a question, Lokyni runs both a dense vector search (FAISS, semantic similarity) and a keyword search (BM25, exact term matching), then fuses the two result sets using Reciprocal Rank Fusion (RRF). An optional cross-encoder reranker re-scores the top candidates for precision.

3. **Generation** — The most relevant passages are assembled into a context window and passed to your LLM with strict grounding rules. The model answers using only the retrieved content, and Lokyni returns the answer along with clickable source citations.

4. **Conversation** — Follow-up questions are understood in context. Lokyni resolves references ("tell me more", "what about the second one?"), detects topic changes, and keeps a running summary of long conversations so the thread stays coherent.

Everything runs locally. Outbound network calls are limited to a few predictable cases:

- Calls to your chosen LLM provider. There are none if that provider is a local Ollama instance.
- A one-time model download for the built-in local embedder (about 120 MB), the first time documents are indexed. This is the default; it does not happen if you switch embeddings to Ollama or OpenAI, and a larger, more accurate embedding model can be selected in Settings.
- A one-time model download for the reranker.
- A one-time language-data download the first time OCR reads a scanned document.
- A one-time voice-model download the first time an answer is read aloud or a question is asked by voice. This happens only if you turn those features on.
- A one-time media-decoder download the first time a non-WAV audio or video file is transcribed.

Read-aloud's system voices and the bundled English model are local. An operating-system voice that reports itself as online is used only after you allow online voices. Live web search and web-page ingestion also reach the internet, but only when you turn them on and use them.

## Installation

Once you have met all the requirements, follow these steps to install Lokyni:

1. Open a command line terminal
2. Change directory to where the Lokyni files are located
3. Type: `npm install`
4. Wait for all packages to download and install
5. Make sure a language model is available to write the answers (embedding needs no setup — the built-in local embedder handles it):
   - For **Ollama**, install it from [ollama.com](https://ollama.com), then pull a chat model, for example:
     ```
     ollama pull llama3.2
     ```
     (You do **not** need to pull an embedding model: documents are embedded by the built-in local model by default. If you would rather embed with Ollama, set the embeddings provider to Ollama in Settings and pull `bge-m3` — multilingual and open, about a 1.2 GB download — or the lighter `nomic-embed-text` (about 270 MB) on a memory-tight machine. The Settings "Suggest models" picker recommends by your available memory.)
   - For an **OpenAI-compatible** provider, have your API key ready (see [Configuration](#configuration))
6. The built-in defaults already work as-is for a standard local Ollama setup (using
   `llama3.2` for chat and the built-in local embedder). To change models, embed with Ollama
   or OpenAI, or use an OpenAI-compatible chat provider, copy `config/config.json.default` to
   `config/config.json` and edit it (see [Configuration](#configuration)).
7. Type: `npm start`
   - You can also use `node lokyni.js debug` to print detailed retrieval diagnostics to the console, which is useful when tuning or troubleshooting
   - Run it from the Lokyni directory. Lokyni keeps its `config/` and `data/` folders next to where it is started, so `npm start` (or `node lokyni.js` from that folder) finds them. Starting it from somewhere else would look for those folders in the current directory instead. The background, service, Docker, and desktop-app setups all handle this for you.
8. Open a web browser and go to: http://127.0.0.1:7887
9. Add your documents through the web interface (see [Adding Documents](#adding-documents)) and start asking questions

On first start, if no language model is reachable, Lokyni shows a connect screen that walks you through pointing it at Ollama or an OpenAI-compatible provider, so you don't have to edit `config.json` by hand. For a local Ollama it lists the models you already have installed, so you pick one from a dropdown instead of typing its name. If you don't have local AI hardware, choose OpenAI on that screen — it works on any computer and needs only an API key. (Your documents are still indexed and searchable without this — embedding is handled by the built-in local model — but writing answers needs a language model.)

On first start, Lokyni builds the vector index from any documents already present in `data/documents`. Subsequent starts load the cached index and only re-index files that changed.

## Running in the Background (pm2)

To keep Lokyni running in the background and restart automatically, it is recommended to use the Node.js process manager **pm2**:

1. Install **pm2** by typing: `npm install pm2 -g`
2. Create a file called `ecosystem.config.js` in the same location where your Lokyni files are located and place the below configuration into it:

```
module.exports = {
  apps: [
    {
      name: 'lokyni',
      namespace: 'lokyni',
      script: '/home/lokyni/lokyni.js',
      kill_timeout: 8000,
      max_memory_restart: '4000M'
    }
  ]
}
```

3. Replace `/home/lokyni/lokyni.js` with the actual location where Lokyni resides on your server and save the file
4. Tell **pm2** to start Lokyni with a one-time command by typing: `pm2 start ecosystem.config.js`
5. Type: `pm2 save` to save the configuration
6. If you don't already have **pm2** starting at system boot, type this with root privileges: `pm2 startup`. Then type: `pm2 save`

Lokyni will now start automatically even when the system is rebooted. Adjust `max_memory_restart` to suit your server — a larger document set and a large local model will need more headroom.

## Running as a Service (no pm2)

If you'd rather not add pm2 as a dependency, Lokyni can register itself directly with your operating system so it starts at login and restarts if it crashes. This uses the native mechanism on each platform and requires nothing beyond Node:

| Platform | Mechanism | Location |
| --- | --- | --- |
| macOS | LaunchAgent | `~/Library/LaunchAgents/com.lokyni.server.plist` |
| Linux | systemd user service | `~/.config/systemd/user/lokyni.service` |
| Windows | Scheduled Task (falls back to the `HKCU` Run key) | Task name `LokyniServer` |

Commands:

```
node lokyni.js --install       install to ~/.lokyni, run at login, restart on crash
node lokyni.js --uninstall     remove the service and stop
node lokyni.js --restart       restart the running service
node lokyni.js --status        show running state, index and provider health
node lokyni.js --open          open the web UI in your browser
node lokyni.js --help          list all commands
```

However you run it, the process shows up as **`lokyni`** (and the MCP server as `lokyni-mcp`) in `ps`, `top`, `htop`, and the command column of macOS Activity Monitor — not a bare `node` — so it's easy to find and stop.

A few OS views — macOS Activity Monitor's **Process Name** column and the Windows **Task Manager → Details** tab — read the executable's on-disk filename, which no program can rename at runtime. So that they show `lokyni` too, `--install` launches the background service through a copy of your Node binary named `lokyni`, kept in `~/.lokyni/bin`. It's rebuilt automatically after a Node upgrade (and on `--restart`), falls back to a plain `node` launch if branding isn't possible, and is removed by `--uninstall`. This is purely cosmetic — nothing about how Lokyni runs depends on it.

### What `--install` Does

By default, `--install` copies Lokyni into `~/.lokyni` and runs it from there. This
means the folder you downloaded or unzipped from is no longer needed — you can
delete it, and the service keeps working.

The installed directory has exactly the same layout as a source checkout, so
nothing about how Lokyni resolves paths changes:

```
~/.lokyni/
  lokyni.js
  package.json
  lib/
  node_modules/
  bin/                 branded launcher (a Node binary named "lokyni")
  config/
    config.json        your settings (written by the Settings UI)
    config.json.default a copyable template
  data/
    workspaces/
      default/
        documents/       your files for this workspace
        vector_store/    index, manifest, caches
        workspace.json   this workspace's indexed folders
      workspaces.json    the list of workspaces
    sessions/            conversations (shared across workspaces)
  logs/
    2026-09-16.log       dated diagnostic log, one file per day (pruned after 30 days)
  lokyni.log
  lokyni.pid
```

Details worth knowing:

- **Your data moves, it doesn't duplicate.** If the source folder has a `config/`
  or `data/` directory, they are *moved* into `~/.lokyni` so exactly one
  authoritative copy of your documents and index exists.
- **Re-running `--install` upgrades in place.** A running instance is stopped first so
  its files aren't held open and two servers never race for the port, then application
  files are refreshed and the service restarts. An existing `config/` and `data/` in
  `~/.lokyni` are never overwritten — the installed copy wins and the source is left untouched.
- **Dependencies are copied** rather than reinstalled, which preserves already-built
  native modules and is much faster. If that fails, `npm install` runs in the target.
- **Source checkouts are left alone.** If the directory contains `.git`, Lokyni
  assumes it's a working tree and installs in place instead of copying. Pass
  `--relocate` to override.
- **Temporary locations are flagged.** Installing in place from Downloads, Desktop,
  or a temp directory prints a warning, since the service records an absolute path
  and would break if that folder is moved or removed.
- **Logging is quiet by default, with a dated trail.** The terminal shows only
  important lines (startup, warnings, errors); routine progress and one-time notices
  are held back unless you start with the `debug` argument (`node lokyni.js debug`).
  Either way, the full trail is written to `~/.lokyni/logs/YYYY-MM-DD.log`, one file
  per day, pruned after 30 days, with secrets masked. Set `"fileLogging": false` in
  `config.json` to keep everything in memory only and write nothing to disk.

### Shutdown and Cleanup

Lokyni holds several long-lived resources while running: the web server and its live
client connections, a pool of OCR worker processes, file watchers on your indexed
folders, and (when ingesting web pages) a headless browser. On shutdown it tears all of
these down in order so nothing is left orphaned — no stray worker processes eating
memory, no held file handles, no bound port lingering under a service manager.

This happens on every exit path: **Ctrl-C** (SIGINT), a **`kill`/service stop** (SIGTERM), an uncaught crash, and normal process exit. On Ctrl-C you'll see a `🛑 Lokyni shutting down…` line, and then Lokyni:

- stops accepting new connections and releases the port,
- lets any in-progress indexing finish, so the on-disk index isn't left half-written,
- stops the OCR workers and file watchers,
- closes the browser,
- flushes the caches to disk,
- and removes the pid file.

A hard timeout guarantees the process still exits promptly even if a resource is slow to release. A plain Ctrl-C is a clean shutdown — there's nothing you need to do.

Flags that modify this behavior:

```
node lokyni.js --install --in-place    register where it already sits (no copy)
node lokyni.js --install --relocate    force a copy to ~/.lokyni, even from a checkout
node lokyni.js --install --no-open     don't open the web UI when the install finishes
```

When the install finishes, Lokyni waits for the service to start responding and then
opens the web UI in your browser — so you can see immediately that it worked. This
happens only at the end of `--install`, never when the service starts on its own:
with automatic restarts enabled, opening a browser on every start would spawn a tab
each time the service restarted, and a window appearing unprompted at login is
unwelcome. Set `"openAfterInstall": false` in `config.json` to disable it permanently,
or pass `--no-open` for a single install.

`--status` always reports the directory the service actually runs from, so if you
edit the folder you installed *from* and nothing changes, the status output will
show you why.

### Where Your Data Lives

After `--install`, everything Lokyni owns lives under `~/.lokyni`. If you run Lokyni
directly from a folder instead (no install, or `--in-place`), `<lokyni-dir>` below is
that folder.

| What | Location |
| --- | --- |
| Configuration | `<lokyni-dir>/config/config.json` |
| Your documents | `<lokyni-dir>/data/workspaces/<id>/documents/` |
| Vector index and caches | `<lokyni-dir>/data/workspaces/<id>/vector_store/` |
| Saved conversations | `<lokyni-dir>/data/sessions/` |
| Service logs | `~/.lokyni/lokyni.log`, `~/.lokyni/lokyni-error.log` |
| Process id | `~/.lokyni/lokyni.pid` |
| Service registration | `~/Library/LaunchAgents/com.lokyni.server.plist` (macOS), `~/.config/systemd/user/lokyni.service` (Linux), Scheduled Task `LokyniServer` (Windows) |
| Branded launcher | `~/.lokyni/bin/lokyni` (so the service shows as `lokyni`, not `node`) |
| Reranker model cache | `<lokyni-dir>/data/models/` (downloaded once) |
| Secret key (seals stored credentials) | `<lokyni-dir>/data/secret.key` |

To back up Lokyni, copy `~/.lokyni` (or your Lokyni directory) — that's everything
except regenerable caches. `node lokyni.js --status` prints these paths for your
installation.

#### Secrets at rest

Some settings are credentials Lokyni must use, not just check: the provider API
keys, the SMTP password, the single sign-on client secret, and connector access
tokens. A password embedded in a URL setting is included too — for example a web
proxy, a model host, or a base URL written as `https://user:pass@host`. All of
these are encrypted where they are stored (AES-256-GCM). The key that unlocks
them is kept in a separate file, `data/secret.key`, not in the config file it
protects. So a `config.json` that is copied, shared for support, committed by
mistake, or included in a backup does not reveal its secrets on its own.

A URL with no embedded password stays readable in the config file, so an
ordinary host or endpoint is still easy to see and edit. When a URL does carry a
password, the Settings page shows the host and user but hides the password. Leave
it hidden to keep the saved password, or type the password in to change it. In a
list of several proxies, you can edit one and leave the others hidden — each
hidden password is kept from what was saved.

The key file is created once, readable only by your account. You can instead
supply the key yourself through the `LOKYNI_SECRET_KEY` environment variable (at
least 16 characters), which is never written to disk. You can also point Lokyni at
a key file in another location with `--secret-key-file <path>`. Keep a copy of the
key with your backup, because the sealed secrets cannot be read without it.

This protects a config file that leaves your machine. It does not defend against
someone who can already read both your config file and your key file, such as
another process running as your own user. Passwords and Lokyni's own API keys are
not in this group: those are only ever verified, so they are stored as one-way
hashes (scrypt and SHA-256) and are never decrypted.

An existing install upgrades on its own. The first time the new version starts,
it seals any credentials that were still stored as plain text, with no action
from you.

**NOTE:** The service records an absolute path to the run directory. A default
`--install` puts that inside your home directory where it's stable. If you install
with `--in-place` and later move the folder, run `--uninstall` then `--install`
again from the new location.

`--status` reports whether the server is running, where its logs are, whether the service is registered, and (when the server is up) live index and provider health:

```
Lokyni ● running  (pid 5123)
  Web UI:   http://127.0.0.1:7887
  Run dir:  /Users/you/lokyni
  Logs:     ~/.lokyni/lokyni.log
  Service:  installed (LaunchAgent)
  Process:  runs as "lokyni" in the OS process list
  Index:    46 documents · 16038 chunks
  Provider: ollama · llama3.2
```

**NOTE:** Use either pm2 or the built-in service, not both, since each would start its own server on the same port. `--install` checks for a pm2-managed Lokyni and warns you if it finds one. pm2 remains fully supported; nothing about it has changed.

Platform-specific behavior at install time:

- **macOS** — background services get a minimal `PATH`, so the LaunchAgent sets it explicitly to include `/opt/homebrew/bin` and `/usr/local/bin`. This is what lets the service find a locally-installed Ollama.
- **Linux** — `--install` enables lingering (`loginctl enable-linger`) so the service runs without an active login session.
- **Windows** — `--install` tries to register a task that starts at boot (this needs an admin prompt), falls back to starting at logon, and finally to the registry Run key if scheduled tasks are unavailable.

## Docker

Docker is the simplest way to self-host Lokyni on a server, a NAS, or a homelab, reached over your network. On a personal computer the desktop app or the installable web app is the easier path; Docker is for the always-on, networked case.

The Compose file lives in the `docker/` folder and includes an optional, bundled Ollama, so the whole stack runs a local model out of the box with nothing else installed.

To start it:

```bash
docker compose -f docker/docker-compose.yml up -d
```

The first time, pull a chat model into the bundled Ollama (embedding is handled by the built-in local model, so no embedding model is required):

```bash
docker compose -f docker/docker-compose.yml exec ollama ollama pull llama3.2
```

(To embed with Ollama instead of the built-in local model, set the embeddings provider to Ollama in Settings and also `ollama pull bge-m3`.)

Then open http://127.0.0.1:7887 and add your documents.

**What persists.** One named volume (`lokyni-state`) holds everything Lokyni keeps: your configuration, the document index, your workspaces, saved conversations, and anything Lokyni downloads on demand — the built-in embedding model, the reranker model, the voice models (read-aloud and voice input), and the media decoder used to transcribe audio and video. A second volume holds the models the bundled Ollama pulls. Upgrading the image leaves both untouched.

**Indexing folders from the host.** The container cannot see your host folders unless you mount them. To index documents that live on the host, mount each folder read-only in the Compose file, then add it under Documents → Indexed folders using its path inside the container:

```yaml
    volumes:
      - lokyni-state:/state
      - /home/you/Documents:/documents:ro
```

**Using a host folder for state.** The default named volume is owned by the container user. To keep
state in a host folder instead, make that folder writable by the container user first. On a Linux
host:

```bash
mkdir -p ./lokyni-state
sudo chown -R 1000:1000 ./lokyni-state
```

Then replace the volume line with `- ./lokyni-state:/state`. On Docker Desktop, share the parent
folder with Docker and confirm it is writable. If the folder is read-only or owned by another user,
Lokyni stops at startup and prints the folder and the ownership fix instead of failing with a generic
permission error.

**Using an Ollama you already run.** If you have Ollama elsewhere, remove the `ollama` service and its `depends_on` from the Compose file, then point Lokyni at your host with `--ollama-host`. On Docker Desktop (macOS and Windows), use `http://host.docker.internal:11434`. On Linux, `host.docker.internal` does not resolve by default, so either add `extra_hosts: ["host.docker.internal:host-gateway"]` to the `lokyni` service or use the host's LAN IP address. Lokyni reads `--ollama-host` and `--bind` from the command line, so no configuration file is needed to start.

**Security.** The port is published on loopback (`127.0.0.1:7887`) by default. With no accounts, the control plane — settings, file browsing, backups — has no sign-in, so it stays on loopback for the local operator only. To share Lokyni with other people, create accounts (see [Users and Access](#users-and-access)); once an account exists, the app requires a sign-in. Either way, to reach Lokyni from other machines put a reverse proxy that terminates HTTPS in front of it (see [Reverse Proxy Setup](#reverse-proxy-setup)) so traffic is encrypted, rather than opening the port to your network unencrypted. The bundled Ollama has no authentication either, so its port is never published; only Lokyni reaches it on the internal network. The container runs with `--enforce-host-guard`, which keeps the DNS-rebinding Host guard active even though the server binds `0.0.0.0` inside the container. Only loopback and any hostnames you add to `trustedHosts` are accepted. Behind a reverse proxy, add your public hostname to `trustedHosts` in `config.json`.

The container is hardened by default: it runs as a non-root user, with a read-only root filesystem (all writes go to the data volume or a temporary filesystem), no added Linux capabilities, and no new privileges.

## Scanned Documents (OCR)

A scanned PDF or a photographed page has no text layer, so its words cannot be read
directly. With OCR enabled, Lokyni renders those pages and reads the text on them, so
the document becomes searchable by its content. Large scans are read in small page
batches, which keeps memory flat no matter how many pages the document has.

The built-in Tesseract engine always reads English. Under **Advanced → Scanned documents**,
you can add up to four more languages — Spanish, French, German, Chinese, Japanese,
Arabic, Hebrew, and more. English stays on as a floor, so a mixed-language page still
reads. The desktop app ships with the English pack built in, so it reads scanned pages
offline from the first launch. Any language you add later (and, in the standalone and
container editions, English too) downloads once (roughly 1–30 MB) the first time it is
needed, is checked against a pinned checksum, and is cached under `data/tessdata`; after
that, recognition runs fully offline. For a language not in the list, choose the Vision
method and a model that supports it.

A document is never dropped for being hard to parse. If OCR is off, or a page has no
readable text at all, the document is still indexed by its file name, so it stays
findable, can be opened, and can be summarized — it is reported as name-only rather than
skipped. A document format whose text this version does not read yet (for example a
rich-text or OpenDocument file) is indexed by name the same way, so it is never missed.
A file is left out only when it is empty, too small, or unreadable.

Configure it in the settings panel under **Scanned documents**, which explains the
trade-off between the two methods and only shows the vision-model field when that
method is selected. The same values can be set in `config.json`.

On by default, with no setup required. The defaults are:

```json
{
  "useOcr": true,
  "ocrEngine": "tesseract",
  "ocrVisionModel": "llama3.2-vision",
  "ocrMaxPages": 500,
  "ocrLanguages": []
}
```

- `ocrEngine` — which recognizer to use.
  - `"tesseract"` (default) works immediately: the package installs with Lokyni and
    its English language data (~10 MB) is downloaded once the first time OCR runs, checked
    against a pinned checksum, and cached under `data/tessdata`. After that it is read
    locally, so recognition is fully offline and never contacts a network. On an
    air-gapped or offline host, place `eng.traineddata.gz` (and any selected packs) in
    `data/tessdata` beforehand and it is used as-is; if the data can't be verified, OCR is
    skipped rather than reaching out to a network. Fast
    and accurate on clean scans; weaker on faint, low-contrast or complex pages
    (security-printed IDs, dense forms). It automatically corrects page orientation
    and tilt before reading — see **Orientation and skew** below.

  - `"vision"` sends page images to a vision model through your configured provider.
    Markedly better on messy real-world scans, tables and multi-column layouts — but
    needs a multi-gigabyte model pulled first (`ollama pull llama3.2-vision`, the
    default vision model).
    If you select it without the model installed, Lokyni logs a warning (listing the
    models you do have) and falls back to tesseract rather than failing on every page.
    Switching the engine or model takes effect on the next document read — no restart
    needed — but existing scans keep their cached text until you rebuild the index.
- `ocrVisionModel` — which vision model to use for OCR. Choose one that's strong at
  document transcription — `minicpm-v` or `llama3.2-vision`. Small captioning models
  (e.g. `moondream`) tend to *summarize* an image rather than transcribe every field,
  so they read a page as a short description instead of its full text. That makes them a
  poor fit for OCR — though they're fine for the separate **vision describe** feature.
  Defaults to `llama3.2-vision`. This is a different setting from the describe model.
- `ocrLanguages` — additional built-in OCR languages, as an array of engine codes (for
  example `["spa", "deu"]`). Defaults to `[]`; English is always included and does not need
  to be listed. Up to four additional languages. Each selected pack downloads once, is
  checksum-verified, and is cached under `data/tessdata`, so recognition is offline after
  the first use. A pack that cannot be downloaded is dropped and English carries on.
- `ocrMaxPages` — ceiling per document, default `500`, counted from the first page.
  Memory stays flat no matter how long a document is (pages are read in small batches), so
  the only cost of a higher cap is time — OCR takes seconds per page. The default reads a
  typical long document in full while still capping a pathological multi-thousand-page scan
  so one document can't dominate a first index. Raise it for a library of very long scans.
  When a document exceeds the limit Lokyni says so — both per document and in the summary at
  the end of indexing — so a partly-read scan is never silent.

**Orientation and skew are corrected automatically.** Before reading a page (image
or rendered scanned-PDF page), tesseract OCR straightens it in three layers, so a
photo taken sideways or a page scanned crooked still reads:

- **EXIF rotation** — a phone photo saved with an orientation tag is rotated upright.
- **Deskew** — a slight tilt (a page scanned a few degrees crooked) is detected by a
  projection-profile method and rotated level. Only a confident, non-trivial tilt is
  corrected, so straight pages are left untouched.
- **90°/180°/270° retry** — if a page reads with low confidence (a sign it's fully
  rotated), it's re-read at each orientation and the most confident result is kept.
  Well-oriented pages skip this, so it only costs time on pages that need it.

All of this is pure image processing (no extra dependency) and applies to scanned
PDFs too, since their pages are rendered to images first. It runs at read time, so a
page already in the index isn't re-straightened until you rebuild the index.

**Images become indexable too.** With OCR on, `.png`, `.jpg`, `.jpeg`, `.webp`,
`.tif` and `.tiff` are indexed by reading the text in them. Turning on **describe
images** (below) also makes them indexable even with OCR off, since the vision model
gives each one a description. They're ignored only when both are off, since with
neither one every image would extract to nothing.

**Describing images (optional).** OCR only reads *text*. An image with no text — a
photo, a diagram, a chart, a screenshot — extracts to nothing and indexes as an empty,
unsearchable document. Turn on **vision describe** to have a local vision model
describe what such images actually depict (plus a few tags), so they become findable
by content — "the whiteboard photo", "the auth-flow diagram". This is:

- **Off by default** and independent of the OCR engine — it works alongside the
  built-in OCR, the vision OCR, or even with OCR off entirely (image-only indexing).
- **Model-gated.** It needs a vision model pulled in Ollama and selected in
  Settings → Describe images — e.g. `qwen2.5vl:7b`, `llava:13b`, or `moondream`. No
  model selected → nothing happens and OCR behaves exactly as before.
- **Heavy.** Vision models want real memory and time. If your machine can't spare it,
  leave this off; OCR is unaffected either way.

Config keys: `visionDescribe` (boolean, default false), `visionModel` (the model
name), and optionally `visionInputMaxEdge` (images are downscaled before being sent —
default 1024), `visionTemperature` (default 0.2), and `visionMaxTags` (default 12).
Only images whose OCR text is essentially empty are described, so text-bearing scans
are unaffected. Descriptions are cached with the OCR results.

**Figures and tables (optional).** Text extraction captures a page's *words*, but a
chart's takeaway, a diagram's meaning, and a table's structure live in the pixels and
are lost. Turn on **figure & table ingest** to have the vision model make that content
searchable, appended to the document's indexed text — so "the scan-performance table",
"what the revenue chart shows", or "what does Figure 3 show?" become answerable through
the normal grounded, cited flow. It covers:

- **PDFs** — each page is rendered and its figures and charts are described (each
  labeled "Figure 3", "Table 2" for precise references) and its tables reproduced as
  Markdown.
- **Word and PowerPoint** — these have no page renderer, so the images embedded in the
  `.docx`/`.pptx` (a pasted chart, a diagram, a screenshot) are described. Decorative
  icons and logos below a minimum size are skipped.

This is:

- **Off by default.** It uses the same vision model as image describe (`visionModel`),
  so with no model selected nothing happens.
- **Bounded.** One vision call per page (or per embedded image) makes it slow, so PDFs
  are page-capped (`visualIngestMaxPages`, default 20), office documents are image-capped
  (`visualIngestMaxImages`, default 12; `visualIngestMinImageEdge`, default 160 px), and
  files too large to open safely in the main process are skipped (`visualIngestMaxBytes`,
  default 50 MB) and left to the text path. Descriptions are cached by file content, so
  an unchanged file is described once.
- **Applied at index time.** Turning it on re-indexes your existing documents
  automatically. Visual content is pulled from the ones already indexed too, with no
  manual rebuild needed.

**Figure thumbnails (optional).** With **Crop figure thumbnails** on as well, each
detected figure or table is cropped into its own image and shown on the cited source:
answers get a small figures toggle that reveals the actual charts and tables (with a
label and page). The vision model is asked for each figure's location on the page; a
figure with no clear location is still described in text, just without a thumbnail. The
searchable description is unaffected — it still lists every table value. Thumbnails are
stored alongside the index, served locally, and included in a workspace backup.

Config keys: `useVisualIngest` (boolean, default false) and `visualIngestCropFigures`
(boolean, default false), both toggleable in Settings → Describe images.

**How it decides.** A PDF whose extracted text is very short relative to its page
count is treated as a scan — not simply zero, because scanned PDFs often carry a
stray header or page number in a real text layer. Any genuine text is kept alongside
the recognized text rather than replaced.

**A note on `sharp`.** OCR preprocessing uses `sharp`, which Lokyni deliberately
does *not* declare as a dependency — it uses the single copy that the local
reranker/embedding library (`@huggingface/transformers`) already brings in. `sharp`
links libvips natively, and installing a second copy loads two different libvips
builds into one process, which the dynamic linker warns about and which risks
crashes. If you see a warning about `libvips-cpp` being "implemented in both", run
`npm uninstall sharp`.

**Turning it off.** Set `"useOcr": false` if you'd rather not spend time recognizing
scanned pages. A scanned document with no text layer is then indexed by its file name, so
it still appears in your library and can be opened — it just isn't searchable by its
contents until OCR is turned back on.

**Speed and memory.** Pages within a document are recognized in parallel across a small
pool of workers. The pool is sized automatically to the machine — to both its core count
and its available memory — so a computer with room to spare runs several workers and a
small server runs one. Set `"ocrWorkers"` to override, up to 8; the value is still held
within what memory allows, so it can't overrun. Pages are read in small batches, which
keeps memory flat no matter how many pages a document has. A large or high-resolution scan
is never dropped for being too big to read: if a first pass runs short on memory, Lokyni
retries with a single worker, and only a document with no readable text at all is indexed
by name instead. The vision engine stays sequential, since those requests queue at the
model server anyway.

**Results are cached.** OCR output is stored alongside the index, keyed by file
contents, so a scanned document is only read once — restarting doesn't repeat the
work. Editing a file invalidates its entry automatically, and the cache is discarded
when the index is rebuilt.

**It's still slow the first time.** Expect a few seconds per page. Tesseract pages run in parallel across
the worker pool (the vision engine runs one page at a time), and a failure on one page doesn't lose the
rest of the document.

## Why This Answer

Every answer carries a **Why this answer?** button next to its sources. It opens a
panel showing what retrieval actually did:

- **What happened** — whether the question was rewritten from the conversation,
  whether it was treated as a follow-up or a new topic, whether a document selection
  restricted the search, and how many documents were used.
- **Documents considered** — every candidate that was scored, not just the ones
  cited, each with its relevance score and, for the ones that lost, why: *scored as
  unrelated to the question*, or *ranked below the documents that were used*.

This exists because the most common frustration with tools of this kind is that when
an answer ignores a document, the failure looks arbitrary. Seeing that a document
*was* considered and scored −8.4 against your question is a different experience from
wondering whether it was indexed at all.

It's most useful when there was no answer: the panel then shows the best keyword
score against the threshold, so "nothing matched" becomes a number you can act on
rather than a shrug.

The trace is derived from work retrieval already does — no extra model calls, no
measurable cost — and is never used to make a retrieval decision.

### Learning from Ratings

Alongside the Explain toggle is a **Learn** toggle. When it's on, each answer gets a
👍/👎 rating control, and Lokyni records the outcome (the question, the documents
used, the reranker score). That record does two things over time:

- **Surfaces similar past questions** — if you ask something close to a question you
  previously rated 👍, Lokyni notes that you asked something similar before and it
  worked.
- **Down-weights documents that led to bad answers** — a document that produced 👎
  answers on similar questions gets a small ranking penalty on future similar
  queries. This is deliberately conservative: it only engages after a few 👎 ratings
  exist, the penalty only reorders candidates (it never removes a document), and the
  Explain-style relevance gates still apply. Turn Learn off and nothing is recorded
  or applied — Lokyni behaves as if the feature isn't there.

Like the trace, this stays fully local and needs no extra model calls: matching a new
question against past ones uses BM25 (the same keyword-ranking Lokyni already uses for
documents), whose term saturation and length normalization rank short natural-language
questions better than plain word-overlap would.

## Measuring Answer Quality

Every time you change a model, an embedding model, or a retrieval setting, answer quality
shifts in ways that are hard to judge by spot-checking. The **Quality evaluation** panel
(Settings → Tools & data) turns that into a number you can watch.

Save a handful of questions that represent how you actually use a workspace, then press
**Run evaluation**. Not sure where to start? Press **Suggest from my documents** and Lokyni
proposes a few representative questions drawn from your own files — in the documents' own
language — which you can edit or remove before running. Lokyni answers each one and scores
four things, each from 0 to 100%:

- **Faithfulness** — how much of the answer its cited sources actually support (the same
  check the Verify badge uses). A low score means the answer drifted beyond the documents.
- **Answer relevancy** — how well the answer addresses the question, rather than wandering
  off or dodging it.
- **Context precision** — how many of the retrieved passages were actually on-topic, so you
  can see whether retrieval is bringing back signal or noise.
- **Citation attribution F1** — whether each citation is doing real work. Lokyni checks every
  answer sentence against the exact text each cited source served: *precision* is the share of
  sentences traceable to a citation, *recall* is the share of cited sources that support at least
  one sentence, and the F1 combines them. A padded citation list or a sentence with no support
  lowers the score, and the per-question breakdown names citations that supported no sentence.
  It is deterministic word-overlap, so read it as a trend rather than a verdict.

Each run shows the change since the previous one, so you can tell at a glance whether a
change helped or hurt, plus a per-question breakdown to see where. Open any question in that
breakdown for the deeper detail: the claims the judge could not fully support, figures and
quotations that do not appear in the cited sources, how many sentences each citation backed,
and a preview of the answer. Every list is bounded, so a long answer never floods the panel.
It uses your own model and your own documents, needs no "correct answers" written in
advance, and runs only when you press the button — nothing leaves your machine and nothing
runs on its own. Scores from a small local model are best read as a trend over time, not an
exact grade. Removing a saved question asks you to confirm first, since a representative set
takes effort to rebuild.

Below the latest results, a **trend** charts each metric as a small sparkline across your
recent runs (the last 50 are kept), so you can see quality move over time — not just since the
last run — as you swap models, change chunking, or toggle retrieval features. The trend appears
once you have run the evaluation at least twice. Each run also records the answer-pipeline
version it used; if the last run predates the current build, the panel says so, so a step
change from a pipeline update is not mistaken for a model or retrieval regression.

Below the trend, **Compare runs** puts any two recorded runs side by side. The last 10 full
runs for each workspace are kept for this; older runs remain in the compact trend. Choose Run A
and Run B and press **Compare** to see each metric for both, the change from A to B, which run
was stronger, and a per-question breakdown. Each run also records the provider, the chat and
embedding models, and whether the reranker and query rewrite were on, so the comparison shows
what changed besides the score. Questions are matched by their saved id, so one added or removed
between runs is marked instead of disappearing. A change of a few points on a small question
set can be noise; use the per-question rows to see what actually moved.

You can also run an evaluation from the command line — `node lokyni.js --eval` scores the
active workspace's saved questions and prints a report, then exits (add a workspace name to
target another one). It uses your own model and documents, so nothing leaves the machine, and
it is handy for a scheduled check or a continuous-integration gate.

## Workspaces

A workspace is a separate document collection with its own index. The selector in
the header switches between them, and **+ New workspace…** creates one.

Each browser window or tab can view a different workspace at the same time. Switching
the workspace in one window does not disturb another — a question, summary, or
synthesis is always answered from the workspace that window is showing, with that
workspace's own settings and rating history. The Documents panel follows the same
rule: each window lists, uploads to, views, and removes documents in the workspace it
is showing, and opening a cited source opens it from that source's own workspace.

This is a retrieval feature, not just organization. As unrelated documents pile into
a single corpus, answers get worse: keyword scores drift, the reranker sees more
plausible-but-wrong candidates, and topic detection has more ways to go wrong.
Keeping a legal corpus separate from a technical one measurably improves answers in
both.

### When to use separate workspaces

A good rule of thumb: **one workspace per body of work you'd think of as its own
thing.** A few reasons to split, in rough priority:

- **Keep sensitive material on its own.** Personal, medical, financial, or legal
  documents are best kept in a dedicated workspace, separate from work or project
  files. Everything stays on your machine either way, but separation means a broad
  query — or a [workspace synthesis](#workspace-synthesis), which reads across the
  whole collection — won't pull your medical records into an answer about your code.
  It also makes it safe to demo or screen-share a project workspace without exposing
  private files.
- **Better answers.** As above — unrelated topics in one corpus degrade retrieval.
  Distinct subjects (a research project, your finances, a codebase) each retrieve
  more accurately on their own.
- **Faster, more focused synthesis.** Workspace synthesis over a tightly-scoped
  collection is both quicker and more useful than one that spans unrelated topics,
  where the overview can only conclude "these documents are diverse."

You don't need many — most people are well served by a small number of broad
workspaces (e.g. *work*, *personal*, one per active project), not one per folder.

Each workspace lives under the data directory:

```
data/
  workspaces/
    default/
      documents/        ← your files for this workspace
      vector_store/     ← index, manifest, caches
      workspace.json    ← this workspace's indexed folders
    research/
      documents/
      vector_store/
    workspaces.json     ← the list of workspaces
  sessions/             ← conversations (shared across workspaces)
```

Things worth knowing:

- **The active workspace is always live; others load on demand.** The workspace shown
  in the selector is held fully in memory. When a window views a different workspace,
  Lokyni loads that one into a small, memory-bounded cache so the window can search it,
  and drops the least-recently-used one when the cache is full. Switching the active
  workspace reloads its index, which takes a moment on a large corpus.
- **Switching starts a new conversation**, because the previous one refers to
  documents that are no longer loaded.
- **There is always at least one usable workspace.** The default can't be deleted,
  and neither can the last remaining one. If the workspace list is lost or a
  workspace's folder is removed outside the app, Lokyni recreates what it needs at
  startup rather than failing. To delete any other workspace, switch to it and choose
  *✕ Delete this workspace…* from the selector; you'll be asked to type its name to
  confirm, since it permanently removes that workspace's documents and index.
- **A new workspace starts empty.** Asking a question before adding documents gives
  a prompt to add some rather than an error — and web search still works, since it
  doesn't depend on the corpus.
- **Each workspace can have its own persona.** In the document panel, *Workspace
  persona* stores a short instruction for how Lokyni should answer in that workspace
  — its tone, role, or audience (for example, "Answer as a patient tutor for a
  beginner"). It shapes voice only: answers still come solely from the documents,
  with citations, and it is saved with the workspace so a backup carries it along.
- **Existing installs migrate automatically.** If you upgrade from a version without
  workspaces, your `data/documents` and `data/vector_store` move into
  `data/workspaces/default/` on first start — nothing is re-embedded and no documents
  are lost.
- **Additional indexed folders are per-workspace.** Each workspace keeps its own
  list in `data/workspaces/<id>/workspace.json`, so a new workspace starts genuinely
  empty rather than inheriting every folder you've configured elsewhere. (An install
  that predates workspaces keeps its existing folders in the default workspace.)
- **Rename** a workspace with *✎ Rename this workspace…* in the selector. Only the
  display name changes — the folder keeps its original name so its documents and
  index stay put.

### Backup and Restore

Each workspace can be exported to a single `.lokb` file containing its documents,
its vector index, and its indexed-folder settings — from the **Documents** panel →
*Backup & restore*. That makes a workspace portable: move it to another machine,
snapshot it before a risky change, or archive a finished project and delete it
locally.

- **Optional encryption.** Enter a passphrase and the archive is AES-256-GCM
  encrypted with a scrypt-derived key. Worth using — a backup is the copy most likely
  to end up on a USB stick or in cloud storage. Without a passphrase it's plain
  compressed data.
- **Optional index.** Including the index makes a larger file but avoids
  re-embedding on restore. Excluding it keeps the archive small; Lokyni rebuilds the
  index from the documents afterward.
- **Restore shows you first.** Lokyni reads the archive and tells you what's in it —
  workspace name, document count, date — before writing anything.
- **Restore is non-destructive by default.** It creates a new workspace. Tick
  *replace this workspace* to overwrite instead, which discards the current contents.
- **Verify without restoring.** **Verify file** decrypts and decompresses the whole archive in a throwaway
  folder, checks every file's checksum, then deletes the copy. It never registers or changes a workspace, so
  it is safe to run against live data. It is a restore drill that proves the archive is complete and
  restorable before you rely on it. Like a restore, it needs enough free space for the archive's
  uncompressed contents.
- **Integrity is verified.** Every file carries a checksum, and an encrypted archive's
  authentication tag covers both its contents and its header (file list, sizes,
  checksums), so a corrupted or tampered backup fails loudly rather than restoring
  partial or altered data. A restore stages everything and verifies it before
  swapping it in, so a failed restore never touches the existing workspace — and a
  crash mid-swap is recovered automatically on the next start.
- **The format is versioned.** A `.lokb` written by a newer Lokyni is refused with a
  clear message by an older one, rather than mis-read.

No extra dependencies are required — the archive format uses Node's built-in
compression and crypto.

## Users and Access

Lokyni runs as a single-user tool out of the box and becomes multi-user the moment
you create the first account. Nothing here needs a cloud service or an internet
connection — accounts, passwords, and sessions all live on your own machine.

**Single user (default).** With no accounts, Lokyni works exactly as it always has:
on loopback it is open to you, the local operator. There is nothing to sign in to.

**Turning on accounts.** Open the app and create the first account (or use the login
page). The first account becomes the administrator. From that point on, the app
requires people to sign in. Existing API keys keep working unchanged.

**Adding people.** An administrator adds users under **More → Users & Access**. Each
person gets a username and a password. By default there is no public sign-up; an
admin creates the accounts. If you would rather let people register themselves, turn
on **Allow signups** in Settings (the first account is always the admin either way).

**Names.** The username is the sign-in identifier and stays simple letters and digits.
Separately, each person can set a display name in any language or script — on the
Account page, at sign-up, or by an administrator — and that is the name shown next to
them everywhere. It never changes the username used to sign in.

**Roles.** There are two account roles:

- **Admin** — can manage settings, users, API keys, connectors, backups, and every
  workspace.
- **Member** — can use the app and the workspaces they have been given access to.

**Workspace access.** A workspace is shared with specific people, each at a role:

- **Viewer** — can ask questions and read sources.
- **Editor** — can also add and remove documents.
- **Admin** — can also manage the workspace and who can access it.
- **Owner** — can also delete the workspace.

A member only sees the workspaces they belong to; an administrator sees all of them.
Set this under **More → Users & Access → Workspace access**.

**Your account.** Anyone signed in can open **More → Account** to change their
password, see where they are signed in, sign out other sessions, or sign out. A
password change signs out your other sessions.

**Passwords and sessions.** Passwords are stored only as a salted scrypt hash, never
in the clear. A session is a long random token kept on the server, so it survives a
restart (you are not signed out when the app restarts) and can be revoked at any
time. Sessions stay signed in for 30 days of inactivity. Each account keeps its most
recent 25 sessions; older ones are dropped automatically, so an old phone or browser
you never signed out of doesn't linger forever.

**Sign-in protection.** Repeated failed logins are rate-limited — both per source
connection and per username — so after several wrong attempts (about 8 to 10) that
source or account is locked out for about 15 minutes. The limits reset when the app
restarts.
This is automatic; there is nothing to configure.

**If you forget the password.** Reset it on the machine itself:

```
node lokyni.js --reset-password <username>
```

It prompts for a new password (or pass `--password`, or pipe one in), and signs out
that user's other sessions. Because it runs on the host, it needs no email service.
Run it against the same data directory the app uses: if you started Lokyni with
`--data-dir`, or installed it as a service, pass the same `--data-dir` here so it finds
your accounts.

**Remote access.** Accounts make it safe for a small team to share one Lokyni from
different locations. Still put it behind a reverse proxy that terminates HTTPS (see
[Reverse Proxy Setup](#reverse-proxy-setup)) so passwords and documents travel
encrypted — the built-in login is the identity layer, and TLS is the transport.

## Single Sign-On (SSO)

Lokyni can let people sign in with your organization's identity provider through
**OpenID Connect (OIDC)** — so there are no separate Lokyni passwords to manage.
This is optional and **off by default**; local username and password accounts keep
working alongside it.

It works with any standards-compliant OIDC provider and uses the Authorization Code
flow with PKCE. Lokyni validates the returned ID token fully — the signature against
the provider's published keys, plus the issuer, audience, expiry, and a one-time
nonce — before it trusts an identity. It needs no extra software to install; the
implementation uses only Node's built-in crypto.

**Set it up** from the app — an administrator opens **More → Users & Access**, fills
in the **Single sign-on** section (issuer, client ID, client secret, and the options
below), and can use **Test connection** to confirm the provider is reachable before
saving. Changes take effect immediately, with no restart. The client secret is never
sent back to the browser.

You can also configure it by hand with an `oidc` block in `config.json` (the two are
equivalent; secrets stay in that file and are never exposed):

```json
{
  "oidc": {
    "enabled": true,
    "issuer": "https://your-provider.example.com",
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret",
    "redirectUri": "https://lokyni.example.com/auth/sso/callback",
    "buttonLabel": "Sign in with SSO",
    "autoCreateUsers": true,
    "linkByEmail": true,
    "defaultRole": "member"
  }
}
```

- **`issuer`** — your provider's base URL. Lokyni reads its
  `/.well-known/openid-configuration` automatically. It must be an `https` URL (an
  `http://localhost` issuer is allowed for development).
- **`redirectUri`** — register exactly this URL with your provider. It is
  `<your Lokyni URL>/auth/sso/callback`. If you leave it out, Lokyni derives it from
  the request — set it explicitly behind a reverse proxy, where it is both more
  reliable and safer (a derived URL only trusts a forwarded host you have listed in
  `trustedHosts`).
- **`autoCreateUsers`** — when `true` (the default), a first-time sign-in creates a
  Lokyni account automatically. When `false`, an administrator must create the
  account first; the sign-in then links to it.
- **`linkByEmail`** — when `true` (the default), a first SSO sign-in whose
  **verified** email matches an existing local account links to that account. This
  trusts your provider's `email_verified` claim, which is correct for a single
  trusted company directory. Set it to `false` for a multi-tenant or less-trusted
  provider, so a verified-email claim can never bridge an external identity into a
  pre-existing (possibly admin) account; linking then happens only by provider
  subject.
- **`defaultRole`** — the role for auto-created accounts (`member` or `admin`). The
  very first account created on a fresh install always becomes the administrator.
- **`usernameClaim`** / **`emailClaim`** — which ID-token claims to read the username
  and email from (defaults: `preferred_username` and `email`).

**How accounts link.** An SSO identity is matched first by its stable provider
subject, then — only for a verified email — to an existing account with that email
(so you can pre-create accounts and let people claim them on first sign-in), and
otherwise a new account is provisioned when `autoCreateUsers` is on. A disabled
account can never sign in, through SSO or otherwise.

Once enabled, the login page shows a sign-in button for your provider. You can still
sign in locally — useful for the administrator account and for recovery with
`--reset-password`.

## Scaling to Multiple Instances

A single Lokyni instance serves a team well. When you need to handle more people at
once, you can run several instances over one shared data directory (a mounted
volume) behind a load balancer. This keeps the local-first design — there is still no
external database, vector service, or message broker to run.

The model is deliberately simple and safe: roles are **static**, so there is never
more than one writer and no split-brain.

- **One primary** (`--primary`) does all indexing and writes.
- **Any number of read replicas** (`--replica`) serve search, chat, and document
  reads from the shared index. A replica loads the index read-only and refreshes
  automatically when the primary updates it, so it always catches up. A replica
  refuses write actions (indexing, uploads, workspace changes, URL ingestion, and
  account creation) with a clear message — send those to the primary. Signing in and
  changing your own password still work on any instance. A read replica shows a small
  banner in the UI so people know they are on one.

Point every instance at the same `--data-dir`:

```bash
# the writer
node lokyni.js --primary --data-dir /srv/lokyni/data --port 7887
# one or more read replicas (same shared data dir, different ports/hosts)
node lokyni.js --replica --data-dir /srv/lokyni/data --port 7888
```

**Accounts are shared automatically.** Users, sessions, API keys, and workspace
access all live in the shared data directory, so a person signs in once and every
instance recognizes them — a session started on one instance works on the others.

**Load balancer notes.**

- Turn on **sticky sessions** so a browser's chat WebSocket (`/ws`) stays on one
  instance for the length of a conversation.
- Send the interactive UI and any write actions to the primary; a replica returns a
  `409` for writes. The read API (`/api/v1`) and MCP endpoint can be served by any
  instance.
- Forward the **`X-Forwarded-Proto`** header (and `X-Forwarded-Host`) from a
  TLS-terminating proxy, so secure cookies and the single sign-on redirect URL are
  built with the right scheme.

**Failover.** Because roles are static, there is no automatic election. If the
primary goes down, promote a replica by restarting it with `--primary`. Run **exactly
one primary** at a time. On a single host the instance lock refuses a second primary,
but across separate hosts that share the directory the lock cannot see the other host,
so keeping one primary is the operator's responsibility — a second one would be a
second writer against the shared index.

**The shared directory** must be a filesystem every instance can read, and that the
primary can write, with ordinary consistency — a local network volume works well. The
built-in watchdog checks that this instance can actually use the shared directory for
its role. Each instance keeps its own tamper-evident audit chain in the shared
directory, and the audit view merges them, so the security trail stays intact with
several instances running.

You can also set the role in `config.json` instead of the flags:

```json
{ "cluster": { "enabled": true, "role": "replica" } }
```

**With Docker.** A ready-made cluster compose file runs a primary and a read replica
over one shared volume:

```bash
docker compose -f docker/docker-compose.cluster.yml up -d
```

The primary is on port 7887 and the replica on 7888. Both mount the same volume, so
the accounts, the index, the sign-in secret, and the audit trail are shared. Add more
replica services on more ports to serve more readers, and put a reverse proxy in front
to route writes and the UI to the primary. The file has the full notes.

## Adding Documents

There are two ways to get documents into Lokyni: let it index folders you already have, or add files to its own `data/documents` directory.

- **Point it at existing folders** — the fastest way to a useful knowledge base. Tell Lokyni about folders you already keep documents in (`~/Documents`, a project directory, a synced folder) and it indexes them **in place** — nothing is moved or copied, the originals stay put, and changes are picked up automatically. See [Indexing Folders Outside Lokyni](#indexing-folders-outside-lokyni) below.
- **Through the web interface** — use the upload panel to drag and drop or select files. Uploaded files are saved into `data/documents` and indexed automatically.
- **Directly on disk** — copy files into `data/documents` yourself. Lokyni watches the folder and picks up changes automatically (see [Real-Time Indexing](#real-time-indexing)).
- **With the browser clipper** — from **Settings → Browser clipper**, create a clipper bookmarklet and drag it to your bookmarks bar. Click it on any page — including pages you're logged into — to save that page into Lokyni. It reads the page your browser has already loaded, so it works behind logins without sharing your credentials. (Creating a clipper makes a dedicated `write`-scoped API key; the bookmarklet is shown once, so drag it to your bookmarks before closing.)
- **From a web page or YouTube video** — paste a URL into the "Add a web page URL" box in the document panel. A normal page is fetched and its article text is saved. Plain pages are fetched directly; a headless browser renders the page only when it needs it, and **Web page capture** in Settings can force either method. A page that returns an HTTP error is rejected, so a 404 or a login wall cannot become a cited source. A **YouTube video** link (`youtube.com/watch…`, `youtu.be/…`, a Short, or an embed) is turned into a document from its **captions** — so a talk, lecture, or tutorial becomes searchable and `#`-citable like any other source. It needs no API key, and if a video has captions disabled it says so plainly rather than saving an empty document. See [YouTube Transcripts](#youtube-transcripts).

**Supported file types:**

| Type | Extension | Notes |
| --- | --- | --- |
| Plain text | `.txt`, `.log` | Indexed as-is |
| Markdown | `.md` | Rendered in the document viewer |
| PDF | `.pdf` | Text is extracted; scanned/image PDFs are read with OCR (see [Scanned Documents (OCR)](#scanned-documents-ocr)) |
| Word | `.docx` | Text is extracted for indexing; embedded images can be described (see [Scanned Documents (OCR)](#scanned-documents-ocr)) |
| PowerPoint | `.pptx` | Slide text and speaker notes are extracted in order; embedded images can be described (see [Scanned Documents (OCR)](#scanned-documents-ocr)) |
| EPUB | `.epub` | Chapters are extracted in reading order (spine) and stripped to text |
| HTML | `.html`, `.htm` | Readable text is extracted; scripts, styles, and markup are stripped |
| Spreadsheets / data | `.csv`, `.tsv`, `.xlsx`, `.xlsm`, `.json` | Tabular and structured data is extracted as text for indexing |
| Images | `.png`, `.jpg`, `.jpeg`, `.webp`, `.tif`, `.tiff` | Read with OCR when OCR is enabled — including rotated, angled, or crooked scans. Text-free images can optionally be described by a vision model (see [Scanned Documents (OCR)](#scanned-documents-ocr)) |

The maximum upload size is 500 MB per file. Large documents are handled with proportionally larger passage windows so answers still have enough context.

To remove a document, delete it from the web interface or remove it from `data/documents`. Its vectors are purged from the index automatically on the next update.

### Indexing Folders Outside Lokyni

You can also point Lokyni at folders you already keep documents in — `~/Documents`, a project directory, a synced folder — without moving or copying anything. Those files are indexed **in place**: Lokyni reads them where they live, and the originals stay exactly where they are.

Add folders from the **Documents** panel → *Indexed folders*. Click **Browse** to pick a folder visually, or type a path directly; changes save and reindex immediately. They live with the documents rather than in Settings because they belong to the active workspace, not the install. You can also set them in that workspace's `workspace.json`:

```json
// data/workspaces/<id>/workspace.json
{
  "sourcePaths": [
    "~/Documents/notes",
    { "path": "~/Projects/specs", "recursive": true, "maxDepth": 3 }
  ]
}
```

A plain string indexes only the top level of that folder. The object form adds:

- `recursive` — descend into subfolders. Off by default.
- `maxDepth` — how deep to descend when recursive. Defaults to `3`.
- `enabled` — set to `false` to stop indexing a folder without removing it from the list. Its settings are kept for when you switch it back on.

In the settings panel each folder row has two checkboxes: the one on the left enables or disables indexing for that folder, and **subfolders** on the right controls recursion. A disabled folder is grayed out and struck through. Saving settings always re-checks every folder, so removing, re-adding, or toggling a folder takes effect immediately.

Before a folder is added, the panel reports how many files it would index and their total size, so you can see the scale before committing. The panel header shows which workspace you're editing.

**Guard rails.** Folders you haven't curated can be large and noisy, which bloats the index and dilutes retrieval quality. Discovery is therefore bounded:

- `sourceMaxFiles` — maximum files taken from each folder. Defaults to `500`.
- `sourceMaxFileBytes` — files larger than this are skipped. Defaults to `26214400` (25 MB).
- `sourceExclude` — path fragments to skip. Defaults to `node_modules`, `.git`, `Library/`, `/AppData/`, `.Trash`, `venv`, `__pycache__`.
- Hidden files and folders (starting with `.`) are always skipped.
- Only the supported types are indexed: text and documents (`.txt`, `.log`, `.md`, `.pdf`, `.docx`, `.pptx`, `.epub`, `.html`, `.htm`), data files (`.csv`, `.tsv`, `.xlsx`, `.xlsm`, `.json`), and — with OCR enabled — images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.tif`, `.tiff`).

**Things worth knowing:**

- **Deleting a file removes it from the index.** These folders are watched like `data/documents`, so if you clear your Downloads folder, those documents leave your knowledge base too. Keep anything you want permanently indexed in `data/documents`.
- **macOS may block access.** Reading `~/Documents` or `~/Downloads` from a background service requires Full Disk Access. If Lokyni logs a permission warning, grant it in System Settings → Privacy & Security → Full Disk Access.
- **The document viewer only opens indexed files.** Files from these folders can be viewed and cited like any other, but the viewer will not serve anything Lokyni hasn't indexed, even inside an allowed folder.
- **Start narrow.** Adding a huge folder is easy and expensive to undo — the index has to be rebuilt for those files either way. Pointing at a specific subfolder usually gives better answers than pointing at an entire home directory.

**External drives and network shares.** The folder picker lists your home directory alongside every mounted volume — external drives, network shares, and on Windows each drive letter — so you can index documents that don't live in your home folder. Volumes are discovered through the filesystem alone; no system commands are run.

If a drive is unmounted or a share goes offline, Lokyni keeps its documents in the index rather than purging them, and logs a notice. They stay searchable and refresh automatically when the volume returns — without this, ejecting a USB stick would drop those documents and force a full re-index on every reconnect.

By default the picker can browse your home directory and mounted volumes only. Set `"browseFilesystemRoot": true` in `config.json` to also browse from `/` for system paths like `/srv` or `/opt`.

### Obsidian Vaults

An Obsidian vault is just a folder of Markdown files, so Lokyni indexes it directly — no plugin, no export, no conversion. Add the vault's folder under *Indexed folders* (turn on **subfolders** so nested notes are included) and every note becomes searchable, `#`-citable, and answerable. Notes are indexed **in place**, so your vault stays exactly where it is and edits are picked up automatically. Obsidian's own `[[wiki-links]]` and YAML front-matter are kept as part of the note text; they don't interfere with retrieval.

### YouTube Transcripts

Paste a YouTube link into the "Add a web page URL" box and Lokyni adds the video to your workspace as a document built from its **captions**. A lecture, talk, tutorial, interview, or podcast then becomes something you can search, cite, compare, and summarize like any other source. It recognizes the usual link forms (`youtube.com/watch…`, `youtu.be/…`, Shorts, and embeds).

It needs **no API key and no extra software** — no `yt-dlp`, no `ffmpeg`, nothing to install. Lokyni reads the video's caption track directly over the network and saves it as a text document headed with the video title, channel, and source URL. Because it fetches the captions itself (rather than driving a browser), it works the same on macOS, Linux, Windows, in Docker, and in the desktop app — anywhere Lokyni can reach the network.

It prefers a human-written English caption track, then any human track, then auto-generated captions. If a video has captions disabled, Lokyni says so plainly instead of saving an empty document. The transcript is length-bounded so even a very long video stays memory-safe, and the fetch is confined to YouTube's own hosts.

## Configuration

Lokyni reads its settings from a `config.json` file in the `config/` folder. All settings are optional and fall back to sensible defaults, so a minimal file is enough to begin. Most settings can also be changed live from the in-app [Settings Panel](#settings-panel) without editing the file by hand.

If you edit `config.json` by hand and leave it malformed (a stray comma or an unquoted key), Lokyni refuses to start and prints the parse error. It never silently reverts to defaults and behaves as if freshly installed, so a typo can never quietly discard your provider, model, keys, or indexed folders. A missing `config.json` is fine and simply starts from defaults; fix or delete a broken one to start again.

Some advanced keys can only be set by editing `config.json` — they are not shown in the Settings panel. The list below is not exhaustive, but these are the common ones:

- `minCosineScore` and the RRF weights (`rrfFaissWeight`, `rrfBm25Weight`, `rrfK`).
- Model choices: `assistantRole`, `faithfulnessModel`, `rerankerModel`, `colbertModel`, `graphRagModel`.
- `synthesisMaxDocs`, `graphHops`, `debounceTime`, and `bindAddress`.
- The web-search tuning numbers (`webSearchResultCount`, `webSearchTimeoutMs`, and the rest).
- The parse-isolation controls described below.

`graphHops` sets how far Lokyni follows its graph — the entity graph and, when enabled, the knowledge graph — when you ask how two things are related. The default `1` finds a document whose subject sits directly between the two things you named. Set it to `2` to also follow a longer chain — A connects to B, B connects to C — so the linking documents surface even when nothing sits directly between your two terms. Higher reach trades a little extra recall noise, so `1` is the default; the maximum is `3`.

### Command-line Flags

A few settings can be passed on the command line, which overrides `config.json` and needs no configuration file. This is how a launcher or a container sets them. Application settings are never taken from environment variables.

- `--port <n>` — the port the web interface listens on. Defaults to `7887`.
- `--bind <address>` — the address the server binds to. Defaults to `127.0.0.1`. Set it to `0.0.0.0` only to reach Lokyni from other machines, and see the security note in [Docker](#docker) and [Reverse Proxy Setup](#reverse-proxy-setup).
- `--ollama-host <url>` — the Ollama base URL. Defaults to `http://localhost:11434`.
- `--data-dir <path>` — where Lokyni keeps its data (workspaces, the index, API keys, the reranker model). Defaults to a `data` folder in the working directory. Set it to keep the data in a fixed location regardless of where Lokyni is started from.
- `--enforce-host-guard` — keep the DNS-rebinding Host guard active even when bound to `0.0.0.0`. Only loopback and any configured `trustedHosts` are then accepted. The Docker image sets this, because a container must bind `0.0.0.0` for its published port to work.
- `--dns-order <order>` — the DNS result order: `ipv4first`, `ipv6first`, or `verbatim`.

Run `node lokyni.js --help` for the full list, including the background-service commands.

### Large-file parse isolation

Lokyni parses large documents in a separate, memory-capped helper process, so a huge or malformed file can never grow the main app toward an out-of-memory crash. It is on by default and needs no configuration.

- `useParseIsolation` — set to `false` to parse every file inside the main process instead. This removes the memory and time safety net for document parsing, so a very large or malformed file can then stall or crash the main process. Leave it on unless you have a specific reason to change it, and only with documents you trust. Defaults to `true`.
- `parseIsolationMinBytes` — the size at or above which a file is parsed in the helper process. Smaller files parse in the main process, since the helper's startup cost is not worth it for them. Defaults to about 4 MB.

A minimal local (Ollama) configuration looks like this:

```json
{
  "provider": "ollama",
  "model": "llama3.2",
  "embeddingsModel": "bge-m3",
  "ollamaHost": "http://localhost:11434"
}
```

### Provider Settings

In Settings, the Model and Embeddings model fields are dropdowns of the models actually available from the selected provider, so you pick from a list instead of typing an exact name. Choose "Custom / enter manually…" to type any name your provider supports (useful for a model that isn't listed, or when the provider is offline). The list refreshes when you change the provider, the Ollama host, or the OpenAI base URL.

- `provider` — the **chat** backend: `"ollama"` (local, default), `"openai"` (any OpenAI-compatible API), or `"anthropic"` (Claude). This sets only where chat/generation runs; embeddings are configured separately (see `embeddingsProvider`), so you can switch the chat provider without re-embedding your documents.
- `model` — the chat/generation model. Defaults to `llama3.2` for Ollama, `gpt-4o` for OpenAI, and `claude-sonnet-4-5` for Anthropic. Pick from the model list in Settings, which shows what your provider offers.
- `embeddingsProvider` — the provider used to **embed** your documents, independent of the chat provider: `"ollama"` or `"openai"` (Anthropic has no embeddings, so it is chat-only). Optional — when unset it follows the chat provider if that one can embed, otherwise it falls back to Ollama. Because it is separate, you can chat with Claude or GPT while your documents stay embedded on a local, free model. To switch chat providers freely, pin embeddings to a portable open model on local Ollama — for example `bge-m3` (multilingual, strong retrieval) or `nomic-embed-text`. Your documents are then never re-embedded when you change the chat provider.
- `embeddingsModel` — the model used to embed document chunks and queries. Defaults to `bge-m3` for Ollama (multilingual and open/self-hostable; a lighter `nomic-embed-text` suits a memory-tight machine) and `text-embedding-3-small` for OpenAI. Changing it does not re-embed your existing documents: by default [`useEmbeddingBanks`](#conversational-intelligence-settings) keeps a separate vector index per embedding model, so your old documents stay searchable while new ones use the new model (set that flag to `false` to force a full rebuild on every model change instead). A note on "open/self-hostable": it means you can run the same model's weights on different hosts without being locked to one vendor — **not** that the same model name served two ways (a local quantized build vs a full-precision host, or across model-server versions) produces identical vectors. It generally does not, so Lokyni never assumes it. When you switch the provider or endpoint for the same model while the old one is still reachable, Lokyni embeds a small multilingual probe through both and measures how close their vectors are. If they match — the common case for the same model — your existing bank is reused as-is, with no new bank and no re-embed. If they differ, a new bank is opened and the old one stays searchable, just as a model change does.

- `embeddingContextTokens` — the size of the embedding model's context window, in tokens. The default of `2048` is a safe size that fits the common embedding models, including the default `bge-m3` (which accepts far more, so 2048-token chunks fit comfortably). It sets how large a chunk may be, because a chunk longer than the window is rejected by the embedder and would be left out of search. If you switch to a model with a smaller window (many are `512` or `256`), lower this to match so chunks are sized to fit. Re-index applies it to existing documents.

  Not sure which model to run? In Settings → Provider, click ✨ Suggest models to see chat and embedding models suited to your machine. Lokyni checks your available memory (and GPU, when it can detect one) and marks the recommended pick and which models you have already pulled. One click applies your choice to the field. It is a starting point, not a limit — you can type any model your provider supports.

  **Switching the embeddings model, provider, or endpoint does not re-embed your documents.** By default ([`useEmbeddingBanks`](#conversational-intelligence-settings)), Lokyni keeps a separate vector index per embedding identity: your existing documents stay searchable through the provider that embedded them while new and changed ones use the new one. When you move the **same model** to a different provider or endpoint while the old one is still reachable, Lokyni measures whether the two produce the same vectors and, if so, reuses your existing bank — no new bank and no re-embed. A frozen bank is normally queried through the endpoint and key that built it. When you switch to a different model whose vectors are close enough, Lokyni fits a small learned adapter at the switch, while the old provider is still reachable. Even after the old provider is gone, your new provider's queries are then translated into the old bank's space, so its existing vectors stay searchable with no re-embed. When the two spaces are too different to bridge, the corpus has to be re-embedded with the current model. On a local, no-cost embedder (Ollama) Lokyni starts that in the background automatically — it is resumable and non-blocking, and every existing result keeps serving while it runs, so you are never left with a lasting gap and never blocked. On a metered provider Lokyni never re-embeds on its own; run **Settings → Consolidate embedding banks** when you are ready. If you turn banks off, changing the embeddings model, provider, or endpoint instead invalidates the single index and rebuilds it from scratch, which can take time for a large document set.

  **Will a switch re-embed?** Lokyni measures it — it never assumes two models match by name. You can check before committing: next to the embeddings model in Settings, **Will this re-embed?** compares the new configuration against your current one and tells you plainly whether your existing embeddings will be reused or a new bank will be created. On a local embedder (Ollama) this updates automatically as you edit, since the check costs nothing; on a metered provider it runs only when you press the button, so a preview is never billed. Moving the same model between providers or endpoints is almost always a reuse. Moving to a different model depends on whether a learned map can bridge the two spaces. As a rule of thumb, switching to a *smaller* embedding model can often keep your existing (larger) bank searchable through an adapter, because the larger space already contains enough detail to line up with the smaller one. Switching to a *larger* model usually needs a re-embed to use its full detail. Either way your documents are never lost, and nothing is re-embedded until the measurement shows it is necessary. Lokyni's reuse state is shown in Settings so you can always see which banks are active, which are kept searchable by an adapter even without their provider, and which still rely on a provider you switched away from.

- `ollamaHost` — the URL of your Ollama server. Defaults to `http://localhost:11434`.
- `ollamaKeepAlive` — how long Ollama keeps the model loaded in memory between requests, so each answer skips a multi-second reload from disk. Accepts Ollama's duration form (`"30m"`, `"1h"`) or a number of seconds; `-1` keeps it loaded until Ollama restarts, `0` unloads it immediately. Defaults to `30m`. A longer value uses more memory.
- `llmTimeoutMs` — the idle timeout for a model call, in milliseconds. If no output arrives for this long, the call is abandoned so an unreachable or wedged model can't hang a question forever. The timer resets on every chunk, so a slow but progressing answer is never cut off. Defaults to `120000`; the minimum is `5000`.
- `embedTimeoutMs` — the timeout for a single embedding call, in milliseconds. A search embeds your question before it can look anything up, so if the provider stalls this bound keeps the search from hanging. On a timeout the vector results are skipped and the keyword results still answer. Defaults to `60000`; the minimum is `5000`.
- `ollamaApiKey` — an optional bearer token for Ollama. A local Ollama needs none, but **Ollama Cloud** and any authenticated reverse proxy in front of a remote Ollama require one. When set, it is sent as an `Authorization: Bearer …` header on chat, embeddings, and health-check requests. Leave it empty for local use.
- `openaiApiKey` — your API key when using the `openai` provider.

**How API keys are handled in the settings panel:** keys are never sent back to the
browser. A field with a stored key shows a `••••••••` placeholder and stays empty —
leaving it empty when you save means *unchanged*, so changing an unrelated setting
can never wipe a key you can't see. Type a new value to replace it, or press
**Clear** to remove it.

- `openaiBaseUrl` — an optional custom base URL for OpenAI-compatible endpoints (for example, a self-hosted gateway or an alternative provider). A local Ollama also exposes an OpenAI-compatible endpoint at `http://localhost:11434/v1`, so you *can* reach a local model through the `openai` provider by setting this — though the native `ollama` provider is the simpler path and needs no key.
- `embeddingsApiKey` / `embeddingsBaseUrl` — a **separate** API key and base URL for an OpenAI-compatible **embedding** endpoint, used only when `embeddingsProvider` is `openai`. Each is optional and falls back to `openaiApiKey` / `openaiBaseUrl` when blank. This lets you embed on a hosted open model (for example `bge-m3`) with its *own* key and host while chatting on a different OpenAI account — the two no longer have to share one key. Left blank, embeddings reuse the chat OpenAI credentials, exactly as before. The key is never sent back to the browser and is sealed at rest like the others.
- `anthropicApiKey` — your API key when using the `anthropic` (Claude) provider. Handled exactly like the other keys (never sent back to the browser; empty on save means unchanged). Claude is reached through Anthropic's OpenAI-compatible endpoint, so no extra software is needed. Remember Claude cannot embed — set `embeddingsProvider` to `ollama` or `openai`.
- `anthropicBaseUrl` — an optional custom base URL for the Anthropic provider. Defaults to `https://api.anthropic.com/v1/` (Anthropic's OpenAI-compatible endpoint); leave it empty to use that.

### Retrieval and Generation Settings

- `temperature` — LLM sampling temperature. Lower values (e.g. `0.35`, the default) produce more focused, deterministic answers, which is usually what you want for document Q&A.
- `maxTokens` — the maximum number of tokens in a generated answer. Defaults to `0`, which means **Auto**: the cap is sized to your model at request time, so a long answer (like a full-document summary) isn't cut off and switching models needs no retuning. Set a positive number to pin a specific cap. In Settings it's **Max answer length** — leave it blank for Auto.
- `maxHistory` — the number of recent conversation turns kept verbatim in the model's context. Defaults to `4`.
- `passageSize` — the number of characters served per document passage. Defaults to `8000`. Larger documents automatically receive proportionally larger windows.
- `minCosineScore` — the minimum vector similarity a query must reach to be considered in-scope. Defaults to `0.35`. Queries with no meaningful match are politely declined rather than answered with a guess. This is a fast first-pass filter on the embedding model's cosine score. Because each embedding model scores on its own scale, it is deliberately permissive and backed by a second, model-agnostic check — see [`rerankerDropBelow`](#cross-encoder-reranker-settings), which decides the final in-scope call on the cross-encoder score so the gate works the same whichever embedding model you run.
- `rrfFaissWeight` / `rrfBm25Weight` / `rrfK` — the Reciprocal Rank Fusion weights that combine the vector (FAISS) and keyword (BM25) rankings, and the rank constant. Default to `0.3`, `0.7`, and `60` — a balance that favors keyword precision, which suits identifier-heavy corpora (code, IDs, part numbers). Raise `rrfFaissWeight` toward `rrfBm25Weight` for a prose corpus where questions are paraphrased and exact-term overlap is rare. Most users never need to touch these; they exist so retrieval can be tuned per corpus without editing code.
- `useContextualRetrieval` — before embedding each chunk, an LLM prepends a one-sentence note on where the chunk sits in the document, so the vector carries global context (a chunk saying "revenue grew 3%" becomes findable by "ACME Q3 revenue"). This measurably reduces failed retrievals on documents where a chunk alone is ambiguous. Defaults to `false`.
  - Off by default because it adds one LLM call per chunk at index time. The notes are cached in `vector_store/context-cache.json`, so it's a one-time cost per document.
  - Only the embedded text changes — citations and answers still come from the raw document.
  - Turning it on re-indexes your existing documents automatically, so no manual rebuild is needed. It changes every chunk's embedding, so it cannot apply to only new documents. Turning it off re-indexes without it. Also toggleable under Advanced → Retrieval.
- `faithfulnessModel` — the model used for the [answer verification / faithfulness check](#verifying-answers-faithfulness-check) (the **✓ Verify** toggle). Fact-checking wants a *capable* judge: a small ~3B model gives unreliable verdicts, so set this to your most capable local model (a 7B–8B chat model works well) even if your main answer model is smaller. Empty (the default) uses the main chat model — which then judges its own answer, so a clean result shows a neutral **✓ Self-checked** badge; set a distinct model here to earn the confident **✓ Grounded** badge.
- `faithfulnessMaxTokens` — token budget for the faithfulness judge's JSON verdicts. Defaults to `200`.
- `numCtx` — the model's context window in tokens. The default is `0`, which means **automatic**: Lokyni reads the selected model's real context window from the model host and uses it, capped at `32768` for memory safety. This way the window is never silently too small, and a larger model's bigger window is used without hand-tuning. The window must be large enough to hold the retrieved passages plus the grounding rules and conversation history. To override the automatic value, set a positive number here; an explicit value is used as-is and is not capped. Leave it blank in Settings for automatic.
- `assistantRole` — an optional custom system persona describing how the assistant should behave.
- `debounceTime` — how long in milliseconds to wait after a file change before re-indexing, so a burst of edits coalesces into one update. Defaults to `3000`.
- `minFileSize` — files smaller than this many bytes are skipped, since very short files carry no useful signal and dilute retrieval. Defaults to `50`. Lower it if you keep genuinely short notes you want searchable; skipped files are reported on the console so you can see what was left out.
- `maxFileBytes` — the largest single file the indexer will read into memory. Defaults to `524288000` (500 MB), matching the upload limit. A larger file dropped straight into the documents folder is skipped rather than risk running the server out of memory; the skip is reported on the console. Raise it only if you have the RAM for it.
- `port` — the port the web interface listens on. Defaults to `7887`, chosen to avoid the crowded 3000/8000/8080 range so it won't collide with dev servers — which matters when Lokyni runs as a background service. If the port is already in use, Lokyni reports it clearly on startup instead of failing silently. The service commands (`--status`, `--open`) read this value too. You can override it for a single run with a command-line argument, `node lokyni.js --port 8080`, which takes precedence over `config.json`.
- `bindAddress` — the network address the server binds to. Defaults to `127.0.0.1` (loopback), so a private, local-first tool is not unintentionally exposed on your network. The control plane (settings, file browsing, backups) is protected in several independent layers:
  - With no accounts, it is same-origin and unauthenticated (the local operator). Once you create accounts (see [Users and Access](#users-and-access)), it requires a sign-in.
  - Lokyni blocks cross-origin requests to it, so a website open in another tab cannot drive it or read your documents.
  - Every state-changing request from a signed-in session must carry a per-session anti-CSRF token. A cross-site page can neither read nor forge that value. API-key callers on the `/api/v1` data plane authenticate with their key instead and are unaffected.
  - While bound to loopback, Lokyni rejects any request whose `Host` header is not a loopback address. This stops a DNS-rebinding attack.

  A reverse proxy should either rewrite the upstream host to `localhost` or be listed in `trustedHosts` (see "Reverse Proxy Setup"). Set `bindAddress` to `0.0.0.0` only if you deliberately want to reach Lokyni from other devices on your network, and firewall the port accordingly.

  **The easy way:** rather than editing `bindAddress` by hand, turn on **Allow access from other devices on your network** under **Advanced → Security**. It binds Lokyni to your network on the next restart. Because that would otherwise put your documents in reach of anyone on the network, Lokyni requires an account first (set one up from the account menu, see [Users and Access](#users-and-access)) — the toggle stays disabled until a sign-in exists, so the corpus is never exposed unauthenticated. An explicit `bindAddress` or `--bind` still works as an advanced override and is left to you to secure.
- `trustedHosts` — a list of extra `Host` header values to accept while bound to loopback, for a reverse proxy that forwards your public host name unchanged. Empty by default. For example, `"trustedHosts": ["lokyni.example.com"]`. Leave it empty if your proxy rewrites the host to `localhost`.

### Conversational Intelligence Settings

These settings control how Lokyni understands follow-up questions and manages long conversations. Each can be toggled independently; the default is noted for each setting.

- `useIntentClassifier` — when enabled, a single LLM pass reads each turn and classifies it (continue, new topic, compare, reference, or meta), resolves references, and names the target document. This consolidates topic-switch, comparison, and continuation detection into one decision and generally produces the most natural conversation flow. On any failure it falls back to the built-in heuristics, so it is always safe to leave on. Defaults to `true`. Also toggleable under Settings → Features.
  - `intentMaxTokens` — token budget for the classification response. Defaults to `160`. The classifier refers to documents by number rather than echoing full filenames, so this budget stays sufficient even with long document names.
  - `intentModel` — an optional smaller/faster model to use just for classification, keeping the main model free for answering. Leave empty to use the primary model.
- `synthesisMaxDocs` — how many documents [Workspace Synthesis](#workspace-synthesis) summarizes before combining them. Defaults to `60`. Each document is one sequential model call, so this caps how long synthesis takes. When a workspace exceeds it, a representative sample spread across folders is used. Raise it for broader coverage at the cost of a longer wait.
- `extractionMaxDocs` — how many documents a single [Extraction Table](#extraction-tables) run processes. Defaults to `100`. Each document is one sequential model call, so this caps how long a run takes; documents beyond the limit are left out (the panel says how many).
- `extractionMaxCharsPerDoc` — how much of each document's text an [Extraction Table](#extraction-tables) run reads. Defaults to `24000`. A longer document is read only in part (the panel notes when this happened); raise it to read more of each document at the cost of a larger prompt and a longer run.
- `useQueryRewrite` — rewrites follow-up questions into self-contained search queries so references like "it" or "the second one" retrieve the right content. Defaults to `true`.
  - `rewriteMaxTokens` — token budget for the rewrite. Defaults to `96`.
  - `rewriteModel` — an optional model override for rewriting and summarization.
- `useConversationSummary` — keeps a rolling, structured summary of older turns so long conversations stay coherent without exceeding the context window. The first exchange is always preserved verbatim to keep the thread anchored to its original topic. Defaults to `true`.
  - `summaryMaxTokens` — token budget for the summary. Defaults to `400`.
  - `historySummaryThresholdChars` — the conversation size (in characters) at which summarization begins. Defaults to `6000`.
  - `historyProtectLastN` — the number of most recent messages always kept verbatim. Defaults to twice `maxHistory`.
- `useMetaConversation` — answers questions *about* the conversation ("what did I just ask?", "which documents have we looked at?") directly from conversation state, without a document search. Defaults to `true`. Also toggleable under Advanced → Conversation.
- `useTopicSwitchAck` — opens with a short, natural acknowledgment ("Switching over to …") when the topic genuinely changes, so the transition feels intentional. Defaults to `true`. Also toggleable under Advanced → Conversation.
- `useClarifyingQuestions` — asks a single clarifying question when a reference is genuinely ambiguous, instead of guessing. This also covers a bare positional reference ("what about the second one?") that can't be tied to anything in the conversation: Lokyni asks what you mean rather than answering from a chance keyword match. Defaults to `true`. Also toggleable under Advanced → Conversation.
- `usePartialMatchTier` — when a query only loosely matches the corpus, offers what the closest document does cover and is candid about the gap, instead of a flat out-of-scope refusal. Defaults to `true`. Also toggleable under Advanced → Conversation.
- `useCorrectiveRetrieval` — a corrective recover-gate. When a query matches the corpus only weakly — something came back, but not a confident match — Lokyni rephrases the question once and searches again. The new results are merged in, so the reranker gets a second, differently-worded shot at the right passage before answering from a mediocre one. It only kicks in on weak matches, so it costs nothing on confident ones (and nothing when off). Opt-in; defaults to `false`. Also toggleable under Advanced → Retrieval. The weakness cutoff is `correctiveCosineMax` (default `0.6`): a top match scoring below it is treated as weak. Raise it to correct more often, lower it to correct more rarely.
- `useCrossLingual` — answer across languages. Lokyni's default embedding model (`bge-m3`) is multilingual, so a question asked in one language can match a document written in another. The hybrid search, though, normally leans on shared keywords to confirm a match — and a cross-language question shares no words with its document, so that confirmation step (and the English-trained reranker behind it) would otherwise discard the correct result. When this is on, a strong embedding match that has no keyword support is trusted on the embedding alone: the search ranks by meaning only and skips the keyword gates for that query. It is scoped to confident matches, so an out-of-corpus question is still declined rather than answered from a weak resemblance. On by default. Also toggleable under Advanced → Retrieval ("Answer across languages"). This is what makes "ask an English question of a Japanese corpus" (or the reverse) find the right document; same-language search is unchanged.
- `useEmbeddingBanks` — keep a separate vector index (a *bank*) per embedding identity, instead of one index tied to a single model. Defaults to `true`. Switching the chat model or chat provider never touches the bank. Switching the embedding model, provider, or endpoint keeps the old bank, so nothing is re-embedded; when you move the same model to a new provider or endpoint, Lokyni measures the two and reuses your existing bank when they are equivalent, otherwise opening a new bank alongside the old one. A corpus that has only ever used one model keeps a single bank, so there is no extra cost. Set it to `false` to force the older single-index behavior; the change applies live.
  - With banks off, changing the embeddings model, provider, or endpoint forces a full re-embed of every document, and search returns nothing until it finishes.
  - With banks on, changing the embedding identity creates a new *active* bank and keeps the old one — frozen, but still searched. Existing documents stay findable through their old bank while new and changed documents embed into the new one. A query searches every bank and fuses the results, so an embedding change is incremental rather than a blocking rebuild.
  - A frozen bank is queried through the endpoint and key that built it. Keep that endpoint reachable; if it is gone, run **Consolidate embedding banks** to re-embed the corpus with the current model.
  - Your existing single index migrates into a bank automatically the first time banks are enabled (nothing is re-embedded). Banks live under `vector_store/banks/<fingerprint>/`, tracked by `vector_store/banks.json`.
  - Once you've settled on a model, **Settings → Consolidate embedding banks** re-embeds every document with the current model into one bank, then removes the rest. The move is additive and resumable. It runs in bounded batches, and every older bank stays loaded and searchable until its documents have moved. Because the document text does not change, each batch reuses the existing keyword index instead of re-tokenizing the whole corpus. An interrupted run (a restart, a crash, or an embedding provider outage) resumes from where it stopped the next time you run Consolidate. Nothing already moved is lost, and the Settings health panel notes an unfinished run.
- `useSemanticCache` — when on, re-asking the exact same question against an unchanged corpus returns the previous answer instantly, skipping retrieval and generation. A hit is only ever a genuine repeat: it requires the same corpus (any indexing change retires the cache), the same answer-affecting settings, and the same question. It also applies only to a plain first-turn question — never a follow-up, a web or research answer, a focused or attached query, or a date-filtered one. The key includes the answer-pipeline version, so upgrading to a build whose prompts or safeguards changed retires older cached answers instead of replaying them. Defaults to `false`. Also toggleable under Advanced → Conversation.
- `useDocumentSummaries` — the first level of a layered index, one that works at more than one level of detail. When on, a short, grounded summary of each document is written at index time and appended to the document's indexed text. A broad question ("what is this about", "what are the common themes?") then retrieves the summary, so the model reads a coherent synthesis rather than a stray fragment. The summary is generated from the document's own text (and any figure descriptions), cites that same document, and is cached by content hash so an unchanged document is summarized once. It adds one model call per document at index time, so it is opt-in. Turning it on re-indexes your existing documents automatically, so every document gets a summary. This matches contextual retrieval and visual ingest. Defaults to `false`. Also toggleable in Advanced → Retrieval.
- `useAutoSynthesis` — the second level of that layered index. When on, a genuinely whole-corpus question ("what are the common themes across all my documents?", "give me an overview of this workspace", "how do these connect?") is answered by workspace synthesis instead of top-k passage retrieval. Synthesis is a map-reduce that reads across the whole collection, where top-k retrieval only sees a few documents. Only unambiguous whole-corpus phrasing routes this way; ordinary and per-document questions stay on the normal path. It reuses the same synthesis the Generate action runs, so it can be slow on a large workspace — hence opt-in. Defaults to `false`. Also toggleable in Advanced → Retrieval.
- `useRagFusion` — multi-query retrieval. When on, a small helper model call rewrites a fresh question into a few alternative phrasings. Each phrasing runs its own search, and the result lists are merged so a passage the exact wording missed — but a paraphrase finds — is still surfaced for the reranker. It runs only on a fresh query (never a retry, focus mode, or attachment answer) and is best-effort — if variant generation returns nothing, the single-query results are used unchanged. Opt-in; defaults to `false`. Also toggleable in Advanced → Retrieval. The number of extra phrasings is `ragFusionQueries` (default `3`).
- `useHyde` — hypothetical-answer retrieval. When on, a small helper model call drafts a short passage that would answer the question. That passage is embedded and used as an extra query, then merged with the other results. Because it reads more like a document than a question, it surfaces passages a bare question can miss — most helpful when you ask in lay terms about technical material. The drafted passage is only ever a retrieval probe: it is never shown and never used as an answer, so it cannot introduce fabrication. Opt-in; defaults to `false`. Also toggleable in Advanced → Retrieval.
- `useEntityGraph` — a lightweight entity co-occurrence graph for multi-hop "how are X and Y related?" questions, where the connecting facts live in different documents. A pure-JS proper-noun/acronym extractor (no model call, no dependency) builds the graph lazily from the loaded documents and caches it until the corpus changes. When a question names two or more known entities, the entities that bridge them become an extra query. The bridging documents are then pulled in and served even if they don't repeat the question's keywords, so the document that actually connects the two entities isn't dropped. Recall only: the model still answers from real passages, grounded and cited. Defaults to `false`. Also toggleable in Advanced → Retrieval.
- `useGraphRag` — a knowledge graph the model builds by reading each document. Where the entity graph above notices only which names appear together, this records the actual relationships each document describes, so it can bridge a named pair through a connection the co-occurrence graph would miss. Defaults to `false`. Also toggleable in Advanced → Retrieval.
  - **Building it.** When you turn it on, Lokyni builds it automatically in the background — reading the documents you already have, never re-embedding anything, and reporting how many entities and relationships it found. A **Rebuild knowledge graph** button is there if you ever want to force a full refresh (for example after changing the extraction model).
  - **Incremental.** Each document is read once and cached by its content. A later build re-reads only what changed and drops anything you removed. Once the graph exists, it refreshes itself in the background after each indexing run.
  - **Safe to interrupt.** A build saves its progress as it goes (every few documents, written atomically so the stored graph is never corrupted). If you close the app partway through a long build, nothing is lost — the next time it opens, the build picks up where it left off and finishes the remaining documents in the background.
  - **At query time.** If a question names two or more entities the graph knows, the relationships connecting them become an extra query and their documents are pulled in. This is recall only — the model still answers from real, cited passages.
  - **Model and safety.** It reads documents with the main chat model unless you set `graphRagModel`. It is best-effort: a failed extraction simply adds nothing to the graph for that document, and it can never block or slow indexing or a question.
- `useAdaptiveRetrieval` — adaptive routing for the extra-recall passes above. When on, a cheap, deterministic complexity check runs RAG-Fusion and HyDE only for involved questions (comparative, multi-part, multi-entity, or long) while a simple factual lookup takes the fast single-query path — saving the extra model call and vector searches where they add little. It only has an effect when RAG-Fusion or HyDE is enabled. Opt-in; defaults to `false`. Also toggleable in Advanced → Retrieval.
- `useSuggestedQuestions` — a master switch for follow-up suggestion chips. When on (the default) and **Suggest follow-ups** is turned on in the composer's Tools menu, a short auxiliary model call after each grounded answer proposes a few natural next questions, shown as one-click chips under the answer. The call runs after the answer finishes streaming, so it never delays the reply. Set to `false` to disable the feature entirely. Also toggleable under Settings → Features (the composer's Follow-ups option still arms it per session).
- `showAnswerConfidence` — show a high, medium, or low confidence chip on each document answer. The verdict is blended from signals already computed (support, retrieval strength, figures, and stability when it is on), so it costs no extra model call on its own. Defaults to `true`. See [Answer Confidence](#answer-confidence). Also toggleable under Settings → Advanced → Conversation.
- `abstainOnWeakEvidence` — when on, a low-confidence answer carries a short honest caution beneath its controls, so a thin answer reads as tentative. The answer text is unchanged, and a confident single-source answer is never flagged. Defaults to `false`.
- `useSemanticEntropy` — when on, each answer is re-asked a few times and the replies are compared by meaning; an answer that changes run to run is marked unstable, which lowers its confidence. It catches an answer the model cannot reproduce. It adds `semanticEntropySamples` minus one extra generations per answer, so it is opt-in. Runs after the answer streams, so it never delays the reply. Defaults to `false`.
- `semanticEntropySamples` — how many replies to compare when `useSemanticEntropy` is on, from `2` to `6`. The first is the answer itself, so the extra cost is this value minus one. Defaults to `3`.

### Cross-Encoder Reranker Settings

- `useReranker` — enables a cross-encoder reranker that scores every retrieved passage for relevance. It reorders the candidate documents and, within each document, picks the passage that best answers your question rather than whichever fragment the vector search surfaced first, which meaningfully improves answer precision. The model (~23 MB quantized) downloads once from Hugging Face and is cached locally; if the download fails, retrieval falls back silently to the base ranking. All of its CPU work (tokenization and inference) runs in a background worker thread, so scoring never blocks the server's event loop — concurrent queries and the live status stream stay responsive while it runs. Defaults to `true`. Also toggleable under Advanced → Retrieval.

  **NOTE:** Turning `useReranker` on or off takes effect on the next question, with no restart. When you enable it, the first question pays a brief one-time warm-up while the model loads. Only changing `rerankerModel` (below) needs a restart.

- `rerankerModel` — the reranker model to use. Defaults to `Xenova/ms-marco-MiniLM-L-6-v2`, a Transformers.js-compatible cross-encoder with ONNX weights. Older `cross-encoder/…` model names are automatically mapped to their working equivalents.

- `rerankerDropBelow` — the off-topic cutoff on the cross-encoder score, and the model-agnostic half of the relevance gate. The reranker scores each retrieved passage for genuine relevance on a fixed scale (roughly `-11` for clearly off-topic up to about `+9` for a strong match). That scale does not move when you change the embedding model, so one cutoff keeps off-topic questions out no matter which embedding model you run. A single [`minCosineScore`](#retrieval-and-generation-settings) value cannot do that. When the reranker is on and *every* retrieved passage scores below this, the documents hold no genuine match, so Lokyni declines and offers to search the web rather than citing noise. Defaults to `-8`, which sits safely below even a weak-but-relevant passage (those score about `-1` to `-5`), so only passages the model actively judged off-topic are dropped. Raise it to be stricter, lower it to keep more. It applies only when `useReranker` is on; with the reranker off or unable to score, this gate is skipped and only the `minCosineScore` pre-filter applies (so behavior is unchanged). It is also skipped for a confidently non-English question, since the default English-trained reranker under-scores genuine non-English matches.

- `useColbertRerank` — an optional second-stage refinement, off by default. After the cross-encoder scores the candidate passages, this re-sorts them using *late interaction*: instead of comparing one pooled vector per passage, it compares the query and each passage token by token and rewards a passage that covers every part of your question somewhere in its text. It sharpens which passage is chosen to represent each document, which can help precise, multi-part questions. It runs a heavier per-token model pass, so it is opt-in. Like the cross-encoder, all of its work runs in a background worker thread and it is best-effort — if its model can't load or scoring fails, retrieval simply keeps the cross-encoder order, so it can only sharpen results, never block or degrade them. It leaves the relevance decision (whether to answer at all, or offer a web search) to the cross-encoder, unchanged. Takes effect on the next question, with no restart. Defaults to `false`.

- `colbertModel` — the token-embedding model used for the late-interaction pass above. Defaults to `Xenova/all-MiniLM-L6-v2` (Transformers.js-compatible, ONNX, downloaded once and cached locally). Changing it needs a restart. A model trained specifically for late interaction gives the best results; a general sentence model still works.

### Web Search Settings

Web search lets Lokyni answer from live web pages when you explicitly ask it to, or when your documents genuinely have nothing on a web-answerable question. It is opt-in by design — the network is never touched unless you turn on **Search the web** in the composer's Tools menu for a message or accept an offered search — so the default fully-local, private posture is preserved. It requires no API key — it scrapes DuckDuckGo's lightweight HTML endpoint.

- `useWebSearch` — master switch for the whole feature. When `true`, **Search the web** appears in the composer's Tools menu and auto-suggestion can offer a web search on a genuine document miss. When `false`, the feature is disabled entirely and the toggle is hidden. Defaults to `true`.

  **NOTE:** `useWebSearch` and `webAutoSuggest` take effect immediately, with no restart.
- `webAutoSuggest` — when `true` and a question finds nothing in your documents but looks web-answerable (a factual or current-information query), Lokyni offers a Yes / No web-search prompt instead of just reporting no answer. The web is never searched until you accept. A genuinely *live* question — today's price, the current weather, the latest release — triggers the offer even when a related document exists. No static document can answer such a question, so this saves several wasted retrieval attempts. Set `false` to disable auto-suggestion while keeping the manual **Search the web** option. Defaults to `true`.
- `webOfferMaxRerankerScore` — auto-suggest only offers a web search when the best reranker score for the failed query is at or below this value. Reranker (ms-marco) scores run roughly −11 (irrelevant) to +9 (strong), so `0` is a sensible "no real match" cutoff. Defaults to `0`. Raise it to offer web more readily, lower it to be stricter. Only applies when the reranker is on.
- `webSearchResultCount` — how many search results to request from DuckDuckGo. Defaults to `5`.
- `webSearchFetchCount` — how many of the top results to fetch full page text for (the rest contribute their search snippet). Defaults to `3`.
- `webSearchMaxCharsPerPage` — the readable-text cap per fetched page, to keep the context window manageable. Defaults to `6000`.
- `webSearchTimeoutMs` — per-request timeout for the search and each page fetch, in milliseconds. Defaults to `15000`.
- `useWebResultRanking` — before fetching pages, reorder the raw search results by a *source prior*. It weighs three signals: domain authority (`.gov`/`.edu` and well-known reference sites rank high, social feeds and content farms low), how well each result's title and snippet match your query, and recency. This makes the pages Lokyni reads and grounds on the most trustworthy and on-topic ones, not whatever order the engine returned. It only reorders results — it never drops any. Defaults to `true`.
- `urlCapture` — how a pasted web page is captured. `auto` (default) tries a bounded plain HTTP fetch and uses the headless browser only when the page is thin, walled, an error shell, or mostly scripts. `http` never launches a browser, so it works on minimal installs. `headless` always renders. Auto remembers a host that needed rendering for a while, so later captures go straight to the browser.
- `webProxyUrl` — an optional outbound (egress) proxy for all web access: the search query, the result-page fetches, and headless URL ingestion. Empty by default, which means direct connections. Set it to work behind a network that requires a proxy, or to avoid tying every request to one IP. You can list **more than one** proxy (one per line, or comma or space separated) to form a pool. A bare `host:port` is treated as `http://host:port`. The `http://` and `https://` schemes are fully supported on every path, and **SOCKS** (`socks://`, `socks5://`, `socks5h://`, `socks4://`) is now supported on every path too (search, page fetches, and URL ingestion). When this is empty, Lokyni falls back to the standard `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` environment variables, so an environment that already exports those needs no extra setting. An authenticated proxy (`user:pass@host:port`) is supported, including for SOCKS. Because an egress proxy is remote, it cannot reach this machine's own localhost or private network. So the direct path's connection-vetting is not needed when a proxy is set, and configuring one is a decision to trust its network.
- `webProxyRotate` — when a pool of several proxies is configured, rotate across them in round-robin order so each request uses the next proxy. Opt-in and `false` by default; with it off, the pool's first proxy is used. A single proxy makes this moot.
- `webProxyRetries` — when a request is blocked or fails through a proxy (proxies get rate-limited or blocked), retry it through the next proxy in the pool, up to this many times. Defaults to `2`; set `0` to disable retrying. It only takes effect when a proxy is configured, and each retry advances to a different proxy even when rotation is off. Each proxy's health is tracked so a genuinely failing exit (its connection keeps failing) is briefly rested, while an exit that only hit a site's rate limit — the site refused, the proxy is fine — is not penalized. If every exit is resting, the whole pool is still tried rather than giving up.
- `webProxyStrict` — strict no-leak mode. Opt-in and `false` by default. When on, a web request for which a proxy is configured but cannot be applied **fails** instead of quietly falling back to a direct connection that would expose your real IP address. Leave it off to let such a request degrade to a direct connection.

**Privacy note:** When you use web search, the query and the fetched page requests leave your machine and go to DuckDuckGo and the result sites. This is the one part of Lokyni that makes outbound calls beyond your LLM provider, and it only happens when you explicitly invoke it. If you run Lokyni behind an egress allowlist, permit `duckduckgo.com` and the sites you expect to reach.

### Email (SMTP) Settings

Optional — only needed if you want [scheduled automations](#scheduled-automations-and-digests)
to *also* email their results. Without it, automation results still go to the in-app
Inbox; email is purely additive.

The easiest way to set this up is in the app: **Settings → Email (SMTP)** — enter your
host, port, encryption, username, password, and From address, click **Save SMTP**, then
**Send test email** to confirm it works (it verifies the connection and, with a "Send
test to" address, sends a real message). The password is stored locally and never shown
again — leave it blank on a later save to keep the existing one. Changes take effect
immediately, without a restart.

Equivalently, you can add an `smtp` block to `config.json` by hand:

```json
{
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "user": "you@example.com",
    "pass": "app-password",
    "from": "Lokyni <you@example.com>"
  }
}
```

`secure` defaults to `true` for port 465, otherwise `false` (STARTTLS). `user`/`pass`
are omitted for an unauthenticated relay. Email uses `nodemailer`; if it isn't installed
or SMTP isn't configured, email delivery is skipped gracefully and the Inbox still works.

### Security Settings

- `auditLog` — keep a tamper-evident [security audit log](#security-audit-log) (`data/audit.jsonl`) of key, config, index, and access events. Defaults to `true`; set `false` to disable it entirely. Also toggleable in Advanced → Security.
- `allowSignups` — let people create their own accounts from the login page instead of an admin creating them. Defaults to `false` (admin creates users). The first account is always allowed and becomes the administrator, regardless of this setting. See [Users and Access](#users-and-access).

Secrets are also redacted from the logs automatically, with no setting to configure. Everything Lokyni writes to the log viewer, the in-memory buffer, and the service log files is scrubbed of obvious credential shapes. That includes bearer tokens, `sk-…` and `lok_…` keys, `user:password@host` in a URL, and `token=` or `password:` style values. As a result, a shared log never leaks a key.

## Features

### The Composer and Answer Options

Asking a question is meant to feel simple. The composer is a clean row: attach a file, type your question, and send. Every optional way to answer lives behind one **Tools** menu next to the input, so the box stays uncluttered.

Open Tools to turn options on or off. They are grouped by purpose — where answers come from (search the web, deep research), how answers are shown (explain the answer, verify the answer, suggest follow-ups, learn from ratings), and a date-range filter. Each option has a plain-language name and a one-line description, so you never have to guess what it does. Whatever you turn on appears as a small chip above the input, and the Tools button shows a count, so it is always clear what is active before you send. Explain the answer and Learn from ratings are on by default.

When the conversation is empty, a few starter prompts appear under the prompt. Selecting one fills the box (it does not send), so you can edit the question before asking. This gives a first-time user an easy way to begin.

The top bar keeps the workspace picker, the document manager, and a new-conversation button in front. Secondary actions — Logs, Inbox, and the Guide — are grouped under a **⋯ More** menu so the header stays tidy, with Settings and the theme switch as icons.

On a phone, Tools opens as a bottom sheet titled **Answer options**, with a close control and a dimmed backdrop. Tap outside the sheet, press Escape, or use the close control to dismiss it. On a larger screen the same options stay a compact popover beside the composer.

### Stopping a Turn and Long-Running Progress

While an answer is generating, the Send button becomes **Stop**. Press it to end the turn immediately: Lokyni cancels the model request and any retrieval, synthesis, or research work still in flight, keeps whatever text had already streamed, and marks the answer **Stopped.** The conversation is kept, so you can send the question again or ask a follow-up. Stop is not the same as **New**: Stop ends only this turn, while New permanently deletes the conversation. The control is the same button, so it works from the keyboard too — reach it with Tab and activate it with Enter or Space.

Long turns report what they are doing in the status bubble. Deep Research shows its planning step, each sub-question it is researching (with a count, such as "2 of 4"), and the final synthesis. Workspace generation shows how many documents it has read. Every progress line also resets the slow-turn notice.

That notice appears after two minutes without a token or progress update and keeps the turn running, so it never discards a late answer. The notice names the stage it is waiting on: searching your documents, reranking passages, writing the answer, searching the web, or deep research. This keeps a slow model distinct from slow retrieval. When a stage has been silent for a shorter interval, the server also attributes the stall in the logs and in the notice. If the connection itself drops, the composer resets and the server cancels the abandoned turn.

### Read Answers Aloud

Lokyni can speak an answer in a natural voice. Turn on **Read answers aloud** in Settings and a **Read aloud** button appears under each answer. Click it to hear the answer, and click again to stop. Turning the feature on also adds the control to answers already on the screen, so there is no need to reload. Changing the read-aloud language updates those controls too, and turning the feature off removes them. It is useful for long answers, for listening while you do something else, and for accessibility.

Read-aloud follows the language of each answer. English uses the bundled voice model. Every other language uses a voice installed in your operating system through the browser's standard speech interface. That keeps the download small, and coverage grows with your device instead of a heavy bundled model. Automatic detection separates languages that share a writing system, including Ukrainian, Belarusian, Bulgarian, Serbian, Macedonian, Persian, Urdu, and Marathi. The catalog also covers common Latin-script languages such as Catalan, Galician, Basque, Afrikaans, Malay, Filipino, Swahili, Icelandic, Lithuanian, Latvian, Estonian, Slovak, Slovenian, Croatian, Bosnian, Albanian, Welsh, Irish, and Maltese. **Read-aloud language** in Settings is **Automatic** by default, which matches each answer. Choose a specific language to force it when two languages are hard to tell apart or an answer is too short to identify.

The bundled voice runs entirely on your machine. The first time you use it, a small voice model (about 90 MB) downloads once. After that it works offline, and nothing you have it read is sent to a cloud service. Settings offers several English voices (US and UK, female and male), so you can pick the default you prefer.

System voices are normally installed on the device and work offline. Some operating systems also offer voices generated by a network service. A voice the browser reports as online is never used unless you turn on Allow online voices in Settings. With that off, read-aloud stays local wherever your device has a local voice. An answer in a language with no local voice shows a clear message instead of silently using an online one. System voices come from the browser and the desktop shell. Not every shell exposes them, so if the desktop app reports none, open Lokyni in your browser to read non-English answers aloud.

**System voice** in Settings has its own language picker, separate from **Read-aloud language**. Choose the language you want to browse, then pin a voice for it. Playback can stay on **Automatic** while you prefer one Spanish voice and a different French voice. **Automatic** in the voice picker means the best available local voice for that language. Local voices are listed first. A voice the browser reports as online appears only when online voices are allowed, and a pinned voice that is no longer installed falls back to the best available voice. The ▶ button beside the picker plays a short sample in that language. If no installed voice is reported for the chosen language, the row says so, and the preview still tries the system default. The browsing language follows your saved settings, so Cancel discards a change to it like any other edit. If a voice uses a network service, Settings labels it online and the first read with it shows a brief notice, so the choice is never silent.

Open **Installed voices** below the picker for a read-only list of every language and the voices this device reports for it. Each language shows its local voices, its online voices, or no voice installed. A summary counts how many languages have a local voice, an online-only voice, or no voice. The panel reads the same voice list, language catalog, and local/online classification that playback uses, so it explains exactly what this machine can speak.

For one answer, open its **⋯ More** menu and choose **Read as…**. The dialog shows the detected language, then re-reads that answer in the language you pick without changing your Settings default. Use it when a short or mixed-language answer is hard to identify automatically. The choice applies to that answer only.

The Read aloud control also reports its playback state and announces which voice is speaking to screen readers, so starting and stopping audio is not a purely visual change.

Read-aloud streams audio. For the bundled voice it starts speaking the first sentence within a few seconds while the rest is prepared, instead of waiting for the whole answer. Playback is scheduled to stay smooth and gap-free from one sentence to the next at any speed. System speech is split into the same language-aware chunks, which also avoids engines that truncate a long utterance.

In Settings you can preview any bundled voice with the ▶ button beside its picker and set the **speed** (0.5×–2×) used by read-aloud, voice answers, and podcasts. The podcast's two host voices are chosen there too, each with its own preview.

The feature is off until you enable it, so the voice model is never downloaded unless you ask for it. When you do turn it on, the model is fetched **once in the background** so the first read-aloud is fast rather than stalling on a download; Settings shows **preparing** and updates to **ready** when it finishes. If you have forced a non-English read-aloud language, the English model is not downloaded for that configuration, because every answer is voiced by the system. Synthesis runs in a background worker, so it never blocks the app, and the model is released from memory after a short idle period and loaded again on demand.

### Ask by Voice

Turn on **Ask questions by voice** in Settings and a microphone button appears in the composer. Click it to start recording, speak your question, and click again to stop. Your speech is transcribed and dropped into the question box, where you can fix a misheard word before you send it. Voice is just a quicker way to fill the box; the answer comes back through the same grounded, cited pipeline as a typed question.

Transcription runs entirely on your machine. The microphone audio is converted in your browser and sent to a local model; nothing is sent to any cloud service, and the first use downloads a small model (about 75 MB) once, after which it works offline. Many languages are supported — set your spoken language under **Spoken language** in Settings (English by default).

The microphone button appears both in a normal browser pointed at Lokyni and in the desktop app. The first time you use voice input the operating system asks for microphone permission — allow it once and the app remembers. (On macOS, if you ever change your mind, you can toggle Lokyni's microphone access under System Settings → Privacy & Security → Microphone.)

If your machine has more than one microphone, pick which one to use under **Microphone** in Settings — the same setting works in the browser and the desktop app, and it applies to both voice input and hands-free mode. Device names appear once you have allowed microphone access. Leave it on **Default microphone** to follow whatever your system picks.

Like read-aloud, the feature is off until you enable it, and the model is never downloaded unless you ask for it. The microphone button only appears when your browser can record and you have granted microphone access; if access is blocked, you get a single clear message rather than a nagging prompt. Transcription runs in a background worker so it never blocks the app, and the model is released after a short idle period and loaded again on demand. Paired with **Read answers aloud**, you can ask a question out loud and hear the answer spoken back.

### Hands-Free Voice Mode

Next to the microphone button is a **hands-free** button. Click it once and you can hold a whole conversation without touching the keyboard: Lokyni listens continuously, notices when you have finished speaking, transcribes what you said, answers it, and — with **Read answers aloud** on — speaks the answer back. Then it listens again, so you can just keep talking. Click the button again to stop.

You can **interrupt** the spoken answer at any time: start talking over it and Lokyni stops the playback and listens to your new question (barge-in), the way a real conversation works. It also stops generating that answer's audio when you cut in, so nothing keeps running in the background.

Speech detection is local and model-free — a lightweight detector in your browser with an **adaptive noise floor**, so background noise doesn't constantly trip it and a short cough or "mm-hm" over the answer isn't mistaken for an interruption. It needs microphone access (a one-time browser prompt) and the **Ask questions by voice** setting on. The button appears only when both are available. Your microphone audio never goes anywhere except to the same local transcription the microphone button uses, as a short clip per question. The read-back uses the same language-aware read-aloud routing as the Read aloud button (the bundled English voice, or a system voice for other languages); if read-aloud is off, Lokyni still listens and answers in text.

### Audio and Video Files

Turn on **Transcribe audio & video** in Settings and Lokyni treats media files as documents: it transcribes what is spoken in them and indexes the transcript, so a recorded lecture, meeting, podcast, or video becomes fully searchable and citable — the same as a PDF or a Word file. Add them the way you add any document: upload them, or drop them in an indexed folder. Common audio and video formats are supported (mp3, m4a, wav, flac, ogg, aac, and more; mp4, mov, webm, mkv, and more).

Transcription is entirely local and private — nothing is ever sent to a cloud service. WAV files are decoded by Lokyni directly. For compressed and video formats, Lokyni fetches a media decoder once into its own data folder and reuses it; it never uses a decoder already installed on your system, so every install behaves identically. If that one-time download can't happen (for example, no internet), WAV files still transcribe and other media are simply indexed by their file name until the decoder is available — a file is never dropped.

The work is bounded and safe. A long recording is transcribed in segments so memory stays flat no matter how long the file is, and there is a cap (default 180 minutes per file, adjustable in Settings) so a huge file can't run away. Each transcript is cached, so re-indexing an unchanged file never re-transcribes it. Transcription runs in the background and is skipped for files that contain no speech. The spoken language follows the same **Spoken language** setting as voice input.

### Hybrid Retrieval

Lokyni does not rely on vector search alone. Every query runs through both a dense semantic search (FAISS) and a keyword search (BM25), and the two are fused with Reciprocal Rank Fusion. This catches both meaning-based matches (a question phrased differently from the document) and exact-term matches (names, codes, specific phrases) that pure vector search often misses. A cross-encoder reranker then re-scores the top candidates for a final precision boost.

While a query runs, the composer shows what the pipeline is doing — *searching your documents*, *reranking the top passages*, then *writing the answer from N sources*. On a local model the brief wait then reads as visible progress rather than a frozen screen.

### Conversational Follow-ups

Follow-up questions are understood in context. "Tell me more", "go on", "give me an in-depth analysis", "what else does it talk about?", and "what about that?" all continue the current subject rather than starting a fresh search. A continuation is recognized by meaning, not by a fixed list of phrases: any follow-up that names no new subject of its own — in any language — is treated as a continuation, so it is never quietly steered onto a different document. Short documents are served in full on a follow-up so the model always has the complete material to expand on, and references to earlier discussion are resolved from the conversation.

A follow-up that asks whether the current subject relates to or mentions something else — "does it mention X?", "what does this have to do with X?", "is there anything about X here?" — stays on the documents you are discussing and answers from them. If the term isn't there, Lokyni tells you plainly ("these documents don't mention X") instead of jumping to a different document that happens to contain it.

### Context Switching

When you change subjects, Lokyni detects the shift, resets the conversation focus to the new topic, and steers retrieval to the right document — announcing the change with a brief, natural transition. When the intent classifier is enabled, this decision is made by the model reading the whole thread, which is far more reliable than keyword heuristics alone. Continuation follow-ups are never mistaken for topic changes, and genuine new topics are never forced to stay on the old document.

### Multi-Document Comparison

Ask Lokyni to compare or contrast ("compare X and Y", "what's the difference between these two accounts") and it deliberately assembles balanced passages from multiple documents. It then instructs the model to synthesize across them and attribute each point to its source, rather than answering from a single dominant document.

A two-sided *relational* question is handled the same way. When you ask how two named subjects connect — "how does X relate to Y?", "connect X with Y", "what is the relationship between X and Y?" — Lokyni recognizes that both subjects matter and serves each one's document, so the answer can actually draw the connection instead of covering only the stronger match. The connective wording is recognized across languages, and the balanced handling applies only when the question names two distinct subjects, so a single-subject question stays on its one document.

### Workspace Synthesis

The **✦ Generate** control in the document panel produces a synthesized output across *every* document in the workspace. Pick a format from the dropdown beside it:

- **Overview** — the common themes, where the documents connect or conflict, and what the collection as a whole covers (the "brief me on this whole collection" move).
- **Study guide** — key concepts, the points worth remembering, and self-check questions.
- **FAQ** — the questions a reader is most likely to ask, each with a grounded answer.
- **Timeline** — the dated events across the documents in chronological order.
- **Briefing** — an executive summary with key findings and implications.
- **Flashcards** — question/answer pairs for study.
- **Audio Overview** — a two-host podcast dialogue about the collection (see [Audio Overview](#audio-overview) below).

All formats reuse the same map-reduce machinery (summarize each document, then one synthesis pass over those summaries), so they stay within the model's context even for a large workspace — only the final instruction differs. Each is grounded in the documents, and a follow-up ("tell me more") continues from the result.

Because it summarizes every document before combining, synthesis takes longer than a single question. Clicking **✦ Generate** first shows a short confirmation that says what the chosen format will do and that it reads across the whole workspace, so a long run never starts by surprise. Once you confirm, it tells you how many documents it's working across before it starts.

If a workspace has more documents than the synthesis limit (default 60, set by `synthesisMaxDocs`), Lokyni summarizes a representative sample spread across your folders rather than the first N. The overview then reflects the whole collection, not just whichever files sort first, and Lokyni says plainly that it's working from a sample. Raise `synthesisMaxDocs` for broader coverage at the cost of a longer wait.

Synthesis skips files that are noise in an overview — license files, project config and lock files (`package.json`, `*.lock`, and similar), and images with no meaningful text (icons, decorative graphics). Those files stay fully searchable; only synthesis passes over them.

The same capability is available through the API via [`POST /api/v1/synthesize`](#public-api-v1), with an optional `focus` to steer the angle.

### Audio Overview

Pick **Audio Overview** from the Generate menu and Lokyni writes a short, lively two-host podcast about your workspace — a natural back-and-forth between two hosts that explains the main themes in plain language. It is built on the same synthesis as the other formats, so it reads across your whole collection and is grounded in your documents: the hosts only discuss what the documents actually say, with no invented facts, numbers, or quotations. The dialogue appears in the chat as a transcript you can read.

With **Read answers aloud** turned on (see above), a **Play as podcast** button appears under the dialogue. It voices the two hosts with two different local voices and stitches them into one audio track you can listen to — generated entirely on your machine, nothing sent anywhere. Generating the audio for a long dialogue takes a moment; a progress state shows while it works, and you can click again to **cancel** it (which stops the work immediately, not just the playback). The two host voices default to a contrasting pair and can be changed with `podcastVoiceA` / `podcastVoiceB` in `config.json`. The two-host podcast is English-only because both host voices come from the bundled model; an Audio Overview written in another language gets the language-aware **Read aloud** control instead, so it is voiced by a system voice rather than read with English hosts.

If read-aloud is off, you still get the full dialogue as text — a conversational overview of your collection — with a one-line hint on how to enable the audio.

### Extraction Tables

Where synthesis blends your documents into one narrative, **Extraction Tables** keep them apart — one row per document — so you can compare the same fields across a whole collection at a glance. It's the tool for "pull the method, the sample size, and the headline result out of every one of these papers," or "list each contract's party, term, and renewal date."

Click **⊞ Extract** in the document panel, define the columns you want (for example *Method*, *Sample size*, *Key finding*), and run it. Lokyni reads each document in turn and fills in a grid that builds live as it works. Every cell is grounded in that document's own text: hover a value to see the short verbatim quote it was taken from, and a cell is left empty rather than guessed when the document doesn't say. Tick **Only the selected documents** to run it over just the documents you've focused instead of the whole workspace.

When it finishes, **Export CSV** saves the grid for a spreadsheet. It opens cleanly in Excel, Numbers, or Google Sheets, and a cell that starts with a formula character is written as plain text so nothing runs on open.

The run is bounded. It processes up to `extractionMaxDocs` documents (default 100) and reads up to `extractionMaxCharsPerDoc` characters of each (default 24000). It runs one document at a time, so it never overloads a local model. The panel's **Cancel** stops it at once and keeps whatever rows were already extracted. Like synthesis, it skips noise files such as license, config, and lock files, and images with no text.

### Corpus Mind-Map

The **🕸 Map** button in the document panel opens an interactive map of your workspace — the entities across your documents (people, organizations, places, concepts) and how they connect. It's a visual way to see the shape of a collection at a glance: which topics are central, what clusters together, and where the links run. A bigger dot means an entity appears in more relationships.

**Explore it like a canvas:** drag to pan, and scroll, pinch, or use the on-screen buttons to zoom — so even a dense map stays readable (zoom in to read any label). The busiest hubs are always labeled; smaller points reveal their name when you hover or zoom in. **Hover a point** to trace its connections (its links light up and the rest dims). **Click a point** to select it — its details appear below the map with an **Ask about** button that drops a ready-made question into the composer, so you jump straight from the map into a grounded answer. It works the same with a mouse, a trackpad, or touch.

The map draws on the knowledge graph (the `useGraphRag` setting). Turn on **Knowledge graph** in Advanced → Retrieval — it builds automatically in the background and then stays current as your documents change; the map shows the most-connected entities (bounded so it stays readable and fast even on a large corpus). It's rendered right in the app with no external library, and it respects the workspace each window is viewing.

### Notes

**✎ Notes** in the document panel lets you write your own notes right inside a workspace — and they are first-class documents, not a separate scratchpad. Each note is saved as a Markdown file in the workspace, so it is indexed like everything else: it turns up in answers, you can cite it with `#`, and it appears in the document list. This is the "second brain" layer — capture a thought, a summary, or a conclusion, and it becomes part of what you can ask about later.

The editor has a list of your notes on the left and the note on the right. Write in Markdown; **Save** indexes the note so it becomes searchable within a moment. A **Related documents** strip shows the notes and documents most similar to the one you're writing — the same similarity Lokyni uses for related-document lookups — so connections across your workspace surface as you write. Notes are workspace-scoped, saved atomically (a crash can never leave a half-written note), and deleting one asks first.

### Nested Folders in the Document List

The document panel shows your documents as a **collapsible folder tree** rather than a flat list, mirroring the folder structure on disk. Documents added in subfolders — including the per-connector folders a [connector](#connectors) sync creates — nest under a collapsible header that shows the folder name and a document count. Click a header to expand or collapse it; tick a folder's checkbox to focus every document inside it at once (a partially-selected folder shows an indeterminate state). This keeps a large or connector-fed workspace navigable instead of an endless flat list.

### Finding and Opening a Document

The document panel has a filter box above the list. Type part of a file name or folder path to narrow the list. Matching ignores case and accents, so `cafe` finds `café`, and it works for names in any script. The status line reports how many documents are shown, and **Select shown** focuses only the visible matches. Clear the box, or press Escape while it is focused, to return to the full list.

Click a document's name to open it in the in-app viewer. The checkbox beside it — or a click elsewhere on the row — focuses the document for search. Those are separate actions, so opening a file never changes what your next question is focused on.

### Focusing on Specific Documents

In the document panel you can select one or more documents to restrict a question to just those — a "focused" search. When documents are focused, even a vague question like "what's this about?" is answered from the selected documents rather than searched across the whole library. You can also reference a document inline while typing: type `#` in the chat box and pick from the list that appears; the chosen document is added to the focus for that question.

### Full-Context Mode

When you've focused one or more documents, a **full text** toggle appears in the document panel's filter bar. With it on, the selected documents are fed to the model *whole* rather than as retrieved passages. This is best for short documents (an ID, a one-page form, a style guide), where the relevant detail is a single line that passage retrieval might rank too low to surface. Documents above a size cap fall back to normal passage retrieval so the context window can't overflow.

### One-Off Attachments

The paperclip button attaches a file to a single question without adding it to your library or index — a "quick question about this file I don't want to keep" flow. Lokyni extracts the file's text (including OCR for scans) in memory and answers from it, then discards it. Small files are read whole. For a large file, Lokyni retrieves the passages most relevant to your question, so a question about any part of a long document finds that part, not just the beginning. It tells you when it has used excerpts rather than the whole file.

### Meta-Conversational Turns

Questions about the conversation itself are answered instantly from memory, without a document search:

- "What did I just ask?"
- "Summarize what we've covered."
- "Which documents have we looked at?"

### Citations and Passage Highlighting

Every answer is traceable to its exact source, at three levels of detail.

A single **Sources (N)** row below each answer identifies every document it used, and the answer's actions sit in one stable strip beneath it: rate the answer, read it aloud, check its sources, or open **⋯ More** for Copy, Download, and "Why this answer?". Each numbered source pill links to the built-in document viewer and jumps directly to the cited passage, which is highlighted in place — so you can verify any claim against the original text in one click. When the cited pages overlap, the label also reports how many are independent — for example, **Sources (5) · 2 independent**. Pages from one publisher and syndicated copies count once. It is a corroboration hint, not a truth score. A source can also carry a neutral credibility label: **preprint** marks a preprint server or preprint DOI, and **retracted** or **concern** marks retraction or expression-of-concern language found in the source text. These labels are local, advisory, and never remove or down-rank a source.

Hovering (or keyboard-focusing) any citation — a pill or a chip in the strip — shows a small preview card. The card names the source, shows where in the document the passage sits and how strongly it matched, and includes a snippet of the exact cited text. This lets you judge a source without leaving the conversation. On a touch device there is no hover, so tapping a citation opens the full source in the viewer instead.

**Export citations…** in the answer's **⋯ More** menu saves that answer's sources for a reference manager as BibTeX (`.bib`), RIS (`.ris`), or CSL-JSON (`.json`). The reverse works from the Documents panel. **References** imports an RIS, BibTeX, or CSL-JSON file, or text you paste. Each entry becomes a small document in the workspace, searchable and citable like any upload. Both directions use the same field mapping, so a round trip keeps titles, authors, years, venues, DOIs, and URLs.

### Verifying Answers (Faithfulness Check)

Lokyni verifies answers in two tiers. A fast, deterministic **number check** runs on every document
answer automatically: it confirms that each figure the answer states — a price, percentage, count, or
amount — actually appears in the cited sources. It makes no model call, so it adds no delay, and it
stays silent unless it finds a number the sources don't contain, so a clean answer is never cluttered.

For deeper checking, turn on **Verify the answer** in the composer's Tools menu. Each answer then also
gets a model judge that grades every claim as *supported*, *partial*, or *unsupported*. This second
pass is opt-in because it adds an LLM call after each answer; the number check above is always on
because it is free. When Verify is on, a badge appears next to the answer:

- **✓ Grounded** — every checked claim is supported by the sources (shown when a distinct `faithfulnessModel` graded the answer — see below).
- **✓ Self-checked** — the neutral version of the above: the answer model checked its own output and flagged nothing, when no separate judge is configured.
- **◐ Mostly grounded** — some claims are only partially supported.
- **⚠ Unverified claims** — one or more claims aren't backed by the sources.

Even with Verify off, if the number check flags a figure, a warning badge appears on its own so the
problem is never missed. Click any badge to see exactly which sentences the sources don't fully
support, and any figure the answer states that the sources don't contain. This catches the subtle
failure where a claim is plausible but the source doesn't actually say it, and the specific one where a
model fills in a confident number from its training that your documents never mentioned. A flagged
figure always pulls the badge down from a confident "Grounded" to at least "◐ Mostly grounded" (and, when
the claim judge is off, to a ⚠ warning), so an unverified number is never hidden behind a green badge.

An honest negative is handled carefully. When Lokyni answers that your documents *don't* mention something —
"No, these files don't discuss that" — a weak judge model often marks that absence as "unsupported," which
reads as a failing claim even though the answer is correct. For a simple negative like that one, the check
recognizes it and does not mark it unverified.

Safety comes first, though. The check never does this for a sentence that introduces any new content — a name,
a number, or a plain fact the sources don't contain. That is the one rule it will not bend, because for an
anti-hallucination check the worst outcome is hiding an invented fact. So a more nuanced decline, worded with
extra detail, may still show an "unverified" badge even when it is honest. If you want reliable verdicts on
every answer, set a capable `faithfulnessModel` (see below). The small default judge that grades its own output
is conservative by design here, so it never hides a fabrication.

The number check is precise by design. It matches by value with a small rounding tolerance, so "about
85,000" still matches a source "84,583", and it understands magnitudes and currencies, so "$5 billion"
matches "5,000,000,000". It also skips things that aren't factual quantities — years, small counts, and
page or section references — and treats a correct total or difference of source figures as grounded, so
it flags a figure only when it truly appears nowhere in your sources. It only ever flags; it never edits
the answer.

**Verdict quality depends on the judge model.** A small 3B model gives shaky verdicts, so for reliable
checking set `faithfulnessModel` (see [Configuration](#configuration)) to a capable local model — a 7B to
8B chat model works well — even if your main answer model is smaller. With no `faithfulnessModel` set, the
answer model judges its own output, so a clean result shows the neutral **✓ Self-checked** badge rather
than the confident **✓ Grounded** one, because a model rubber-stamping itself is not real assurance; the ◐
and ⚠ caveats still appear when a self-judge flags its own claims. A claim the judge returns no verdict on
is left out of the score rather than counted against the answer, so the count reflects what was actually
checked. The claim judge runs only on document answers, so a web-search answer or a "search the web?"
offer never shows the claim badge.

**Always-on checks (no toggle).** Separately, every answer passes through a set of fast,
deterministic checks that need no model — they run whether or not Verify is on. They
correct a stated arithmetic slip, strip data-exfiltration vectors (raw media/script tags,
invisible/bidi control characters) from the answer, and decline if the answer would
reproduce the assistant's own instructions. If an answer names a document that was not among
the retrieved sources — an invented citation — a short caution is appended noting it may not
be in your library. A substantial quotation is also checked against the retrieved passages;
one that does not appear there gets a neutral caution, because a fabricated quotation is the
most damaging kind of unsupported claim. These are deliberately conservative: they only
act on things that are unambiguously wrong, so they never rewrite a correct answer. And
because a retrieved document is untrusted text, its content is fenced in the prompt with a
per-answer random marker and treated strictly as data — so a document that says "ignore
previous instructions" is described, never obeyed.

### Answer Confidence

Every document answer can carry one plain verdict on how sure Lokyni is: high, medium, or low confidence. It is a single, holistic signal. It is different from the small dot on each source, which shows how strongly that one document matched. The chip is shown by default and is free, because it blends signals Lokyni has already computed and makes no extra model call of its own.

The verdict starts from whether the sources actually support the answer. That is the same check the Verify badge uses, when Verify is on. When Verify is off, it starts from how strongly a document matched the question. From there it can only move down. An invented figure, or an answer that only weakly matches the documents, lowers it. Hover the chip to read the reasons in plain language.

Three controls, under Settings → Advanced → Conversation, shape it:

- **Show answer confidence** turns the chip on or off. It is on by default.
- **Caution on weak evidence** adds a short honest note beneath a low-confidence answer, so a thin answer reads as tentative. The answer text itself is unchanged. It is off by default. A single strong source is a confident answer, not weak evidence, so it is never flagged this way.
- **Check answer stability** re-asks the same question a few times and compares the replies by meaning. If they disagree, the answer is unstable and its confidence drops. This catches an answer the model cannot reproduce, which the grounding checks cannot see. It adds model calls, so it is off by default. The number of re-asks is set by the stability samples value.

The chip and the stability check work in any language, because they rely on the documents and on meaning, not on specific words. One small refinement, which flags wording that sounds more certain than the evidence supports, runs only for an answer confidently detected as English, so it never misfires on another language.

### Conversation Persistence

Your conversation survives a page refresh or reconnect. Lokyni assigns each browser a session and persists the durable conversation state locally, restoring the thread when you return. Clicking **New** clears it, and stale sessions are pruned automatically after 30 days.

### Real-Time Indexing

Lokyni watches the `data/documents` folder and updates the index automatically when files are added, changed, or removed — no restart required. Updates are applied to a shadow copy of the index and swapped in atomically, so questions asked during an update always see a complete, consistent index. Only changed files are re-processed, and removed files have their vectors purged cleanly.

### Related Documents

When you open a document in the viewer, the **◈ Related** button in the toolbar shows the documents most similar to it — a way to discover connections across your library. It uses the same semantic search as retrieval, comparing the document against the rest of your corpus, and lists the closest matches with a similarity score. The button appears once the results load; if nothing is closely related, it says so rather than showing weak matches.

### Rebuilding the Index

If search or related documents start behaving oddly — most often after moving your documents folder, which changes the internal file paths the index is keyed on — you can rebuild the index from scratch. Go to **Settings → Rebuild index** and confirm; Lokyni wipes the search index and re-reads every document. Your documents are never modified, only the index Lokyni builds from them. This runs against the live server (no restart needed) and can take a while for a large library. The same is available from the command line as `node lokyni.js --reindex` (which prompts for confirmation; add `--yes` to skip it).

**The index keeps itself tidy, so you rarely need to rebuild just to reclaim space.** When you delete a document, its vectors are removed from the index as part of the same update. On the rare occasion a few are left behind — a document first indexed by a much older version, or an update interrupted by a crash — Lokyni clears them automatically at the next start: a quick background pass removes any vectors whose document is gone, without re-reading or re-embedding anything. It only ever removes vectors it can confirm belong to a deleted document, so nothing you still have is touched, and it runs quietly out of the way of your searches.

### Conversation Compression

Long conversations are compressed intelligently. The first exchange (which usually establishes the topic and document) and the most recent turns are kept verbatim, while the middle is folded into a structured running summary under fixed headings — Topic, Key Points, Important Values / Numbers, Documents Referenced, and Still Open. This keeps long threads coherent and within the model's context window without losing the original framing.

### Live Web Search

When your answer needs current information the documents don't contain, Lokyni can search the live web — always as an explicit, opt-in action, never silently.

There are three ways it comes into play:

- **Search the web** — turn it on in the composer's Tools menu and answers also draw on live web results, not just your documents. It is off by default — your documents stay the only source until you choose otherwise — and it stays on until you turn it off. Whatever you turn on shows as a removable chip above the input (click the chip's ✕ to turn it off), so it is always clear web search is active before you send.
- **Ask-first auto-suggest** — if a normal question finds nothing in your documents and looks like something the web could answer, Lokyni offers to search with a Yes / No prompt rather than just reporting it has no answer. A genuinely live question (today's price, current weather, the latest release) triggers the offer even when a related document happens to match — since no static document can answer it. The web is only searched if you accept. This is controlled by `webAutoSuggest`.
- **Grounded web follow-ups** — after a web answer, a follow-up that continues the same subject ("what date is that from?", "and the source?") is answered from the pages already fetched, without running a new search. This is the same continuation behavior you get with local documents.

Web answers flow through the same grounding and citation pipeline as local documents: the model is instructed to answer only from the fetched pages and attribute claims to their source, and each answer comes with clickable source pills pointing to the live URLs. Web search requires no API key and no configuration beyond enabling it.

Before grounding, Lokyni collapses duplicate sources so one story mirrored across several outlets is not treated as several independent confirmations. Exact duplicate links are dropped, and pages whose text is a near-duplicate (the same article syndicated under different URLs) are reduced to a single best-ranked copy. Two different pages on the same site are kept, since they can carry different information. This keeps the answer honest about how much the sources really corroborate it and avoids wasting the context window on repeated text.

Each web source also shows a short credibility tier when you hover its pill — *official source* for government, military, and university sites, *established source* for well-known reference and news outlets, and *forum / social* for community sites. This reuses the same signals that order the results, so it is a transparent structural hint, not a judgment of any particular page. Most sites fall in the neutral middle and show no tier.

See [Web Search Settings](#web-search-settings) for the configuration options and the privacy note.

### Deep Research

For a broad question that no single passage answers, Deep Research runs a multi-step investigation instead of a single retrieve-and-answer pass. Turn on **Deep research** in the composer's Tools menu and ask your question. Lokyni plans a set of focused sub-questions and gathers evidence for each across your documents. If you also have 🌐 web search on for the message, it draws on the live web too. It reviews what is still missing, runs another round or two as needed, then synthesizes one structured report that cites every source it drew on.

Because it is heavyweight, Deep Research is a **one-shot** option: it applies to your next question and then turns itself back off, so a costly multi-step run never silently repeats on every follow-up. Turn it on again whenever you want another deep investigation. (The lighter options — web search, Explain, Verify, Follow-ups — stay on until you turn them off.)

It stays grounded the same way ordinary answers are — the report is built only from the evidence gathered, claims are attributed to their sources inline, and it says so plainly when the evidence doesn't cover part of the question rather than filling the gap. Progress is shown as it works (planning, each sub-question with its position in the run, and synthesizing), and the finished report comes with clickable source pills for every document and web page it used. Because a deep run can take a while, the Send button is a **Stop** control for the whole investigation; stopping keeps any report text already written and leaves the conversation intact.

Deep Research is local by default: it searches only your documents unless you also enable web search for that message, so the web is never touched without your explicit opt-in. It makes several model calls (planning, per-sub-question retrieval, and synthesis), so it takes longer than a normal answer — it's built for depth, not quick lookups.

If you select specific documents first (focus mode), Deep Research confines its document search to just those, so you can run a thorough investigation over a single report or a handful of files without the rest of your library entering the picture.

### Prompt Templates

Reusable, parameterized prompts for the workflows you repeat — "extract action items",
"summarize as a timeline", "explain like a lawyer". Type `/` in the chat box, then part
of a template's name, and pick from the list that appears (the same picker UX as the `#`
document reference). The template body is inserted into the composer, where you can edit
it before sending.

Bodies may contain `{variables}`. `{date}`, `{time}`, and `{workspace}` fill in
automatically at insert time; any other `{name}` becomes a placeholder the composer
selects so you can immediately type over it. Manage templates in **Settings → Prompt
templates** (add, edit, delete); a handful of useful starters are seeded on first run.
Templates are stored globally (in `data/prompt-templates.json`) and shared across
workspaces.

### Scheduled Automations and Digests

Lokyni can work for you on a schedule instead of only when asked. In **Settings →
Automations**, create a job for the active workspace that runs automatically:

- **Saved question** — runs a question on a schedule and delivers the grounded, cited
  answer (e.g. "every Monday, what changed in the project spec?").
- **Workspace digest** — runs a whole-workspace synthesis, and only notifies you when
  the workspace's documents have actually changed since the last run (so an unchanged
  corpus stays quiet).

Pick a schedule from the presets (daily, weekly, monthly, hourly) or enter any cron
expression. Results are delivered to the in-app **Inbox** (under the **⋯ More** menu in
the header, with an unread badge) — nothing leaves your machine. Optionally, results are also
emailed if you configure SMTP (see [Configuration](#configuration)); email is the one
outbound path and is purely additive. **Run now** tests a job immediately. A workspace can hold up to 50 automations, which keeps the settings file and the number of armed timers bounded.

A saved question also remembers the evidence it cited last time. For each source it keeps an identity and
a short content fingerprint, then compares the next run against that snapshot. A delivered result opens
with **Evidence since the last run**, which lists sources that are new, no longer cited, or changed, and
says whether the answer moved. A first run has nothing to compare, so it has no header. The snapshot holds
no document text, only identities and fingerprints, and is bounded to 50 sources.

Jobs run in the background while Lokyni is running, in the server's local timezone — so
this pairs naturally with running Lokyni [as a background service](#running-as-a-service-no-pm2).
The scheduler uses `node-cron`; if that dependency is missing, automations are disabled
with a startup notice and everything else works unchanged.

### Themes

The button in the top-right cycles through three themes: **dark**, **light**, and
**sepia** — a warm, low-glare palette suited to long reading sessions. The icon
shows which theme you'll switch to next. Your choice is remembered per browser, and
applies to the document viewer as well as the chat view.

### Text Size

For easier reading — especially helpful for accessibility — **Settings → Appearance →
Text size** scales the text you read (answers, your questions, and documents, including
the document viewer) from **Small** up to **Largest**. It changes instantly, is
remembered per device, and leaves the buttons and toolbars at their normal size so the
layout never breaks. Your browser's own zoom (Ctrl/Cmd and `+` / `-`) still works on top
of it if you want to enlarge everything, including the toolbars.

### Desktop App

Lokyni ships as a native desktop app for macOS, Windows, and Linux. It opens in its own
window with its own launcher icon and starts the local server for you, so there is nothing
to run in a terminal. The window is a thin wrapper around the same local app, so the interface
and features work as they do in a browser. On macOS, the bundled runtime requires macOS 13.5
or later. When you close the window while Lokyni is still indexing or answering, it asks before
quitting so that work isn't cut off.

**First launch on macOS.** The Mac app is ad-hoc signed for local use rather than through a paid
Apple Developer account, and macOS quarantines anything downloaded from the web. So the first time
you open it, you may see a warning that it "cannot be opened because the developer cannot be
verified," or that the app "is damaged and can't be opened." The app is not damaged. To open it,
try to open Lokyni once and dismiss the warning. Then go to **System Settings → Privacy & Security**,
scroll to the Security section, and choose **Open Anyway**. If you prefer the command line, run:

```
xattr -dr com.apple.quarantine /Applications/Lokyni.app
```

You do this once per install, and again after an update, because each download is quarantined the
same way. (Older versions of macOS let you right-click the app and choose **Open**; recent versions
removed that shortcut for apps signed this way, so use **Open Anyway**.)

**First launch on Windows.** The installers are unsigned, so Windows SmartScreen may warn that it
"protected your PC." Choose **More info**, then **Run anyway** to proceed. Linux packages
(`.deb` / `.rpm`) install normally.

Adding a web page by URL tries a plain HTTP fetch first, then renders with a browser engine only when the page needs it. This is the Auto default. **Web page capture** in Settings can force HTTP only, which needs no browser, or Browser only, which always renders. If no browser is installed, plain pages still import, and a page that requires rendering reports that it could not be captured. Live web search and deep research never need a browser engine because they read pages with a plain fetch.

You can also install Lokyni straight from a browser as a Progressive Web App, without the
native package. In a Chromium-based browser (Chrome or Edge), open Lokyni and use the install
icon in the address bar, or the browser menu's "Install" option. On an iPhone or iPad, open
Lokyni in Safari and choose "Add to Home Screen." The installed app opens in its own window
with its own launcher icon.

Either way, this changes nothing about how Lokyni works. It is still the same local app,
served by the local server. The interface and its fonts are served entirely by Lokyni
itself, with no external requests, so it looks and behaves the same on every machine.

To build the desktop app from source, run `npm run tauri:build`. The packaged app is written
under `src-tauri/target/release/bundle/` for your platform.

### In-App Guide

The **Guide** item under the header's **⋯ More** menu opens this documentation inside the app, rendered and
fully searchable, so setup and reference are always at hand without leaving Lokyni. Type in
the search box to highlight every match. Move between hits with the arrow buttons, or with
Enter and Shift-Enter. The ranked "Jump to" chips take you straight to the section that
covers a term the most, rather than its first passing mention. Press the `/` key anywhere to
open the guide with the search box focused. Heading anchors stay unique and script-aware, and
wide code blocks and tables are keyboard-focusable, so the Guide is navigable without a mouse.
The guide works the same in a browser, the installed web app, the desktop app, and Docker.

## Settings Panel

Nearly every setting in the panel is applied live, without a restart, from the gear icon. Provider, model, embeddings, temperature, token limits, the reranker and web-search toggles, and the conversational-intelligence toggles all hot-reload and take effect on your next question. Enabling the cross-encoder reranker adds a brief one-time warm-up on the first question while its model loads.

The panel's defaults and numeric bounds come from one shared schema used by the config reader, the settings API, and the form itself, so a saved value, a documented default, and an input limit cannot disagree.

Use the filter box at the top of the panel to narrow Settings. Typing reveals a matching setting inside a collapsed group and hides unrelated sections; Escape clears a typed filter without closing the panel. The **Health** section shows the latest integrity sweep with a plain-language finding and remedy for each item. It is read-only: opening it never starts a sweep.

A few settings need a restart to take effect:

- Turning Verbose logging on or off (under Advanced).
- The advanced, hand-edited `config.json` knobs that are not in the panel (for example `rerankerModel`, `port`, and `bindAddress`).

## API Information

Lokyni exposes a small HTTP API for managing documents and checking status. All endpoints are served from the same port as the web interface (default `7887`).

Most responses are compressed when the client supports it. An unknown API path returns a JSON `404` with `{ "error": "Not found" }`, so API clients can handle it the same way as any other error.

### Documents

- **`GET /api/documents`** — list all documents with their name, size, modification time, and whether they are currently indexed.
- **`POST /api/documents`** — upload one or more documents (multipart form field `files`, up to 50 at a time, 500 MB each by default — the limit follows the configured `maxFileBytes`). Accepted types: `.txt`, `.log`, `.md`, `.pdf`, `.docx`, `.pptx`, `.epub`, `.html`, `.htm`, `.csv`, `.tsv`, `.xlsx`, `.xlsm`, `.json`, and images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.tif`, `.tiff`) when OCR or image description is enabled.
- **`POST /api/documents/url`** — ingest a web page. Body `{ url }`. Lokyni tries a plain HTTP fetch first and renders with a headless browser only when the page needs it; the `urlCapture` setting can force either method. It extracts the article text, saves it as a document in the active workspace, and indexes it. An HTTP error response is rejected before extraction, so an error page is never indexed. A **YouTube video URL** is instead turned into a document from its captions (see [YouTube Transcripts](#youtube-transcripts)) — no headless browser involved. You can also paste a URL directly in the Documents panel.
- **`POST /api/documents/citations/export`** — format cited sources for a reference manager. Body `{ sources, format }`, where `format` is `bibtex` (default), `ris`, or `csl`. Returns the file text with the matching content type.
- **`POST /api/documents/citations/import`** — add references as documents. Body `{ text, format }` with RIS, BibTeX, or CSL-JSON (`format` may be `auto`). Each entry is written as a small text document in the active workspace and indexed. The entry count is capped, and an empty or unrecognized file is rejected with a clear message.
- **`DELETE /api/documents?path=<relativePath>`** — remove a document by its path relative to the documents directory.

These `/api/documents` routes are the in-app control plane (same-origin, session-authenticated), not the API-key `/api/v1` surface. A couple more exist for the UI and are not part of the public API: `POST /api/documents/attach` (a one-off in-memory extraction for a single file) and `GET /api/documents/related` (the "related documents" panel).

### Public API (v1)

For using Lokyni from scripts or other tools, the `/api/v1` endpoints require an API key (create one in Settings → API keys). Pass the key as `Authorization: Bearer <key>` or `x-api-key: <key>`. Each endpoint targets a workspace via an optional `workspace` param, independent of whichever workspace the web UI is showing; omitted, it defaults to `default`.

- **`POST /api/v1/search`** — `{ query, workspace?, k? }` → retrieval results (passages), no LLM. Requires the `search` scope.
- **`POST /api/v1/chat/completions`** — OpenAI-compatible grounded chat (requires the `search` scope). Point any OpenAI client at Lokyni and get answers drawn only from your documents. See [OpenAI-Compatible Endpoint](#openai-compatible-endpoint) below.
- **`POST /api/v1/summarize`** — `{ docId, workspace? }` → a summary of one document (one-shot JSON, or SSE stream). Requires the `summarize` scope.
- **`POST /api/v1/synthesize`** — `{ workspace?, focus? }` → an overview synthesized across *all* documents in a workspace: common themes, connections, and what the collection covers (one-shot JSON, or SSE stream). Requires the `summarize` scope. `focus` optionally steers the angle ("focus on methodology"). Slower than a single query — it summarizes each document, then synthesizes.
- **`GET /api/v1/workspaces`** — list workspaces.
- **`GET /api/v1/documents?workspace=<id>`** — list a workspace's documents. Paginated: optional `limit` (default 100, max 1000) and `offset`. The response includes `total` and `nextOffset` (null on the last page) so you can page through a large corpus.
- **`POST /api/v1/ingest-url`** — `{ url, title?, html?, text?, workspace? }` → add a web page (requires the `write` scope). If `html` or `text` is supplied (as the browser clipper does, reading the page's already-loaded DOM), that content is saved directly — which captures pages behind a login. Otherwise the server fetches the URL itself.

**Scopes.** Each key holds a subset of `search`, `summarize`, `read`, `write`. A key must hold `write` to add documents; read scopes never imply it. Set scopes when creating a key (Settings UI, or `POST /api/keys { name, scopes }`).

**Workspaces.** A key can be limited to specific workspaces, or left open to all. In the Settings UI, check the workspaces a key may reach under **Workspaces** when creating it — leave them all unchecked to allow every workspace (including ones added later). Over the API, pass `allowedWorkspaces: ["id", …]` to `POST /api/keys`; omit it (or send an empty list) for all-workspace access. Each key's reach is shown in the key list, so an all-access key is never a silent default.

**Rate limiting.** Each key has a requests-per-minute limit (default 120; `0` = unlimited; set per key). Responses carry `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`; over-limit requests get `429` with `Retry-After`.

A cold workspace (one never opened in the UI) may return `202 { status: 'warming' }` on its first API call while its index cache builds in the background — retry after a few seconds.

**A first call.** Create a key in Settings → API keys with the `search` scope, then ask for the passages that match a query:

```
curl http://127.0.0.1:7887/api/v1/search \
  -H "Authorization: Bearer <your-lokyni-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"query":"refund window","k":3}'
```

The reply is JSON — the matching passages, each tagged with the document it came from:

```json
{
  "query": "refund window",
  "workspace": "default",
  "passages": [
    {
      "source": "refund-policy.pdf",
      "docId": "refund-policy.pdf",
      "fileType": "pdf",
      "content": "Refunds are available within 30 days of purchase…"
    }
  ]
}
```

**Responses and status codes.** Every endpoint returns JSON. A successful body is keyed to the endpoint — `/search` returns `passages`, `/summarize` a `summary`, `/synthesize` a `synthesis`, and the list endpoints a `workspaces` or `documents` array. Any response other than the `202` warming reply above carries `{ "error": "<message>" }` when the status code is not `200`:

| Code | Meaning |
| --- | --- |
| `400` | A required field is missing or invalid — for example, an empty `query`. |
| `401` | The API key is missing or not recognized. |
| `403` | The key is valid but lacks the scope the endpoint needs. |
| `404` | The referenced document does not exist in that workspace. |
| `409` | The request cannot be served yet — for example, synthesizing a workspace that has no documents. |
| `429` | Either the key's per-minute rate limit was exceeded, or too many model-backed requests (search, summarize, synthesize, chat) are being processed at once; wait for the `Retry-After` header and retry. |
| `202` | The workspace is still warming; retry in a few seconds. |
| `413` | The request body is larger than the limit. |
| `500` | An unexpected server error. The message is a fixed, generic string — the specific cause is written to the server log, never returned to the caller. |
| `502` | A web page could not be fetched for `ingest-url` — the page was unreachable, timed out, or too many fetches are already in progress. |

#### Security audit log

Lokyni keeps a **tamper-evident audit trail** of security-relevant actions. It records:

- API keys created or revoked
- configuration changes (which setting, never the value, so a secret never reaches the log)
- index rebuilds and backup restores
- workspace changes (create, rename, delete)
- external ingests — URL ingests, connector syncs, and connectors added or removed
- failed authentications on the API and network MCP endpoints

This matters most once you expose Lokyni beyond localhost, where knowing what was accessed — and being able to trust that record — is the point.

Each entry is a link in a SHA-256 hash chain: editing, deleting, or reordering an entry breaks a link, which the [watchdog](#watchdog) detects and warns about. This is *detection*, not prevention — a hash chain makes tampering evident, not impossible. The trail lives in `data/audit.jsonl`, self-prunes to the newest 10,000 entries, and is written entirely off the answer path (best-effort, never-throw), so it can never slow or break a query.

View it in **Logs → Audit**, which also shows the chain-integrity verdict. It is on by default; set `"auditLog": false` in `config.json` (or turn off **Advanced → Security → Security audit log**) to disable it entirely — useful for a purely local single-user install that wants nothing written.

#### OpenAI-Compatible Endpoint

`POST /api/v1/chat/completions` speaks the OpenAI Chat Completions format. Any tool or library that already talks to OpenAI can point at Lokyni with just a base-URL change. Instead of raw model output, you get answers **grounded in your documents** — cited, and candid when nothing matches. It's the same grounded behavior as the web chat, exposed as a drop-in API.

It is deliberately **grounded-only**: every answer comes from the indexed documents, and a question with no match returns an honest "I don't have anything on that" rather than a guess. (If you want ungrounded model chat, point your client at your provider directly — e.g. Ollama's own `http://localhost:11434/v1`. You point at Lokyni to get the retrieval grounding.)

- **Auth & scope** — same API keys as the rest of `/api/v1`; the key needs the `search` scope.
- **Workspace** — add a top-level `"workspace"` field to target one; omitted, it uses `default`.
- **Streaming** — set `"stream": true` for Server-Sent Events (OpenAI `chat.completion.chunk` deltas, terminated by `[DONE]`); omit it for a single JSON response. The streamed answer goes through the same verification pass as the JSON response. That pass runs the grounding and safety checks the web chat applies: it strips exfiltration attempts, declines a system-prompt leak, cautions when an answer names a document that was not among the retrieved sources, and flags a figure the cited documents do not support. It can only run on the complete answer, so with streaming the verified answer arrives once generation finishes rather than token by token. If a client disconnects mid-request, the server stops generating.
- **`model` field** — accepted and echoed back for client compatibility, but it doesn't select behavior: the workspace's configured model answers.
- **Sources** — responses include a `lokyni_sources` array (the documents the answer used). The non-streaming JSON response also carries `lokyni_grounded` (false on a miss); the streaming path emits `lokyni_sources` as a trailing event. These are extra fields, and standard OpenAI clients ignore them.

Using the official OpenAI Python client:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:7887/api/v1",   # your Lokyni host + /api/v1
    api_key="<your-lokyni-api-key>",            # a key with the 'search' scope
)

resp = client.chat.completions.create(
    model="lokyni",                              # any string; echoed back
    messages=[{"role": "user", "content": "What does our refund policy say?"}],
)
print(resp.choices[0].message.content)
```

Or with plain `curl`:

```
curl http://localhost:7887/api/v1/chat/completions \
  -H "Authorization: Bearer <your-lokyni-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What does our refund policy say?"}]}'
```

Prior turns in `messages` are used as conversation context, so multi-turn callers get the same follow-up resolution the web UI has ("tell me more", "what about the second one?").

### Configuration Endpoints

- **`GET /api/config`** — return the current effective configuration (secrets such as the OpenAI key are never returned in plain text).
- **`POST /api/config`** — update configuration. Recognized keys are written to `config.json` and hot-reloaded where supported.
- **`GET /api/models`** — list the models available from a provider, so the Settings model fields can be dropdowns instead of a name you type. Serves both providers (Ollama's installed models and an OpenAI-compatible provider's model list) and accepts `?provider=`, plus `?host=` (Ollama) or `?base_url=` (OpenAI) to list a not-yet-saved endpoint. Pre-save listing works only for a local or LAN endpoint; a not-yet-saved public endpoint is ignored and the saved one is listed instead. The stored API key is attached only when the target matches the saved endpoint, so a caller-supplied host or base URL never receives it. Returns `{ available: false }` when the provider can't be reached, so the UI degrades to a plain text field.

### Document Viewer

- **`GET /document/view?path=<path>&start=<char>&end=<char>`** — render a document in the viewer, optionally highlighting and scrolling to a cited character range.
- **`GET /document/raw?path=<path>`** — serve the raw document file for download.

## MCP (Model Context Protocol)

Lokyni speaks [MCP](https://modelcontextprotocol.io) in both directions.

**As an MCP server** — MCP clients like Claude Desktop and Cursor can search and
summarize your Lokyni corpus as a tool, so an AI assistant can ground its answers in
your private documents without those documents ever leaving your machine. Run
`node lokyni.js --mcp` for a local (stdio) server, or use the authenticated network
endpoint at `POST /mcp`.

**As an MCP client (connectors)** — Lokyni can pull documents *in* from an MCP server
as an ingestion source. The **filesystem** connector points at a folder (Settings →
Connectors) and Lokyni keeps that folder's text files synced into a workspace, skipping
dependency and build directories automatically. A **GitHub** connector is also available
(see the MCP Reference below). Re-sync to refresh; Test to verify a connector works
before relying on it.

Full setup, the Claude Desktop config, transports, scopes, and how to add new connector
types are documented in the [MCP Reference](#mcp-reference) section below.

## Watchdog

Lokyni keeps an eye on its own health. A built-in watchdog runs a sweep of integrity checks when Lokyni starts, then re-runs the same sweep every few hours while it's running. This way a problem that only shows up later — a disk filling up, a schedule that quietly stops firing — is still caught.

The checks are **warn-only**. Each one surfaces a problem and tells you how to fix it. None of them ever block startup or interrupt a query. Every sweep is written to the [security audit log](#security-audit-log), so you have a durable record: a clean sweep logs a single `watchdog.ok`, and any problem is logged as its own entry you can review later.

A sweep checks that:

- The data directory is writable.
- Free disk space is not running low.
- Memory headroom is adequate, so the process is warned before it runs out and crashes.
- The event loop is responsive, so heavy background work isn't stalling the server.
- The values in `config.json` are within sane ranges.
- The search index is internally consistent (and if not, it points you to Rebuild).
- The keyword (BM25) half of hybrid search actually built, so search hasn't quietly degraded to dense-only.
- Each downloaded ranking model is complete on disk. A download interrupted partway is re-fetched automatically on next use; this check warns you when it is incomplete and cannot be re-fetched (offline, or the model host is blocked), so a weaker ranking is reported instead of discovered from vague results.
- The index actually holds your documents, so a corpus that exists on disk is never served as empty.
- The security audit log has not been tampered with.
- Every state-changing API route requires a permission scope.
- The API-key file is readable, so a broken one doesn't reject every key with no explanation.
- The server is not accidentally exposed to the network without protection.
- Every scheduled automation has a valid schedule, so none silently stops running.
- No workspace holds more automations than the per-workspace cap, so the settings file and the scheduler stay bounded.
- An interrupted embedding-bank re-embed is noted, so it can be resumed rather than silently left half moved.
- The background service still points at files that exist, so it will restart after a reboot.
- No leftover temporary files or browser profiles are piling up from an interrupted write or crash.
- The multi-user stores are healthy — the accounts file parses (a broken one keeps the app closed rather than silently reopening it), the sign-in secret is available, and no workspace access row points at a deleted user or workspace.
- In a multi-instance setup, this instance can actually use the shared data directory for its role (a replica can read it; the primary can also write it).

Each warning explains itself in plain language — what it means and how to fix it — so a code like `watchdog.disk_low` is never a dead end. New checks are added to the same registry, so the set grows as Lokyni does.

## Health Endpoint

- **`GET /api/health`** — a detailed health report useful for monitoring and troubleshooting. It returns:
  - **Index stats** — document count, chunk count, vector count, and the BM25 median score
  - **Lifecycle** — process uptime, when the index was last updated, and a summary of the last delta (files added / removed)
  - **Provider** — the active provider, model, and embeddings model, plus a live reachability probe (with a short timeout) confirming the provider is responding
  - **Disk** — free space on the volume holding your data directory (`freeBytes` / `freeMB`), so you can see headroom before an index rebuild or backup. The [watchdog](#watchdog) also warns when free space runs low, since indexing, OCR caches, and backups all fail or truncate on a full disk.
  - **Features** — which of the reranker, query rewrite, and conversation summary are enabled
  - **Pipeline versions** — `pipeline.answer` (retires cached answers when the answer pipeline changes) and `pipeline.indexFormat` (forces an index rebuild when the stored map shapes change)

- **Backup control plane** — `POST /api/backup` streams a workspace archive; `POST /api/backup/inspect` reads its header; `POST /api/backup/verify` runs a restore drill (decrypt, decompress, checksum every file, then discard); `POST /api/backup/restore` restores it. All are admin-only and same-origin.
- **`GET /api/watchdog`** — the latest completed integrity sweep, read-only, for the Settings health panel. Admin-only, because findings can name paths and configuration. It never starts a new sweep.
- **`GET /status`** — a lightweight readiness check returning whether the index is ready, whether an update is in progress, the document count, and a `busy` flag (true while indexing or answering). It also reports a resumable embedding-bank migration, if one is in progress or paused. The desktop app reads the `busy` flag to confirm before quitting, so long-running work isn't aborted.
- **`GET /api/logs`** — the tail of the service logs (`?lines=` up to 2000, default 200), returned per stream as `stdout` and `stderr`. Only the last 256 KB of each file is read, so this stays fast on a long-running service.

### Viewing Logs

The **Logs** item under the header's **⋯ More** menu opens a viewer showing recent output, errors, and
the security audit trail, with optional auto-refresh. A **Copy** button copies what is shown to the
clipboard, so you can paste it into a bug report without hunting for a file. A dated log trail is also
written to `~/.lokyni/logs/YYYY-MM-DD.log` and pruned after 30 days, so there is always an on-disk
record even when you run from a terminal. Indexing failures are pushed into the chat view as a
dismissible banner with a link straight to the logs, so a problem surfaces where you are already looking.

To capture detailed diagnostics for a bug report, turn on **Verbose logging** under **Settings →
Advanced → Diagnostics**, then restart Lokyni for it to take effect. This is the way to get full detail
in the desktop app, where the server runs in the background and cannot be given a command-line flag.
Reproduce the problem, open **Logs**, and use **Copy** to share the output. Leave verbose logging off
for normal use, since it makes the logs much larger. Verbose logs can include your query text and
document or file names, so review what you copy before sharing it.

## Reverse Proxy Setup

To expose Lokyni behind a domain name with HTTPS, place it behind a reverse proxy such as Caddy, Nginx, or Apache. Lokyni uses WebSockets (Socket.IO) for the chat stream on the path `/ws`, so make sure your proxy is configured to upgrade and forward WebSocket connections in addition to normal HTTP traffic.

Because Lokyni binds to loopback by default, it guards against DNS-rebinding attacks by only accepting requests whose `Host` header is a loopback address. A proxy that forwards your public host name unchanged would be turned away with a "403 Unrecognized Host" error. You have two ways to handle this. The simplest is to have the proxy rewrite the upstream host to `localhost`. A minimal Caddy example:

```
lokyni.example.com {
    reverse_proxy 127.0.0.1:7887 {
        header_up Host localhost:7887
    }
}
```

The other option is to keep the original host and tell Lokyni to trust it. Add a `trustedHosts` list to `config.json`:

```json
{
    "trustedHosts": ["lokyni.example.com"]
}
```

Caddy handles WebSocket upgrades automatically. For Nginx, ensure the `Upgrade` and `Connection` headers are passed through for the `/ws` path. If you rewrite the host in Nginx, use `proxy_set_header Host localhost:7887;`.

**NOTE:** If you run Lokyni behind a CDN or cache such as Cloudflare, you may need to clear caches after upgrading so the latest interface files are served.

## Upgrading

When upgrading to a new version of Lokyni, follow these steps:

1. Stop the running Lokyni process
   - If using **pm2**, type: `pm2 stop lokyni`
   - If using the built-in service, type: `node lokyni.js --restart` after upgrading (or `--uninstall` first if you prefer a clean stop)
2. Make a backup of the directory where your current Lokyni files are located, including your `config/` folder and the `data` directory
3. Extract the new Lokyni files into the existing directory, allowing new files to replace the originals
4. Restore your `config/config.json` if it was overwritten, and compare it against any new configuration options introduced in the release
5. Type: `npm install` to ensure all modules are installed properly
6. Start Lokyni and verify the new version is running
7. Watch the console (or run with `node lokyni.js debug`) for a few minutes to confirm indexing and retrieval are working as expected

**NOTE ON THE DEFAULT PORT:** Lokyni's default port is `7887`. If your `config.json` sets `"port"` explicitly, that value continues to be used — remove the line to adopt the default. Existing installs that relied on the old default will keep working, but update any bookmarks or reverse-proxy configuration if you change it.

Everything under `data/` is preserved across upgrades:

- your documents and the cached vector index
- saved conversations
- your **prompt templates** (`data/prompt-templates.json`)
- your **scheduled automations** (in each workspace's `workspace.json`) and the automation inbox

Your data lives outside the application files, so replacing those files never touches it. `--install` *moves* `data/` and `config/` into `~/.lokyni` and never overwrites them on a re-install, so your `config/config.json` (including any SMTP settings) is kept too. If the embeddings model changed, the index rebuilds automatically on first start.

## Frequently Asked Questions (FAQ)

#### Is my data private?
Yes. When you run Lokyni with a local Ollama model, your documents, your questions, and the model's answers all stay entirely on your own machine — nothing is sent to any third party. The only outbound calls are to your chosen LLM provider, and if that provider is local, there are none. Two exceptions, both opt-in or one-time: a one-time download of the reranker model from Hugging Face (after which it runs locally), and live web search, which only makes network calls when you explicitly invoke it (see below).

#### When does web search send data off my machine?
Only when you ask it to. Clicking the 🌐 toggle for a message, or accepting an offered web search, sends that query to DuckDuckGo and fetches the resulting pages. If you never use web search, or disable it with `useWebSearch: false`, Lokyni makes no web calls at all beyond your LLM provider. The auto-suggest feature only ever *offers* — it never searches without your confirmation.

#### Do I need an internet connection?
Only if you use a remote provider (such as OpenAI). With a local Ollama model and the reranker already cached, Lokyni runs completely offline.

#### What file types can I use?
Text and documents (`.txt`, `.log`, `.md`, `.pdf`, `.docx`, `.pptx`, `.epub`, `.html`, `.htm`), spreadsheets and data files (`.csv`, `.tsv`, `.xlsx`, `.xlsm`, `.json`), and images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.tif`, `.tiff`). Text is extracted from documents for indexing; scanned PDFs and images are read with OCR when it's enabled.

#### How large can my documents be?
Individual uploads can be up to 500 MB. Very large documents are handled with larger passage windows so answers still have enough context, though extremely large files take longer to index and search. Very long filenames are shortened to keep the stored path within Windows limits, and the extension is preserved.

#### What happens when the disk fills?
Lokyni warns at startup when less than 500 MB is free on the volume holding its data. If the volume is already full, or a later write runs out of space, it stops with a message that names the data directory instead of leaving a partial index. Free space on that volume, or move the data directory with `--data-dir`. In Docker, check `docker system df` and remove unused images or containers. Do not delete the state volume without a backup; it holds your configuration, index, and saved conversations.

#### Does it work with non-English documents and questions?
Yes. The default embedding model (`bge-m3`) is multilingual, so retrieval works across languages out of the box, and the text indexing handles non-Latin scripts (Chinese, Japanese, Korean, Cyrillic, Arabic, and more) and accented filenames. You can ask in the language your documents are written in, or in a different one. When your question is in another language, Lokyni answers in the language of your question. It translates the explanation while keeping names, numbers, dates, and direct quotations from the documents exactly as written. So you can read an English corpus in Spanish, or a Japanese one in English, as far as your chat model's own language ability allows. When the documents don't answer a question asked in another language, Lokyni recognizes that "no answer" by meaning, not just by English wording, so it still offers to search the web the same way it would in English. Scanned pages use English plus any additional OCR languages you select (or the Vision method for a language not in the list); read-aloud uses the bundled English voice for English and your system's voices for other languages, including languages that share a writing system.

#### Why did Lokyni say it doesn't have that information?
Lokyni only answers from your indexed documents. If a question has no meaningful match in the corpus, it declines rather than inventing an answer. If the query is a loose match, it will instead offer what the closest document does cover and note the gap. If you believe the information *is* in your documents, confirm the document indexed successfully (check the document list or `GET /api/health`) and try rephrasing with more specific terms.

#### Why are my answers short or degenerate?
This usually means the model's context window (`numCtx`) is too small to hold the retrieved passages plus the grounding rules, causing the system prompt to be truncated. Leave `numCtx` on automatic (the default `0`) so Lokyni sizes it to the model, or set a larger explicit value if your model and hardware support it. Reducing `passageSize` also helps.

#### Do I have to rebuild the index when I add documents?
No. Lokyni watches the documents folder and indexes new, changed, or removed files automatically, applying the update atomically without interrupting queries.

#### When do I need to rebuild the whole index?
Almost never. Adding, editing, or removing documents never needs a full rebuild. Changing the embeddings model, provider, or endpoint does not force one either, because embedding banks are on by default: your existing documents stay searchable through the provider that embedded them while new ones use the new identity. A full rebuild is only forced if you turn `useEmbeddingBanks` off and then change the embedding identity, which invalidates the single shared index. You can also rebuild on purpose any time from Settings. When you switch to a different model, Lokyni measures whether a learned adapter can bridge the two spaces and, when it can, keeps the old bank searchable without re-embedding; only when it cannot does the corpus need a re-embed, which runs automatically in the background on a local embedder or on demand through **Consolidate embedding banks** otherwise.

#### The cross-encoder reranker failed to load — is that a problem?
No. If the reranker model can't be downloaded or loaded (for example, on an offline machine that has never cached it), Lokyni logs a warning and continues using the base hybrid ranking. Answers still work; they just don't get the extra reranking precision. Once the machine can reach Hugging Face once, the model is cached and used automatically thereafter.

#### Web search, the model download, or URL ingestion fails with a network error, but my connection is fine.
On some machines Node tries a host's IPv6 address first, and if IPv6 routing is broken or flaky that surfaces as a "fetch failed" error even though IPv4 works. Lokyni prefers IPv4 by default to avoid this, while still falling back to IPv6 on IPv6-only hosts. If you need a different order, start it with `--dns-order verbatim` (Node's default) or `--dns-order ipv6first`.

#### The intent classifier adds latency on my local model. Can I speed it up?
Yes. The classifier adds one LLM round-trip per turn. You can point it at a smaller, faster model with `intentModel`, reduce `intentMaxTokens`, or disable it entirely with `useIntentClassifier: false` — in which case Lokyni falls back to its built-in heuristics for understanding follow-ups and topic changes.

#### Can I use a model other than the defaults?
Yes. Set `model` and `embeddingsModel` to any model your provider supports. For Ollama, pull the model first (`ollama pull <name>`). Changing the chat model never touches your index. Changing the embeddings model, provider, or endpoint does not re-embed your existing documents either: by default `useEmbeddingBanks` keeps a separate vector index per embedding identity, so your old documents stay searchable through the provider that embedded them while new and changed ones use the new one. Keep that old endpoint reachable; if it is gone, **Consolidate embedding banks** re-embeds the corpus. (Set `useEmbeddingBanks` to `false` if you would rather each embedding change trigger a one-time full rebuild.)

#### Can I chat with Claude (Anthropic) or a hosted model while keeping my documents private to embed?
Yes. The chat provider and the embedding provider are independent. Set `provider` to `anthropic` (or `openai`) for chat, and `embeddingsProvider` to `ollama` so your documents are embedded locally and privately — only your questions and the retrieved passages go to the hosted chat model, never your whole corpus. Anthropic has no embeddings endpoint, so Claude chat must pair with Ollama or OpenAI embeddings. Because the embedding provider is separate, you can switch chat providers whenever you like and your documents are never re-embedded. Once a corpus exists, Settings records the embedding identity whenever it saves, so a chat-provider change cannot silently move it; pinning embeddings to a portable open model on local Ollama (such as `bge-m3`) makes that switch free. Keep that embedding endpoint reachable for the old bank.

#### Will my conversation survive a page refresh?
Yes. Conversations are persisted per browser and restored automatically when you reconnect. Click **New** to start fresh; old sessions are pruned automatically after 30 days.

#### How do I see exactly where an answer came from?
Every answer shows one numbered **Sources (N)** row below it. Hover or focus any citation to preview the source — its title, where in the document the passage sits, how strongly it matched, and a snippet of the exact cited text. Click a citation to open the built-in viewer, which jumps to and highlights that passage, so you can verify it against the original. The answer's controls stay in one predictable strip beneath the sources; **⋯ More** is a standard keyboard menu (arrow keys move, Escape closes).

## Retrieval Pipeline Reference

This section maps every decision point in Lokyni's retrieval path — what each layer decides, the threshold it uses and why, and how the layers interact. It's reference material for understanding *why* Lokyni retrieved (or declined to retrieve) something. Most users won't need it, but it's the section to read before changing anything in `lib/retrieval/`.

It exists because the pipeline has accumulated roughly a dozen interacting
heuristics, each individually justified by a real failure. The interactions are
where bugs live — several past bugs were caused by a fix at one layer being
defeated by a different code path, not by any single layer being wrong.

Everything here is in `lib/retrieval/search.js` unless noted.

---

### Quick reference: threshold table

| # | Layer | Threshold | Configurable | Effect when it fires |
|---|---|---|---|---|
| 0 | Intent classifier | — | `useIntentClassifier` | Sets intent, target docs, resolved query |
| 0a | Intent grounding guard (`intent.js`) | any content term must survive | no | Rejects whole classification → heuristic fallback |
| 0b | Continuation grounding guard | any resolved term must appear in conversation doc | no | Rejects continuation → treated as new topic |
| 3 | Relevance gate (cosine) | `minCosineScore` 0.35 | yes | Out of scope (web-fallback eligible) |
| 4 | BM25 candidate filter | ≥ 40% of top BM25 | no | Drops weak candidates from the BM25 set |
| 4b | BM25 median gate — hard | < 50% of corpus median | no | Out of scope (web-fallback eligible) ¹ |
| 4b | BM25 median gate — soft | 50–100% of median | `usePartialMatchTier` | Partial match (candid about gaps) ¹ |
| 5a | RRF fusion | FAISS 0.3 / BM25 0.7, K=60 | `rrfFaissWeight` / `rrfBm25Weight` / `rrfK` | Fuses the vector and keyword rankings |
| 5a-(-1) | Outcome down-weight | penalty map from `options.downweight` | Learn toggle | Lowers score of docs that led to 👎 on similar past queries (reorders only, never drops) |
| 5a-0ᵛ | Intent target validation | must appear in candidates **or** share a query term | no | Drops hallucinated target docs before promotion |
| 5a-0 | Intent target promotion | +0.05 above top | no | Named (validated) target doc ranked first |
| 5a-i | Continuation injection | min score | no | Conversation doc forced into ranking |
| 5b | BM25-dominant rerank | top BM25 > 2× second | no | BM25 winner promoted to RRF top |
| 6 | Topic shift — BM25 disagrees | ≥ 2× median **and** > 1.3× allowed | no | Context reset, winner promoted |
| 6 | Topic shift — raw query | ≥ 2× median | no | Context reset, winner promoted |
| 7 | Allowed-doc boost | +0.05 | no | Conversation docs ranked higher |
| 8 | Reranker | cross-encoder score order | `useReranker` | Reorders documents and picks the best chunk per document |
| 8 | No BM25 overlap | any overlap required (unless reranker > 0) | no | Drops doc (not first-doc protected) ¹ ² |
| 8 | Named-entity whole-word | all named tokens absent | no | Drops doc (rescue if it empties everything) |
| 8 | RRF filter | 80% of top (60% post-shift, 35% compare) | no | Drops doc (first-doc protected) |
| 8 | Zero BM25 score | score = 0 (unless reranker > 0) | no | Drops doc (first-doc protected) ¹ ² |
| 8 | Relative BM25 | < 50% of top doc's BM25 | no | Drops doc (first-doc protected) |
| 8 | Keyword density gate | < 5 hits (2 for compare/large) | no | Drops doc (first-doc protected) |
| — | Web offer gate (`socket.js`) | top rerank (over **used** docs) ≤ 0, **or** a live/current-info query | `webOfferMaxRerankerScore` | Offers web search instead of failing |

¹ **Skipped when BM25 can't build.** wink-bm25 refuses to consolidate a 1–2
document collection, returning a null engine that scores every query 0. All four
BM25-dependent gates (median gate, no-overlap filter, zero-score, and the co-source
hard rule) are guarded by `!liveBM25.empty && liveBM25.engine` and simply do not run
in that state — a false 0 is not evidence of irrelevance. Retrieval falls back to
vector search + reranker, and the cosine gate (row 3) still applies, so an off-topic
query is still caught. This is what makes a freshly-ingested single-document
workspace answerable. It self-corrects to full hybrid the moment a workspace has 2+
documents. (This is a correctness fix, *not* the small-corpus gate relaxation that
was tried and reverted.)

² **Strong-semantic exemption.** The two zero-keyword-overlap gates (no-overlap and
zero-score) are skipped for a document the cross-encoder reranker scored **positive**
(a genuine match). A paraphrase or synonym answer — the corpus says "automobile", the
question asks "car" — can have zero BM25 overlap yet be exactly right; without this
exemption those pure-semantic matches were unreachable. The reranker's per-document
best score (`rerankByParent`) is the signal. Empty on retries (the reranker is
skipped there), so retry behavior is unchanged.

---

### Layer 0 — Intent classification

One LLM pass reads the recent thread and returns
`{ intent, targetDocs[], resolvedQuery, ambiguous, clarify }`, where intent is one
of `continue | new_topic | compare | reference | meta`.

When a classification exists it is authoritative — the heuristic topic-shift
block (layer 6) is skipped entirely. On any failure (timeout, unparseable JSON,
failed validation) it returns `null` and the full heuristic path runs instead.
This fail-safe design is why the classifier can be enabled by default.

#### 0a — Intent grounding guard (`intent.js`)

**Problem it solves:** the classifier sometimes resolves a query onto the *previous*
topic, discarding the actual subject. Observed: a question naming a new person
returned `continue` with a resolved query about the prior conversation.

**Rule:** extract distinctive content terms from the raw user message (all tokens
minus `GROUNDING_STOP`). If at least one exists and **none** survive into
`resolvedQuery` or the named `targetDocs`, reject the entire classification.

**Why terms and not capitalization:** an earlier version only checked capitalized
proper nouns, which missed lowercase subjects like product names and acronyms.

**Why it can't misfire on continuations:** pure follow-ups ("tell me more", "go on",
"what else") consist entirely of stop words, so the term list is empty and the
guard doesn't run.

#### 0b — Continuation grounding guard (`search.js`, `intentSaysContinue` / trace step `continuation-rejected`)

**Problem it solves:** the classifier labels a question about a genuinely different
document as `reference` or `continue`. Staying on the conversation document then
pins the wrong source and filters out the correctly-retrieved one.

**Rule:** for `continue`/`reference` only, take the resolved query's specific
keywords (minus `REQUEST_WORDS`). If none appear in any allowed document's filename
or first 20 000 characters, the verdict is not grounded:

1. `intentSaysContinue` → false (no continuation injection at 5a-i, no allowed-doc
   boost at layer 7)
2. Stale conversation-document targets are dropped from `intentTargetIds`
3. `queryIsSpecific` → true
4. **The intent-driven topic shift fires** (layer 6), resetting context

Step 4 is essential. Without it, a rejected continuation matches neither the
intent-shift path (which requires `new_topic`) nor the heuristic path (which requires
no intent at all), so `allowedDocIds` is never cleared and the stale document keeps
its +0.05 boost at layer 7. The correctly-retrieved document then fails the 80% RRF
filter against that artificially-boosted stale one.

#### 0c — Ungrounded positional reference → clarify (`search.js`, `useClarifyingQuestions`)

**Problem it solves:** a bare positional reference with no subject of its own — "what
about the second one?", "the first", "how about that one?" — that guard 0b could not
tie to any conversation document. Searching for the literal words finds nothing, and
the pipeline would then offer a nonsensical web search for "the second one".

**Rule:** when guard 0b rejects a `continue`/`reference` verdict (`intentSaysContinue`
became false) **and** the raw message matches `POSITIONAL_REFERENCE_RE` (an ordinal /
demonstrative with no concrete subject), return a single clarifying question instead
of resetting and searching. Gated on `useClarifyingQuestions`.

---

### Layers 3–4b — Scope gates

Several independent gates decide whether the corpus can answer at all. All of them
return `canWebFallback: true` so `socket.js` may offer a web search.

- **Unknown named subject (before the statistical gates)** — a question whose name-like
  terms are all absent from the corpus is declined, whether it is the first turn or a new
  subject raised mid-conversation. This stops ordinary domain words from making an absent
  subject look answerable. Pronoun-only follow-ups contain no name-like term and are
  untouched. Quoted names and letter-plus-digit identifiers work in any script; cased
  scripts also use capitalization. A question that mixes a known name with an unknown one
  is left to the model, so the known part can still be answered. Short all-caps acronyms
  are left to semantic retrieval, because they often expand to a phrase the corpus does use.
- **Relevance gate (3)** — cosine similarity below `minCosineScore`. Bypassed when
  an active conversation document exists, since vague follow-ups legitimately score
  low.
- **Near-miss recall second-chance** — if the relevance gate fails but a passage
  scored just below the bar (a terminology mismatch, where your documents discuss the
  topic with a different word than the question — for example a corpus that says
  "giants" for a question about "nephilim"), Lokyni re-expresses the question as a
  likely answer and retrieves once more before giving up. It re-checks the *same* gate
  at the *same* threshold, so this can only improve recall — it never lowers the bar or
  forces a weak answer through. A genuinely out-of-corpus question has no passage near
  the bar, so it skips this and goes straight to the web offer. It adds one model call,
  only on a near-miss, and only when always-on HyDE is off (that already covers it).
- **BM25 median — hard (4b)** — top BM25 below 50% of the corpus median means
  nothing meaningfully matches.
- **BM25 median — soft (4b)** — between 50% and 100% of median is a *partial*
  match: serve the closest document with `isPartial`, which instructs the model to
  share what's genuinely relevant and be candid about what isn't.

**Known limitation:** BM25 can be deceptively high for off-topic documents that
share a common token (a place name, a generic noun). A weather question scored 2.4×
the median against unrelated local-services PDFs purely on the city name. This is
why the *reranker* score, not BM25, gates the web-search offer — the cross-encoder
correctly scored those documents strongly negative.

**Two refinements to the web-offer gate** (`socket.js`):

- **Scored over used documents only.** The reranker score that gates the offer is the
  best score among the documents actually *served*, not the max over every candidate
  chunk. An off-topic candidate's stray positive chunk (a document later dropped by
  the gates) used to masquerade as "a genuine match exists" and wrongly suppress the
  offer.
- **Live-info bypass.** A question that is inherently time-sensitive — today's price,
  the current weather, the latest release — cannot be answered by *any* static
  document, even one that reranks positively because it shares the topic. A strong
  current-info signal (`looksCurrentInfo`) therefore bypasses the reranker gate, so
  "what is the current price of Bitcoin today?" offers a web search instead of burning
  the full retry budget against a trading PDF and then flatly refusing.

---

### Layers 5–7 — Ranking

RRF fuses the FAISS and BM25 rankings. Default weights are FAISS `0.3` / BM25 `0.7`, with rank constant `60`. All three are configurable (`rrfFaissWeight`, `rrfBm25Weight`, `rrfK`) — raise the FAISS weight for a corpus whose vocabulary favors semantic over keyword matching, or lower it for the reverse.

**Graph bridge (recall, before ranking).** When a question names two or more entities the corpus knows, an extra query is added for the entities that connect them, and its results are fused into the candidate set. The entity graph (`useEntityGraph`) supplies this from name co-occurrence, and the knowledge graph (`useGraphRag`), when built, supplies it from the relationships the model extracted. The documents carrying those connections are exempt from the co-source keyword gates below, so the document that actually links the two entities is not dropped for failing to repeat the question's words. It is recall only — the model still answers from real, cited passages. Both are off by default.

Several adjustments then apply, in order:

0. **Outcome down-weight (5a-(-1))** — when the Learn toggle is on and enough 👎
   ratings exist, documents that led to bad answers on *similar past queries* get a
   small score penalty (proportional to accumulated 👎 evidence, capped at ~15% of
   the top score). It only reorders candidates — it never removes a document — so a
   wrongly-penalized doc still surfaces if nothing better exists. The penalty is also
   carried into the cross-encoder reorder (step 8), scaled to the score spread and
   under the same cap, so a strong 👎 signal sinks a document among the reranked slots
   rather than being overwritten by the reranker order — while a strong match with a
   light penalty still wins. The penalty map is
   computed in `socket.js` (which holds the rating signal) and passed into
   `searchDocuments` via `options.downweight`; search.js just applies what it's
   given. Off / cold / lightly-rated corpus → no map, no effect.
1. **Intent target validation + promotion (5a-0)** — a classifier-named document is
   set to `top + 0.05`, ranking it first. First, named targets are validated: a
   local classifier sometimes names documents unrelated to the resolved query (e.g.
   naming two screenshot images as the target for "install the software"). A target is kept
   only if it appears in the fused candidate ranking **or** its filename shares a
   distinctive term with the resolved query; unsupported targets are dropped so a
   hallucinated one can't bury the genuinely relevant document.
2. **Continuation injection (5a-i)** — for continuations, allowed documents are
   appended to the ranking if absent. "Tell me more" matches nothing semantically
   but must still serve the active document.
3. **BM25-dominant rerank (5b)** — when the top BM25 score is more than twice the
   second, that document is promoted. Strong exact-term evidence should beat
   semantic similarity.
4. **Topic shift (6)** — see below.
5. **Allowed-doc boost (7)** — `+0.05` for conversation documents, **only when no
   topic shift occurred this query**. This conditional is what makes shift detection
   consequential; without it the stale document keeps winning.

**Follow-up document set (`allowedDocIds` after assembly).** On a **continuation**,
the documents served this turn are *unioned* with the prior `allowedDocIds` (served
first, bounded to 4) rather than replacing them. A vague continuation often serves
just one document; overwriting with only that one permanently drops a co-source cited
on an earlier turn — so a later specific follow-up ("who created it?") could no longer
reach the document that named the creator and would contradict the earlier answer.
The bound stops a long thread from accreting an unbounded pinned set.

**Recognizing a vague continuation (`isVagueContinuation`, single source).** Whether a
follow-up is a *vague continuation* — one that carries no new subject of its own, so it
must stay on the thread — is decided in one place and reused by every follow-up path
(intent fast-path, query expansion, query rewrite, retry budget, web continuation), so
those decisions can never drift apart. Two complementary signals, so new phrasings never
need a one-off patch:

1. A fast phrase table for the common explicit continuations ("tell me more", "go on",
   "what else", "summarize that", "go deeper"), which needs no index.
2. A **language-agnostic** structural test for everything else: a query whose tokens are
   all function / meta words carries no corpus-distinctive term, and
   `extractSpecificKeywords` (which strips a single-sourced `GENERIC_WORDS` set, then keeps
   only IDF-distinctive tokens) returns nothing. "What else does it talk about?",
   "¿de qué más habla?", and "もっと教えて" all reduce to zero specific terms. A pivot to a
   real subject — present in the corpus or not — keeps that subject's distinctive term and
   is **not** vague. `GENERIC_WORDS` also lists the common continuation vocabulary ("more",
   "else", "tell me", "explain") across the major languages Lokyni is used in, so a
   continuation imperative that never appears in the documents is still recognized rather
   than mistaken for a new subject.

Every fixed word list a retrieval decision depends on — the generic-word set above, the
topic-shift and co-source stop lists, the proper-noun and grounding guards, the entity and
similarity lists — lives as **data** in one shared file (`lib/ai/data/lexicon.json`), loaded
once by `lib/retrieval/lexicon.js`. Each list is a separate decision kept under its own named
key, co-located rather than merged. A list is therefore defined in exactly one place and read
everywhere by name, with no inline copies to drift apart, and adding a word or a new language
is a data edit with no code change. A missing or malformed file degrades to empty lists with a
loud warning rather than failing to start, and the test suite guards the file's presence and
shape. The language detector's per-language function words and its list of detectable
languages are externalized the same way, in `lib/ai/data/languages.json`, so adding a
language is a data edit there too. (Regexes, file-type and protocol constants, and other code
logic stay in code — only fixed word and language *data* is externalized.)

**Continuation ordering (`orderContinuationDocs`).** When the allowed documents are
promoted to the front for a continuation, a *vague* one ("tell me more") orders them by
**conversation primacy** — `allowedDocIds[0]` is the primary source of the last answer —
not by this query's fused score. A vague query has no topical signal. Ranking by score would then promote whichever cited
co-source has the higher *base* relevance (a longer, denser file) over the document the
thread is actually about. Each "tell me more" would drift further onto it — until the
model, served a passage that no longer contains the subject, disowns its own earlier answer. A *specific* follow-up keeps fused-score order, since its
keywords legitimately indicate which allowed document it targets.

Ordering alone is not enough, because a co-source is still *served* (just second), and a
long one read forward can drift off the subject. So on a vague "tell me more" with more
than one document in play, a co-source whose next passage shares none of the **thread's**
specific vocabulary is skipped — the thread stays on its primary document. Because a vague
query has no specific terms of its own, the gate judges against the established topic of
the recent turns (the conversation's own distinctive terms), which is exactly what the
user is continuing — so it stays effective for "tell me more" and "what else does it talk
about" alike. This never touches the primary document or a single-document conversation,
and it only applies when the follow-up actually advances blindly, never to a passage
matched by its own keywords.

**Regression guard.** Two offline, deterministic, model-free test harnesses lock this in
so fixes never regress into the one-phrasing-at-a-time cycle: `followup-matrix.test.js`
crosses many synthetic threads against a taxonomy of follow-up shapes (continuation,
pivot, facet) in several languages and asserts the classifier labels every one correctly,
and `followup-drift.test.js` runs multi-turn conversations through the real retrieval
orchestration and asserts a continuation never drifts onto a co-source's unrelated pages
or a different-subject document, while a pivot still moves to the new subject.

#### Topic shift (layer 6)

Two mutually exclusive paths:

**Intent-driven** — fires on `new_topic`, or on a continuation rejected by guard 0b.
Performs a full conversation reset (shared `clearConversationState` in
`lib/conversation.js`): `allowedDocIds`, history, read positions, the rolling
conversation summary, the consulted-docs list, and all passage-tracking maps. Using
one shared reset for both a topic shift and "New" fixed a bug where a shift cleared
only history/docs, leaving the *previous* topic's summary injected into the new
topic's answer for several turns. Promotes the target if named.

**Heuristic** (only when there is no intent classification) — fires on any of:
- The top RRF documents contain no allowed document
- BM25 strongly disagrees: top non-allowed ≥ 2× median **and** > 1.3× the best
  allowed score

- Raw (unexpanded) query BM25 ≥ 2× median — expansion can inject prior-topic terms
  that mask a real shift, so the unmodified query is checked separately

The winner is promoted by swapping scores with the current top rather than
adding a fixed boost. A large additive boost compresses the natural score ratios and
causes genuinely relevant co-sources to fail the RRF percentage filter downstream.

---

### Layer 8 — Document assembly gates

Candidates are walked in ranked order; each gate can drop a document. Order matters:
cheap checks run first, and the expensive keyword-density scan runs last.

**Critical distinction — first-document protection.** Gates guarded by
`if (mergedDocs.length > 0)` only apply to the *second and later* documents, so they
can never empty the result. Two gates are not so guarded:

- **No BM25 overlap** — intentional. A document with zero keyword overlap should not
  lead a result. *Exception:* when BM25 couldn't build (1–2 doc corpus, null engine),
  this gate is skipped entirely — every doc has "zero overlap" then only because BM25
  isn't running, not because it's irrelevant. See footnote ¹ in the threshold table.
- **Named-entity whole-word** — riskier. It fires whenever the query contains a
  proper noun and drops any document not containing it verbatim. A misspelling, an
  alias, or a name appearing only in a scanned image would drop *everything*.
  **Mitigation:** the best document rejected solely by this gate is retained as
  `namedGateRescue`. If the gate empties the result set, that document is served
  flagged `isPartial`, so the model is candid rather than returning a dead end.

Whole-word matching (`\bname\b`) is used deliberately so a short name doesn't match
inside a longer unrelated word.

**Allowed documents bypass** the BM25-overlap, named-entity, and RRF filters — they
are the active conversation document and must be served regardless of how a vague
follow-up ranks.

---

### Interaction hazards

Patterns that have caused real bugs. Check these when changing any layer:

1. **A flag flipped at one layer must be honored at every layer that reads it.**
   Guard 0b sets `intentSaysContinue = false`, but three separate places consume
   continuation state (injection 5a-i, shift 6, boost 7). Missing one leaves the
   stale document winning.

2. **`intent` being truthy is not the same as the intent being *used*.** The
   heuristic block is gated on `!intent`. Any path that neutralizes a classification
   without clearing `intent` must supply its own equivalent handling.

3. **Promotion and filtering are coupled.** Boosting a document to `top + 0.05`
   raises `topRrfScore`, which raises the 80% filter bar for everything else. A
   promotion intended to help one document can silently eliminate another.

4. **BM25 magnitude is not relevance.** Shared common tokens inflate BM25 for
   off-topic documents. Prefer the reranker score for relevance judgments.

5. **Vague continuations must never trip subject-based guards.** Any new guard keyed
   on "distinctive terms" must verify that request-word-only queries produce an
   empty term list.

---

### Turn handling (`socket.js`)

The socket message handler wraps the retrieval call with the retry loop, the
web-offer decision, and how a turn is recorded. Behaviors worth knowing:

- **Cold-start vague continuation.** A vague continuation ("tell me more", "go on")
  with nothing to continue — a fresh conversation, no selected docs, no attachment —
  returns a short "ask a question first" prompt instead of running a keyword search
  where the words "tell"/"more" match an arbitrary document.
- **Failed-response detection.** A response is treated as a failure (and retried, or
  routed to a web offer) only when it is degenerate or *essentially just* a "no
  information" refusal — a short response, or one that opens with the refusal. A long,
  substantive answer that merely contains a clause like "…not mentioned in the
  documents" is no longer discarded and retried. Genuinely short factual answers (a
  number, a currency amount, "Q3") are not treated as degenerate.
- **Out-of-scope turns are not recorded.** An out-of-scope refusal is streamed but not
  pushed into history, so it doesn't pollute the rolling summary or a later "recap".
- **Ending-intent retry cap.** "How did it end?" / "the final outcome" caps retries to
  one — but only when it's a genuine follow-up. On a first query, a substantive
  question that merely contains "final"/"outcome"/"result" gets the normal retry budget.
- **Resolved-query cache.** The rewritten/resolved retrieval query is computed once on
  attempt 1 and reused across retries (intent classification is already skipped on
  retries); re-running the rewrite each attempt only re-paid latency for the same
  temperature-0 output.
- **Pending web offer is superseded.** A new normal message clears any unanswered
  "search the web?" offer, so a later stray accept can't run a stale query.

---

### Debug trace reference

With `node lokyni.js debug`, these lines mark each decision:

| Line | Layer | Meaning |
|---|---|---|
| `🧭 Intent:` | 0 | Classification, targets, resolved query |
| `🧭 Intent: rejected — raw content term(s)` | 0a | Guard rejected classification |
| `🧭 Continuation rejected` | 0b | Ungrounded continuation → new topic |
| `🧭 Dropped stale conversation target doc(s)` | 0b | Hallucinated targets removed |
| `❓ Ungrounded positional reference` | 0c | Asked for clarification instead of searching |
| `🚫 Query rejected` | 3 / 4b | Out of scope |
| `🚫 Out-of-scope — …without recording it` | socket | Refusal streamed but not persisted |
| `≈ Partial match` | 4b | Soft-band partial answer |
| `🎯 Dropped … unsupported intent target(s)` | 5a-0ᵛ | Hallucinated targets validated out |
| `🎯 Intent target docs promoted` | 5a-0 | Classifier steering |
| `📌 Injected conversation doc` | 5a-i | Continuation injection |
| `🔀 Topic shift detected` / `🔀 Intent=…` | 6 | Full context reset |
| `🔝 Post-shift rerank` | 6 | Winner promoted |
| `📉 Outcome down-weight applied to` | 5a-(-1) | Docs penalized from 👎 on similar past queries |
| `🔀 Reranker scores` | 8 | Cross-encoder ordering |
| `⏭️ Filtered/Excluded …` | 8 | Which gate dropped a document |
| `📖 Named-entity gate eliminated all candidates` | 8 | Rescue fired |
| `🤔 Vague continuation with no context` | socket | Asked what to expand on (cold start) |
| `🌐 …weak match (rerank=…)` / `🌐 …live-info query` | socket | Web offer (reranker-gated, or bypassed for a current-info query) |

**Reading a trace:** work top-down. The intent line tells you which branch ran; the
ranking block shows the score order the gates then act on; the `⏭️` lines name the
exact gate that dropped each document. When the wrong document is served, the usual
cause is a promotion inflating `topRrfScore` (hazard 3) or stale conversation state
that should have been reset (hazards 1–2).

### Retrieval quality eval

Because "it tells you when it doesn't know" is the behavior that matters most, there's
a small eval harness that measures it, at `lib/test/eval/`. Run it with:

```
npm run eval
```

It builds a fresh index over a labeled fixture corpus (`lib/test/eval/fixtures/`) in an
isolated temp directory — never touching your `./data` — and runs each case in
`lib/test/eval/cases.json` through the **same** grounded pipeline the public API uses
(`runGroundedChat`). It then prints a scorecard.

The top line is honesty, because a confident fabrication is the one failure a
document assistant must never make. An answer fails hard — and the harness exits
non-zero — if it does either of these:

- **Cites a source that isn't in the corpus.** Every source an answer names is checked
  against the actual indexed documents; a citation to a document that was never indexed
  is a phantom.
- **Leaks a fact it was supposed to refuse.** Cases can carry a `forbid` list — the
  real-world answer to an out-of-corpus question ("Paris", "Argentina"), or the payload
  of a prompt-injection trap. If a declined answer contains a forbidden term, the model
  didn't really refuse.

Wrongly refusing a question the documents *do* answer is also a hard failure. Everything
else — a grounded answer that misses an expected fact, or cites the wrong document — is a
soft warning that lowers the grounded score but doesn't fail the run, gated by a tunable
minimum (default `0.6`, override with `--min-grounded=0.8`).

A case declares what it expects: `answer` (with `expectDoc` and `mustInclude`), `refuse`
(out-of-corpus general knowledge, optionally with `forbid`), or `nodata` (a plausible but
invented document name that must not be "summarized" into existence). Multi-turn
`conversations` run through shared conversation state to guard follow-up behavior,
including that a refusal on one turn doesn't fabricate on the next (`nofab`). One fixture
carries an embedded "ignore all previous instructions" block with a `forbid` payload, so
the run also proves the assistant treats document text as data, not as commands.

To point the same honesty checks at your **own** workspace instead of the fixtures, add
`--corpus`:

```
node lib/test/eval/run.js --corpus
```

This runs read-only against your real `./data` corpus (it never writes or rebuilds) and
applies the corpus-independent invariants — invented document names are declined, and
out-of-corpus questions are refused without leaking the answer — so you can confirm the
guarantee holds on your actual documents.

Two companion evals measure the other halves of quality. The recall benchmark grades
ranking rather than honesty — for each labeled case it runs the real retrieval pipeline
and checks whether the expected document was served and at what rank, printing recall,
top-1, and MRR. It skips answer generation, so it is a fast, low-noise signal for weighing
a fusion, threshold, or reranker change — measure before and after rather than shipping on
intuition:

```
npm run eval:recall
```

The visual eval proves multimodal figure and table QA end to end. It indexes a figure-heavy
workspace with OCR turned off, so a fact that lives only inside a rendered table image can
reach the index only through the visual-ingest pass. It then asks for that fact through the
same cited pipeline the API uses. The eval skips cleanly when the provider, a vision model,
or image rendering is unavailable, so it is safe to run anywhere:

```
npm run eval:visual
```

Both run in a throwaway temp directory over the fixture corpus and never touch your `./data`.
Like the honesty eval, they need the LLM provider (Ollama by default) reachable.

The eval needs the LLM provider (Ollama by default) reachable, since it embeds and
generates for real. There is also an offline unit suite that needs no model or network —
it covers the deterministic logic directly: query routing, result ranking, follow-up
continuation, the always-on answer checks (arithmetic/exfil/leak), the grounding fence and
context cap, the boot-integrity watchdog, the tamper-evident audit chain, backup
restore data-safety, the SSRF guard, the atomic index save, the API-key store, the
language detector, and a syntax gate over every module (so a parse error in a boot-only
file is caught even though no test executes it). It also validates the eval golden set
itself — every case is well-formed and every expected document is present — so a drifted
`cases.json` or a renamed fixture fails here, in CI, without needing a model:

```
npm run test:unit
```

The offline suite also includes a deterministic retrieval regression. It builds a small synthetic
corpus in ten languages and runs the production tokenizer, chunker, BM25 index, rank fusion,
relevance gates, follow-up handling, and passage windowing. A lexical embedding stub replaces only
the model transport, so the test needs no model, network, worker, or disk writes. It checks exact-term
lookup across the fixture's languages, dense subword matching, off-corpus abstention,
unknown named subjects, pronoun-only follow-ups, citation bounds on a long document, and
repeatable output. Run it alone with
`node lib/test/unit/retrieval-regression.test.js`.

The browser suite drives the real server and UI in Chromium and Firefox against a local stub
provider. It covers the composer, a phone-width answer, Settings layout, themes, focus return, the
answer menu, the document filter, the mobile Tools sheet, the Guide, the large-list performance
path, language-aware read-aloud with a stubbed speech engine (the per-language voice picker, its preview,
independent voice-language browsing, installed-voice diagnostics, live-answer reattachment and re-labeling
after a Settings change, removal when the feature is turned off, restored-session language and voice, the
per-answer Read as dialog, the hands-free utterance pipeline, the silent-engine watchdog, and the
online-voice opt-in), and axe accessibility checks. It uses no model, credentials, or external network.
Install the browser runtimes once, then run the suite:

```
npx puppeteer browsers install chrome
npx puppeteer browsers install firefox
npm run test:e2e
```

A separate Safari pass covers the rendering engine for the same core flows. Safari is not driven by
Puppeteer, so `npm run test:e2e` covers Chromium and Firefox only. Enable Safari's WebDriver once:

1. Open Safari → Settings → Advanced and turn on "Show features for web developers".
2. In the Develop menu, turn on "Allow Remote Automation" and confirm the prompt.

Then run:

```
npm run e2e:safari
```

The runner starts the same deterministic harness and checks the streamed answer, the single Sources row, a
non-English answer with its own sources, the answer menu's keyboard behavior, the document filter and viewer,
theme and text size with Escape focus return, the Guide, the read-aloud control, the evaluation run
comparison, and the phone-width Tools sheet. It runs axe on each open surface and writes screenshots to
`test-results/`. When the Safari setting is missing, it prints the steps above and exits with code 2, so it
is safe to run in a fresh environment.

A dispatch-only workflow, **Safari pass** (`.github/workflows/safari.yml`), runs the same script on a macOS
runner. Start it from Actions → Safari pass → Run workflow. It stays manual until a hosted run proves it can
open a Safari session. The job probes WebDriver first, including navigation and script execution. If that
probe fails for any environment reason, including Safari's manual remote-automation setting, the job records
a warning with the exact steps, skips the pass, and does not fail the build. Once the probe succeeds, a real
pass failure still fails the job. The probe is available locally as `npm run e2e:safari:probe`.

A dispatch-only **Windows pass** workflow (`.github/workflows/windows.yml`) runs the Chromium suite on
`windows-latest` and builds the NSIS and MSI installers. It installs each silently, checks the packaged
executable, the bundled app, and the version reported by the Windows resources, then uninstalls them. It needs
no signing certificate and no GUI session, so a hosted runner can validate the installers.

A dispatch-only **Linux pass** workflow (`.github/workflows/linux.yml`) builds the `.deb` and `.rpm`, installs
the `.deb`, starts the packaged sidecar under the installed runtime, and checks the RPM metadata and contents.
It needs no GUI session or signing certificate.

On macOS, `npm run verify:dmg` mounts the newest DMG and checks its ad-hoc signature, bundle version, macOS
floor, and packaged sidecar and runtime, then unmounts it. It never launches the app or touches user data.

A few checks still need a person: audible playback, VoiceOver announcements and focus order, the installed
Safari app, and the PWA shell on one iOS device. Run those in current Safari and on the device:

1. Turn on Read answers aloud: play, stop, open Read as…, confirm the detected language, switch the
   language, and open Installed voices.
2. Repeat the core path with VoiceOver and the keyboard alone.
3. Add the app to the Home Screen, open it in its own window, and repeat the answer and Settings path.

Add fixtures, cases, and conversations to widen coverage; the harness picks them up from
`cases.json` with no code changes, through a hardened loader that drops a malformed case
and fails safe rather than crashing the run.

For the resumable embedding-bank re-embed, `npm run bench:consolidation` builds a synthetic corpus in a
temporary folder and reports the per-batch hashing and BM25 cost, including the saving from the migration's
stat-validated hash cache. Add `-- --docs=10000 --passes=10` for a larger run. It uses no model, network, or
user data.

A pre-commit hook is included that runs this suite and blocks a commit if anything fails,
so a regression can't land. Enable it once per clone:

```
git config core.hooksPath .githooks
```

Bypass it for a single commit with `git commit --no-verify`.

## MCP Reference

Full detail on using Lokyni with the Model Context Protocol — tools exposed, transports and trust models, client setup, and ingestion connectors.

Lokyni can act as an [MCP](https://modelcontextprotocol.io) server, so MCP-speaking
clients — Claude Desktop, Cursor, agent frameworks — can search and summarize your
Lokyni corpus as a tool. Your documents never leave your machine: the client asks
Lokyni, Lokyni searches locally, and only the retrieved passages go back.

This is Direction A ("Lokyni as an MCP server"). The reverse — Lokyni pulling
documents *in* from other MCP servers — is covered as Direction B below.

### Tools exposed

| Tool | What it does |
|------|--------------|
| `search_documents` | Search a workspace for passages relevant to a query. Returns grounded passages. |
| `summarize_document` | Summarize one document by its `docId`. |
| `list_documents` | List a workspace's documents (name, id, type, size). |
| `list_workspaces` | List available workspaces. |

Each takes an optional `workspace` (defaults to `default`).

### Two transports, two trust models

**stdio — no API key.** When a client like Claude Desktop launches Lokyni as a
subprocess, that process runs as you, locally. It's trusted, so no key is required.
This is the common case.

**Network (HTTP) — API key required.** Lokyni also serves MCP at `POST /mcp` on its
web server. Anything reaching Lokyni over the network is *not* trusted the way a local
subprocess is, so every network MCP request must carry an API key
(`Authorization: Bearer <key>` or `x-api-key`), authorized exactly like the `/api/v1`
routes — same scopes, same per-workspace restrictions, same rate limits. A key needs
`search` to search, `summarize` to summarize, and `read` to list.

### Setup: Claude Desktop (stdio)

Add Lokyni to Claude Desktop's MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lokyni": {
      "command": "node",
      "args": ["/absolute/path/to/lokyni/lokyni.js", "--mcp"]
    }
  }
}
```

Restart Claude Desktop. Lokyni's tools appear, and Claude can search your private
documents when a question calls for it. Run `node lokyni.js --mcp` yourself first to
confirm it starts (it will sit quietly waiting on stdio — that's correct; Ctrl-C to
exit).

Note: `--mcp` loads the index and speaks MCP on stdout, so **all diagnostic logging
is redirected to stderr** — stdout carries only the MCP protocol. Don't be surprised
that `--mcp` prints nothing to stdout.

### Setup: networked client (HTTP)

Point the client at `http://<host>:<port>/mcp` (same host/port as the web UI) and give
it an API key created in Settings → API keys. Give the key only the scopes it needs.

### MCP Requirements

The MCP SDK (`@modelcontextprotocol/sdk`) is a dependency — run `npm install` after
updating. If it's missing, Lokyni still runs normally; only MCP is disabled, with a
note on startup telling you to install.

---

### Direction B — Lokyni as an MCP client (ingestion connectors)

The reverse direction: Lokyni connects *out* to an MCP server and pulls documents
*in*, indexing them like any other source. This turns "an MCP server that exposes
documents" into a Lokyni ingestion source.

### Connectors

A **connector** is a per-workspace ingestion source (stored in the workspace's
settings). Manage them in Settings → Connectors: add one, **Sync** to pull documents
in, **Remove** to delete it (ingested documents stay). Re-syncing refreshes the set —
files removed at the source are removed from the workspace, new ones are added.

Ingested documents land under `documents/_connectors/<connector-id>/` so a re-sync can
cleanly replace the set and connectors never collide with each other or with files you
added manually.

### Filesystem connector

The first connector type, backed by the official
`@modelcontextprotocol/server-filesystem`. Point it at a folder:

- **Type:** filesystem
- **Folder path:** an absolute path (e.g. `/Users/you/Documents/notes`)

On sync, Lokyni spawns the filesystem MCP server scoped to that folder, walks the tree
(`directory_tree`), reads each text file (`read_text_file`), and writes them into the
workspace. Text-like extensions only (`.txt`, `.md`, `.csv`, `.json`, `.html`, `.yaml`,
etc.); binaries are skipped. Dependency and build directories (`node_modules`, `.git`,
`dist`, `venv`, and similar), plus Obsidian's `.obsidian` config folder and `.trash`,
are skipped automatically. Everything runs locally — nothing leaves your machine.

**Obsidian vaults.** An Obsidian vault is just a folder of Markdown, so it's the same
connector — the Type dropdown offers "Obsidian vault" as a friendlier label that points
at your vault folder. Because `.obsidian` is excluded by default, only your notes get
indexed, not the vault's config and plugin data.

This connector requires the filesystem MCP server, fetched on demand via `npx -y`
(needs network access the first time to download it).

### GitHub connector

Pull a GitHub repository's text files into a workspace, backed by the official
`@modelcontextprotocol/server-github`. Point it at a repo:

- **Type:** GitHub repository
- **Owner:** the user or organization (e.g. `octocat`)
- **Repository:** the repo name (e.g. `Hello-World`)
- **Branch:** optional — defaults to the repository's default branch
- **Token:** optional — see below

On sync, Lokyni walks the repo (breadth-first through directories via
`get_file_contents`), reads each text file, and writes them into the workspace — the
same supported text types and the same skip-rules as the filesystem connector
(`node_modules`, `.git`, `dist`, `venv`, and the rest are skipped; up to 500 files per
sync). It reuses the shared client, write path, and indexing, so a GitHub-ingested repo
behaves like any other source once indexed.

**Public vs private repos.** A **public** repository needs no token (GitHub's
unauthenticated API is rate-limited but sufficient for a small repo). A **private**
repository — or higher rate limits on a large one — needs a GitHub
[personal access token](https://github.com/settings/tokens) with `repo` read scope.
The token is passed to the MCP server through an environment variable (never on the
command line), stored in the workspace settings, and **never sent back to the browser**
— the settings panel only shows whether one is set, exactly like a provider API key.

This connector fetches `@modelcontextprotocol/server-github` on demand via `npx -y`
(needs network access the first time).

### Pinning a connector's server version

By default a connector fetches the latest release of its official MCP server package —
the same track-upstream policy Lokyni uses for its own dependencies. If you prefer
supply-chain certainty, or you need to repoint a connector at a replacement package, set
an explicit **package** on the connector config to a pinned npm spec, for example
`@modelcontextprotocol/server-filesystem@2025.1.0`. Lokyni validates the value to a plain
npm package-spec shape (an optional scope, a name, and an optional `@version`), so it can
never smuggle a command-line flag, a local path, or shell characters into the spawn. Leave
**package** empty to keep tracking the latest release.

### Adding another connector type

The framework is generic — the client, registry, write path, and indexing are shared.
A new type needs:

1. A spec builder in `lib/mcp/connectors.js` (`SPEC_BUILDERS`) — how to spawn that MCP server
   (and any env, e.g. an auth token).
2. A puller (`PULLERS`) — how to turn its tools into `{name, text}` documents. If the
   server exposes the same `directory_tree` / `read_text_file` shape it can reuse the
   filesystem puller; otherwise it maps that server's own tools (as the GitHub puller
   does with `get_file_contents`). Shared helpers — `TEXT_EXT`, `resolveExcludeDirs`,
   the `{name, text}` doc shape — keep a new type consistent with the existing ones.

## Disclaimer

Lokyni is provided for informational and productivity purposes. Answers are generated by a language model from your indexed documents and may contain errors, omissions, or misinterpretations. Always verify important information against the original source material — the citation and passage-highlighting features are provided to make this easy. Do not rely on Lokyni as a sole source of truth for critical, legal, medical, financial, or safety-related decisions.

You are responsible for ensuring you have the right to index and process any documents you add, and for complying with any applicable data-handling obligations. The authors and affiliates are not responsible for any outcomes resulting from the use of this software, which you use at your own risk.

## License

Lokyni is free software under the GNU Affero General Public License, version 3 or later. Copyright (C) 2026 3CQS. You may use, study, modify, and share it under those terms, and the full text is in the [LICENSE](../LICENSE) file. If you run a modified version as a network service, the license asks you to offer its users the corresponding source.
