# meridian zenith

AI-powered personalised study planner for Cambridge middle school students (Grades 6-8).

## What it does

On first visit, users:
1. Enter their name
2. Upload a photo or screenshot of their report card — AI reads grades and teacher comments
3. Upload a photo or screenshot of their syllabus/course planner — AI maps out term topics
4. Add a Groq API key (free at console.groq.com)

Groq then generates a fully personalised 6-day weekly study plan based on their actual data — weak subjects get more focus, tasks reference real syllabus topics.

## Features

- **Overview dashboard** — today's progress, 28-day habit grid, grade breakdown, term countdown, roadmap summary

- **Personalised AI plan** — generated from report card + syllabus
- **Session timer** — 15/25/30/60/custom presets, ring animation, alarm sound
- **Task checklist** — today's tasks auto-loaded, detail panel with AI tips
- **AI-generated content** — fresh reading extracts, practice problems, exercises per task
- **AI chat** — ask follow-up questions about any task
- **Streak tracker** — daily completion streak
- **Ambient music** — brown noise, rain, focus tones (Web Audio, no ads)
- **Reward modal** — AI-generated message on day completion
- **6 themes** — light, dark, forest, ocean, midnight, warm
- **CS fundamentals roadmap** — 16-week self-study curriculum
- **Monthly projects** — 4 cross-subject projects per term
- **Spaced repetition** — completed tasks return for review on an expanding schedule (SM-2 variant)
- **Exam mode** — add exam dates; within 14 days that subject leads your day and its review cards come back sooner
- **Study time stats** — timer sessions are saved and broken down by subject
- **Backup** — export/restore everything as a JSON file
- **Settings** — edit name, API key, exam dates, re-upload docs, change theme

Grades on the overview come from the report card the AI reads. With no report card uploaded, that card shows an empty state rather than placeholder numbers.

## How review scheduling works

Ticking a task off creates a review card. Answering it schedules the next appearance:

| Answer | Effect |
| --- | --- |
| forgot | back to 1 day, ease drops, counted as a lapse |
| hard | interval × 1.2, ease drops slightly |
| good | 1 day → 3 days → interval × ease |
| easy | longer jump, ease rises |

Ease starts at 2.5 and never falls below 1.3. If the subject has an exam coming up, the interval is capped so the card falls due *before* the exam rather than after it.

## Data

Everything is in localStorage under `mz*` keys — profile, streak, sessions, reviews, exams, per-day task state. There is no server, so clearing browsing data erases it. Settings → backup → export writes the lot to a JSON file.

## No default plan

There is no fallback curriculum. If generation fails you get a retry button and an import option — the app never hands over a generic schedule dressed up as yours.

Plans are validated before they are saved and again at boot. A plan the renderers can't handle triggers a recovery screen offering regenerate, import, or export-a-backup — it can no longer crash the app into an unbootable state.

## Import

| Source | What happens |
| --- | --- |
| Meridian backup (.json) | restored directly |
| Photo of a schedule | read by the vision model, turned into a plan |
| Photo of an exam timetable | subjects, dates and per-paper syllabus extracted into exam mode |

## Tests

```bash
node test-features.js   # sessions, spaced repetition, exams, backup
node test-overview.js   # overview rendering
node test-onboarding.js  # walks every onboarding path, fails on any dead end
node test-resilience.js  # malformed AI plans must never brick the app
node test-markdown.js    # AI content rendering and escaping
```

## Stack

Pure HTML/CSS/JS. No build step, no dependencies, no server.

## Deploy to Render

1. Push to GitHub
2. Render → New → Static Site → connect repo
3. Build command: *(empty)*
4. Publish directory: `.`
5. Deploy

## API key

Uses Groq (free tier). Get a key at [console.groq.com](https://console.groq.com).
Key is stored in localStorage only — never sent anywhere except Groq's API.

Uploads are images only. PDFs are rejected with a message telling you to screenshot them — the vision model can't read PDF files directly.

### Models

| Purpose | Model ID |
| --- | --- |
| Text (plan, tips, chat) | `openai/gpt-oss-20b` |
| Vision (report card, syllabus) | `qwen/qwen3.6-27b` |

Groq retires model IDs on a schedule, and requests to a dead ID fail. If AI features stop working, check the [deprecations page](https://console.groq.com/docs/deprecations) before assuming the bug is yours — both IDs above are defined at the top of `main.js`.
